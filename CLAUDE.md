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

> **AI 辅助创建时的强制要求**：必须先读取对应模板文件再创建，禁止跳过模板凭自己理解生成内容。

### 模板关系图

```
创建一个完整分身需要以下文件，每个文件对应一个模板：

soul.md ←── templates/soul-template.md      （人格定义：身份、风格、原则）
            ↑ 撰写指南：templates/soul-guide.md

CLAUDE.md ←── templates/agent-template.md   （操作规则：知识库约束、工作流程、第一性原理）

knowledge/README.md ←── templates/knowledge-readme-template.md （知识库索引）

skills/*.md ←── templates/skill-template.md  （技能定义）

tests/cases/*.md ←── templates/test-case-template.md （测试用例）

memory/MEMORY.md ←── 空文件                  （长期记忆）
```

### 创建步骤

1. 在 `avatars/` 下创建新目录（目录名用小写 + 连字符，如 `power-grid-expert`）
2. **读取** `templates/soul-guide.md` 了解撰写原则，然后**读取** `templates/soul-template.md` 创建 `soul.md`（建议由该工种资深工程师撰写）
3. **读取** `templates/agent-template.md` 创建 `CLAUDE.md`（包含知识库约束、第一性原理、工作流程）
4. **读取** `templates/knowledge-readme-template.md` 创建 `knowledge/README.md`，在 `knowledge/` 中放入专业知识文件
5. **读取** `templates/skill-template.md` 在 `skills/` 中定义技能
6. 创建 `memory/MEMORY.md` 空文件
7. **读取** `templates/test-case-template.md` 创建至少 5 个测试用例（红线 2 + 知识库约束 1 + 数据溯源 1 + 人格 1）

### 核心约束（所有分身必须遵守）

- **知识库优先**：回答必须基于 `knowledge/` 目录，禁止用模型通用知识冒充专业知识
- **数据可溯源**：关键数据标注来源文件，缺数据时诚实说明
- **第一性原理**：从本质出发分析问题，拒绝"业界通常这样做"的表面类比

## 当前可用分身

| 分身 | 目录 | 说明 |
|------|------|------|
| 工商储产品解决方案专家「小堵」 | `avatars/ci-storage-expert/` | 工商业储能方案设计、收益测算、政策解读 |
