# cangjie-skill / Headroom 借鉴与实现说明

## 目标与边界

本次只吸收可验证的方法，不引入两个项目本体或新增运行时依赖。

- cangjie-skill：借鉴整书理解、独立候选提取、三重校验、RIA++、关系图、审计轨迹和断点恢复。
- 明确排除：`SKILL.md` 生成、一键安装、Skill 发布、Darwin 测试与自动进化。
- Headroom：借鉴 ContentRouter、可恢复引用、live-zone、fail-open、稳定前缀、指标和检索反馈。
- 明确排除：代理服务、MCP、Python/ML/ONNX 依赖、代码压缩和自动修改生产策略。

参考：

- cangjie-skill：`/Users/kian/.agents/skills/cangjie-skill/`
- Headroom：https://github.com/headroomlabs-ai/headroom
- Headroom CCR：https://headroom-docs.vercel.app/docs/ccr
- Headroom 限制：https://headroom-docs.vercel.app/docs/limitations

## 深度知识提炼

入口仍是知识库面板的 `DEEP`，用户选择文档、深度和类型后一次运行完成：

1. 逐章提炼，并保留原文件与页码锚点。
2. Adler 整书理解：结构、解释、批判、应用。
3. 框架、原则、案例、反例、术语五视角独立提取候选。
4. 对每个候选执行 V1 跨上下文支持、V2 新问题应用力、V3 独特性校验。
5. 验证通过项构造成 R/I/A1/A2/E/B 完整知识单元。
6. 建立 depends-on、contrasts-with、composes-with 关系图。
7. 生成兼容原消费面的术语表、模式与决策、速查表和索引。

新增审计产物包括：

- `00-整书理解.md`
- `候选池/{框架,原则,案例,反例,术语}.md`
- `三重校验.md`、`验证通过.md`、`淘汰记录.md`
- `知识单元.md`、`关系图.md`
- `PIPELINE_STATE.md`

书级产物与章节笔记都参与断点探测。纯续跑会读取已有内容供下游使用，不重复支付模型调用。

## 安全可恢复上下文

工具结果按“直通 / 无损 / 可恢复”路由：

- 直通：源码、diff、知识检索证据、Excel 查询、错误结果、密集数值序列。
- 无损：均匀标量 JSON 数组可重排为 CSV；字段和值全部保留。
- 可恢复：其他大结果只有在存在真实 `read_tool_result` 引用时才允许统计压缩或首尾缩减。

超过 6000 字符的成功工具结果先保存到：

`tool-results/<conversationId>/<toolName>-<sha256>.txt`

模型只看到 `tool-result:<toolName>:<sha256>`，不会看到用户目录绝对路径。相同会话、工具和内容自动去重；引用不能跨会话读取；旧版绝对路径继续兼容。

`read_tool_result` 是统一入口：

- `ref`：读取新的哈希 spool。
- `call_id`：读取 web/lazy 正文。
- `path`：只兼容旧会话。

落盘失败、压缩失败或压缩膨胀时均原样返回。历史条数裁剪、旧助手回答缩减和主动摘要都带 `session_search(mode="view")` 恢复指引。

每次原文取回会追加审计事件，并在会话 spool 目录更新 `RETRIEVAL_FEEDBACK.md`；同一工具高频取回时给出“保持直通或提高可见预算”的建议，但不会自动修改生产策略。

## 可测试性与验收

自动化覆盖：

- 知识质量链全部产物、三重验证硬门槛、淘汰审计、超长书输入上限、取消和纯续跑零重复调用。
- ContentRouter 对代码/RAG/密集数值的逐字直通。
- 无引用禁止有损压缩、有引用可往返取回。
- 哈希去重、会话隔离、TTL 清理、读取字节/行数上限和落盘失败 fail-open。
- 上下文摘要工具调用配对、负收益回退和历史恢复提示。
- 压缩开/关 A/B 对照中的数字、来源锚点和受保护内容逐字一致。

上线验收命令：

```bash
cd packages/core && npm run build && npm test
cd desktop-app && npm run typecheck && npm run test:qa-gate && npm run build
git diff --check
```
