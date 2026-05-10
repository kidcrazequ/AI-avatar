# Avatar 内 Project（二级分区）目录约定

- **会话与工作区**：磁盘路径为 `avatars/<avatarId>/workspaces/<projectId>/<conversationId>/`。历史安装若仍为扁平路径 `workspaces/<conversationId>/`，在 `projectId === default` 时会自动继续使用该目录。
- **项目独占知识**：可选目录 `avatars/<avatarId>/projects/<projectId>/knowledge/`（结构与分身根目录 `knowledge/` 相同）。会与分身全局知识**合并检索**；`rag_only` / `source:` 等与根目录规则一致。
- **默认分区**：未指定或老数据会话的 `project_id` 为字面量 **`default`**（SQLite 列默认）。
