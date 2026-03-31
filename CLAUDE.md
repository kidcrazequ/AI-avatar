# AI 分身项目 (Soul)

这是一个 AI 分身管理项目。每个分身是一个独立的 AI 专家，拥有自己的灵魂（人格）、知识包和技能树。

## 项目结构

```
soul/
├── templates/          ← 模板（给工种专家创建新分身用）
├── shared/knowledge/   ← 共享知识（所有分身可引用）
└── avatars/            ← 分身目录（每个子目录 = 一个分身）
```

## 如何使用分身

进入分身目录，启动 Claude：

```bash
cd ~/AI/soul/avatars/ci-storage-expert
claude
```

Claude 会自动加载该分身的 CLAUDE.md → soul.md → knowledge/ → memory/，以该分身的身份与你交互。

## 如何创建新分身

1. 在 `avatars/` 下创建新目录
2. 参照 `templates/soul-template.md` 编写 soul.md（建议由该工种资深工程师撰写，参考 `templates/soul-guide.md`）
3. 在 `knowledge/` 中放入专业知识文件
4. 在 `skills/` 中定义技能（参考 `templates/skill-template.md`）
5. 创建 `memory/MEMORY.md` 空文件
6. 编写 CLAUDE.md 入口文件（参考已有分身）

## 当前可用分身

| 分身 | 目录 | 说明 |
|------|------|------|
| 工商储产品解决方案专家「小堵」 | `avatars/ci-storage-expert/` | 工商业储能方案设计、收益测算、政策解读 |
