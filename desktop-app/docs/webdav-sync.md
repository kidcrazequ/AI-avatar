<!--
 Soul WebDAV 跨设备同步 用户指南

 @author zhi.qu
 @date 2026-05-09
-->

# Soul WebDAV 跨设备同步

> **作者**：zhi.qu  
> **日期**：2026-05-09  
> **配套主计划**：`.cursor/plans/对手对比融合执行计划_2026-05.plan.md` §4.14  
> **状态**：MVP（全量 zip 快照单向同步，无双向 merge）  
> **适用版本**：Soul Desktop（Electron）2026-05-09 之后  
> **读者**：在两台以上电脑使用 Soul、希望分身 / 知识库 / 会话历史能跨机迁移的个人用户  

---

## 一、能用来做什么 / 不能做什么

### 1.1 能做什么

| 能力 | 说明 |
|------|------|
| ✅ **全量备份** | 把当前设备的 SQLite 数据库 + `avatars/` + `shared/` + `conversations/*.jsonl` 打成一个 zip 上传到你自己的 WebDAV |
| ✅ **跨设备恢复** | 在新设备装好 Soul → 填同样的 WebDAV 配置 → 列出远端备份 → 一键恢复 → 应用重启即得 |
| ✅ **自动定时备份** | hourly / every-6-hours / daily（每天 09:00 UTC）三档；底层与定时任务（#11）同一个 cron 调度器 |
| ✅ **远端保留份数控制** | 默认保留最近 7 份，可调到 [1, 30] 之间；超出自动删除最旧 |
| ✅ **本地兜底备份** | 每次「恢复」前先把当前数据完整打到 `userData/sync-pre-restore/<id>-<ts>/local-pre-restore.zip`，恢复出意外可手动找回 |
| ✅ **加密凭据存储** | WebDAV 密码经 Electron `safeStorage` 加密后才入 `settings` 表 |

### 1.2 不能做什么（**MVP 边界**）

| 不做项 | 原因 / 替代方案 |
|--------|-----------------|
| ❌ **端到端加密（E2EE）** | MVP 范围外；信任 WebDAV 服务器端 + HTTPS 传输 |
| ❌ **双向 merge** | 单向「以最新备份覆盖本地」；冲突由用户在两台设备之间约定单向流向 |
| ❌ **大文件切分上传** | 单 zip 上限 500 MB（坚果云硬限），超出会抛 `SnapshotTooLargeError` |
| ❌ **同步 `attachments/` 与 `_index/`** | 占用过大；附件由用户自行迁移，索引由分身首次启动时按需重建 |
| ❌ **应用启动 / 退出时强制同步** | 启动同步会让首屏延迟不可控；退出同步会导致关闭体验劣化 |
| ❌ **fs.watch 实时增量同步** | 会反复 push 大量小变更，远端无法承受；走 cron 才稳定 |
| ❌ **多账号 / 多服务器** | 单实例配置；要切账号请在「设置 → 跨设备同步」直接覆盖 |

> **与 Cherry Studio 风格的差异**：Cherry Studio 强调 SQLite 单库直传 + 跨平台数据迁移；Soul 因为 `avatars/` + `conversations/*.jsonl` 是真正的"语料正本"，必须打成 zip 一起同步，否则恢复出来的分身只剩"壳"。  
> **与 #15 Web Embed widget / #6 LangBot 的差异**：本能力是**用户私域数据迁移**（B → A 复制设备状态），不是「让分身上线提供服务」；嵌入网页或接入 IM 请用 #15 / #6。

---

## 二、快速上手（5 步配置坚果云）

### 2.1 注册坚果云账号 + 获取「应用密码」

1. 打开 <https://www.jianguoyun.com/> 注册免费账号
2. 登录后右上角头像 → **「账户信息」**
3. 进入 **「安全选项」** → **「第三方应用管理」** → **「添加应用」** → 填写应用名（如 `Soul Desktop`）
4. 系统生成一串字母数字应用密码，**注意：不是登录密码！**

> **重要**：坚果云出于安全策略，**禁止**第三方应用直接使用登录密码；必须用应用密码（独立可吊销）。这一点在所有 WebDAV 客户端设置时都一样。

### 2.2 打开 Soul → 设置 → 跨设备同步

Soul Desktop → **设置（Settings）** → **TOOLS Tab** → **跨设备同步**子区。

<!-- 截图：状态卡片（待截图） -->

### 2.3 填写 4 项基础配置

| 字段 | 坚果云填法 | 说明 |
|------|-----------|------|
| 启用同步 | 勾选 | 关闭时所有同步动作（含 cron）都被跳过 |
| Endpoint | `https://dav.jianguoyun.com/dav/` | 末尾斜杠会被自动去除 |
| 用户名 | 注册邮箱 | 例如 `you@example.com` |
| 应用密码 | 第 2.1 步生成的字符串 | 经 safeStorage 加密后入库；不会回显明文 |
| Base Path | `/soul-backup` | 远端目录；不存在会被自动创建（PROPFIND + MKCOL） |
| 忽略 TLS 错误 | **不勾** | **公网请勿勾选**；仅企业内网自签证书才需要 |

### 2.4 点「测试连接」

点击 **「测试连接」**，预期 1–3 秒内返回：

- ✅ **「连接成功」** → 可以进行下一步
- ❌ **「连接失败：[401] 未授权」** → 检查应用密码是否复制完整 / 用了登录密码
- ❌ **「连接失败：self signed certificate」** → 仅自建场景；勾选「忽略 TLS 错误」（不推荐）

### 2.5 立即备份 → 验证

点 **「立即备份」**，状态条会显示「备份中…」；完成后：

- 远端 `dav.jianguoyun.com/dav/soul-backup/` 下出现 `soul-backup-<deviceId>-2026-05-09-08-30-15.zip`
- 「同步历史」面板新增一条 `success` 记录，含文件数 / 总字节数 / 耗时

---

## 三、Nextcloud 配置示例

| 字段 | 填法 |
|------|------|
| Endpoint | `https://nextcloud.example.com/remote.php/dav/files/<你的用户名>/` |
| 用户名 | 登录 Nextcloud 的用户名 |
| 密码 | 推荐**应用密码**（设置 → 安全 → 应用密码 → 创建）；登录密码也能用但风险高 |
| Base Path | `/soul-backup`（默认创建在用户根目录下） |
| 忽略 TLS 错误 | **不勾**（Nextcloud 默认有合法证书） |

> **注意**：Nextcloud 的 endpoint 必须包含 `remote.php/dav/files/<username>/`，少一段会得到 404。

---

## 四、Synology DSM 配置示例

| 字段 | 填法 |
|------|------|
| Endpoint | `https://nas.local:5006/`（DSM 默认 HTTPS WebDAV 端口 5006；HTTP 是 5005，**不推荐**） |
| 用户名 | DSM 用户名 |
| 密码 | DSM 密码（建议为 Soul 单独建一个仅有 WebDAV 权限的账号） |
| Base Path | `/soul-backup` |
| 忽略 TLS 错误 | 视情况；DSM 默认是自签证书，没绑域名时勾选；绑了域名 + Let's Encrypt 不勾 |

DSM 启用 WebDAV：**控制面板** → **文件服务** → **WebDAV** → 勾选 HTTPS → 应用。然后在 **共享文件夹** → 给目标账号分配读写权限。

---

## 五、自建 Apache mod_dav 配置示例（高级）

`/etc/apache2/sites-available/dav.conf`：

```apache
<VirtualHost *:443>
    ServerName dav.example.com
    DocumentRoot /var/www/dav

    SSLEngine on
    SSLCertificateFile /etc/letsencrypt/live/dav.example.com/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/dav.example.com/privkey.pem

    Alias /soul /var/www/dav/soul
    <Directory /var/www/dav/soul>
        Dav On
        AuthType Basic
        AuthName "Soul WebDAV"
        AuthUserFile /etc/apache2/dav.passwd
        Require valid-user
    </Directory>
</VirtualHost>
```

