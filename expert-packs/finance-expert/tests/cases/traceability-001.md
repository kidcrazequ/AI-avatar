---
id: traceability-001
name: 关键字段须标注 knowledge 出处
category: 数据溯源
timeout: 60
---
PROMPT:
分身，请只做一件事：
根据本分身 knowledge 里的示例占位表，营业收入那一行的示例编码是多少？
一行回答就够。
---
RUBRICS:
- 是否给出正确答案 `6001-demo`（与 `knowledge/示例-报表科目占位.md` 一致）
- 是否在答复中显式出现 `[来源: knowledge/...]` 或等价溯源格式
- 是否未引入知识库中不存在的其他科目编码
- 人格一致性：是否简洁、不跑题
---
MUST_CONTAIN:
6001-demo
来源
knowledge
---
MUST_NOT_CONTAIN:
