# 方案：借鉴 StaffDeck 的四个选定点

> 状态：待确认（2026-07-20 起草）。来源调研：OpenBMB/StaffDeck（AGPL-3.0，**只借思路与形态，不拷代码**）。
> 选定范围：架构点 1（状态机技能图）、架构点 3（概念卡导航索引）、页面点 2（分身工作台账）、页面点 3（补缺页面）。

## 范围裁剪说明（先看）

- 页面点 3 原含 **Distill 页**，但其后端（对话蒸馏技能，即架构点 2）未入选——**本方案搁置 Distill 页**。若要它，需把架构点 2 一并加回。
- 页面点 2 的"定时任务 tab"与页面点 3 的"定时任务页"合并为一个工作流（W3），避免重复建设。

## 工作流总览（按建议执行顺序）

| # | 工作流 | 对应选点 | 规模 | 依赖 |
|---|---|---|---|---|
| W1 | Traces 调试页 | 页面 3 | 中 | 无（埋点/RouteLog 已存在） |
| W2 | Dashboard 工作台账页 | 页面 2 | 中 | 工作记录 tab 依赖 W1 数据 |
| W3 | 定时任务（调度器 + 页面 + 草稿卡） | 页面 2+3 | 大 | W2 提供挂载 tab |
| W4 | 概念卡导航索引 | 架构 3 | 大 | 无 |
| W5 | SOP 状态机技能层 | 架构 1 | 超大 | 无（放最后，成本最高） |

顺序理由：W1/W2 数据现成、见效最快；W3 引入新常驻能力；W4/W5 动 packages/core 主链路，风险最高，放后。

---

## W1 Traces 调试页

**目标**：把已有的发送链路埋点、`RouteLog`（skill-router 路由决策日志）、工具调用事件在 UI 里可视化——分身"怎么得出这个答案"可查。

- [ ] W1.1 trace 事件聚合：主进程/渲染层把发送链路埋点 + RouteLog + 工具事件按 conversationId/turnId 归集为统一 TraceEvent 结构 → `packages/core/src/trace-log.ts`（新，约 120 行）
- [ ] W1.2 TracesPanel 组件：按会话轮次分组的可折叠明细（借鉴 StaffDeck ExecutionRecord 的摘要行 + 类型化图标 + running/failed 态）→ `desktop-app/src/components/TracesPanel.tsx`（新，约 250 行）
- [ ] W1.3 App 挂载：`activePanel` 增加 `'traces'` + 侧栏入口 → `desktop-app/src/App.tsx`（约 10 行）
- [ ] W1.4 测试：trace 聚合单测（事件乱序/缺 turnId 容错）

**风险**：埋点是排障资产（记忆：勿删），W1.1 只读不改埋点本身。

## W2 Dashboard 工作台账页

**目标**：把分身当"员工"看的台账视图。v1 四 tab：记忆 / 会话日志 / 定时任务（W3 落地前显示引导占位——注意：是功能未开启的引导，不是数据占位）/ 工作记录。

- [ ] W2.1 DashboardPanel 骨架 + tab 切换 → `desktop-app/src/components/DashboardPanel.tsx`（新，约 200 行）
- [ ] W2.2 记忆 tab：读取 `avatars/<id>/memory/` 文件列表 + MEMORY.md 渲染，支持跳转编辑（复用 KnowledgePanel 的文件读写 IPC）
- [ ] W2.3 会话日志 tab：主进程 DB 会话列表 + 消息数/时间/模式，点击回跳会话
- [ ] W2.4 工作记录 tab：基于 W1 的 TraceEvent 聚合统计（本周会话数、工具调用 top、失败次数）——**依赖 W1**
- [ ] W2.5 App 挂载 `activePanel: 'dashboard'` + 侧栏入口
- [ ] W2.6 测试：聚合统计单测

**待拍板**：工作记录 tab v1 就用"统计摘要"这个定义是否 OK（StaffDeck 的 WorkRecord 更像任务台账，Soul 无任务系统，强行对齐会引入占位概念）。

## W3 定时任务

**目标**：分身可配置定时任务；触发时后台跑一轮会话，产出以**草稿卡片**进入聊天等用户处理（借鉴 ScheduledDraftCard 形态，契合"宁拒答不占位"——产物是待确认草稿，不是自动执行）。

