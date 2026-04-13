# Soul: macOS + Windows 全自动更新方案

## Context

Soul 桌面应用目前版本 v0.5.3，用户安装的是 v0.4.0。升级需要手动下载新版覆盖安装。当前已实现轻量"检查更新"提示（启动时检查 GitHub Releases 版本号，有新版显示 banner + 下载链接），但用户需要手动下载安装。

目标：实现双平台全自动更新——后台静默下载，提示用户一键重启即完成升级。

## 技术选型

**`electron-updater` + 阿里云 OSS**

| 维度 | 选择 | 理由 |
|------|------|------|
| 更新库 | `electron-updater` | electron-builder 内置，项目已用 electron-builder 打包，零集成成本 |
| 分发源 | 阿里云 OSS + CDN | 国内快、便宜（几块/月）、S3 兼容协议 electron-updater 原生支持 |
| macOS 签名 | Developer ID + Apple 公证 | 已有 Apple 开发者账号，公证后 macOS 允许自动更新 |
| Windows 签名 | 可选 | 不签名也能自动更新（NSIS 全量替换），只是安装时弹 SmartScreen 警告 |

### 为什么不选其他方案

| 方案 | 不选理由 |
|------|---------|
| GitHub Releases | 国内访问慢，用户下载体验差 |
| update.electronjs.org | 仅 public repo，macOS 必须签名，无法自定义 |
| Hazel（Vercel） | 仅 macOS，不支持 Windows |
| S3 直连 | 阿里云 OSS 就是 S3 兼容，用 OSS 更便宜 |

---

## 架构设计

```
┌─ 开发者本机 ─────────────────────────────────────────┐
│                                                       │
│  npm run dist:mac / dist:win                          │
│       ↓                                               │
│  electron-builder 打包                                │
│       ↓                                               │
│  afterSign hook → macOS 公证（notarize）              │
│       ↓                                               │
│  产出：                                               │
│    macOS: Soul-{version}-arm64.dmg + latest-mac.yml   │
│    Windows: Soul-Setup-{version}.exe + latest.yml     │
│       ↓                                               │
│  scripts/publish-oss.sh → 上传到阿里云 OSS            │
│                                                       │
└───────────────────────────────────────────────────────┘

┌─ 用户机器 ────────────────────────────────────────────┐
│                                                       │
│  App 启动                                             │
│       ↓                                               │
│  autoUpdater.checkForUpdates()                        │
│       ↓                                               │
│  请求 OSS: https://{bucket}.oss-{region}.aliyuncs.com │
│            /releases/latest-mac.yml 或 latest.yml     │
│       ↓                                               │
│  有新版 → 后台下载（显示进度条）                      │
│       ↓                                               │
│  下载完成 → 弹提示"新版本已就绪，重启安装？"         │
│       ↓                                               │
│  用户点"重启" → autoUpdater.quitAndInstall()         │
│       ↓                                               │
│  macOS: 替换 .app + 重启                              │
│  Windows: 静默 NSIS 安装 + 重启                       │
│                                                       │
└───────────────────────────────────────────────────────┘
```

---

## 文件变更清单

| 文件 | 类型 | 变更要点 |
|------|------|---------|
| `desktop-app/package.json` | 改 | 新增 `electron-updater` 依赖 |
| `desktop-app/electron-builder.yml` | 改 | 添加 `publish` 配置（指向 OSS）、`afterSign` 公证 hook |
| `desktop-app/electron/main.ts` | 改 | 集成 `autoUpdater`：启动检查 → 下载 → 通知渲染进程。替换现有 `check-update` IPC |
| `desktop-app/electron/preload.ts` | 改 | 暴露 `onUpdateAvailable` / `onUpdateDownloaded` / `onDownloadProgress` / `installUpdate` |
| `desktop-app/src/global.d.ts` | 改 | 新增更新相关类型声明 |
| `desktop-app/src/App.tsx` | 改 | 替换现有 banner 为：下载进度条 + "重启安装"按钮 |
| `desktop-app/scripts/notarize.js` | 新建 | macOS 公证脚本（afterSign hook 调用） |
| `desktop-app/scripts/publish-oss.sh` | 新建 | 打包后上传到阿里云 OSS 的脚本 |