启用模块 + 创建账号 + 重启：

```bash
sudo a2enmod dav dav_fs
sudo htpasswd -c /etc/apache2/dav.passwd zhi.qu
sudo systemctl reload apache2
```

Soul 端配置：

| 字段 | 填法 |
|------|------|
| Endpoint | `https://dav.example.com/soul/` |
| 用户名 | `zhi.qu` |
| 密码 | htpasswd 设置的密码 |
| Base Path | `/soul-backup` |
| 忽略 TLS 错误 | **不勾**（已用 Let's Encrypt） |

---

## 六、自动间隔与 cron

UI 提供 4 档：

| 档位 | 含义 | 内部 cron 表达式 | 时区 |
|------|------|------------------|------|
| `off` | 关闭自动同步（仅手动） | — | — |
| `hourly` | 每小时整点 | `0 * * * *` | UTC |
| `every-6-hours` | 每 6 小时整点 | `0 */6 * * *` | UTC |
| `daily` | 每天 09:00 | `0 9 * * *` | UTC |

> **为什么时区固定 UTC**：跨设备同步天然涉及多时区，统一 UTC 避免「同一档位在不同设备触发时间不一样」的认知混乱。如果 09:00 UTC 不合你的作息，可在主进程日志里看实际触发时间，结合自身时区判断。

cron 与 #11 定时任务**共享同一个 cron-scheduler**，但用独立 taskId（`webdav-sync`）；互不干扰，cron 任务名空间隔离。

---

## 七、跨设备恢复流程

### 7.1 设备 A（已配置且备份过）

`backupNow()` 完成后远端有一组 `soul-backup-*.zip`。

### 7.2 设备 B（全新安装）

1. 装好 Soul Desktop
2. **不要**在新设备先创建分身或新增任何会话（避免被恢复时覆盖）
3. **设置 → 跨设备同步** → 填写**与设备 A 完全相同的 WebDAV 配置**
4. 点 **「测试连接」** 确认凭据正确
5. 点 **「列出远端备份」** → 选最新一份 → **「恢复到本设备」**
6. 弹窗二次确认：「将覆盖本机数据，是否继续？」 → 确认
7. 等待 15 秒–2 分钟（取决于备份大小）
8. 应用自动 `relaunch()`；重启后 `avatars/` `shared/` `conversations/` `xiaodu.db` 已切换为远端版本

### 7.3 兜底：恢复出错时

恢复前 SyncManager 会自动在本机 `userData/sync-pre-restore/<historyId>-<timestamp>/local-pre-restore.zip` 留一份**当前数据的完整 zip**。
如果恢复后发现数据不对：

```bash
# 找到兜底 zip 路径（macOS 示例）
open ~/Library/Application\ Support/soul-electron/sync-pre-restore/

# 用 unzip 看清单
unzip -l local-pre-restore.zip
```

把 `snapshot/avatars/` `snapshot/shared/` `snapshot/conversations/` 解压回 `userData/` 对应目录，把 `snapshot/xiaodu-snapshot.db` 改名为 `xiaodu.db` 替换 → 再次启动 Soul 即恢复到本机原状。

---

## 八、安全与凭据

### 8.1 safeStorage 各 OS 实现

| OS | safeStorage backend | 加密强度 |
|----|---------------------|----------|
| macOS | `keychain` | Keychain，硬件 Secure Enclave 加持 |
| Windows | `dpapi` | DPAPI，绑当前用户账户 |
| Linux（有 keyring） | `gnome_libsecret` / `kwallet5` | 系统 keyring |
| Linux（**无 keyring**） | `basic_text` | **明文写入 ~/.config**，不安全 |

### 8.2 Linux basic_text 风险与缓解

- Soul 启动时检测 backend，如为 `basic_text` → 设置面板顶部展示醒目的「不安全」标签 + hint
- 缓解：安装 `libsecret-tools`（gnome）或 `kwallet`（KDE）后重启应用，backend 会切到 keyring

