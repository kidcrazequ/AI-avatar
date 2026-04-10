# Soul · AI 分身

本地运行的 AI 专家分身：每个人格自带知识库、技能与记忆，对话可走 RAG 与工具调用，数据留在你的电脑上。

![桌面端主界面](docs/images/desktop-app.png)

## 桌面应用

基于 **Electron + React + TypeScript**，当前版本见 [`desktop-app/package.json`](desktop-app/package.json) 与 [`CHANGELOG.md`](CHANGELOG.md)。

```bash
cd desktop-app
npm install
npm run dev
```

生产构建与安装包：`npm run build`，再按需执行 `npm run dist:mac` / `npm run dist:win`（需已配置 [`electron-builder`](desktop-app/electron-builder.yml) 环境）。

## 仓库结构

| 路径 | 说明 |
|------|------|
| `desktop-app/` | 桌面客户端 |
| `packages/core/` | 核心逻辑（SoulLoader、知识检索、Wiki、Avatar 等） |
| `templates/` | 新建分身模板 |
| `shared/knowledge/` | 共享知识 |
| `avatars/` | 各分身目录（应用内创建的分身数据在用户数据目录，安装包不预置分身） |

## 更新记录

详见 [CHANGELOG.md](CHANGELOG.md)。
