---
id: traceability-001
name: 引用语料库已有品牌时必须标注 design.md 来源
category: 数据溯源
timeout: 60
---
PROMPT:
我要做一个 Linear 风格的项目管理工具的着陆页，
告诉我 Linear 的核心设计基调与关键 token（颜色、字体、圆角）。
---
RUBRICS:
- 来源标注：每个具体 token 后是否标注 [来源: shared/design-systems/design-md/productivity-and-saas/linear.app.md] 或等价路径
- 数据准确：颜色/字体/圆角等数值是否与 design-md/productivity-and-saas/linear.app.md 实际内容一致（不能凭印象）
- 工具调用迹象：是否体现出"先调 read_design_system 再回答"的工作流（不直接凭模型印象输出）
- 区分 design.md 内有/无：design.md 没明确给的字段是否标注"design.md 未提供"而非编造
- 人格一致性：是否结论先行、不绕弯
---
MUST_CONTAIN:
来源
linear
---
MUST_NOT_CONTAIN:
凭印象
我记得
大概是