### 8.3 推荐 HTTPS 必选

WebDAV 协议本身是 HTTP；Basic Auth 在 HTTP 上是明文密码。**任何公网部署都必须强制 HTTPS**：

- 公网 endpoint 不以 `https://` 开头：UI 标红警示
- 自签证书：仅企业内网勾选「忽略 TLS 错误」；公网勿用

### 8.4 公网穿透不内置

Soul 不内置 cloudflared / ngrok / frpc。若你的 WebDAV 跑在家里 NAS，需要自行用 Cloudflare Tunnel / Tailscale / WireGuard 把它暴露到公网；与 §4.7 / §4.13（widget Tunnel）的策略一致 —— 不让 Soul 变成轻量级反代，避免 DDoS / 滥用 / 合规外延。

---

## 九、坚果云专项注意（中国用户）

坚果云对 WebDAV 客户端做了一些与 RFC 不完全对齐的限制，Soul 内部已做兼容，但用户需要了解：

| 限制 | Soul 行为 |
|------|-----------|
| **PROPFIND 仅允许 Depth: 1** | `listBackups()` 强制 `deep: false`，与坚果云一致 |
| **单 PROPFIND 最多返回 750 项** | Soul 单目录只放 `soul-backup-*.zip`；超 750 份要先在 UI 调小 retentionCount |
| **30 分钟内 600 次 API 调用速率** | hourly 自动同步远低于此，安全；如果你手动连续按「立即备份」务必克制 |
| **单文件上限 500 MB** | 与 `DEFAULT_SNAPSHOT_MAX_BYTES` 一致；超出抛 `SnapshotTooLargeError`，需裁剪 `avatars/` 后重试 |
| **总空间 1 GB（免费版）** | 7 份保留 = 平均每份 < 140 MB；若超出请下调 retentionCount 或升级套餐 |

---

## 十、故障排查 FAQ

### Q1：「测试连接失败：[401] 未授权」

- 用了**登录密码**而不是**应用密码**（坚果云 / Nextcloud 都需要应用密码）
- 应用密码复制时多了一个空格 / 缺尾字符
- 用户名拼错（坚果云用注册邮箱，不是昵称）

### Q2：「测试连接失败：self signed certificate」

- 自建 Apache / DSM 默认证书是自签
- 临时方案：勾选「忽略 TLS 错误」（**仅企业内网建议**）
- 长期方案：用 Let's Encrypt / acme.sh 给域名签证书

### Q3：「立即备份」点完后状态一直转圈

- 备份大小 = SQLite + `avatars/` + `shared/` + `conversations/` 累加；分身知识库大时 build snapshot 阶段就要数十秒
- 看主进程日志（macOS：`~/Library/Application Support/soul-electron/logs/`）的 `[snapshot-builder] build start` → `build done` 间隔
- 上传阶段慢通常是带宽 + 坚果云限速；耐心等

### Q4：恢复完成后发现「附件全没了」

- **设计如此**：MVP 不同步 `avatars/<id>/attachments/`（与 §4.14 一致）
- 附件请用 iCloud Drive / OneDrive / 拷贝硬盘的方式自行迁移
- 未来如做 attachments 同步，会作为独立子任务在 §4.14 升级

### Q5：「embedding 索引重建慢」

- **设计如此**：MVP 不同步 `avatars/<id>/_index/`
- 恢复后首次对该分身提问会触发 reindex；视知识库大小 1–10 分钟
- 可以在恢复后手动到「分身详情 → 重建索引」立刻触发，避免首次提问卡顿

### Q6：「应用启动时 sync 失败」一闪而过

- 启动 `registerAutoInterval()` 内部如配置缺失会优雅降级（仅 `logger.warn` 不阻塞主流程）
- 表现：应用正常启动，但状态条提示「自动同步未启用」
- 排查：设置面板 → 重新点「保存配置」→ 确保 endpoint / username / 应用密码都到位

### Q7：「并发备份冲突 sync_already_running」

