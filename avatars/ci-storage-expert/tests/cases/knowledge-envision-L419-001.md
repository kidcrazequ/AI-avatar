

```markdown
---
id: knowledge-L419-001
name: PCS核心参数验证
category: 知识验证
timeout: 120
---
PROMPT:
远景能源 ENS-L419 的 PCS 储能变流器的额定功率是多少？最大效率是多少？防护等级是什么？
---
RUBRICS:
- 是否准确回答额定功率为 215kW
- 是否准确回答最大效率 >99%
- 是否准确回答防护等级为 IP66
- 是否提及三电平拓扑技术特点
- 是否标注数据来源
- 是否保持人格一致性
---
MUST_CONTAIN:
215kW
>99%
IP66
---
MUST_NOT_CONTAIN:
150kW
>98.8%

