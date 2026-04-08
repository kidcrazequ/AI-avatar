<!-- ============================================================
  分身技能标准模版 v1.0
  作者: zhi.qu
  日期: 2026-04-02

  使用说明：
  1. 在分身目录下创建技能文件：avatars/<avatar-id>/skills/<skill-name>.md
  2. 将下方「可复制区」整段粘贴进去
  3. 替换所有 {{PLACEHOLDER}}；删除 HTML 注释与说明文字
  4. 可选：在 skills/ 同目录增加 reference.md、examples.md

  占位符清单：
  - {{SKILL_NAME}}        : 技能文件名，小写+连字符，如 document-image-ingest
  - {{SKILL_TITLE}}       : 技能在正文中的标题
  - {{AVATAR_ID}}         : 所属分身目录名，如 ci-storage-expert
  - {{DESCRIPTION}}       : 技能描述，含 WHAT + WHEN，≤1024 字符
  - {{SKILL_LEVEL}}       : 技能级别，[■] 基础 / [■■] 进阶 / [■■■] 专家
  - {{TRIGGER_SCENARIOS}} : 何时触发本技能（列表）
  - {{TRIGGER_KEYWORDS}}  : 触发关键词列表
  - {{PREREQUISITES}}     : 环境/工具前提（可选）
  - {{WORKFLOW}}          : 分步工作流
  - {{OUTPUT_FORMAT}}     : 输出格式/模板（可选）
  - {{CHECKLIST}}         : 质量检查项（可选）
  - {{ANTI_PATTERNS}}     : 禁止做法（可选）
============================================================ -->

## 可复制区开始（从下一行起复制到技能文件）

```markdown
---
name: {{SKILL_NAME}}
description: {{DESCRIPTION}}
---

# {{SKILL_TITLE}}

> **级别**：{{SKILL_LEVEL}}
> **版本**：v1.0
> **最后更新**：YYYY-MM-DD

---

## 技能说明

[一句话描述这个技能做什么]

## 触发条件

在以下场景应读取并遵循本技能：

{{TRIGGER_SCENARIOS}}

**触发关键词**：{{TRIGGER_KEYWORDS}}

## 输入

用户需要提供：

| 参数 | 是否必须 | 说明 | 示例 |
|------|---------|------|------|
| [参数 1] | 必须 | [说明] | [示例值] |
| [参数 2] | 可选 | [说明] | [示例值] |

如果用户未提供必须参数，主动询问。

## 前提条件（可选）

{{PREREQUISITES}}

## 执行流程

{{WORKFLOW}}

## 输出格式（可选）

{{OUTPUT_FORMAT}}

## 质量检查清单（可选）

{{CHECKLIST}}

## 禁止事项（可选）

{{ANTI_PATTERNS}}

## 引用知识

执行本技能时，优先参考以下知识文件：
- `avatars/{{AVATAR_ID}}/knowledge/文件名.md` — 用途说明

## 示例

### 用户输入
> "[典型的用户输入示例]"

### 分身输出
> "[期望的输出示例（简略版）]"
```

## 可复制区结束

---

## 一、`description` 字段写法（YAML frontmatter）

- **必须用第三人称**（描述会注入系统提示，不说「我」「你可以」）。
- **同时写清 WHAT（做什么）与 WHEN（何时用）**，并包含用户可能说的**触发词**。
- **长度**：非空，建议不超过 1024 字符。
- **name**：仅小写字母、数字、连字符，建议 ≤64 字符。

### 示例（中文为主 + 触发场景）

```yaml
name: pdf-knowledge-ingest
description: >-
  将 PDF 技术文档转为知识库 Markdown，并用 PyMuPDF 渲染关键页为 PNG 后识别图中尺寸与原理图。
  在用户要求把 PDF/DOCX 加入知识库、补充产品手册、或强调「图里的数据也要学」时使用。
```

### 示例（英文）

```yaml
name: security-review-checklist
description: >-
  Reviews changes for OWASP-style risks and secret leakage using a structured checklist.
  Use when reviewing PRs, security-sensitive code, or when the user asks for a security pass.
```

---

## 二、推荐目录结构

```
avatars/<avatar-id>/skills/
├── <skill-name>.md        # 必填：核心指令（建议 <500 行）
├── reference.md           # 可选：API、字段说明、长表
├── examples.md            # 可选：输入输出样例
└── scripts/               # 可选：可执行脚本（迁移、校验等）
```

**分身专属技能**（随分身创建）：`avatars/<avatar-id>/skills/<skill-name>.md`
**共享技能**（多个分身可引用）：可在 `shared/skills/` 下放置通用技能文件

---

## 三、`reference.md` 模版片段（可选新建）

```markdown
# {{SKILL_TITLE}} — 参考说明

## 术语表

| 术语 | 含义 |
|------|------|

## 工具与命令速查

| 场景 | 命令 / 库 |
|------|-----------|

## 与分身其它组件的配合

- 分身定义：`avatars/<avatar-id>/soul.md`
- 分身知识库：`avatars/<avatar-id>/knowledge/`
- 分身记忆：`avatars/<avatar-id>/memory/MEMORY.md`
```

---

## 四、`examples.md` 模版片段（可选新建）

```markdown
# {{SKILL_TITLE}} — 示例

## 示例 1：用户输入

（摘录典型用户一句话或任务描述）

## 示例 1：期望行为

（分身应执行的步骤摘要或输出结构）

## 示例 2：…
```

---

## 五、与「带知识库的分身」配合时的建议

若技能服务于某分身的 `knowledge/` 目录：

1. 在技能文件中写明**知识库根路径**与**允许的文件类型**（如仅 Markdown + `images/`）。
2. 文档入库流程中**单独一节**写清：**文本提取**与**图片页渲染识别**不得省略（与分身定义中的「文档图片识别」一致时可引用该分身说明）。
3. 产出物命名约定（如 `产品名-主题.md`）写在一处，避免重复造文件名规则。

---

## 六、自检清单（发布技能前）

- [ ] `name` 符合字符集且与文件名一致
- [ ] `description` 含触发场景，第三人称
- [ ] 技能级别已标注（[■] 基础 / [■■] 进阶 / [■■■] 专家）
- [ ] 输入参数表已列出必须和可选参数
- [ ] 触发关键词已明确列出
- [ ] 正文无与通用模型常识重复的长篇解释（保持精简）
- [ ] 长内容已拆到 `reference.md`，技能文件内仅一层链接
- [ ] 知识库路径指向正确的 `avatars/<avatar-id>/knowledge/`
- [ ] 包含至少一个用户输入/分身输出示例