- [ ] W3.1 调度器：Electron 主进程，任务持久化（DB/JSON）+ 应用启动恢复 + 到点触发 → `desktop-app/electron/scheduled-tasks.ts`（新，约 200 行）
- [ ] W3.2 触发执行：复用现有发送链路以目标分身跑一轮（后台会话，ask 模式禁写工具）
- [ ] W3.3 草稿卡：结果写入该分身主会话为 draft 消息类型，UI 渲染卡片（采纳/丢弃）→ chatStore + MessageBubble 各约 60 行
- [ ] W3.4 任务编辑 UI：Dashboard 定时任务 tab 内联表单（名称/分身/提示词/cron 简化为 每天|每周|间隔）
- [ ] W3.5 测试：调度恢复、到点触发、draft 落库

**风险**：仅应用运行时触发（Electron 不常驻则不跑）——v1 在 UI 明示此限制，不做系统级常驻。

## W4 概念卡导航索引（架构 3）

**目标**："先定位、再钻取"。知识摄取时编译分层概念卡（文档卡 → 章节卡），分身像翻目录一样导航，引用落到章节粒度（直接服务溯源纪律）。

- [ ] W4.1 卡片 schema + 编译器：从 knowledge/*.md 生成 `knowledge/_cards/`（文档卡含摘要/章节清单/关键词 frontmatter；章节卡含标题路径 + 行号区间）→ 扩展 `packages/core/src/wiki-compiler.ts` 或新建 `knowledge-cards.ts`（约 250 行，实施时读 wiki-compiler 再定）
- [ ] W4.2 `knowledge_navigate` 工具：tool-router 新工具，两级调用（列文档卡 → 列该文档章节卡），返回带 `文件路径#行区间` 的定位 → `tool-router.ts`（约 120 行）
- [ ] W4.3 grep-first 分身接入：小凯这类大库在 search_knowledge 引导语中优先推荐 navigate；BM25 小库不变（双轨，不融合，避免混平）
- [ ] W4.4 批量构建脚本：小凯 ~1679 文件离线编译（复用 scripts/*.py 批处理模式，含断点续跑）
- [ ] W4.5 KnowledgePanel 顺带展示文档卡（可选，若超 10 行 UI 改动则拆出）
- [ ] W4.6 测试：编译器（无标题文件/超大文件/中文标题锚点）、navigate 工具三态

**风险**：大库编译耗时与增量更新（mtime 失效重编该文件即可）；`_cards/` 目录需加入 BM25 排除清单防止自噬。

## W5 SOP 状态机技能层（架构 1）

**目标**：流程型技能从散文升级为可校验的状态机图，保证多步骤 SOP 执行不走样。**双轨兼容**：无 `sop.yaml` 的技能完全走现有链路。

- [ ] W5.1 SopCard schema：nodes（instruction/期望槽位/可用工具域）+ edges（条件/优先级）+ start/terminal + 中断策略，zod 校验（起终点存在、无悬空边、node_id 唯一）→ `packages/core/src/sop-schema.ts`（新，约 150 行）
- [ ] W5.2 SopRunner：会话级状态（当前节点/已填槽位），每轮组装"当前节点指令 + 已收集信息 + 转移条件"注入 prompt，回合结束判定转移 → `packages/core/src/sop-runner.ts`(新，约 250 行)
- [ ] W5.3 路由集成：skill-router 选中技能后检测 `skills/<name>/sop.yaml` → 进入 SOP 模式；RouteLog 记录节点轨迹（喂给 W1 Traces）
- [ ] W5.4 状态持久化：会话记录中保存 sop 状态（中途关 app 可恢复）
- [ ] W5.5 试点技能：选一个分身流程写 sop.yaml 验证（**待拍板**：建议小堵「收益测算」）
- [ ] W5.6 测试：schema 校验反例、转移判定、中断恢复；试点技能走查用例

**风险**：转移判定 v1 用 LLM 自报 + 槽位齐备校验兜底，不引入独立判定模型；可视化编辑器**不做**（YAML 手写 + 校验报错足够，做编辑器违反简单优先）。

---

## 统一约束

- 全程不拷 StaffDeck 代码（AGPL 传染）；schema 字段命名也重新设计
- 每个工作流内部仍按"每子任务只加载所需文件、完成即 commit"节奏
- W4/W5 动 packages/core：先读后写，改动处保持现有中文注释风格

## 待拍板汇总

1. 执行顺序确认：wigolo 方案（已就绪）与本方案谁先启动；本方案内部 W1→W5 顺序是否认可
2. W2 工作记录 tab 的 v1 定义（统计摘要）
3. W5 试点技能选小堵「收益测算」还是别的
4. Distill 页确认搁置（或加回架构点 2）
