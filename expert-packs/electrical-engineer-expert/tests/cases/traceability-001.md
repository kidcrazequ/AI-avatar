---
id: traceability-001
name: 占位符号表须带出 knowledge 出处
category: 数据溯源
timeout: 60
---
PROMPT:
根据本分身 knowledge 占位表，三相异步电动机示意图的占位编码是哪个？一行回答。
---
RUBRICS:
- 是否给出正确答案 `M3-DEMO-IEC`
- 是否出现 `[来源: knowledge/...]` 或等价溯源
- 是否不引入占位表外的编码
---
MUST_CONTAIN:
M3-DEMO-IEC
来源
knowledge
---
MUST_NOT_CONTAIN:
