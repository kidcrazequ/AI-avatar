# Palace 记忆宫殿指南

> 更新日期：2026-06-17  
> 适用范围：`packages/core/src/palace/`、桌面端 Palace 面板、ToolRouter Palace 工具、`scripts/backfill-palace.ts`

## 一句话定义

Palace 记忆宫殿不是“多一个知识库”，而是分身的职业处境路由层：让分身在任务开始前想起该看哪些材料、按什么顺序看、哪些坑不能踩、哪些承诺要追踪、任务结束后哪些经验要先进入待确认沉淀。

## 为什么叫“记忆宫殿”

传统记忆宫殿的核心不是“储存更多文字”，而是把记忆放在可导航的位置上，需要时沿路线取回。Soul 里的 Palace 借这个名字，但落点更工程化：

- **宫殿**：一个分身拥有一座独立的本地文件空间，和 `knowledge/`、`skills/`、`memory/` 并列。
- **房间**：`palace/rooms/*.md` 是任务路线卡，例如“今日驾驶舱”“写汇报”“冲突沟通”。
- **路线**：路线卡告诉 Agent 触发场景、必读材料、阅读顺序、输出位置和沉淀目标。
- **活记忆**：承诺台账和 inbox 让每次任务后的事实、承诺、写法先进入可复盘状态，再由用户确认是否归档。

代码里使用英文 `Palace`，界面和文档使用中文“记忆宫殿”。这个命名的关键边界是：它存的是“什么时候该想起什么”，不是“事实全文”。

## 与现有层的边界

| 层 | 存什么 | 不负责什么 |
|---|---|---|
| `knowledge/` | 专业事实、参数、原始资料、可引用依据 | 不判断任务路线 |
| `skills/` | 可复用任务方法和输出格式 | 不记录个人处境 |
| `memory/` | 长期偏好、纠偏、稳定画像 | 不塞任务过程临时发现 |
| `wiki/` | 知识百科、概念聚合、优质问答沉淀 | 不追踪承诺闭环 |
| `palace/` | 任务路线、处境上下文、承诺台账、待确认沉淀 | 不替代知识库和长期记忆 |

## 文件协议

每个分身的 Palace 位于：

```text
avatars/<avatarId>/palace/
├── manifest.json
├── profile.md
├── company.md
├── commitments.json        # 承诺台账正本（JSON）
├── commitments.md          # 自动生成的只读 Markdown 镜像
├── index.md                # 自动生成：按人物/项目/时间聚合的导航索引
├── people/
├── projects/
├── meetings/
├── reports/
├── decisions/
├── achievements/
├── wiki/
├── rooms/
│   └── <room-id>.md
└── inbox/
    ├── items.json          # inbox 正本（JSON）
    └── inbox.md            # 自动生成的只读 Markdown 镜像
```

> `commitments.md` / `inbox/inbox.md` / `index.md` 是**自动生成的只读派生文件**：JSON 仍是承诺/inbox 的唯一正本，这些 `.md` 在每次写入后由 store 重新渲染，纯为“不被锁死、任何编辑器都能打开看”服务，手改不会回写。`index.md` 在路线卡 / 承诺变更后按文件名和结构化字段重新聚合。

### manifest.json

记录协议版本、目录映射和基础文件。当前协议：

- `schemaVersion: 1`
- `protocolVersion: "2026-06-p0"`

### rooms/*.md

路线卡使用 Markdown + frontmatter。frontmatter 放结构化路由字段，正文放人类可读说明。

关键字段：

- `id` / `name` / `description`
- `triggers`：触发关键词
- `priority`：多条路线命中时的排序权重
- `requiredFiles`：执行前要读的文件
- `readOrder`：材料阅读顺序
- `conditionalReads`：条件读，每条形如「涉及 X → 重点看 Y」，按命中场景追加阅读
- `pitfalls`：需要避开的坑 / 敏感点
- `outputLocation`：推荐输出位置
- `toneGuidance`：建议口径 / 语气基调，进入任务前上下文包
- `sedimentTargets`：任务后沉淀目标

### commitments.json

承诺台账记录“我答应了谁什么”“谁欠我什么”“什么时候到期”。状态：

- `proposed`
- `open`
- `blocked`
- `done`
- `dropped`

方向：

- `i_owe_them`
- `they_owe_me`
- `mutual`
- `watch`

### inbox/items.json

任务后沉淀队列。Agent 可以把新事实、新人物、新项目、承诺、写法、路线候选先写进 inbox，等待用户接受或拒绝，避免直接污染长期记忆。

## 工具入口

ToolRouter 已支持 Palace 工具（工具名以 `packages/core/src/tool-router.ts` 实现为准）：

- `match_palace_rooms(task, top_k?)`：在 `palace/rooms/` 中匹配任务路线卡（只读）。
- `build_palace_context_card(task, room_id?, top_k?)`：命中路线后生成任务前上下文包（只读）。上下文包含条件读、对方画像（按任务命中 `people/<人>.md`）、能用素材、坑、建议口径、承诺提示和待确认沉淀。
- `write_palace_room(id, name, ...)`：创建 / 更新一张路线卡，把任务流程固化成路由。持久写入，走 `tool-permission-policy`，Plan 模式不可用，桌面端会触发用户确认。
- `list_palace_commitments` / `add_palace_commitment` / `update_palace_commitment`：承诺闭环。
- `list_palace_inbox` / `add_palace_inbox_item` / `update_palace_inbox_item`：任务后沉淀队列。

任务后沉淀由 `soul-loader` 注入的「任务后沉淀盘问（5 问）」驱动：每做完一件正经任务，按经验资产化流水线「干一件事 → 沉淀过程 → 复盘结果 → 抽象出方法」自问新事实 / 项目 / 人 / 表态 / 可复用写法，命中就 `add_palace_inbox_item` 落 pending，用户确认后才 accepted。

安全边界：

- Palace 写工具走 `tool-permission-policy`，属于本地记忆/承诺写入，不允许静默扩大权限。
- 承诺和 inbox 更新只接受结构化字段，不让模型直接拼任意路径。
- Palace 文件路径由 core 层统一解析，不由前端传入绝对路径。

## 桌面端入口

桌面端顶部导航新增“宫殿”。

面板包含四个视图：

- **路线**：查看所有 rooms（触发、必读、条件读、坑、建议口径），并支持「新建房间」、编辑、删除路线卡。
- **承诺**：查看承诺台账，支持完成、阻塞、作废。
- **沉淀**：查看 pending inbox，支持新增候选、接受、拒绝。
- **档案**：查看 `profile.md` 和 `company.md`。

首次打开「宫殿」面板时（`palace:get-overview` 传 `seedExamples=true`），会给**全新**分身种入 3 张示例路线卡（今日驾驶舱 / 写汇报 / 冲突沟通），避免空房子；已建好的老宫殿不受影响，可用「新建房间」自行补。

主进程 IPC：

- `palace:get-overview`
- `palace:update-commitment`
- `palace:add-inbox-item`
- `palace:update-inbox-item`
- `palace:write-room` / `palace:delete-room`
- `palace:reveal`

## 迁移与回填

Palace 是文件协议，不需要 SQLite migration。现有分身可用脚本回填基础文件树：

```bash
cd /Users/kian/备份/AI/soul

# 只扫描，不写入
npx tsx scripts/backfill-palace.ts

# 为 avatars/ 下分身补齐 palace/
npx tsx scripts/backfill-palace.ts --write

# 扫描专家包正本
npx tsx scripts/backfill-palace.ts --root expert-packs
```

桌面端也提供脚本入口：

```bash
cd /Users/kian/备份/AI/soul/desktop-app
npm run backfill:palace -- --write
```

`ensurePalaceWorkspace()` 是幂等操作：已有文件不会被覆盖，只补缺失目录和基础文件。

## 发布前检查

建议发布前至少跑：

```bash
cd /Users/kian/备份/AI/soul/packages/core
npm run typecheck
npm run build
npm run test

cd /Users/kian/备份/AI/soul/desktop-app
npm run typecheck
npm run build
npm run backfill:palace
```

`npm run backfill:palace` 默认 dry-run，发现未回填分身会返回 2；这表示需要决定是否执行 `--write`，不是代码失败。

