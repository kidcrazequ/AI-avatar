# Avatar 内 Project（二级分区）约定

每个分身可在 **Avatar** 下划分多个 **Project**，用于隔离工作区与项目级知识，与会话绑定。

## 目录

| 路径 | 用途 |
|------|------|
| `avatars/<avatarId>/workspaces/<projectId>/<conversationId>/` | 会话工作区（工具 `read_file` / `write_file` 等） |
| `avatars/<avatarId>/projects/<projectId>/knowledge/` | 项目知识（与根目录 `knowledge/` 合并进 system prompt 与 RAG） |

- `projectId` 建议使用字母、数字、下划线、连字符。
- 未指定或历史数据使用 **`default`** 分区。
- 若历史上曾使用扁平路径 `workspaces/<conversationId>/`（无 `default` 前缀），应用在 `projectId === default` 时仍会优先解析到该目录。

## 桌面端

- 左侧栏 **Project** 下拉框切换当前项目；**新建对话**会写入当前 `project_id`。
- 切换项目后会重新 `loadAvatar`，将 `projects/<projectId>/knowledge` 中的 Markdown 与全局知识合并注入。
