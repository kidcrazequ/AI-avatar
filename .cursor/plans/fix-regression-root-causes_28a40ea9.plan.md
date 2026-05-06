---
name: fix-regression-root-causes
overview: 修复小堵回归中工具未触发、图表技能未前置、query_excel 被过早限流、题库缓存不一致和章节断言漂移等根因。目标是让回归失败从“提示词不稳定”转为代码层可控、可复现、可验证。
todos:
  - id: fix-query-excel-budget
    content: 修复 query_excel 过早限流，允许 schema 后继续取行级数据
    status: completed
  - id: force-chart-skill
    content: 图表题代码层强制前置 load_skill 并保留 chart 输出约束
    status: completed
  - id: handle-dsml-leak
    content: 拦截最终答案中的 DSML 伪工具调用泄漏
    status: completed
  - id: snapshot-question-bank
    content: 运行时保存当次题库快照并避免缓存旧题库
    status: completed
  - id: fix-generator-anchors
    content: 修复 L5 脏值过滤与 L6/L7 章节锚定生成
    status: completed
  - id: add-focused-tests
    content: 补充相关单测并执行小范围验证
    status: pending
isProject: false
---

# 修复回归根因计划

## 范围

本次修复会涉及多个源代码文件，按任务拆分规则先确认计划，再逐步执行。核心问题集中在：工具调用链路、回归运行器题库快照、Excel 查询限流、图表技能强制调用、章节题生成/断言。

关键文件：
- [desktop-app/src/stores/chatStore.ts](/Users/cnlm007398/AI/soul/desktop-app/src/stores/chatStore.ts)
- [desktop-app/src/services/llm-service.ts](/Users/cnlm007398/AI/soul/desktop-app/src/services/llm-service.ts)
- [desktop-app/src/services/batch-regression-runner.ts](/Users/cnlm007398/AI/soul/desktop-app/src/services/batch-regression-runner.ts)
- [desktop-app/src/components/BatchRegressionPanel.tsx](/Users/cnlm007398/AI/soul/desktop-app/src/components/BatchRegressionPanel.tsx)
- [desktop-app/electron/main.ts](/Users/cnlm007398/AI/soul/desktop-app/electron/main.ts)
- [desktop-app/electron/kb-question-generator.ts](/Users/cnlm007398/AI/soul/desktop-app/electron/kb-question-generator.ts)
- [desktop-app/src/services/batch-regression-runner.test.ts](/Users/cnlm007398/AI/soul/desktop-app/src/services/batch-regression-runner.test.ts)

## 子任务列表

- 子任务 1：修复 `query_excel` 过早限流
  - 文件：`desktop-app/src/stores/chatStore.ts`
  - 做法：把全局 1 次上限改为按场景允许多步查询，至少支持 schema → rows → fallback；避免 L1/L3/L4 在第一轮 schema 后被迫收敛。
  - 风险：过度放开会拖慢回归，所以保留总轮次和缓存保护。

- 子任务 2：修复图表题 `load_skill` 未前置
  - 文件：`desktop-app/src/stores/chatStore.ts`
  - 做法：对命中图表关键词的请求，在工具链路层注入或强制执行一次 `load_skill('chart-from-knowledge')`，并确保最终仍要求 ` ```chart `。
  - 风险：要避免普通非图表问答误触发。

- 子任务 3：拦截 DSML 文本工具调用泄漏
  - 文件：`desktop-app/src/services/llm-service.ts` 或 `desktop-app/src/stores/chatStore.ts`
  - 做法：检测最终答案中出现 `<｜｜DSML｜｜tool_calls>` 这类伪工具调用文本时，不把它当最终答案直接结束；优先转为真实工具调用或返回一次“请使用 function calling”纠偏轮。
  - 风险：不同模型的伪工具格式可能不完全一致，先覆盖报告中已出现的格式。

- 子任务 4：修复回归题库缓存与运行快照
  - 文件：`desktop-app/src/components/BatchRegressionPanel.tsx`、`desktop-app/electron/main.ts`、必要时 `batch-regression-runner.ts`
  - 做法：运行前强制使用最新加载的题库，保存当次题库快照到 `tests/runs/<runId>/question-bank.json`，报告里记录 bank 来源，避免报告和当前 `question-bank.json` 对不上。
  - 风险：会改变 run 目录结构，需要兼容历史报告列表。

- 子任务 5：修复 L5/L6/L7 题目生成与章节锚定
  - 文件：`desktop-app/electron/kb-question-generator.ts`
  - 做法：继续过滤脏 BOM 值；对重复章节生成稳定章节名，例如 `数据表格 (3)`；章节切片必须读到下一个同级标题，避免 `表 4-5` 下的后续子试验 `%` 漏掉。
  - 风险：题库再生成后旧报告不可直接横比，但会更符合真实知识检索。

- 子任务 6：补测试并小范围验证
  - 文件：`desktop-app/src/services/batch-regression-runner.test.ts`、相关已有测试文件
  - 做法：增加单元测试覆盖：多次 `query_excel` 允许、图表题必须出现 `load_skill`、题库快照保存、DSML 泄漏拦截、L5 脏值过滤。
  - 验证：先跑相关单测；如通过，再建议只跑失败类别的小批量回归（L1/L2/L3/L4/L5/L6/L7），不直接全量 30 题浪费时间。

## 执行顺序

1. 子任务 1 → 子任务 2 → 子任务 3：先修工具执行链路，因为这是 L1/L2/L3/L4 的共同根因。
2. 子任务 4：再修回归运行可信度，确保下一份报告能追溯当次题库。
3. 子任务 5：修题库和章节断言，解决 L5/L6/L7 的漂移问题。
4. 子任务 6：补测试并验证。

## 风险提示

- 这不是单文件小改，预计至少改 5 个源代码文件，必须分步执行。
- 当前工作区已有大量未提交改动，我会只改本计划涉及文件，不回滚用户已有变更。
- `avatar.png` 当前显示为删除状态，这和本修复无关，不会处理。

确认后我将从子任务 1 开始执行，每完成一个子任务汇报结果，再等你确认继续。