---

## 详细实现

### 1. 安装依赖

```bash
cd desktop-app
npm install electron-updater
```

### 2. electron-builder.yml 配置

```yaml
# 现有配置保持不变，新增：
publish:
  provider: generic
  url: https://{bucket}.oss-{region}.aliyuncs.com/releases/

# macOS 签名 + 公证
mac:
  identity: "Developer ID Application: {你的名字} ({Team ID})"
  hardenedRuntime: true
  gatekeeperAssess: false
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist
afterSign: scripts/notarize.js

# Windows（可选签名）
win:
  publisherName: "{你的名字或公司名}"
```

### 3. 主进程 autoUpdater 集成

```typescript
// electron/main.ts — 替换现有 check-update IPC

import { autoUpdater } from 'electron-updater'

// 配置
autoUpdater.autoDownload = true         // 检测到新版自动下载
autoUpdater.autoInstallOnAppQuit = true // 退出时自动安装

// 事件转发到渲染进程
autoUpdater.on('checking-for-update', () => {
  mainWindow?.webContents.send('update-status', { status: 'checking' })
})

autoUpdater.on('update-available', (info) => {
  mainWindow?.webContents.send('update-status', {
    status: 'available',
    version: info.version,
    releaseNotes: info.releaseNotes,
  })
})

autoUpdater.on('update-not-available', () => {
  mainWindow?.webContents.send('update-status', { status: 'not-available' })
})

autoUpdater.on('download-progress', (progress) => {
  mainWindow?.webContents.send('update-status', {
    status: 'downloading',
    percent: progress.percent,
    bytesPerSecond: progress.bytesPerSecond,
    transferred: progress.transferred,
    total: progress.total,
  })
})

autoUpdater.on('update-downloaded', (info) => {
  mainWindow?.webContents.send('update-status', {
    status: 'downloaded',
    version: info.version,
  })
})

autoUpdater.on('error', (err) => {
  console.error('[autoUpdater] 更新失败:', err.message)
  mainWindow?.webContents.send('update-status', {
    status: 'error',
    message: err.message,
  })
})

// 启动后延迟 10 秒检查（不阻塞启动）
app.whenReady().then(() => {
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(err => {
      console.warn('[autoUpdater] 检查更新失败:', err.message)
    })
  }, 10000)
})

// IPC：用户点击"重启安装"
ipcMain.handle('install-update', () => {
  autoUpdater.quitAndInstall(false, true)
})
```

### 4. 渲染进程 UI

```tsx
// App.tsx — 替换现有 updateInfo banner

// 状态：
// checking → available → downloading (带进度) → downloaded → 等用户点重启
// 或 not-available / error

// UI 设计：
// - downloading: 顶部细进度条 + "正在下载 v0.6.0 (45%)"
// - downloaded: 顶部横幅 "v0.6.0 已就绪" + [重启安装] 按钮
// - error: 静默，不影响使用
```

### 5. macOS 公证脚本

```javascript
// scripts/notarize.js
const { notarize } = require('@electron/notarize')

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context
  if (electronPlatformName !== 'darwin') return

  const appName = context.packager.appInfo.productFilename

  await notarize({
    appBundleId: 'com.soul.desktop',
    appPath: `${appOutDir}/${appName}.app`,
    appleId: process.env.APPLE_ID,           // Apple ID 邮箱
    appleIdPassword: process.env.APPLE_APP_PASSWORD, // App 专用密码
    teamId: process.env.APPLE_TEAM_ID,       // Team ID
  })
}
```