- 同时点了多次「立即备份」 / cron 自动同步与手动同步撞上
- SyncManager 内部用 `isRunning` 互斥锁防止多任务重叠
- 等当前一次完成（看「同步历史」最后一条状态变 success/failed），再触发下一次

### Q8：Linux 下弹窗「密码不安全」

- safeStorage backend 落到了 `basic_text`（系统无 gnome-libsecret / kwallet）
- 缓解：`sudo apt install libsecret-tools`（Debian/Ubuntu）后重启 Soul
- 或 `sudo apt install kwalletmanager`（KDE）

### Q9：恢复后 SQLite 显示「database disk image is malformed」

- 罕见：恢复过程被中断（强制 kill 进程 / 断电）
- 兜底：进入 `userData/sync-pre-restore/<最新 id>/local-pre-restore.zip` → 解压 `snapshot/xiaodu-snapshot.db` → 改名 `xiaodu.db` 替换 `userData/xiaodu.db` → 启动
- 也可以从远端选**前一份**备份重新恢复（`listRemoteBackups()` 默认按时间倒序）

### Q10：怎么修改 device_id？

- 默认每台设备首次启动 SyncManager 时自动生成 UUIDv4 写入 `settings.device_id`
- 用途：备份文件名 + manifest.deviceId 区分不同设备
- 手动改：`sqlite3 userData/xiaodu.db "UPDATE settings SET value='my-laptop' WHERE key='device_id';"` 后重启
- 注意：改完之后旧设备视角下你被认为「换了一台新设备」，不会自动清理旧名字下的远端备份

### Q11：怎么校验远端 zip 是否被篡改？

- 每个 zip 内 `manifest.json` 列出每个 entry 的 size + sha256
- `extractSnapshot()` 在解压时逐文件重算 sha256 并与 manifest 比对，不匹配即抛错
- 上层用户可手动 `unzip -p soul-backup-xxx.zip manifest.json | jq` 查看完整清单（`shasum -a 256` 自行复算单文件 sha 也能验证）
- 如果发现校验失败，最直接的处理是从远端列表选**前一份**备份重新恢复

### Q12：远端目录被清空了怎么办？

- Soul 不会主动删除远端**目录本身**；retentionCount 只删多余的 `soul-backup-*.zip`
- 如果你在 WebDAV 控制台手工删了目录，下次 `backupNow()` 调用 `ensureBasePath()` 会自动重建
- 但**之前的备份历史无法找回**；这就是为什么强烈建议保留 ≥ 7 份且开 daily 自动同步

---

## 十一、不做项（与 §4.14 决策对齐）

本期**明确不做**以下事项：

| 不做项 | 原因 |
|--------|------|
| ❌ 端到端加密（E2EE） | MVP 仅信任 HTTPS + safeStorage 本地加密；E2EE 涉及密钥派生/恢复词等独立设计 |
| ❌ 双向 merge | 无法在 SQLite 行级别自动 merge，会引入用户难以预测的覆盖结果 |
| ❌ 大文件切分上传 | 500 MB 阈值已能覆盖绝大多数知识库 |
| ❌ `attachments/` 与 `_index/` 同步 | 体积过大、可重建；优先保证「分身骨架 + 会话 + 知识源」迁移成功 |
| ❌ 应用启动时 / 退出时强制同步 | 启动慢 / 关闭慢都会损害用户体验 |
| ❌ `fs.watch` 实时同步 | 远端 API 限速 + 高峰时段冲突，远不如 cron 稳定 |
| ❌ 多账号 / 多 WebDAV | 单账号简化心智；多账号请用 Soul 多 profile（`SOUL_USER_DATA` 环境变量） |

---

## 十二、修订记录

| 日期 | 版本 | 内容 | 作者 |
|------|------|------|------|
| 2026-05-09 | v1.0 | 初版（指挥官-W19-#16 落盘）— 5 步上手 / 4 个 WebDAV 平台示例 / 自动间隔 / 跨设备恢复 / 安全模型 / 坚果云专项 / 10 条 FAQ / 不做项决策 | zhi.qu |