需要的环境变量：
- `APPLE_ID` — Apple 开发者账号邮箱
- `APPLE_APP_PASSWORD` — 在 appleid.apple.com 生成的 App 专用密码
- `APPLE_TEAM_ID` — 开发者 Team ID（在 developer.apple.com 查看）

### 6. OSS 上传脚本

```bash
#!/bin/bash
# scripts/publish-oss.sh
# 依赖：ossutil（阿里云 CLI 工具）

BUCKET="soul-releases"
REGION="cn-hangzhou"
RELEASE_DIR="release"

# 上传 macOS 产物
ossutil cp ${RELEASE_DIR}/Soul-*.dmg oss://${BUCKET}/releases/ -f
ossutil cp ${RELEASE_DIR}/latest-mac.yml oss://${BUCKET}/releases/ -f

# 上传 Windows 产物
ossutil cp ${RELEASE_DIR}/Soul-Setup-*.exe oss://${BUCKET}/releases/ -f
ossutil cp ${RELEASE_DIR}/latest.yml oss://${BUCKET}/releases/ -f

echo "✓ 已上传到 OSS: https://${BUCKET}.oss-${REGION}.aliyuncs.com/releases/"
```

---

## 发版流程（SOP）

```
1. 更新 package.json 版本号 + CHANGELOG
2. git commit + push
3. npm run dist:mac   → 打包 + 签名 + 公证（自动）
4. npm run dist:win   → 打包（可在 CI 或 Windows 机器上跑）
5. bash scripts/publish-oss.sh → 上传到 OSS
6. （可选）GitHub 创建 Release tag
7. 用户下次启动 → 自动检测 + 下载 + 提示重启
```

---

## 前置准备（需要你操作）

| # | 事项 | 说明 |
|---|------|------|
| 1 | **创建阿里云 OSS bucket** | bucket 名如 `soul-releases`，region 选最近的（如 `cn-hangzhou`），公共读 |
| 2 | **安装 ossutil CLI** | `brew install ossutil`（macOS）用于上传脚本 |
| 3 | **配置 ossutil** | `ossutil config`，填入 AccessKey ID/Secret |
| 4 | **macOS 证书** | 确认 Keychain 里有 "Developer ID Application" 证书 |
| 5 | **生成 App 专用密码** | appleid.apple.com → 安全 → App 专用密码 → 生成 |
| 6 | **设置环境变量** | `APPLE_ID`、`APPLE_APP_PASSWORD`、`APPLE_TEAM_ID` |
| 7 | **entitlements 文件** | 创建 `build/entitlements.mac.plist`（允许网络访问等） |

---

## 风险与注意事项

1. **macOS 首次公证会很慢**（5-15 分钟），后续增量快
2. **公证失败常见原因**：未开启 hardened runtime、包含未签名的二进制（7zip-bin 需要额外处理）
3. **Windows SmartScreen**：不签名的 exe 首次安装会弹安全警告，用户点"仍要运行"可继续。签名需要购买代码签名证书（$200-400/年）
4. **更新失败兜底**：`autoUpdater.on('error')` 静默处理，不影响正常使用，用户可手动下载
5. **大版本差异**：如果涉及数据库 schema 变更，需要在启动时加 migration 逻辑（当前已有 v1-v4 的 schema 升级）
6. **OSS 费用**：存储 + 流量极低，100 个用户每月不到 1 元
7. **国内网络**：OSS + CDN 保证国内用户秒级下载，海外用户可加 GitHub Releases 作为备用源

---

## 时间估算

| 阶段 | 耗时 |
|------|------|
| 代码开发（步骤 1-4） | 2-3 小时 |
| macOS 签名 + 公证配置（步骤 5） | 1-2 小时（含调试） |
| OSS 配置 + 上传脚本（步骤 6） | 30 分钟 |
| 端到端测试 | 1-2 小时 |
| **总计** | **约 1 天** |
