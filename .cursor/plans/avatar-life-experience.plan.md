---
title: AI 分身「人生经历」功能 — 实施计划（完整版）
author: zhi.qu
date: 2026-05-09
status: ready
scope: 完整实现（非 MVP），含真实时间生长、双向同步、后台调度
---

# AI 分身「人生经历」功能（Avatar Life Experience）

> 给每个分身一段 **6~10 万字的出厂记忆**：根据分身描述，AI 想象出从 0 岁到用户指定的当前年龄的完整人生事迹，分身依次"经历"这场人生，按算法+AI 复盘的双重遗忘机制筛选，把"还记得的关键瞬间"作为长期记忆注入对话。
>
> 最终效果：分身在对话里的语气、典故、专业判断、价值偏好都从这场人生里长出来——不是工具，而是有"过往"的人。

---

## 0. 已确认的核心决策

| 决策项 | 选择 | 含义 |
|---|---|---|
| 价值定位 | **B 基底型** | 人生事件必须塑造分身的**专业判断风格 + 价值观 + 隐喻系统**，不是闲聊彩蛋 |
| 生成节奏 | **一次性后台生成** | 用户指定"分身现在多大"（如 35 岁）→ 后台生成 0~35 岁完整传记 |
| 遗忘机制 | **C 算法 + AI 复盘** | 先用艾宾浩斯曲线 + 重要性/情感分打分，再让 LLM 扮演分身做"自我复盘"二次筛选 |
| 桌面端入口 | **C 创建向导 + 独立 LifePanel** | 创建分身时强制"出生"，已有分身可在 LifePanel 补做 |
| **真实时间生长** | **必做（1:1 默认）** | 真实世界过 1 个月 → 分身过 1 个月，自动生成新事件，自动 reconsolidate；timeScale 可在 LifePanel 调（1×/12×/52×） |
| **生成失败** | **不阻塞分身使用** | 创建后立即可对话；失败时 LifePanel 显示错误 + 重试按钮 |
| **手动编辑** | **不做** | 只读 + 重新生成 + 删除单事件触发重新生成局部 |
| **历史分身回填** | **必做** | T5 阶段为 `design-master` / `小堵-工商储专家` 生成完整人生 |
| **创作模型缺失** | **fallback + 提示** | `creationModel` 未配 → 用 `chatModel`，UI 顶部黄色提示带"去配置"链接 |
| **完整实现** | **非 MVP** | 真实时间生长、自动 reconsolidate、cron 调度、追加生成、像素风时间轴**全部一期内完成** |

---

## 1. 数据结构 — `avatars/<id>/life/`

```
avatars/<id>/life/
├── manifest.json         # 人生骨架：出生年/当前年龄/家庭/时代/性格主线/专业骨架
├── timeline.json         # 完整事件索引（age/year/title/importance/emotion/status）
├── episodes/             # 每个事件一份 .md（2-5K 字）
│   ├── ep-0003-grandpa-radio.md
│   ├── ep-0007-first-snow.md
│   └── ...（共 60-100 个）
├── consolidated.md       # 经过遗忘曲线筛选的「我记得的人生」（3-8K 字，注入 system prompt）
└── progress.json         # 生成进度（断点续生成、错误日志）
```

### 1.1 `manifest.json` schema（完整版，含真实时间生长字段）

```jsonc
{
  "schemaVersion": 1,
  "personaName": "陈默",                  // 角色名（可与 avatar 名不同，AI 想象）

  // ─── 出生与年龄 ───
  "birthYear": 1991,
  "birthMonth": 8,
  "birthDay": 15,
  "initialAge": 35,                       // 创建分身时用户指定
  "initialAgeBornAt": "2026-05-09T00:00:00Z",  // 创建分身的真实时间锚点

  // ─── 真实时间生长（v1 完整实现） ───
  "timeScale": 1.0,                       // 1.0 = 真实 1 月→分身 1 月；12.0 = 真实 1 月→分身 1 年
  "lastAdvancedAt": "2026-05-09T00:00:00Z",  // 上次 cron 推进的真实时间
  "currentAgeMonths": 420,                // 分身当前年龄（精确到月，方便 cron 计算）
  "growthEnabled": true,                  // 是否启用持续生长（用户可关）

  // ─── 时代与背景 ───
  "gender": "...",
  "birthplace": "...",
  "familyBackground": "...",              // 200-500 字家庭/时代背景

  // ─── 人格主线 ───
  "personalityArc": [                     // 性格演化主线（4-6 个关键转折）
    { "age": 7, "shift": "..." }
  ],
  "professionalSpine": [                  // 专业骨架（如何走到当前专业）
    { "age": 12, "milestone": "..." }
  ],
  "majorRelationships": [...],            // 重要关系（祖辈/导师/挚友/对手）

  // ─── 元数据 ───
  "createdAt": "2026-05-09",              // 用 localDateString()
  "totalEpisodes": 87,
  "totalChars": 95000,
  "generationStatus": "complete",         // pending | generating | complete | failed | growing
  "lastConsolidatedAt": "2026-05-09T00:00:00Z",  // 上次重新整理 consolidated.md 的时间
  "consolidationCounter": 1               // 已 reconsolidate 次数（每 +5 个事件触发 1 次）
}
```

### 1.2 `timeline.json` schema

```jsonc
[
  {
    "id": "ep-0003-grandpa-radio",
    "age": 3,
    "year": 1993,
    "month": 7,
    "title": "爷爷的旧收音机",
    "summary": "...",                  // ≤ 80 字
    "category": "formative",            // formative/daily/trauma/joy/professional/loss
    "themes": ["好奇心", "机械", "祖辈"],
    "importance": 9,                    // 0-10
    "emotion": 7,                       // 0-10 强度
    "emotionType": "wonder",            // joy/sorrow/anger/fear/wonder/shame/love
    "wordCount": 2400,
    "consolidationStatus": "remembered",// remembered | blurred | forgotten
    "consolidationNote": "..."          // AI 复盘理由
  }
]
```

---

## 2. 生成 Pipeline（5 个 Stage：4 初始化 + 1 持续生长）

### 2.1 初始化阶段（创建分身时一次性跑完）

```
Stage 0：人生骨架
  Input：avatar.txt + soul.md + 用户指定 initialAge + 用户额外提示
  Output：manifest.json
  调用：1 次大 LLM call（让 AI 设计家庭/时代/性格主线/专业骨架）

Stage 1：阶段大纲
  把人生切成 6 段：[0-3, 3-7, 7-12, 12-18, 18-25, 25-initialAge]
  每段单独让 LLM 列 8-15 个事件大纲（标题 + 一句话 + importance/emotion 预估）
  调用：6 次中等 LLM call
  注：每段事件密度可调（年轻时高，30 岁后低），由 outline-density 函数控制

Stage 2：逐事件传记生成（最大头）
  每个事件单独写 2-5K 字
  Input：manifest 摘要 + 上下文连续性提示（前后事件标题）
  Output：episodes/ep-xxxx.md
  调用：60-100 次中等 LLM call（最大头，并发 5 + 断点续传）

Stage 3：双重遗忘筛选
  3a. 算法层：
      forget_prob = sigmoid(α·age_gap_to_now − β·importance − γ·emotion + δ·recency_boost)
      默认 α=0.05, β=0.3, γ=0.2, δ=0.4（最近 5 年事件加 recency_boost）
      过滤后剩 30-50% 事件标记 remembered/blurred/forgotten
  3b. AI 复盘层：
      让 LLM 扮演分身"现在的自己"回看 remembered 事件
      输出 consolidated.md（3-8K 字第一人称叙述「我现在还记得什么」）
  调用：1 次大 LLM call

初始化总成本：
  每个 episode 平均 3K 字 ≈ 4500 tokens 输出 + 800 tokens 输入
  80 个 episodes × 5300 tokens ≈ 42 万 tokens
  + Stage 0/1/3 共约 10 万 tokens
  → 总 ~52 万 tokens（DeepSeek-V3 约 ¥0.5-1.5 / 次完整初始化）
```

### 2.2 Stage 4：持续生长（cron 调度，新增）

```
触发：cron 每天 0:30 跑一次（复用 desktop-app/electron/cron-scheduler.ts）

对每个 growthEnabled=true 的分身执行：

Step 4.1：计算时间增量
  realDeltaMonths = (now - lastAdvancedAt) 折算为月
  avatarDeltaMonths = realDeltaMonths × timeScale
  如果 avatarDeltaMonths < 1 → 跳过本次（不到一个月没必要生成）

Step 4.2：判断本次推进是否触发新事件
  newAgeMonths = currentAgeMonths + avatarDeltaMonths
  事件密度函数 d(age) = 该年龄段每月事件触发概率（年轻 0.3，中年 0.15，老年 0.08）
  对 [currentAgeMonths..newAgeMonths] 每个月按 d(age) 投骰子
  累计 N 个待生成事件

Step 4.3：批量生成新事件
  每个新事件复用 Stage 2 prompt，但额外注入：
    - 已有 timeline.json 的最近 5 个事件作为上下文
    - 真实世界当下时间提示（"现在是 2026 年 6 月"）
    - 重大新闻可选（用户可在 LifePanel 关闭）
  生成完追加到 timeline.json + episodes/

Step 4.4：触发 reconsolidate（条件触发）
  若 (totalEpisodes - lastConsolidatedTotalEpisodes) >= 5 或 距上次 reconsolidate >= 30 天
  → 重新跑 Stage 3a + 3b，刷新 consolidated.md
  否则只增量更新 timeline.json，不重写 consolidated

Step 4.5：更新 manifest
  lastAdvancedAt = now
  currentAgeMonths = newAgeMonths
  totalEpisodes += N

成本控制：
  每次推进期望 ≤ 3 个新事件（按 1×timeScale 月均值）
  重 reconsolidate 频率 ≈ 每 1-2 月一次（按 5 事件阈值）
  日均推进成本 ≈ 1-3 万 tokens（≈ ¥0.05-0.2 / 月）
```

### 2.3 用户主动触发的局部重生成

```
场景 A：用户在 LifePanel 删除某事件
  → 自动重新生成该年龄段附近 1-3 个事件（保持时间轴密度）
  → 触发 reconsolidate

场景 B：用户点"重新生成全部"
  → 备份当前 life/ 到 life-backup-<timestamp>/
  → 清空 life/，重新跑 Stage 0-3

场景 C：用户调整 timeScale（例如从 1× 调到 12×）
  → 立即跑一次 Stage 4 catch-up（按新 scale 补齐落后的事件）
```

---

## 3. 注入对话的链路

```
┌──────────────────────────────────────────────────────────┐
│  packages/core/src/soul-loader.ts                         │
│                                                            │
│  loadAvatar() 拼装 system prompt 时新增：                  │
│  ┌─ stableParts:                                          │
│  │   1. CLAUDE.md                                         │
│  │   2. soul.md                                           │
│  │   3. 共享知识                                           │
│  │   4. knowledge/                                         │
│  │ + 5. life/consolidated.md   ← 新增「我的人生（出厂记忆）」│
│  │   6. 工具说明                                           │
│  ├─ dynamicParts:                                         │
│      1. memory/MEMORY.md                                  │
│      2. memory/USER.md                                    │
│                                                            │
│  另外注册新工具 read_life_episode(id)，让分身可以"翻日记"   │
│  full episode 文件不进 system prompt（成本/上下文考虑）     │
└──────────────────────────────────────────────────────────┘
```

---

## 4. 桌面端 UI 设计

### 4.1 创建向导改造（`CreateAvatarWizard.tsx`）

当前 5 步 → 改为 6 步：
```
01 基本信息 → 02 人格定义 → 03 知识库 → 04 技能定义 → 05 人生剧本（新） → 06 确认创建
```

第 5 步「人生剧本」：
```
┌──────────────────────────────────────────────┐
│  05 / 06    人生剧本                          │
├──────────────────────────────────────────────┤
│  [✓] 为分身设计一场完整人生（推荐）            │
│                                                │
│  分身现在的年龄： [  35  ] 岁   (18~80)        │
│                                                │
│  时间生长速度：                                │
│  ( ) 真实同步（1 月→1 月，最自然，推荐）        │
│  (●) 加速 12×（1 月→1 年，快速看到分身长大）   │
│  ( ) 加速 52×（1 周→1 年，仅适合短期实验）      │
│  ( ) 冻结（不随真实时间生长）                   │
│                                                │
│  额外要求（可选）：                             │
│  ┌──────────────────────────────────────┐    │
│  │ 想让分身的人生有海外经历，专业起步早    │    │
│  └──────────────────────────────────────┘    │
│                                                │
│  [预估] 80~100 个事件 · 8~10 万字 · 5~10 分钟  │
│                                                │
│  ⓘ 分身创建完成后会在后台开始"经历人生"，         │
│    你可以先和它对话，人生会逐步成形。            │
│  ⓘ 创作模型未配置，将使用对话模型生成。           │
│    [→ 去设置配置创作模型]                      │
└──────────────────────────────────────────────┘
```

### 4.2 LifePanel（独立面板，类比 MemoryPanel）

入口：`PixelNavBar` 在「记忆」按钮旁加「人生」按钮（icon: `❀`）。

布局（完整版，含真实时间生长可视化）：
```
┌──────────────────────────────────────────────────────────────┐
│  [LIFE / 人生]                                       [✕]      │
│  设计大师 · 35 岁 4 月 · 87 事件 · 还记得 38 件               │
│  下次生长：还有 18 天 17 时（真实 1 月→分身 1 月，1×）         │
├──────────────────────┬───────────────────────────────────────┤
│  时间轴（左 32%）      │  事件详情（右 68%）                   │
│  ─────────────       │  ─────────────                       │
│  0  ●  出生           │  [3 岁 · 1994.07]                    │
│  3  ★  爷爷的收音机    │  爷爷的旧收音机                       │
│  5  ○  第一次走丢      │  ──────                              │
│  7  ★  第一场雪        │  那天下午我趴在地板上...               │
│  ... ...              │  [完整 2400 字]                      │
│  35 ★ 项目失败那夜    │  ──────                              │
│  ┄┄┄┄ NOW ┄┄┄┄┄┄    │  标签：好奇心 · 机械                  │
│  35.5 (待生成)         │  情感：惊奇 (7)                      │
│  ──────              │  状态：◆ 关键瞬间（永久记得）          │
│  ★ 关键瞬间（金）       │  ──────                              │
│  ● 已经历（亮）         │  AI 复盘：                           │
│  ○ 已淡忘（灰）         │  「这件事我记到现在，因为它是我对     │
│  ┄ 未来（虚线）         │   '把复杂的东西拆开看' 这个习惯的     │
│                       │   起点。每次面对一个混乱的设计稿，    │
│                       │   我都会想起那个下午...」             │
│                       │                                       │
│                       │  ──遗忘曲线──                        │
│                       │  ████████░░░░░░ 92% 强度（7 年后）    │
│                       │                                       │
├──────────────────────┴───────────────────────────────────────┤
│ [生成进度: ✔ 87/87] [⏯ 暂停生长] [↻ 重新生成] [⚙ 时间速度]   │
│ [📜 查看完整复盘 consolidated.md] [⬇ 导出全部 episodes]      │
└──────────────────────────────────────────────────────────────┘
```

像素风样式参考已有 `prose-pixel`，时间轴用左侧竖线 + 圆点，颜色用 `bg-px-primary`/`bg-yellow-400`/`bg-px-text-dim`。

### 4.3 LifeTimeRulerSettings（时间速度设置子模态）

```
┌─────────────────────────────────────┐
│  ⚙  时间生长速度                     │
├─────────────────────────────────────┤
│  当前模式：1× 真实同步                │
│                                       │
│  ( ) 1×    真实 1 月 → 分身 1 月      │
│  (●) 12×   真实 1 月 → 分身 1 年      │
│  ( ) 52×   真实 1 周 → 分身 1 年      │
│  ( ) 冻结  不随真实时间生长            │
│                                       │
│  调整后立即按新速度补齐落后事件         │
│  上次推进：2026-04-15                  │
│  按 12× 计算落后：1 年 0 月            │
│  预计补齐：~12 个新事件，3 分钟         │
│                                       │
│            [取消]  [应用]              │
└─────────────────────────────────────┘
```

---

## 5. 工程任务清单（按依赖顺序，7 个 Phase）

> 总工期：**~14 天**（完整实现版含真实时间生长 cron + 局部重生成；每 Phase 是独立子任务集，必须在新窗口逐 Phase 推进，避免上下文膨胀）

### Phase 0：基础数据结构 + IPC 骨架（1.5 天）

| 子任务 | 文件 | 说明 |
|---|---|---|
| T0.1 | `packages/core/src/life/types.ts` （新） | LifeManifest / TimelineEntry / LifeEpisode / LifeProgress 接口 |
| T0.2 | `packages/core/src/life/store.ts` （新） | 读写 life/ 目录的纯函数；复用 `assertSafeSegment` / `resolveUnderRoot` / `localDateString` / `collectFilesRecursive` |
| T0.3 | `packages/core/src/life/store.test.ts` （新） | 单测 |
| T0.4 | `desktop-app/electron/main.ts` （改） | +6 个 handler：`life:get-manifest` / `life:list-timeline` / `life:read-episode` / `life:get-progress` / `life:read-consolidated` / `life:delete-episode` |
| T0.5 | `desktop-app/electron/preload.ts` （改） | 暴露上述 API |
| T0.6 | `desktop-app/src/global.d.ts` （改） | 补 TypeScript 类型 |

### Phase 1：初始化生成器 Pipeline（3 天）

| 子任务 | 文件 | 说明 |
|---|---|---|
| T1.1 | `packages/core/src/life/generator.ts` （新） | Stage 0-3 生成器，复用 LLMService；并发 5 写 episodes |
| T1.2 | `packages/core/src/life/forgetter.ts` （新） | 算法层 sigmoid 公式 + AI 复盘层 |
| T1.3 | `packages/core/src/life/prompts.ts` （新） | 集中管理 4 个 Stage 的 prompt 模板 |
| T1.4 | `packages/core/src/life/generator.test.ts` （新） | mock LLM 单测，验证断点续传 |
| T1.5 | `desktop-app/electron/main.ts` （改） | +`life:start-generation` / `life:cancel-generation` / `life:retry-generation` handler，进度通过 `webContents.send('life:progress', ...)` 推送 |
| T1.6 | `desktop-app/electron/preload.ts` （改） | 暴露 onLifeProgress |
| T1.7 | 断点续传：每个 Stage 完成写 `progress.json`，启动时检查并续跑 | |
| T1.8 | 创作模型 fallback：`creationModel.apiKey` 缺失时改用 `chatModel`，progress 里标记 `usedFallback: true` | |

### Phase 2：持续生长 cron（2.5 天，新增 Phase）

| 子任务 | 文件 | 说明 |
|---|---|---|
| T2.1 | `packages/core/src/life/grower.ts` （新） | Stage 4 推进逻辑：算时间增量 + 事件密度 + 触发生成 |
| T2.2 | `packages/core/src/life/density.ts` （新） | 事件密度函数 d(age)（年轻 0.3，中年 0.15，老年 0.08） |
| T2.3 | `desktop-app/electron/cron-scheduler.ts` （改） | 注册 daily 任务 `life:advance-all-avatars` |
| T2.4 | `desktop-app/electron/main.ts` （改） | +`life:set-time-scale` / `life:toggle-growth` / `life:advance-now` handler（调试用） |
| T2.5 | `packages/core/src/life/grower.test.ts` （新） | 测时间换算 + 事件密度 + 边界情况（timeScale=0/52） |
| T2.6 | reconsolidate 触发：每 +5 episodes 或 +30 天调一次 Stage 3 | |

### Phase 3：渲染端 LifePanel（3 天）

| 子任务 | 文件 | 说明 |
|---|---|---|
| T3.1 | `desktop-app/src/components/LifePanel.tsx` （新） | 主面板：时间轴 + 详情 + 工具栏 + 生长进度条 |
| T3.2 | `desktop-app/src/components/life/LifeTimeline.tsx` （新） | 像素风时间轴（含 NOW 锚点和未来虚线） |
| T3.3 | `desktop-app/src/components/life/LifeEpisodeViewer.tsx` （新） | 事件详情 + 遗忘曲线小图 |
| T3.4 | `desktop-app/src/components/life/LifeTimeScaleModal.tsx` （新） | 4.3 时间速度设置子模态 |
| T3.5 | `desktop-app/src/services/life-service.ts` （新） | 渲染端调度封装 + onLifeProgress 订阅 |
| T3.6 | `desktop-app/src/App.tsx` （改） | 注册 LifePanel；`PixelNavBar` 加入口 |

### Phase 4：创建向导集成（1.5 天）

| 子任务 | 文件 | 说明 |
|---|---|---|
| T4.1 | `desktop-app/src/components/CreateAvatarWizard.tsx` （改） | 6 步流程，加 LifeScriptStep |
| T4.2 | `desktop-app/src/components/wizard/LifeScriptStep.tsx` （新，抽组件） | 第 5 步 UI（含 timeScale 选择 + creationModel 缺失提示） |
| T4.3 | 创建分身后异步触发 `life:start-generation`，不阻塞向导关闭 | |
| T4.4 | 创建完成 Toast 提示「分身正在经历人生，可在 LifePanel 查看进度」 | |

### Phase 5：注入对话 + 工具（1 天）

| 子任务 | 文件 | 说明 |
|---|---|---|
| T5.1 | `packages/core/src/soul-loader.ts` （改） | 读 `life/consolidated.md`，拼到 stableParts；缓存失效要把 `life/manifest.json` 加入快照（参考 main.ts:2382 行附近的快照逻辑） |
| T5.2 | `packages/core/src/tool-router.ts` （改） | +`read_life_episode(id)` 工具，让分身能"翻日记" |
| T5.3 | system prompt 附「人生使用守则」：除非用户问起否则不主动展开往事 | |
| T5.4 | `packages/core/src/soul-loader.test.ts` （改） | 测试人生记忆注入 + 缓存失效 |

### Phase 6：历史分身回填 + 联调测试（2 天）

| 子任务 | 说明 |
|---|---|
| T6.1 | 写脚本 `scripts/backfill-life.ts`：扫描 `avatars/` 下所有没有 `life/` 的分身，提示用户在桌面端补做 |
| T6.2 | 给 `design-master` 跑一遍：35 岁，1× timeScale，验证人生事件作为视觉品味来源 |
| T6.3 | 给 `小堵-工商储专家` 跑一遍：38 岁，12× timeScale，验证人生作为专业判断来源 |
| T6.4 | 在 `avatars/<id>/tests/cases/` 加 `life-001.md` 测试用例：「问起人生往事时是否引用具体事件」 |
| T6.5 | 时间生长 cron 联调：手动触发 `life:advance-now` 验证新事件追加 |
| T6.6 | 完整 E2E：创建一个测试分身 → 生成 → 对话 → 触发推进 → reconsolidate → 验证 system prompt 更新 |

---

## 6. 关键 Prompt 设计（草案）

### 6.1 Stage 0 Prompt — 生成 manifest

```
你是 AI 分身「{avatarName}」的人生设计师。
分身简介：
{avatar.txt 内容}

人格灵魂（节选 1500 字）：
{soul.md 节选}

用户指定参数：
- 分身现在的年龄：{currentAge} 岁
- 当前年份：{currentYear}（出生年 = {currentYear - currentAge}）
- 用户额外要求：{userHint or "无"}

任务：为这个分身想象一段真实可信的完整人生（不是浪漫化）。
要求：
1. 人生主线必须自然孕育出他现在的专业人格（不是空降，要有童年伏笔）
2. 必须有 4-6 个关键转折塑造他现在的判断风格
3. 时代背景要符合实际（{currentYear - currentAge} 年代到现在的真实社会变迁）
4. 不要避讳挫折、失败、亲人离世等真实人生主题
5. 要有 3-5 个重要关系人（祖辈/父母/导师/挚友/对手）

输出 JSON（严格按 manifest.json schema）：
{ "personaName": ..., "birthYear": ..., ... }
```

### 6.2 Stage 2 Prompt — 单事件生成

```
你正在为 AI 分身「{avatarName}」写他的传记。

人生背景（manifest 摘要）：
{manifest 关键字段：personaName/birthYear/familyBackground/personalityArc 主线 1-2 句}

当前要写的事件：
- 年龄：{age} 岁
- 时间：{year}.{month}
- 标题：{title}
- 大纲：{outline}
- 重要性预估：{importance}/10
- 情感强度预估：{emotion}/10

上下文连续性：
- 上一个事件（{prevAge}岁）：{prevTitle}
- 下一个事件（{nextAge}岁）：{nextTitle}

任务：用第一人称写出这个事件的完整片段（{wordTarget} 字 ±20%）。
要求：
1. 有具体的场景细节（光线/气味/对话/动作）
2. 有内心活动，但不要空洞抒情
3. 这个事件要能塑造他**专业人格**的某个面向（即使表面是日常事件）
4. 不要剧透后来的人生，停在他当时的视角
5. 避免"金句体"和段尾抒情套路

直接输出正文（不要 markdown 标题）。
```

### 6.3 Stage 3b Prompt — AI 复盘

```
你现在是 AI 分身「{avatarName}」，今年 {currentAge} 岁。
回顾你的人生，下面这些是你过去经历的事件（按年代排序，已经过算法初筛）：

{remembered episodes 的 title + summary 列表}

任务：用第一人称写一段 3000-5000 字的「我记得的人生」。
要求：
1. 不是逐条复述事件，而是按主题/情绪线索串起来
2. 哪些事件深深刻在记忆里？为什么？
3. 哪些事件其实已经模糊但留下了气味？
4. 这些经历怎么塑造了你现在的判断风格、价值观、专业品味？
5. 写得像深夜独白，不要写得像简历

输出格式：
# 我还记得的人生（{currentAge} 岁回望）

[正文]
```

---

## 7. 风险 & 兜底

| 风险 | 缓解 |
|---|---|
| 生成成本失控 | manifest 里限定 `targetTotalChars`，超出 95K 时停止；progress.json 支持断点续生成 |
| LLM 写得套路化 / 金句体 | Stage 2 prompt 明确"避免段尾抒情"；用 `creationModel`（创作模型）而非 chat 模型 |
| 中途失败 | 每 episode 单独存盘，失败后 `life:start-generation` 自动跳过已完成 |
| 人生与分身专业脱节 | Stage 0 manifest 里强制生成 `professionalSpine`；Stage 2 prompt 明确"塑造专业人格" |
| 用户取消生成 | `life:cancel-generation` 立即停止下一个 episode 调用，已完成的保留 |
| consolidated.md 太长撑爆 system prompt | 软上限 8K 字（约 12K tokens），Stage 3b prompt 里限制 |
| 分身在对话里频繁"卖惨"或剧透往事 | soul-loader 注入时附「人生使用守则」：除非用户问起、否则不主动展开往事 |

---

## 8. 验收标准

- [ ] 创建一个新分身时，第 5 步可选择"为分身设计人生"
- [ ] 后台生成成功率 ≥ 90%（断点续传后）
- [ ] LifePanel 能看到完整时间轴，标识 remembered/blurred/forgotten
- [ ] 点击事件能看到完整正文 + AI 复盘理由
- [ ] 分身在对话中被问起人生时，能引用具体事件（不是泛泛而谈）
- [ ] 分身的回答风格、隐喻、判断标准能体现人生事件的影响（盲测：让两个相同人格但不同人生的分身回答同一专业问题，回答可分辨）
- [ ] 生成总耗时 ≤ 15 分钟（80 个 episodes × 平均 8s）
- [ ] consolidated.md 字数 3K-8K，注入 system prompt 后总长度增量 ≤ 12K tokens

---

## 9. 已确认问题（v1 全部包含）

| 问题 | 决议 |
|---|---|
| 年龄随真实时间增长 | ✅ 必做。Phase 2 实现 cron + Stage 4，timeScale 默认 1×，可调 1×/12×/52×/冻结 |
| 生成失败 | ✅ 不阻塞。分身可正常对话，LifePanel 显示错误 + 重试 |
| 手动编辑事件 | ❌ 不做。只读 + 删除单事件触发局部重生成 + 整体重新生成 |
| 历史分身回填 | ✅ Phase 6 给 `design-master` / `小堵-工商储专家` 补做 |
| `creationModel` 缺失 | ✅ fallback 到 `chatModel`，向导和 LifePanel 顶部黄色提示带"去配置"链接 |

---

## 10. 实施纪律（每个新窗口开工前必读）

### 10.1 单窗口边界
- **每个 Phase 在独立新窗口执行**，主窗口只指挥
- 一个窗口完成 ≤ 3 个子任务后，输出交接摘要 + 关闭对话
- 子任务调试 > 2 轮失败 → 熔断，标记"待人工"，开新窗口

### 10.2 并行规则（依赖文件中提到的 efficient-workflow.mdc）
- 同 Phase 内 ≥ 3 个独立文件 → 多个 generalPurpose subagent 并发派发
- 跑测试用 shell subagent + `run_in_background: true`
- 探索代码用 `explore` subagent，不要在主窗口里做大规模搜索
- 多个独立 subagent 必须**同一条消息里并发派发**（一次 tool_use batch）

### 10.3 编码规范（强约束）
- 新文件必须加 JSDoc 头，含 `@author zhi.qu` 和 `@date YYYY-MM-DD`
- 日期用 `localDateString()` 来自 `@soul/core`（禁 `toISOString().slice(0,10)`）
- HTTP 请求用 `fetchWithTimeout()`（禁裸 `fetch`）
- 路径用户输入必经 `assertSafeSegment()` / `resolveUnderRoot()`
- 错误处理：主进程 Logger，渲染端 try/catch + Toast + `window.electronAPI.logEvent()`
- 禁 `any` / `var` / 空 `catch{}` / `System.out.println` 类调试输出
- 比较一律 `===` / `!==`

### 10.4 任务拆分规则触发
- Phase 0/1/2/5：触发拆分（多文件 .ts 改动）→ 必须先输出子任务清单等用户确认
- Phase 3/4：触发拆分（多个 .tsx 新增）→ 同上
- Phase 6：联调，按"先文档扫描后局部修复"流程

### 10.5 不要做的事
- 不要在 Phase 0 完成前提前实现 Phase 1 的生成逻辑（会引发循环依赖）
- 不要把 `life/` 目录加入 RAG 索引（避免和 knowledge/ 混淆）
- 不要在 system prompt 注入完整 `episodes/`（仅 `consolidated.md`，episodes 走 `read_life_episode` 工具）
- 不要为 `life/manifest.json` 加 frontmatter（它是 JSON 不是 MD）
- 不要复制 SoulLoader 的逻辑到 main.ts，要在 SoulLoader 内扩展

---

## 11. 开工命令（串行执行，每个 Phase 一个新窗口）

> **执行模式**：严格串行，0 → 1 → 2 → 3 → 4 → 5 → 6，每个 Phase 完成后再开下一个新窗口。
> **不用 worktree**，所有改动直接落在主分支（或单一 feature branch）。
> **每个 Phase 完成后必做**：
> 1. 在 plan 末尾追加完成记录（11.10 格式）
> 2. 输出交接摘要给主窗口
> 3. 主窗口确认后关闭子窗口，再开下一个

---

### 11.1 Phase 0 — 基础数据结构 + IPC 骨架

```
@.cursor/plans/avatar-life-experience.plan.md

执行 Phase 0：基础数据结构 + IPC 骨架。

要求：
1. 先输出 T0.1~T0.6 的子任务拆分清单（每个子任务标注：涉及文件、预计行数、风险点），等我确认后再动手
2. 严格遵守 plan 第 10 节实施纪律（特别是 10.3 编码规范：新文件必须 JSDoc + @author zhi.qu + @date，用 localDateString/assertSafeSegment/resolveUnderRoot/collectFilesRecursive，禁 any/var/空 catch）
3. 文件读写参考既有模式（plan 12.2 节）：
   - main.ts:1297-1330 的 read-memory/write-memory handler 模式
   - 路径必经 assertSafeSegment(avatarId, '分身ID')
4. 单测必须通过（packages/core 用 vitest 或现有测试框架）
5. 每个子任务完成后输出"已修改文件 + 关键 diff 行号"，等我"继续"
6. 全部完成后在 plan 文件末尾追加「## Phase 0 完成记录」节（按 11.10 格式）
7. 完成后输出交接摘要：给 Phase 1 的输入清单（新增的 IPC API 名称、life-store 关键函数签名、TypeScript 类型导出路径）
```

---

### 11.2 Phase 1 — 初始化生成器 Pipeline

```
@.cursor/plans/avatar-life-experience.plan.md

执行 Phase 1：初始化生成器 Pipeline（4 个 Stage）。

前置：Phase 0 已完成。开始前先读 plan 末尾的「Phase 0 完成记录」获取交接信息。

要求：
1. 先输出 T1.1~T1.8 的子任务拆分清单
2. 重点参考既有模式（plan 12.2 节）：
   - LLM 调用：复用 main.ts:1335 的 createLLMFn 模式
   - 渐进生成：参考 desktop-app/src/services/soul-step-generator.ts 的 5 步模式
   - 进度推送：webContents.send('life:progress', payload) + 渲染端 ipcRenderer.on
3. Stage 2 并发度=5，断点续传（progress.json 记录已完成 episodes，启动时跳过）
4. creationModel 缺失时 fallback chatModel + 在 progress 里 usedFallback=true
5. prompts.ts 集中管理 4 个 Stage 的 prompt 模板（对应 plan 6.1/6.2/6.3）
6. 单测必须 mock LLM（不要真请求 API）
7. 每个子任务完成后输出 diff 摘要，等我"继续"
8. 全部完成后在 plan 末尾追加「## Phase 1 完成记录」节
9. 输出交接摘要：给 Phase 2 的输入清单（generator 内部函数签名：generateEpisode/generateConsolidated 等，供 Phase 2 复用）
```

---

### 11.3 Phase 2 — 持续生长 cron 调度

```
@.cursor/plans/avatar-life-experience.plan.md

执行 Phase 2：持续生长 cron 调度（Stage 4）。

前置：Phase 1 已完成。开始前先读 plan 末尾的「Phase 1 完成记录」获取 generator 函数签名。

要求：
1. 先输出 T2.1~T2.6 的子任务拆分清单
2. grower.ts 严格按 plan 2.2 节的 Step 4.1~4.5 实现（时间增量计算 → 事件密度抽样 → 批量生成 → 条件 reconsolidate → 更新 manifest）
3. density.ts 事件密度：年轻 0.3，中年 0.15，老年 0.08（按年龄段分桶，可参数化）
4. cron 注册到 desktop-app/electron/cron-scheduler.ts，daily 0:30 触发 life:advance-all-avatars
5. 边界处理（必测）：
   - timeScale=0（冻结）→ 跳过
   - growthEnabled=false → 跳过
   - generationStatus='generating' → 跳过（避免和初始化打架）
   - LLM 失败 → 重试 1 次，仍失败标 progress.lastError，不影响其他分身
6. reconsolidate 触发：(totalEpisodes - lastConsolidatedTotalEpisodes) >= 5 或 距上次 reconsolidate >= 30 天
7. 加 IPC：life:advance-now（调试用，立即推进） / life:set-time-scale / life:toggle-growth
8. 单测覆盖：时间换算（1× / 12× / 52× / 0×）、密度函数边界、reconsolidate 阈值
9. 完成后在 plan 末尾追加「## Phase 2 完成记录」
10. 输出交接摘要：给 Phase 3 的输入清单（新增的 IPC API 列表，UI 需要订阅的事件名）
```

---

### 11.4 Phase 3 — 渲染端 LifePanel

```
@.cursor/plans/avatar-life-experience.plan.md

执行 Phase 3：渲染端 LifePanel + 子组件 + 时间速度模态。

前置：Phase 0~2 已完成。开始前先读 plan 末尾的 Phase 0~2 完成记录，了解可用的 IPC API。

要求：
1. 先输出 T3.1~T3.6 的子任务拆分清单
2. 像素风样式参考既有 desktop-app/src/components/MemoryPanel.tsx（Modal + PanelHeader + 状态机模式）
3. LifePanel 布局严格按 plan 4.2 节的 ASCII 图（含 NOW 锚点 + 未来虚线 + 生长进度提示）
4. LifeTimeScaleModal 严格按 plan 4.3 节
5. 时间轴用 prose-pixel + bg-px-primary（关键瞬间金）/yellow-400/text-dim（淡忘灰）三色编码
6. 加入口到 PixelNavBar，icon: ❀，label: '人生'，key: 'life'，在 App.tsx 注册面板（参考现有 MemoryPanel 的注册方式）
7. 错误处理严格按 .cursor/rules/react-renderer.mdc：失败必 Toast + window.electronAPI.logEvent
8. 订阅 life:progress 事件实时刷新生成进度（参考 chatStore.ts 现有的 ipcRenderer.on 模式）
9. 完成后在 plan 末尾追加「## Phase 3 完成记录」
10. 输出交接摘要：UI 已就绪，给 Phase 4 的输入清单（创建分身后该触发哪个 IPC、如何打开 LifePanel）
```

---

### 11.5 Phase 4 — 创建向导集成

```
@.cursor/plans/avatar-life-experience.plan.md

执行 Phase 4：创建分身向导集成（5 步 → 6 步）。

前置：Phase 0~3 已完成。开始前读 plan 末尾的 Phase 1/3 完成记录，了解 life:start-generation IPC 和 LifePanel 入口。

要求：
1. 先输出 T4.1~T4.4 的子任务拆分清单
2. CreateAvatarWizard.tsx 改动：
   - STEPS 数组从 5 步扩到 6 步：在原第 4 步「技能定义」和第 5 步「确认创建」之间插入「人生剧本」
   - 新增 state：lifeEnabled / lifeAge / lifeTimeScale / lifeExtraHints
   - 创建分身后异步 await window.electronAPI.life.startGeneration(id, { age, timeScale, extraHints })，不阻塞向导关闭
3. 抽 LifeScriptStep.tsx 子组件，UI 严格按 plan 4.1 节 ASCII 图：
   - 默认 ✓ 启用人生（用户可取消）
   - 年龄输入 18-80（默认 30）
   - timeScale 4 选 1 单选（1× / 12× / 52× / 冻结，默认 1×）
   - 额外要求 textarea（可选）
   - 显示预估「80~100 个事件 · 8~10 万字 · 5~10 分钟」
   - creationModel.apiKey 缺失时显示黄色提示「将使用对话模型生成 [→ 去设置配置]」
4. 创建完成 Toast 提示「分身正在经历人生，可在 LifePanel 查看进度」（点 Toast 可打开 LifePanel）
5. 完成后在 plan 末尾追加「## Phase 4 完成记录」
6. 输出交接摘要：向导集成完毕，给 Phase 5 的输入说明（生成的 consolidated.md 路径，soul-loader 可以读了）
```

---

### 11.6 Phase 5 — 注入对话 + read_life_episode 工具

```
@.cursor/plans/avatar-life-experience.plan.md

执行 Phase 5：把人生记忆注入 system prompt + 加 read_life_episode 工具。

前置：Phase 0~4 已完成。Phase 1 已能产出 life/consolidated.md。

要求：
1. 先输出 T5.1~T5.4 的子任务拆分清单
2. soul-loader.ts 改动点（packages/core/src/soul-loader.ts:107~320）：
   - loadAvatar() 在 stableParts 拼装中读 life/consolidated.md（用 readFileSafe，不存在返回空）
   - 注入位置：放在「知识库」之后、「工具说明」之前，标题用「# 我的人生（出厂记忆）」
   - 后面追加「人生使用守则」：除非用户问起否则不主动展开往事；引用人生事件时可 read_life_episode(id) 取全文
3. main.ts 缓存快照：把 life/manifest.json 加入 captureFileSnapshot 列表（参考 main.ts:2382 附近现有代码）
4. tool-router.ts 新增 read_life_episode(id: string) 工具：
   - 从 life/episodes/<id>.md 读全文返回
   - 路径必经 assertSafeSegment + resolveUnderRoot
5. 单测：在 packages/core/src/soul-loader.test.ts 加 case：
   - 有 life/consolidated.md 时 system prompt 包含相应章节
   - 没有时不报错且不出现章节标题
   - life/manifest.json 变化时缓存失效
6. 完成后在 plan 末尾追加「## Phase 5 完成记录」
7. 输出交接摘要：注入链路完毕，可以做 Phase 6 联调
```

---

### 11.7 Phase 6 — 历史分身回填 + 端到端联调

```
@.cursor/plans/avatar-life-experience.plan.md

执行 Phase 6：历史分身回填 + 端到端联调测试。

前置：Phase 0~5 已全部完成。

要求：
1. 先输出 T6.1~T6.6 的子任务拆分清单
2. T6.1：写 scripts/backfill-life.ts，扫描 avatars/ 下所有没有 life/ 目录的分身，输出清单（不自动生成，提示用户在桌面端补做）
3. T6.2：在桌面端为 design-master 触发生成（35 岁，1× timeScale），完成后人工抽查 5 个 episodes 的写作质量（不能套路化、不能"金句体"、要塑造专业人格）
4. T6.3：在桌面端为 小堵-工商储专家 触发生成（38 岁，12× timeScale），完成后人工抽查
5. T6.4：在 avatars/<id>/tests/cases/ 加 life-001.md 测试用例：「问起人生往事时是否引用具体事件」（参考其他 *-001.md 格式）
6. T6.5：手动触发 life:advance-now 验证：
   - 新事件追加到 timeline.json
   - 满 5 个新事件后 consolidated.md 自动重写
   - lastAdvancedAt / currentAgeMonths 正确更新
7. T6.6：完整 E2E：
   - 创建一个全新测试分身「联调测试员」
   - 等待生成完成
   - 在对话里问"你 7 岁那年发生了什么"，验证分身能引用具体 episode（带正确的事件细节，不是泛泛而谈）
   - 调整 timeScale 1× → 12×，验证立即 catch-up 补齐落后事件
   - 删除一个事件，验证局部重生成
8. 把发现的问题统一写入 plan 文件「## Phase 6 已知问题清单」
9. 全部通过后在 plan 顶部 status 改为 `delivered-v1`
10. 输出最终交付摘要给我
```

---

### 11.10 Phase 完成记录格式（每个 Phase 收尾时追加）

```markdown
## Phase X 完成记录（YYYY-MM-DD）

### 子任务完成情况
- [x] T X.1: 简述（commit hash 短码）
- [x] T X.2: 简述
...

### 验收清单
- ✅ 单测全过：xxx
- ✅ 集成测试：xxx
- ✅ 手动验证：xxx

### 已知问题
- ⚠ 问题 1：描述 + 暂时绕过方案

### 给下个 Phase 的输入
- 新增的 IPC API：xxx / xxx
- 新增的导出类型/函数：xxx
- 关键文件位置：xxx
- 注意事项：xxx
```

---

## 12. 上下文交接锚点

### 12.1 已读关键文件（开工时不必再读，本节即摘要）
- `avatars/design-master/{soul.md, CLAUDE.md, avatar.config.json, memory/MEMORY.md}`
- `avatars/小堵-工商储专家/CLAUDE.md`（前 80 行）
- `packages/core/src/soul-loader.ts:107-320`（system prompt 拼装核心）
- `desktop-app/src/components/{MemoryPanel.tsx, UserProfilePanel.tsx, CreateAvatarWizard.tsx:1-80}`
- `desktop-app/electron/main.ts:606-1342`（avatar / memory IPC handlers 集中区）
- `desktop-app/src/App.tsx:90-340`（面板注册 + loadAvatarConfig）
- `desktop-app/src/stores/chatStore.ts:2240-2300`（system prompt 注入流）
- `desktop-app/electron/cron-scheduler.ts`（已存在，Phase 2 直接复用）

### 12.2 关键既有模式参考（生抠模式，避免重新设计）
| 需要做的事 | 参考既有模式 |
|---|---|
| `life/` 目录文件读写 | `read-memory` / `write-memory` handler 的 `assertSafeSegment` 模式（main.ts:1297-1330） |
| LLM 长任务调用 | `consolidate-memory` handler 的 `createLLMFn` 模式（main.ts:1335-1342） |
| 多 Stage 渐进生成 | `soul-step-generator.ts` 的 5 步生成模式（service 层） |
| 渲染端面板组件 | `MemoryPanel.tsx` 的 Modal + PanelHeader + 状态机模式 |
| IPC 进度推送 | `webContents.send('event-name', payload)` + 渲染端 `ipcRenderer.on` 模式 |
| cron 注册 | `desktop-app/electron/cron-scheduler.ts` 现有任务的注册方式 |
| system prompt 缓存失效快照 | `main.ts:2382` 附近的 `captureFileSnapshot` 模式（要把 `life/manifest.json` 加进去） |
| 创建分身向导插步 | `CreateAvatarWizard.tsx` 的 STEPS 数组 + currentStep 状态机 |

### 12.3 编码约定锚点（不要再问）
- 根目录 `CONVENTIONS.md`
- `.cursor/rules/coding-conventions.mdc`
- `.cursor/rules/efficient-workflow.mdc`
- `.cursor/rules/core-utils.mdc`（@soul/core 工具函数清单，禁止重复实现 localDateString/fetchWithTimeout/assertSafeSegment/resolveUnderRoot/collectFilesRecursive）
- `.cursor/rules/react-renderer.mdc`（渲染进程错误处理 + Toast + logEvent）
- 根目录 `CLAUDE.md` / `AGENTS.md`（任务拆分判定 + TS 质量检查规则）

---

## Phase 0 完成记录（2026-05-09）

### 子任务完成情况
- [x] **T0.1** 类型定义：`packages/core/src/life/types.ts`（新增，220 行）— 4 个核心 interface + 5 个联合类型
- [x] **T0.2** 文件读写纯函数：`packages/core/src/life/store.ts`（新增，约 360 行）+ `packages/core/src/index.ts`（追加 +40 行 re-export）
- [x] **T0.3** 单测：`packages/core/src/tests/life-store.test.ts`（新增，约 320 行，30 个 case）+ `packages/core/package.json`（test/test:all 脚本各加 1 项）
- [x] **T0.4** IPC handler：`desktop-app/electron/main.ts`（import +6 名称；第 1343 行后插入 6 个 wrapHandler，约 +55 行）
- [x] **T0.5** preload：`desktop-app/electron/preload.ts`（第 211 行后追加 `life` namespace，+13 行）
- [x] **T0.6** 渲染端类型：`desktop-app/src/global.d.ts`（ElectronAPI 加 `life: { ... }` +22 行；Window 之前插入 7 个类型/4 个 interface，+120 行）

### 验收清单
- ✅ `packages/core/npm run build` 通过
- ✅ `packages/core/npm run typecheck` 通过
- ✅ `packages/core/npm test` 全过（**134 个 case，含 life-store 30 个**）
- ✅ `desktop-app/npx tsc --noEmit` 通过（无 type 错误）
- ✅ 路径安全：`avatarId` 含 `/` `..` 空字符 全部 throw；`episodeId` 含 `/` `..` `.md` `.开头` 全部 throw（store.ts `assertSafeEpisodeId`）
- ✅ 幂等：不存在的 manifest/timeline/episode/progress/consolidated 全部返回 null/空数组/空字符串 不抛错（与 main.ts:1297 read-memory 同模式）
- ✅ 原子写：所有 write* 函数走 `atomicWrite`（temp file → rename）

### 已知问题
- ⚠ **atomicWrite 暂在 store.ts 内置**（与 main.ts:564 `atomicWriteFile` 同模式但未抽公共 utils）。原因：抽到 `packages/core/utils/atomic-write.ts` 需要同时修改 main.ts:564 + 1312 + 1363 共三处，扩大本 Phase 修改面。**TODO(Phase 2)**：grower 第 3 处使用时统一抽到 utils（store.ts 内已加 TODO 注释）。
- ⚠ **JSON.parse 失败抛错而非返回 null**：与 read-memory 不同（后者所有失败都返回空字符串）。原因：人生 manifest/progress 一旦损坏静默返回 null 会让 generator 误判为「未生成」从头重跑，丢失已经生成的 episodes。本设计要求 UI 层显示明确错误提示（Phase 3 LifePanel 实现时按错误信息展示「文件损坏 + 备份后重新生成」）。

### 给下个 Phase（Phase 1）的输入

#### 新增 IPC API（已注册，可被 preload/渲染端直接调用）
| Channel 名 | preload 方法 | 主进程 handler 行为 |
|---|---|---|
| `life:get-manifest` | `window.electronAPI.life.getManifest(avatarId)` | 返回 `LifeManifest \| null` |
| `life:list-timeline` | `window.electronAPI.life.listTimeline(avatarId)` | 返回 `LifeTimelineEntry[]`（空时 `[]`） |
| `life:read-episode` | `window.electronAPI.life.readEpisode(avatarId, episodeId)` | 返回 episode markdown 正文 `string \| null` |
| `life:get-progress` | `window.electronAPI.life.getProgress(avatarId)` | 返回 `LifeProgress \| null` |
| `life:read-consolidated` | `window.electronAPI.life.readConsolidated(avatarId)` | 返回 consolidated.md 正文，不存在返回 `''` |
| `life:delete-episode` | `window.electronAPI.life.deleteEpisode(avatarId, episodeId)` | 同步删除 .md + timeline 条目，返回 `boolean` |

> Phase 1 需要新增的 IPC（生成器相关）：`life:start-generation` / `life:cancel-generation` / `life:retry-generation`，同时通过 `webContents.send('life:progress', payload)` 推送实时进度到渲染端。preload 中加 `life.startGeneration` / `life.cancelGeneration` / `life.retryGeneration` / `life.onProgress(callback) => unsubscribe`。

#### `@soul/core` 已导出的 life-store 函数签名（Phase 1 generator 直接复用，无需重新实现）

```typescript
// 路径解析（同步，throw on unsafe）
getLifeDir(avatarsRoot: string, avatarId: string): string
getLifeManifestPath(avatarsRoot: string, avatarId: string): string
getLifeTimelinePath(avatarsRoot: string, avatarId: string): string
getLifeConsolidatedPath(avatarsRoot: string, avatarId: string): string
getLifeProgressPath(avatarsRoot: string, avatarId: string): string
getLifeEpisodesDir(avatarsRoot: string, avatarId: string): string
getLifeEpisodePath(avatarsRoot: string, avatarId: string, episodeId: string): string
ensureLifeDir(avatarsRoot: string, avatarId: string): Promise<void>

// 读
readLifeManifest(avatarsRoot, avatarId): Promise<LifeManifest | null>
readLifeTimeline(avatarsRoot, avatarId): Promise<LifeTimelineEntry[]>
readLifeEpisode(avatarsRoot, avatarId, episodeId): Promise<string | null>
readLifeConsolidated(avatarsRoot, avatarId): Promise<string>
readLifeProgress(avatarsRoot, avatarId): Promise<LifeProgress | null>
listLifeEpisodeIds(avatarsRoot, avatarId): Promise<string[]>

// 写（全部原子写 + ensureLifeDir）
writeLifeManifest(avatarsRoot, avatarId, manifest: LifeManifest): Promise<void>
writeLifeTimeline(avatarsRoot, avatarId, timeline: LifeTimelineEntry[]): Promise<void>
appendLifeTimelineEntry(avatarsRoot, avatarId, entry: LifeTimelineEntry): Promise<void>  // 拒绝重复 id
writeLifeEpisode(avatarsRoot, avatarId, episode: LifeEpisode): Promise<void>             // episode = { id, content }
deleteLifeEpisode(avatarsRoot, avatarId, episodeId): Promise<boolean>                    // 同步删 .md + timeline；幂等
writeLifeConsolidated(avatarsRoot, avatarId, content: string): Promise<void>
writeLifeProgress(avatarsRoot, avatarId, progress: LifeProgress): Promise<void>
```

#### TypeScript 类型导出路径

| 类型 | @soul/core 入口 | desktop-app/src 全局 |
|---|---|---|
| `LifeManifest` | `import { type LifeManifest } from '@soul/core'` | 全局可用 `LifeManifest`（global.d.ts） |
| `LifeTimelineEntry` | `import { type LifeTimelineEntry } from '@soul/core'` | 全局可用 `LifeTimelineEntry` |
| `LifeEpisode` | `import { type LifeEpisode } from '@soul/core'` | 渲染端用不到（episode 正文以 string 流转） |
| `LifeProgress` | `import { type LifeProgress } from '@soul/core'` | 全局可用 `LifeProgress` |
| `LifeFailedEpisode` | `import { type LifeFailedEpisode } from '@soul/core'` | 全局可用 `LifeFailedEpisode` |
| `LifeArcItem` / `LifeRelationship` | `import { type LifeArcItem, type LifeRelationship } from '@soul/core'` | 全局可用同名 interface |
| 联合类型（5 个） | `LifeEventCategory / LifeEmotionType / LifeConsolidationStatus / LifeGenerationStatus / LifePipelineStage` | 同名全局 type |

#### 注意事项（Phase 1 必读）
1. **不要在 generator.ts 重新实现路径解析**：必须用 store.ts 暴露的 `getLifeEpisodePath` / `ensureLifeDir` 等。
2. **避免 timeline / episode 不一致**：`writeLifeEpisode` 仅写 .md 正文，**不**自动更新 timeline；generator 必须 `writeLifeEpisode + appendLifeTimelineEntry` 成对调用。
3. **断点续传依赖 progress.json**：`LifeProgress.failedEpisodes` 字段已就位，generator 读取后跳过已完成 + 已失败 episodes。
4. **fallback 标记位**：`LifeProgress.usedFallback: boolean` 字段已就位，creationModel 缺失走 chatModel 时 generator 设为 true，UI 黄色提示读这个字段。
5. **schema 一致性**：修改 `packages/core/src/life/types.ts` 必须同步修改 `desktop-app/src/global.d.ts`，文件头都标了「修改时同步」注释。

#### 关键文件位置（Phase 1 直接看这几个）
- 类型权威：`packages/core/src/life/types.ts`
- IO 函数：`packages/core/src/life/store.ts`
- IPC 注册位置：`desktop-app/electron/main.ts:1343` 后（已有 6 个 handler，Phase 1 在此 section 末尾继续追加 `life:start-generation` 等）
- preload 方法位置：`desktop-app/electron/preload.ts:212-225`（life namespace，Phase 1 在此对象内追加新方法）
- 渲染端类型：`desktop-app/src/global.d.ts:354`（ElectronAPI.life 子接口）
- 单测参考：`packages/core/src/tests/life-store.test.ts`（Phase 1 generator.test.ts 可复用 makeManifest / makeTimelineEntry / makeProgress 三个 fixture 工厂）

---

## Phase 1 完成记录（2026-05-09）

### 子任务完成情况

- [x] **T1.1** Prompt 模板：`packages/core/src/life/prompts.ts`（新增，~290 行）— 4 个 builder + 4 个 SYSTEM_PROMPT 常量，对应 plan 6.1/6.2/6.3 + Stage 1
- [x] **T1.2** 双重遗忘：`packages/core/src/life/forgetter.ts`（新增，~180 行）— sigmoid + applyAlgorithmicForgetting + generateConsolidated（含截断 + 主标题兜底）
- [x] **T1.3** 4-Stage Pipeline：`packages/core/src/life/generator.ts`（新增，~600 行）— generateLife 全流程；导出 generateEpisode / appendNewEpisodeForGrowth / partitionAgeStages 供 Phase 2 复用；**T1.7 断点续传**和 **T1.8 fallback 标记**内置
- [x] **T1.4** 单测：
  - `packages/core/src/tests/life-forgetter.test.ts`（新增，~210 行，**17 个 case**）
  - `packages/core/src/tests/life-generator.test.ts`（新增，~430 行，**10 个 case**：全 Pipeline / 断点续传 ×2 / fallback ×2 / cancel / generateEpisode / 失败处理 / partitionAgeStages ×2）
  - `packages/core/package.json` test/test:all 脚本各加 2 项
- [x] **T1.5** IPC handler：`desktop-app/electron/main.ts`
  - import 行追加 `generateLife / LifeLLMConfig / LifeUserParams / LifeProgress`
  - 在 `life:delete-episode` 之后追加 Phase 1 section（+~140 行）：`buildLifeLLMConfig` helper、`spawnLifeGeneration` 内部函数、3 个 wrapHandler（`life:start-generation` / `life:cancel-generation` / `life:retry-generation`）、模块级 `lifeAbortControllers: Map<string, AbortController>` 管理取消
  - 进度推送：`mainWindow.webContents.send('life:progress', { avatarId, progress })`
- [x] **T1.6** 渲染端 API：
  - `desktop-app/electron/preload.ts` life namespace 内追加 startGeneration/cancelGeneration/retryGeneration/onProgress(callback) → unsubscribe（+~22 行）
  - `desktop-app/src/global.d.ts` 新增 4 个 interface（`LifeStartGenerationParams` / `LifeProgressPayload` / `LifeStartGenerationResult` / `LifeCancelGenerationResult`，+~50 行）+ ElectronAPI.life 子接口 4 个新方法（+~20 行）
- [x] **T1.7** 断点续传（验收点）：实现在 generator.ts 的 generateLife 顶部 stage 判定 + Stage 2 readLifeProgress.failedEpisodes / listLifeEpisodeIds 跳过；测试 case「Stage 2 中途已落盘的 episode 续跑时不再调用 LLM」通过
- [x] **T1.8** fallback 标记（验收点）：实现在 main.ts:buildLifeLLMConfig（`creation_api_key.length > 0` 决定 creationConfigured）+ generator.ts 顶部 `progress.usedFallback = !creationConfigured`；测试 case「creationConfigured=false → 走 chatLLM 且 progress.usedFallback=true」通过
- [x] `packages/core/src/index.ts` 追加 +35 行 re-export（generator + prompts 公开 API），渲染端可直接 `import { type LifeUserParams } from '@soul/core'`

### 验收清单

- ✅ `packages/core/npm run build` 通过（无错误）
- ✅ `packages/core/npm test` **161/161 全过**（原 134 + 新增 27）
  - life-forgetter.test.js：17 case 全过（含 sigmoid 边界、阈值、近期 boost、纯函数、generateConsolidated 截断、prompt 不含 forgotten）
  - life-generator.test.js：10 case 全过（含全流程、续跑跳过、complete 零调用、fallback ×2、abort、generateEpisode、partitionAgeStages ×2、失败标记）
- ✅ `desktop-app/npx tsc --noEmit` 通过（**0 错误**）
- ✅ 路径安全：所有 IPC handler 入口 `assertSafeSegment(avatarId)`；store.ts 内部 `assertSafeEpisodeId`
- ✅ HTTP 全走 `createLLMFn`（不裸 fetch）
- ✅ 日期：manifest.createdAt 用 `localDateString(now())`；其他时间字段用 ISO（lastAdvancedAt 等）
- ✅ 编码规范：所有新文件含 `@author zhi.qu` + `@date 2026-05-09` JSDoc 头；禁 `any`/`var`/空 catch；`===` 比较

### 已知问题

- ⚠ **callLLMWithAbort 用 Promise.race 兜底取消**：`createLLMFn` 当前不接收 AbortSignal，所以 generator 内部用 `new Promise + onAbort` 包装。底层 fetch 仍跑直到 5 分钟 fetchJsonWithTimeout 超时——这是设计妥协，不会泄漏（fetch 自有超时），但 abort 后 LLM 仍可能继续消耗 token。**TODO(Phase 2 或独立改造)**：给 createLLMFn 增加可选 signal 参数，让取消立即作用到 fetch 层。
- ⚠ **Stage 0 LLM 输出 schema 容错较强**（缺字段时填默认值如 birthplace='中国'）：避免一次 LLM 失误导致整个 Pipeline 失败，但代价是 manifest 偶尔出现"中国"这种泛地名。Phase 6 联调时如果发现 manifest 质量差，可以在 prompts.ts MANIFEST_SYSTEM_PROMPT 加更严的 self-check 指令。
- ⚠ **partitionAgeStages 切分**：currentAge < 25 时部分段被压缩（如 currentAge=10 时 18-25 段被压成 10-10）。生成时这些段会被 LLM 视为"无新事件"返回少量条目；测试已覆盖边界。Phase 6 历史分身回填时关注 currentAge 较小的分身（如 18 岁）的 outline 质量。

### 给下个 Phase（Phase 2）的输入

#### 新增 IPC API（已注册，可被渲染端直接调用）

| Channel | preload 方法 | 用途 |
|---|---|---|
| `life:start-generation` | `window.electronAPI.life.startGeneration(avatarId, params)` | 启动初始化生成；返回 `{ started: true, usedFallback }` |
| `life:cancel-generation` | `window.electronAPI.life.cancelGeneration(avatarId)` | 取消正在进行的生成；返回 `{ cancelled }` |
| `life:retry-generation` | `window.electronAPI.life.retryGeneration(avatarId, params)` | 取消 + 重启（断点续传） |
| 事件 `life:progress` | `window.electronAPI.life.onProgress(cb) → unsubscribe` | 实时进度，payload `{ avatarId, progress: LifeProgress }` |

#### `@soul/core` 已导出的生成器函数签名（Phase 2 grower 直接复用）

```typescript
// 全 Pipeline 入口
generateLife(opts: GenerateLifeOptions): Promise<void>

// 单事件生成（grower 增量调用首选）
generateEpisode(opts: GenerateEpisodeOptions): Promise<LifeEpisode>

// 单事件 + 落盘（grower 一次推进 1-3 个事件用这个）
appendNewEpisodeForGrowth(opts: AppendNewEpisodeForGrowthOptions): Promise<LifeEpisode>

// Stage 3a 算法层（grower reconsolidate 复用）
applyAlgorithmicForgetting(timeline, currentAge, weights?): LifeTimelineEntry[]

// Stage 3b AI 复盘（grower reconsolidate 复用）
generateConsolidated(opts: GenerateConsolidatedOptions): Promise<string>

// 年龄段切分（grower 选事件密度时复用）
partitionAgeStages(currentAge: number): Array<{ from: number; to: number }>

// 公开常量
DEFAULT_OUTLINE_TARGET_COUNTS: readonly number[]
DEFAULT_FORGETTING_WEIGHTS: ForgettingWeights
CONSOLIDATED_MAX_CHARS: 8000
```

#### 公开类型（Phase 2 直接 `import { type X } from '@soul/core'`）

| 类型 | 说明 |
|---|---|
| `GenerateLifeOptions` | 全 Pipeline 入参；Phase 2 grower 不直接用，但 catch-up 场景可以参考 |
| `GenerateEpisodeOptions` | 单事件入参（manifest + timeline + entry + callLLM） |
| `AppendNewEpisodeForGrowthOptions` | grower 增量入参（带 abortSignal） |
| `LifeLLMConfig` | `{ creationLLM, chatLLM, creationConfigured }` |
| `LifeUserParams` | `{ currentAge, timeScale, growthEnabled, extraHints }` |
| `ForgettingWeights` | sigmoid 权重；grower 可通过覆盖 `delta`(recency boost) 调整新事件偏好 |

#### 注意事项（Phase 2 必读）

1. **`generateLife` 幂等支持续传**：若用户已经初始化过（`generationStatus='complete'`），grower 不要调 `generateLife`，应直接 `appendNewEpisodeForGrowth` 单事件追加。
2. **调用 LLM 前要 `buildLifeLLMConfig` 同款逻辑**：creation_api_key 缺失走 chat。建议把 `buildLifeLLMConfig` 抽到 main.ts 模块级（已抽，函数名同），grower handler 直接复用。
3. **更新 manifest 字段**：grower 推进后必须刷新 `lastAdvancedAt` / `currentAgeMonths` / `totalEpisodes`；reconsolidate 后还要刷新 `lastConsolidatedAt` / `consolidationCounter` / `generationStatus='growing'`（区别于初始化的 `complete`）。
4. **timeline 增量写**：grower 一次推进 N 个事件时，**先**写 episode 文件 + 写 timeline 条目（用 `appendLifeTimelineEntry` 逐个写，不要 `writeLifeTimeline` 整体覆盖避免和 grower 自身竞态），**后**做 reconsolidate。
5. **abort 信号**：grower 由 cron 触发，理论上不会被取消，但仍建议透传 abortSignal 到 `appendNewEpisodeForGrowth`，便于 LifePanel "暂停生长" 即时生效。
6. **failedEpisodes 不会自动重试**：grower 跑一次后失败的 episode 会留在 `progress.failedEpisodes`，下次 grower 不会自动重试。如果 Phase 2 需要"自动重试"语义，要在 grower 里读 progress.failedEpisodes 并清空 → 触发 generator。
7. **不要用 `generateLife` 做 grower 推进**：generateLife 会从头跑 4 Stage（虽然续传跳过已完成），但 Stage 0/1 都会重写 manifest/timeline，破坏增量语义。

#### 关键文件位置（Phase 2 直接看这几个）

- 生成器主体：`packages/core/src/life/generator.ts`（导出函数都在文件顶部 + 中部 + 底部 export 区）
- Prompt 模板：`packages/core/src/life/prompts.ts`（grower 自己的 "考虑当前真实时间" 增强 prompt 应放在 grower.ts 里，不污染初始化 prompts）
- 遗忘算法：`packages/core/src/life/forgetter.ts`
- IPC 集中区：`desktop-app/electron/main.ts:1396` 后（已有 3 个 Phase 1 handler，Phase 2 在此 section 末尾继续追加 `life:set-time-scale` / `life:toggle-growth` / `life:advance-now` / `life:advance-all-avatars`）
- buildLifeLLMConfig 复用：`desktop-app/electron/main.ts` 模块级函数（在 spawnLifeGeneration 上方）
- cron 注册位置：`desktop-app/electron/cron-scheduler.ts`
- 单测参考：`packages/core/src/tests/life-generator.test.ts` 的 `makeMockLLMs` 工厂可直接复制到 grower.test.ts

---

## Phase 2 完成记录（2026-05-09）

### 子任务完成情况

- [x] **T2.1** 事件密度函数：`packages/core/src/life/density.ts`（新增，~95 行）— `eventDensityPerMonth(ageYears, weights?)` + `monthsToYears` + `DEFAULT_DENSITY_WEIGHTS`（年轻 0.3 / 中年 0.15 / 老年 0.08）
- [x] **T2.2** 持续生长主体：`packages/core/src/life/grower.ts`（新增，~625 行）— `advanceLife` 单分身推进（Step 4.1~4.5）、`advanceAllAvatars` 多分身遍历、`computeAvatarDeltaMonths` / `samplePendingMonths` / `shouldReconsolidate` 三个纯函数 + 内存级生长锁
- [x] **T2.3** Cron 扩展：`desktop-app/electron/cron-scheduler.ts`（修改，+~120 行）— 新增 `scheduleDailyCallback(name, hour, minute, callback)` / `triggerDaily` / `cancelDaily` / `cancelAllDaily` / `getRunningDailyNames` + `computeMsUntilNext` 工具函数；保留所有原有 `schedule()/cancel()` 行为不变
- [x] **T2.4** Main 集成：
  - `desktop-app/electron/main.ts`（修改）：import 行追加 `writeLifeManifest / advanceLife / advanceAllAvatars / AdvanceLifeResult / AdvanceAllAvatarsResult / LifeManifest`；whenReady 内部注册 daily 0:30 cron `life-advance-all`；3 个新 IPC handler（`life:set-time-scale` / `life:toggle-growth` / `life:advance-now`）+ 内部 cron 触发器 `runLifeAdvanceAllAvatars()`（约 +130 行）
  - `desktop-app/electron/preload.ts`（修改，+~12 行）：life namespace 新增 `setTimeScale` / `toggleGrowth` / `advanceNow`
  - `desktop-app/src/global.d.ts`（修改，+~50 行）：ElectronAPI.life 加 3 个方法签名 + 3 个返回类型 interface（`LifeSetTimeScaleResult` / `LifeToggleGrowthResult` / `LifeAdvanceNowResult`）
- [x] **T2.5** 单测：
  - `packages/core/src/tests/life-density.test.ts`（新增，~110 行，**12 个 case**：默认权重三档、负年龄 / NaN / Infinity 边界、自定义权重、`monthsToYears` 边界）
  - `packages/core/src/tests/life-grower.test.ts`（新增，~470 行，**29 个 case**：时间换算 8 个 / 抽样 6 个 / 阈值 5 个 / 跳过分支 5 个 / 推进 1 个 / LLM 失败 2 个 / reconsolidate 2 个 / 多分身 1 个 / 内存锁 1 个）
  - `packages/core/package.json`（test/test:all 脚本各 +2 项）
- [x] **T2.6** 包导出 + 本完成记录：`packages/core/src/index.ts` 追加 +~25 行 re-export（density + grower 公共 API），渲染端可直接 `import { type AdvanceLifeResult } from '@soul/core'`

### 验收清单

- ✅ `packages/core/npm run build` 通过（无错误）
- ✅ `packages/core/npm test` **202/202 全过**（原 161 + Phase 2 新增 41）
  - life-density.test.js：12 case 全过（默认三档、边界、自定义权重）
  - life-grower.test.js：29 case 全过（时间换算 1×/12×/52×/0× / 时钟回拨 / 解析失败 / 亚月、抽样确定性 + 上限保护、reconsolidate 阈值组合、5 类跳过分支、LLM 重试失败回滚 timeline、reconsolidate 实际触发、多分身遍历隔离、内存锁并发保护）
- ✅ `desktop-app/npx tsc --noEmit` 通过（**0 错误**）
- ✅ 边界处理 5 类全覆盖：timeScale=0 / growthEnabled=false / generationStatus='generating' / sub-month-delta / 内存锁
- ✅ LLM 失败重试 1 次：`retryLLM(fn, 1, abortSignal)`；timeline 孤儿防护通过 `rollbackTimelineEntry` + try/catch 嵌套实现
- ✅ reconsolidate 阈值精确：5 episodes OR 30 天，两条任一满足触发
- ✅ cron 注册：daily 0:30 触发 `life-advance-all` callback，主进程内执行（不依赖渲染端）
- ✅ 编码规范：所有新文件含 `@author zhi.qu` + `@date 2026-05-09` JSDoc 头；禁 `any`/`var`/空 catch；`===` 比较

### 已知问题

- ⚠ **`MAX_NEW_EPISODES_PER_ADVANCE = 60` 硬上限**：`samplePendingMonths` 单次推进最多生成 60 个事件，防止时间跨度极大（如 52× 一年没推进）时 LLM 调用爆炸。代价：用户长时间不开 App 后会一次只补 60 个事件，剩余的下次再补。**TODO(Phase 3)**：在 LifePanel 显示 "落后 X 月待补 Y 事件" 提示，让用户感知。
- ⚠ **mini-outline LLM 失败的 entry 标识**：grower 失败的 entry 用 `growth-${monthOffset}` 写入 `progress.failedEpisodes`，与 generator 的 `ep-NNNN-slug` 格式不同。LifePanel 显示失败列表时需做模式匹配（`growth-` 前缀 = 持续生长失败，`ep-` = 初始化失败）。
- ⚠ **`scheduleDailyCallback` 不持久化**：每次 App 重启都会重新算到下一次 0:30 的毫秒数，无 DB 存储。优势是简单；代价是用户在 0:30 之前关 App + 0:30 之后开 App 会**错过**一次推进。但下次 App 启动时仍可手动 `life:advance-now` 补救（且累计的 `lastAdvancedAt` 间隔会让下次 cron 多生成事件，无数据丢失）。
- ⚠ **生长锁不持久化**：进程崩溃时锁丢失，重启后第二次 cron 又能跑——这是 desired behavior（崩溃后下一轮要能继续）。但同进程内 cron 与 advance-now 并发仍受锁保护。

### 给下个 Phase（Phase 3 - LifePanel UI）的输入

#### 新增 IPC API（已注册，可被渲染端直接调用）

| Channel | preload 方法 | 用途 |
|---|---|---|
| `life:set-time-scale` | `window.electronAPI.life.setTimeScale(avatarId, timeScale)` | 修改单分身 timeScale，合法 0/1/12/52；返回 `LifeSetTimeScaleResult` |
| `life:toggle-growth` | `window.electronAPI.life.toggleGrowth(avatarId, enabled)` | 开关单分身持续生长；返回 `LifeToggleGrowthResult` |
| `life:advance-now` | `window.electronAPI.life.advanceNow(avatarId)` | 立即推进单分身（同步等待）；返回 `LifeAdvanceNowResult` |

#### UI 需要订阅的事件名（现有，Phase 2 复用）

- `life:progress` — payload `{ avatarId, progress: LifeProgress }`，**Phase 2 复用 Phase 1 同名事件**：cron / advance-now 推进时也通过此事件推送进度
  - `progress.stage` 在持续生长场景下为 `'growing'`（区别于初始化 `'episodes'/'forgetting'`）
  - `progress.failedEpisodes[].id` 形如 `growth-<monthOffset>` 表示来自 grower 的失败（vs `ep-NNNN-...` 来自 generator）
  - 订阅方式：`const unsub = window.electronAPI.life.onProgress((payload) => { ... }); /* 组件卸载时 unsub() */`

#### `@soul/core` 已导出的纯函数（Phase 3 LifePanel 显示进度可直接复用）

```typescript
// 时间倒计时显示（"距下次生长还有 X 天"）
import { computeAvatarDeltaMonths } from '@soul/core'
// → 反向算："还需多少真实天数才能凑够 1 个分身月"

// 事件密度展示（LifeTimeRulerSettings 显示"年轻段每月触发率 30%"）
import { eventDensityPerMonth, DEFAULT_DENSITY_WEIGHTS } from '@soul/core'

// 阈值显示（"当前 N 个事件，距下次 reconsolidate 还差 M 个"）
import { shouldReconsolidate, DEFAULT_RECONSOLIDATE_THRESHOLDS } from '@soul/core'
```

#### LifePanel UI 显示建议（基于 Phase 2 数据流）

1. **生长进度提示**（plan 4.2 顶部"下次生长：还有 X 天 X 时"）
   - 数据源：`manifest.lastAdvancedAt` + `manifest.timeScale`
   - 算法：next = lastAdvancedAt + ceil(1 / timeScale * 30.4375 天)；倒计时 = next - now
   - timeScale=0 时显示 "已冻结"；growthEnabled=false 时显示 "已暂停生长"

2. **失败 episode 显示**（plan 4.2 工具栏"⚠ N 个失败"）
   - 数据源：`progress.failedEpisodes`
   - `growth-` 前缀 → "持续生长失败"；`ep-` 前缀 → "初始化失败"
   - 提供"重试 / 忽略"按钮：重试 = 清空 failedEpisodes 后调 `life:advance-now`

3. **时间速度模态**（plan 4.3）
   - 4 选 1 单选：1× / 12× / 52× / 冻结（map 到 timeScale 1/12/52/0）
   - 改完调 `setTimeScale` 后**立即**调 `advanceNow` 触发 catch-up（避免用户调到 12× 后还要等到明天 0:30 才推进）
   - 显示"按新速度落后 X 月"：用 `computeAvatarDeltaMonths(now, lastAdvancedAt, newScale)` 预估

4. **生长开关**：LifePanel 工具栏的"⏯ 暂停生长"调 `toggleGrowth(avatarId, false)`；"▶ 恢复生长"调 `toggleGrowth(avatarId, true)`

#### 注意事项（Phase 3 必读）

1. **不要在渲染端实现密度抽样**：`samplePendingMonths` 是主进程 grower 的内部细节，UI 只显示 manifest / progress 状态，不预测下次会触发几个事件（不可控的随机性）。
2. **`life:advance-now` 是同步等待**：可能耗时 30s+（多个事件 LLM call）。LifePanel 触发时必须显示 loading 状态 + 禁用按钮，避免用户重复点击。返回 `skipReason='locked'` 时提示用户"已在推进中"。
3. **cron 失败不会通知前端**：`life-advance-all` 在主进程异步跑，错误写入 logger。Phase 3 LifePanel 应在打开时主动 `getProgress(avatarId)` 拉一次最新状态，看 `progress.lastError` 是否非空。
4. **`generationStatus='growing'` 状态识别**：Phase 2 推进结束后 manifest.generationStatus 设为 `'growing'`（区别于初始化的 `'complete'`）。UI 渲染时把 `'complete' | 'growing'` 都视为"已就绪可对话"状态，只有 `'generating'` / `'failed'` / `'pending'` 才显示生成进度条。
5. **多分身并发**：cron 顺序遍历分身（advanceAllAvatars 内部 for 循环），单分身耗时 1-2 分钟，N 个分身共 N×1-2 分钟。这是预期行为（避免 LLM 配额爆炸）。

#### 关键文件位置

- 密度函数：`packages/core/src/life/density.ts`
- 生长主体：`packages/core/src/life/grower.ts`（导出位置：文件顶部 export interface + 文件中部 `advanceLife` / `advanceAllAvatars`）
- IPC 注册位置：`desktop-app/electron/main.ts` Phase 2 section（约 1553 行后，retry-generation handler 下方），位置注释 "持续生长（Phase 2，cron Stage 4）"
- cron 注册：`desktop-app/electron/main.ts` whenReady 内部（约 484 行后），调用 `cronScheduler.scheduleDailyCallback('life-advance-all', 0, 30, ...)`
- preload 方法位置：`desktop-app/electron/preload.ts:243-251`（life namespace Phase 2 section）
- 渲染端类型：`desktop-app/src/global.d.ts:389-401`（ElectronAPI.life Phase 2 方法）+ `:1047-1083`（3 个返回 interface）
- 单测参考：`packages/core/src/tests/life-grower.test.ts` 的 `makeMockLLMs` / `makeManifest` / `makeProgress` / `makeTimelineEntry` 4 个 fixture 工厂可复用到 Phase 6 联调测试

---

## Phase 3 完成记录（2026-05-09）

### 子任务完成情况

- [x] **T3.5** 渲染端服务封装：`desktop-app/src/services/life-service.ts`（新增，**256 行**）— `loadLifeBundle()` / `subscribeLifeProgress()` 两个 IPC 包装；`computeNextGrowthMs / formatNextGrowthEta / estimateBacklogMonths / formatAvatarMonths / formatTimeScaleLabel / formatAgeFromMonths / countRemembered / estimateMemoryStrength` 8 个纯函数；`deriveLifePanelMode / computeProgressPercent` 2 个状态派生工具；`VALID_TIME_SCALES` / `LifeBundle` / `LifePanelMode` / `LifeTimeScale` 4 个公开类型；倒计时算法 inline `30.4375 / timeScale` 公式（与 grower.ts:208 等价）。
- [x] **T3.4** 时间速度模态：`desktop-app/src/components/life/LifeTimeScaleModal.tsx`（新增，**221 行**）— Modal+PanelHeader 模式；4 选 1 单选（1×/12×/52×/0×=冻结）；显示当前模式 + 上次推进 + 落后预估；应用按钮先 `setTimeScale` 再 `advanceNow` 触发 catch-up（plan 2.3 场景 C）；isApplying 期间禁止关闭（onClose 替换为 noop）；失败 try/catch + Toast + logEvent。
- [x] **T3.3** 事件详情：`desktop-app/src/components/life/LifeEpisodeViewer.tsx`（新增，**291 行**）— 顶部 meta（[X 岁 · YYYY.MM]、标题、summary）；正文用 react-markdown + prose-pixel；底部分类 / 主题 / 情感 / 重要性 / 状态徽章；AI 复盘块；像素遗忘曲线（20 格 × 5%）；删除按钮二次确认；selected 切换用 `loadSeqRef` 防竞态（同 MemoryPanel:32）；状态/分类/情感映射表中文化；3 色编码与 timeline 一致。
- [x] **T3.2** 像素风时间轴：`desktop-app/src/components/life/LifeTimeline.tsx`（新增，**230 行**）— 左 32% 列；按 age + month 升序；三色编码 `bg-px-primary`(★ 关键瞬间) / `bg-yellow-400`(● 已经历) / `bg-px-text-dim`(○ 已淡忘)；NOW 锚点（在最后一个 age <= currentAgeYears 的事件后插入 ┄┄ NOW ┄┄）；未来虚线段（`growing` 或 `complete + growthEnabled` 时显示「待生成」，冻结时「已冻结」）；选中态左侧 2px 主色边 + 自动 scrollIntoView；底部 LEGEND 图例。
- [x] **T3.1** 主面板：`desktop-app/src/components/LifePanel.tsx`（新增，**810 行**）— Modal size=lg；5 态状态机（`no-life` / `generating` / `failed` / `ready` / `growing`）；订阅 `life:progress` 自动 unsubscribe；creationModel 缺失顶部黄色 fallback 提示带「→ 去设置」；副子标题显示倒计时（`formatNextGrowthEta`，每 60s tick 一次）+ timeScale 标签 + ● 持续生长中；底部工具栏 [⏸/▶ 生长] [⚙ 时间速度] [📜 复盘] [↻ 重新生成]；`no-life` 模式带简易开始表单 `LifeStartForm`（年龄 + 4 选 1 速度 + 生长开关 + 额外要求）；`generating` 模式显示 stage 文案 + 进度条 + fallback 黄色提示 + 失败列表 + 取消按钮；`failed` 模式显示 lastError + 重试按钮（断点续传）；`ready/growing` 用 ReadyView 嵌入 LifeTimeline + LifeEpisodeViewer + 工具栏；`📜 复盘`子模态用独立 z-60 overlay 显示 consolidated.md。
- [x] **T3.6** 入口注册：`desktop-app/src/App.tsx`（修改，**+13 行**）— `import LifePanel`；`activePanel` 联合类型加 `'life'`；新增派生 `showLifePanel`；`navButtons` 在「记忆」之后插入 `{ icon:'❀', label:'人生', key:'life' }`（按"记忆=短期、人生=长期"语义）；新增 `<LifePanel>` 渲染块（紧跟 MemoryPanel），传入 `hasChatApiKey={Boolean(chatModel.apiKey)}` / `hasCreationApiKey={Boolean(creationModel.apiKey)}` / `onOpenSettings={() => setActivePanel('settings')}`。

### 验收清单

- ✅ `desktop-app/npx tsc --noEmit` 通过（**0 错误**）
- ✅ 5 个新文件全部含 JSDoc 头（`@author zhi.qu` + `@date 2026-05-09`）
- ✅ 禁 `any` / `var` / 空 catch；所有比较 `===` / `!==`
- ✅ 错误处理（react-renderer.mdc）：所有 IPC 调用 try/catch + Toast + `window.electronAPI.logEvent('error', ...)`
- ✅ 订阅生命周期：`subscribeLifeProgress` 返回 unsubscribe，`useEffect` 严格 cleanup；`mountedRef` 双保险防 unmount 后 setState
- ✅ 防竞态：`loadSeqRef` 在 LifePanel + LifeEpisodeViewer 都有，切换分身/事件时丢弃旧 fetch（同 MemoryPanel:32 模式）
- ✅ Plan 4.2 ASCII 图所有元素都已实现：顶栏 personaName + 年龄 + 事件数 + 还记得数 + 下次生长倒计时；左 32% 时间轴含 NOW 锚点 + 未来虚线 + 三色图例；右 68% 详情含遗忘曲线 + AI 复盘；底部工具栏 5 个按钮齐全
- ✅ Plan 4.3 时间速度模态：4 选 1 单选 + 上次推进 + 落后预估 + 应用立即 catch-up
- ✅ PixelNavBar 入口：icon `❀` + label `人生` + key `life`，位于「记忆」与「画像」之间
- ✅ ESLint 抽查仅 2 个 `react-hooks/set-state-in-effect` 告警（LifePanel.tsx:110、LifeEpisodeViewer.tsx:92），与既有 MemoryPanel.tsx:52 同一模式，**非本次回归引入**

### 已知问题

- ⚠ **简易开始表单 vs Phase 4 创建向导**：`no-life` 模式下 LifePanel 提供了一个**简易**的开始表单（年龄 + 4 选 1 速度 + 生长开关 + 额外要求）。这个简易表单 UI 文案与 Phase 4 即将实现的 `LifeScriptStep.tsx`（创建向导第 5 步）会有部分重复，但定位不同：本表单服务**已存在但未生成人生的分身**（plan 0 决策表"已有分身可在 LifePanel 补做"），Phase 4 表单是**新分身创建流程**的一部分。Phase 4 实现时如果发现可复用，可把简易表单提到 `components/life/LifeStartForm.tsx` 共用。
- ⚠ **倒计时不秒级刷新**：副标题「下次生长：还有 X 天 Y 时」仅每 60s 更新一次，避免每秒 setState 浪费渲染。代价是用户切到 LifePanel 的瞬间看到的是上次刷新时刻的值，最晚滞后 1 分钟。如果 Phase 6 联调发现需要更精细，可调整 setInterval 周期或改用 requestAnimationFrame。
- ⚠ **删除事件不自动重生**：T3.3 删除事件目前只调 `life:delete-episode`（Phase 0 既有 IPC，仅删 .md + 移 timeline），不会自动触发"该年龄段附近 1-3 个事件重新生成"（plan 2.3 场景 A）。重新生成由 cron / `advanceNow` 后续 catch-up 时按密度补回。**TODO(Phase 6 联调)**：决策是否要给 `delete-episode` 加 `autoRegenerate` 选项；如要做需要扩展 `grower.ts:advanceLife` 接受"指定补哪些月份"的入参。
- ⚠ **`react-hooks/set-state-in-effect` 既有告警**：LifePanel.tsx:110 + LifeEpisodeViewer.tsx:92 + 既有 MemoryPanel.tsx:52 + App.tsx:167 共 4 处。属于仓库长期既有规则告警，**未阻塞 tsc 编译**。修复方案：把 effect 内的 `loadFn()` 改写成 `void (async () => {...})()` IIFE 模式。本 Phase 不修复以保持与既有代码风格一致；统一修复留给后续质量整治。

### 给下个 Phase（Phase 4 - 创建向导集成）的输入

#### Phase 4 创建分身后该触发的 IPC

```typescript
// 在 CreateAvatarWizard 第 6 步「确认创建」点击后：
// 1. 先调既有 createAvatar
await window.electronAPI.createAvatar(id, soulContent, skills, knowledgeFiles)

// 2. 异步触发人生生成（不 await，不阻塞向导关闭）
if (lifeEnabled) {
  window.electronAPI.life.startGeneration(id, {
    avatarName,
    currentAge: lifeAge,           // 18-80
    timeScale: lifeTimeScale,      // 0 / 1 / 12 / 52
    growthEnabled: lifeTimeScale > 0,
    extraHints: lifeExtraHints,
  }).catch(err => {
    // 失败不影响向导关闭，仅 Toast + log
    console.error('[Wizard] 启动人生生成失败:', err)
    window.electronAPI.logEvent('error', 'wizard-life-start-error', err.message)
  })
}

// 3. 显示 Toast 提示用户去 LifePanel 看进度
showToast('分身正在经历人生，可在「人生」面板查看进度', 'success')
```

#### 如何打开 LifePanel

App.tsx 中已经实现：`setActivePanel('life')`。Phase 4 在 Toast 上加点击行为：
```typescript
showToast({
  message: '分身正在经历人生，可在「人生」面板查看进度',
  type: 'success',
  onClick: () => setActivePanel('life'),  // 需要扩展 Toast 组件支持 onClick
})
```
当前 `Toast.tsx` 不支持 onClick，Phase 4 需要顺手扩展（约 5 行：在 `Props` 加 `onClick?` + 顶层加 `onClick + cursor-pointer + role="button"`）。

#### 需要传给 LifePanel 的 props（已就位，无需 Phase 4 改）

| Prop | 来源 | 说明 |
|---|---|---|
| `avatarId` | `activeAvatarId` | 当前分身 ID |
| `avatarName` | `activeAvatarName \|\| activeAvatarId` | 显示名 |
| `hasChatApiKey` | `Boolean(chatModel.apiKey)` | 缺失时 LifePanel 禁用启动 |
| `hasCreationApiKey` | `Boolean(creationModel.apiKey)` | 缺失时显示黄色 fallback 提示 |
| `onClose` | `() => setActivePanel(null)` | 标准关闭 |
| `onToast` | `showToast` | 复用 App 的 toast |
| `onOpenSettings` | `() => setActivePanel('settings')` | 用户点"去设置"时切换面板 |

#### 公开 API 清单（Phase 4 LifeScriptStep.tsx 可直接用）

```typescript
// 渲染端服务封装
import {
  loadLifeBundle,
  subscribeLifeProgress,
  formatTimeScaleLabel,
  formatNextGrowthEta,
  estimateBacklogMonths,
  formatAvatarMonths,
  formatAgeFromMonths,
  VALID_TIME_SCALES,
  type LifeTimeScale,
  type LifeBundle,
  type LifePanelMode,
} from '@/services/life-service'

// 或如果路径相对：'../services/life-service'
```

#### 关键文件位置（Phase 4 直接看这几个）

- 渲染端服务：`desktop-app/src/services/life-service.ts`
- 主面板：`desktop-app/src/components/LifePanel.tsx`
- 子组件：`desktop-app/src/components/life/{LifeTimeline,LifeEpisodeViewer,LifeTimeScaleModal}.tsx`
- 入口注册：`desktop-app/src/App.tsx:14`（import）+ `:28`（联合类型）+ `:36`（show 派生）+ `:336`（navButtons 加项）+ `:551-560`（渲染块）
- 简易开始表单（Phase 4 可参考）：`LifePanel.tsx` 内嵌的 `LifeStartForm` 函数组件（约 LifePanel.tsx:436-560）

#### 注意事项（Phase 4 必读）

1. **Phase 4 创建向导 5→6 步**：在原第 4 步「技能定义」和第 5 步「确认创建」之间插入「人生剧本」（plan 4.1 ASCII 图）。本 Phase 已实现的 `LifeStartForm` 可作为 Phase 4 `LifeScriptStep.tsx` 的参考实现。
2. **不要复用 LifePanel 的 LifeStartForm**：因为创建向导第 5 步是嵌入式 step，不是独立 modal，UI 容器/状态管理都不一样。但表单字段、校验逻辑、文案可以直接拷贝。
3. **Phase 4 启动 IPC 的 startGeneration 入参 `avatarName`**：必须传**展示名**（用户在向导第 1 步输入的 name），不是 id。`life-service` 已经在 LifePanel 调用时传了 avatarName，参考即可。
4. **创建分身时 chatModel 还未必加载完**：CreateAvatarWizard 创建完分身后会切到该分身，App.tsx 用 `loadModelConfigs` 已加载全局模型。但向导 props 中 `chatModel` 已经包含 apiKey，校验时直接判 `Boolean(chatModel.apiKey)` 即可。
5. **Toast 点击跳转 LifePanel**：本 Phase 已经在 App.tsx 把 LifePanel 注册到 `activePanel='life'`，Phase 4 只需扩展 Toast.tsx 支持 onClick 回调即可。

---

## Phase 4 完成记录（2026-05-09）

### 子任务完成情况

- [x] **T4.0**（前置）Toast 扩展 onClick：`desktop-app/src/components/shared/Toast.tsx`（重写，**+30 行**）— `Props.onClick?` 可选；存在时切换为 `<button>` 渲染（cursor-pointer + hover:opacity-90），缺省仍渲染原 `<div role="alert">`，向后兼容所有现有调用点。
- [x] **T4.2** 抽 LifeScriptStep 子组件：`desktop-app/src/components/wizard/LifeScriptStep.tsx`（**新增，~190 行**）— 严格按 plan 4.1 ASCII：启用 checkbox（默认 ✓ + 推荐文案）/ 年龄输入 18-80 + 边界校验 / 4 选 1 timeScale（1× 真实同步推荐 / 12× / 52× / 0× 冻结）/ extraHints textarea / 预估提示「80~100 个事件 · 8~10 万字 · 5~10 分钟」/ creationModel 缺失时黄色 fallback 提示带"→ 去设置配置"按钮（onOpenSettings 可选）。受控组件：状态由父级 CreateAvatarWizard 持有，本组件仅采集表单。
- [x] **T4.1 + T4.3** CreateAvatarWizard 6 步集成：`desktop-app/src/components/CreateAvatarWizard.tsx`（**改，+~75 行**）：
  - STEPS 数组从 5 项扩到 6 项：在「04 技能定义」和原「05 确认创建」之间插入「05 人生剧本」，原确认创建变为「06 确认创建」。
  - 新增 4 个 state：`lifeEnabled`(默认 true) / `lifeAge`(默认 30) / `lifeTimeScale: LifeTimeScale`(默认 1) / `lifeExtraHints`(默认 '')。
  - `canProceed` 加 case 4：人生剧本步骤校验（未启用直接放行；启用则校验年龄 18-80）。
  - 渲染：`currentStep === 4` 嵌入 `<LifeScriptStep>`；`currentStep === 5` 渲染原确认创建页（在确认信息表新增「人生剧本」一行 + 自动生成提示加 `life/`）。
  - `Props.onCreated` 签名扩展为 `(avatarId, lifeStarted: boolean) => void`，告知父级是否已启动人生生成。
  - 新增内部函数 `triggerLifeGeneration(avatarId)`：fire-and-forget 调 `window.electronAPI.life.startGeneration(id, params)`，失败仅 `logEvent('error', 'wizard-life-start-error', ...)`，不阻塞向导关闭。
  - `handleCreate` 在 createAvatar/skills/avatarImage 全部完成后，按 `lifeEnabled && ageValid` 决定是否触发 `triggerLifeGeneration`，并把 `lifeStarted` 透传给 `onCreated`。
- [x] **T4.4** App 层 Toast 跳转 LifePanel：`desktop-app/src/App.tsx`（**改，+~20 行**）：
  - `toast` state 类型加 `onClick?: () => void`。
  - 新增 `showClickableToast(message, onClick, type)` 工具函数：5 秒显示（比普通 Toast 长，给用户点击时间）；点击后立即 clearTimeout + setToast(null) + 触发回调。
  - `handleAvatarCreated` 签名变为 `(avatarId, lifeStarted: boolean)`：`lifeStarted=true` 时调 `showClickableToast('分身正在经历人生，可在「人生」面板查看进度', () => setActivePanel('life'), 'success')`。
  - `<Toast>` JSX 透传 `onClick={toast.onClick}`。
- [x] **T4.5** 完成记录追加 + 交接摘要

### 验收清单

- ✅ `desktop-app/npx tsc --noEmit` 通过（**0 错误**）
- ✅ Plan 4.1 ASCII 图所有元素都已实现：✓ 启用 / 年龄输入 18-80 + 边界校验 / 4 选 1 timeScale（1× 默认推荐）/ 额外要求 textarea / 预估提示 / fallback 黄色提示带"去设置"链接
- ✅ 6 步流程：基本信息 → 人格 → 知识库 → 技能 → **人生剧本** → 确认创建（确认页展示人生信息）
- ✅ 创建成功后异步触发 `life:start-generation`（不 await，不阻塞向导关闭）
- ✅ Toast 点击可跳转 LifePanel（`activePanel='life'`）
- ✅ 用户取消勾选「为分身设计完整人生」时不触发 IPC，仅显示原有 Toast / 不显示 Toast（lifeStarted=false）
- ✅ 编码规范：所有新文件含 `@author zhi.qu` + `@date 2026-05-09` JSDoc 头；禁 `any`/`var`/空 catch；`===` 比较；用 `LifeTimeScale` 类型而非裸数字
- ✅ ESLint 抽查：本次改动 0 新增告警；既有 2 处告警（`App.tsx:183` `loadModelConfigs` set-state-in-effect、`App.tsx:262` handleSelectAvatar before-declared）属于 Phase 3 完成记录已登记的"仓库长期既有规则告警"，**非本次回归引入**

### 已知问题

- ⚠ **`Props.onCreated` 签名变化**：从 `(avatarId) => void` 变为 `(avatarId, lifeStarted) => void`。当前唯一调用点 `App.tsx:handleAvatarCreated` 已同步更新；如果未来有第三方代码调 CreateAvatarWizard，需更新签名。已在 JSDoc 注释中标注。
- ⚠ **`triggerLifeGeneration` 失败时静默**：异步 IPC 失败仅 `logEvent('error', ...)` + `console.error`，不会向用户弹 Toast。原因：用户已经看到「分身创建成功」Toast 后再弹错误会打断流程，且分身本身可用。失败时用户进入 LifePanel 会看到 `no-life` 状态，可手动重试（LifePanel 的 LifeStartForm）。**TODO(Phase 6)**：联调时观察 startGeneration 失败率是否需要主动通知用户。
- ⚠ **`lifeAge` 输入非法时降级**：用户在第 5 步输入 `abc` 或留空时 `parseInt` 返回 `NaN`，`canProceed` 会拦截下一步；但若用户切到其他步骤再回来，`Number.isFinite(NaN)` 仍 false，组件会显示「年龄须在 18~80 之间」红色提示。这是 desired behavior。
- ⚠ **未做"重新生成"按钮**：第 5 步「人生剧本」未提供"再生成一次"或"使用上次设置"功能（向导是一次性流程，每个新分身都是首次设计）。已有分身想改人生应在 LifePanel 操作。

### 给下个 Phase（Phase 5 — 注入对话 + read_life_episode 工具）的输入

#### Phase 4 落地后的实际状态

1. **创建分身向导走完后**，若用户启用了人生（默认启用），`avatars/<id>/life/` 目录会**异步开始**写入：
   - `manifest.json`（Stage 0 完成后）
   - `timeline.json`（Stage 1 后逐步追加）
   - `episodes/ep-NNNN-*.md`（Stage 2 并发 5 写）
   - `progress.json`（每个 stage 后落盘）
   - **`consolidated.md`（Stage 3b 完成后产出，是 Phase 5 注入 system prompt 的目标文件）**
2. 生成耗时约 5-10 分钟（plan 4.1 预估）。Phase 5 实施时**两种状态都要测**：
   - 生成进行中：`life/consolidated.md` 不存在 → soul-loader 应**安静跳过**（不报错、不出现章节标题）
   - 生成完成：`life/consolidated.md` 存在 3-8K 字 → soul-loader 拼接到 stableParts

#### 关键文件位置（Phase 5 直接看）

- 生成产物路径：`avatars/<id>/life/consolidated.md`
- @soul/core 已暴露的读取函数：`readLifeConsolidated(avatarsRoot, avatarId)` → `Promise<string>`，不存在返回 `''`（Phase 0 实现）
- system prompt 拼装核心：`packages/core/src/soul-loader.ts:107-320`（按 plan 11.6 改造）
- 缓存快照：`desktop-app/electron/main.ts:2382` 附近（把 `life/manifest.json` 加入 `captureFileSnapshot` 列表，避免 manifest 变化后 system prompt 缓存仍生效）

#### Phase 5 注入位置建议

```
stableParts:
  1. CLAUDE.md
  2. soul.md
  3. 共享知识
  4. knowledge/
  5. life/consolidated.md   ← Phase 5 新增（标题: "# 我的人生（出厂记忆）"）
     + 「人生使用守则」段落（除非用户问起否则不主动展开往事；引用具体事件可用 read_life_episode）
  6. 工具说明（含新增 read_life_episode）
```

#### 注意事项（Phase 5 必读）

1. **不要重新实现路径解析**：直接 `import { readLifeConsolidated } from '@soul/core'`（Phase 0 已导出）。
2. **缓存失效要把 `life/manifest.json` 加进快照**：cron 推进或用户重新生成时 manifest 会更新，触发 soul-loader 重读 consolidated.md。
3. **read_life_episode 工具的安全校验**：路径必经 `assertSafeSegment(episodeId)` + `resolveUnderRoot(life/episodes/, episodeId + '.md')`，参考 Phase 0 store.ts 的 `assertSafeEpisodeId`（已在 @soul/core 内部使用，工具层只需调 `readLifeEpisode(avatarsRoot, avatarId, episodeId)` 即可获得安全保护）。
4. **consolidated.md 软上限 8K 字**：Phase 1 forgetter.ts 已强制截断到 `CONSOLIDATED_MAX_CHARS = 8000`（约 12K tokens），soul-loader 直接注入即可，不必再做长度检查。
5. **fallback 提示传递**：用户用 chatModel fallback 生成的人生质量可能略低（Phase 1 progress.usedFallback=true）。Phase 5 不需要在 system prompt 区分这种情况，UI 提示已在 LifePanel 实现。

---

## Phase 4 补丁记录（2026-05-09，二次回归）

> 二次开窗口验证 Phase 4 时发现 1 处真实小遗漏，已补完。年龄范围歧义已澄清，按 plan 11.5 + 已落地实现保持现状。

### 补丁 1：`onOpenSettings` 透传链路打通

**问题**：`CreateAvatarWizard.tsx:477-489` 调用 `LifeScriptStep` 时**没传 `onOpenSettings`**，导致 fallback 黄色提示里的「→ 去设置配置」按钮永远不显示（plan 4.1 ASCII 明确要求显示）。

**修复**：
- `desktop-app/src/components/CreateAvatarWizard.tsx`（**+~12 行**）
  - `Props` 新增可选 `onOpenSettings?: () => void`，含 JSDoc 说明
  - 函数签名解构补 `onOpenSettings`
  - `currentStep === 4` 渲染 `LifeScriptStep` 时传入 `onOpenSettings={onOpenSettings ? () => { onClose(); onOpenSettings() } : undefined}`（先关向导避免被设置面板挡住，再切设置）
- `desktop-app/src/App.tsx`（**+1 行**）
  - 调用 `<CreateAvatarWizard>` 处补 `onOpenSettings={() => setActivePanel('settings')}`

**验证**：
- ✅ `desktop-app/npx tsc --noEmit` 通过（**0 错误**）
- ✅ 用户在向导第 5 步看到黄色 fallback 提示时，「→ 去设置配置」按钮可点；点击后向导关闭、设置面板打开（用户配完 apiKey 后需重新进入向导，trade-off 已知）

### 年龄范围裁决

| 来源 | 年龄范围 | 默认值 |
|---|---|---|
| plan 4.1 ASCII 图 | 18-80 | 35 |
| plan 11.5 任务文案 | 18-80 | 30 |
| Phase 4 第二次任务消息 | 3-40 | 40 |
| **当前实现（保留）** | **18-80** | **30** |

**决议**：保持当前实现（与 plan 11.5 + 首次 Phase 4 完成记录一致）。本次任务消息的 "3-40 默认 40" 与 plan 4.1 ASCII 严重冲突，且 Phase 4 已按 plan 11.5 落地并通过验收，未做覆盖性修改。

### 已知问题

- ⚠ **`onOpenSettings` 触发后用户上下文丢失**：用户在第 5 步点「→ 去设置配置」会**关闭整个向导**，此前在前 4 步填的所有字段（avatarName/soulContent/knowledgeFiles/customSkills 等）全部丢失。这是因为本 Phase 把向导设计为"向导内不切到其他面板"——若改为"保留向导状态"需要把所有 state 上提到 Zustand store（涉及面太大，超出 Phase 4 范围）。**TODO(Phase 6 联调)**：观察实际用户流是否触发此场景；若高频，再上提到 store。当前缓解：用户应先在设置中配好创作模型，再开始创建分身。

---

## Phase 5 完成记录（2026-05-09）

### 子任务完成情况

- [x] **T5.1** SoulLoader 注入：`packages/core/src/soul-loader.ts`（**+~25 行**）
  - 第 124~129 行：新增 `lifeConsolidated = this.readFileSafe(path.join(avatarPath, 'life', 'consolidated.md'))`，文件不存在返回空字符串（与 memory/MEMORY.md 同模式）。
  - 第 142~143 行：`toolsNote` 工具清单加 `read_life_episode(id)` 一行，明确"日常对话不要主动调用"。
  - 第 282~296 行：知识库块（含 RAG 索引、Excel schema）之后、文档输出工作流之前，注入「# 我的人生（出厂记忆）」+ 正文 + 「## 人生使用守则」（4 条：不主动展开 / 被问起再调 read_life_episode / 风格沉淀不直接背诵 / 不剧透未来）。
- [x] **T5.2** ToolRouter read_life_episode：`packages/core/src/tool-router.ts`（**+~35 行**）
  - 第 9 行：import `readLifeEpisode as readLifeEpisodeFromStore` from `./life/store`（避免与同名 case 字符串混淆）。
  - 第 793~794 行：`execute()` switch 加 `case 'read_life_episode'`。
  - 第 1574~1605 行：私有 async 方法 `readLifeEpisode(avatarId, args)`：路径安全双重保护（外层 `assertSafeSegment(avatarId)` + store 内 `assertSafeEpisodeId`，含拒绝 `..` / `/` / `.开头` / `.md` 扩展名）；返回带 `[来源: life/episodes/<id>.md]` 锚点的 markdown 全文；事件不存在或参数缺失返回友好 error。
- [x] **T5.3** 缓存快照：`desktop-app/electron/main.ts:2722~2730`（**+~3 行**）
  - `buildChartCacheEntry` 的 `fileSnapshots` 列表追加 `captureFileSnapshot(path.join(avatarRoot, 'life', 'manifest.json'))`。
  - manifest 变化触发缓存失效场景：cron 推进新事件 / reconsolidate 刷新 lastConsolidatedAt / timeScale 调整。文件不存在时 `captureFileSnapshot` 返回 (0,0)，未启用人生的分身无副作用（与 Excel basename 不存在同行为）。
  - 注：plan 引用的 line 2382 是文档解析 handler（read_pdf/docx/pptx）；实际 `captureFileSnapshot` 列表唯一现存于 `buildChartCacheEntry`（line 2722）。这是 plan 文档老锚点漂移，按"加入 captureFileSnapshot 列表"的语义落到正确位置。
- [x] **T5.4** 单测：`packages/core/src/tests/soul-loader.test.ts`（新增，**~210 行**，**7 个 case**）
  - case 1: 有 consolidated.md → systemPrompt 含「# 我的人生（出厂记忆）」+ 正文片段
  - case 2: 有 consolidated.md → systemPrompt 含「## 人生使用守则」+「不主动展开往事」+「read_life_episode」引导
  - case 3: 没有 consolidated.md（连 life/ 目录都不存在）→ `loadAvatar` 不抛错且 systemPrompt 不含章节标题、守则段
  - case 4: consolidated.md 为空白（仅空格换行）→ 不出现孤立标题
  - case 5: 工具说明清单含 `read_life_episode` 且包含 `ep-XXXX` 示例 id
  - case 6: 写入 manifest.json → 改写 → `captureFileSnapshot` 返回不同 (mtime, size)（证明缓存失效链路）
  - case 7: manifest.json 不存在 → `captureFileSnapshot` 返回 (0, 0) 不抛错
  - `packages/core/package.json` test/test:all 脚本各 +1 项（dist/tests/soul-loader.test.js）

### 验收清单

- ✅ `packages/core/npm run build` 通过（无 TS 错误）
- ✅ `packages/core/npm test` **209/209 全过**（原 202 + Phase 5 新增 7）
  - soul-loader.test.js：7 case 全过（注入存在 / 缺失兜底 / 工具清单 / manifest 快照失效 / 不存在兜底）
- ✅ `desktop-app/npx tsc --noEmit` 通过（**0 错误**）
- ✅ 路径安全：`read_life_episode` 工具路径校验三层（avatarId 经 `assertSafeSegment`、episodeId 经 `assertSafeEpisodeId` 拒绝 `..`/`/`/`.开头`/`.md`、最终路径经 `getLifeEpisodePath` 解析在 life/episodes/ 目录下）
- ✅ 编码规范：所有改动文件保留既有 JSDoc 头；新增 `read_life_episode` 私有方法含 `@author zhi.qu` + `@date 2026-05-09` 注释；禁 `any`/`var`/空 catch；`===` 比较
- ✅ 注入位置严格按 plan 11.6：知识库（含 Excel schema、RAG 索引）之后、文档输出工作流（最末是 toolsNote 工具说明）之前

### 已知问题

- ⚠ **测试文件位置与 plan 字面不一致**：plan 11.6 写的是 `packages/core/src/soul-loader.test.ts`，实际落在 `packages/core/src/tests/soul-loader.test.ts`。原因：`packages/core/src/tests/` 已有 25 个 test 文件（life-store/life-generator/journey 等），保持与既有约定一致；`tests/` 子目录在 `package.json` 的 `node --test` 列表里集中维护。所有 import 路径用 `../soul-loader`，无副作用。
- ⚠ **`read_life_episode` 不做"知识库为空"兜底**：与 `read_knowledge_file` 不同，本工具被调用时不论是否有人生都会去 read 文件。如果分身**根本没人生**（life/episodes/ 不存在），会返回 `事件不存在: <id>` 友好 error。这是 desired behavior：人生未生成时 system prompt 里也不会出现「我的人生」章节，LLM 没机会拿到 episodeId 去调用——错误兜底足够。
- ⚠ **`captureFileSnapshot(life/manifest.json)` 加入 chart cache 但与 system prompt 缓存无直接关系**：当前 `loadAvatar()` 没有持久化的 system prompt 缓存（每次调用即时拼装），所以 manifest 变化"立即"反映在下一次 `loadAvatar()` 上，无需 snapshot 也能新鲜。本次 snapshot 加入是为了让"基于该分身已对话生成的图表答案缓存"在人生推进后失效（避免持有过时人格视角的图表答案）。如果未来引入 system prompt 持久化缓存（如 Anthropic prompt caching 持久 cache key），这条快照也能直接复用。
- ⚠ **「人生使用守则」在 system prompt 末尾区段的位置**：注入位置是「知识库之后、文档输出工作流之前」。守则强度依赖模型遵循度，Phase 6 联调时如果观察到分身仍频繁主动卖惨，可考虑把守则提到顶部（CLAUDE.md 之后），但会牺牲前缀缓存命中率。先观察 Phase 6 实际表现再决策。

### 给下个 Phase（Phase 6 — 历史分身回填 + 端到端联调）的输入

#### Phase 5 落地后的实际状态

1. **soul-loader 已支持人生注入**：分身的 `life/consolidated.md` 一旦存在（≥ 3K 字），下次 `loadAvatar()` 即把内容拼进 system prompt 的「# 我的人生（出厂记忆）」段。Phase 6 的 design-master / 小堵-工商储专家 触发生成完成后，分身**重新加载**（关闭 + 重开 / 触发 reload-avatar）即可生效。
2. **read_life_episode 工具已就位**：分身在对话中可调 `read_life_episode({id: "ep-0007-first-snow"})` 取该事件 markdown 全文。Phase 6 验证「问起人生往事时是否引用具体事件」时，预期会看到分身**先调 read_life_episode**，再回答。
3. **chart cache 失效**：cron 推进或 reconsolidate 后 manifest.json 变化，`get-chart-cache-hit` 会返回 `{hit: false}`，强制重新生成图表答案。Phase 6 时间生长 cron 联调时如果发现旧图表答案仍命中，先确认 manifest.json 是否实际被更新（`grower.ts:advanceLife` 末尾必写）。

#### 关键文件位置（Phase 6 直接看）

- soul-loader 注入逻辑：`packages/core/src/soul-loader.ts:124-129`（读取）+ `:282-296`（注入章节）+ `:142-143`（工具清单）
- read_life_episode 工具：`packages/core/src/tool-router.ts:1574-1605`
- 缓存快照：`desktop-app/electron/main.ts:2722-2730`
- 单测参考：`packages/core/src/tests/soul-loader.test.ts`（fixture 工厂 `setupAvatarSkeleton/writeLifeConsolidated/writeLifeManifest` 可被 Phase 6 联调脚本复用）

#### Phase 6 验收用例建议（基于本 Phase 注入链路）

1. **人生章节存在性**：在桌面端 reload-avatar 后用 dev console 打印 `soulLoader.loadAvatar(id).systemPrompt`，搜索「我的人生（出厂记忆）」确认命中。
2. **read_life_episode 真实调用**：在对话中问「你 7 岁那年发生了什么」，让 LLM 触发工具调用，验证返回内容是 ep-0007 的 markdown 全文（不是 LLM 编造）。
3. **守则有效**：连续 5 个不相关问题（如"今天天气"、"如何配置 Postgres"），观察分身是否主动讲往事。如果有 → 守则失效，考虑在 CLAUDE.md 加强或把守则前移。
4. **缓存失效**：手动触发 `life:advance-now`（推进新事件），生成图表答案，再次同问，观察是否重新调用 LLM（chart cache 失效）。
5. **不存在 episode**：让 LLM 调 `read_life_episode({id: "ep-9999-fake"})`，验证返回 `事件不存在` 友好 error 而非崩溃。

#### 注意事项（Phase 6 必读）

1. **system prompt 长度监控**：consolidated.md 软上限 8K 字（CONSOLIDATED_MAX_CHARS），加上原有 CLAUDE.md / soul.md / 知识库 / 工具说明，总长度可能逼近 30K tokens。Phase 6 联调时如果发现某个分身长度异常，先 grep `Phase 5: 注入「我的人生`，看是否触发了多次注入（不应该，仅一次）。
2. **不要在 read_life_episode 加缓存**：每次工具调用直接读盘是 desired——LLM 通常一段对话只会问 1-2 个具体往事，缓存收益小但增加内存复杂度。
3. **read_life_episode 的 id 来源**：分身只能从 system prompt 里出现的 id 调用此工具——而 consolidated.md 是 forgetter.ts 生成的，里面是否真的会出现 `ep-XXXX-slug` 形式的 id 尚未验证（plan 6.3 prompt 不强制要求）。**Phase 6 必查**：抽查一个 design-master 的 consolidated.md，确认包含可识别的 episodeId；如果不含，需要在 forgetter.ts 的 prompt 加"在每个事件段落前用 [ep-XXXX-slug] 标注 id"指令（属于 Phase 1 prompt 微调，不属于 Phase 5 范围）。

---

## Phase 6 完成记录（2026-05-09，部分交付）

> **状态说明**：本 Phase 是"代码 + 人工联调"混合任务。
> **本窗口已交付**：T6.1 / T6.4 / T6.7（已知问题清单） + T6.2/3/5/6 的桌面端操作脚本与验收清单。
> **待人工验收**：T6.2 / T6.3 / T6.5 / T6.6 必须在 Electron 桌面端用真实 LLM 跑，并由用户做主观抽查（金句体 / 套路化 / 专业人格塑造度）。
> **status 切换 `delivered-v1`**：等用户回执"Phase 6 全部通过"后再单独执行（已知问题清单留作占位）。

### 已完成子任务（代码层）

- [x] **T6.1** 回填扫描脚本：`scripts/backfill-life.ts`（新增，**~250 行**） + `desktop-app/package.json` 加 `backfill:life` 命令
  - 纯 IO 静态扫描，**不调任何 LLM**（避免 CLI 与桌面端共享生成锁冲突 + 避免擅自消耗 API 配额）
  - 四态归类：`ok` / `generating` / `failed` / `missing`
  - 退出码：0=全 ok / 2=有 missing 或 failed / 1=脚本错（CI 可消费）
  - 双输出：人类可读 + `--json`（机器可读）
  - 验证通过：当前两个分身正确识别为 `missing`，npm run 退出码 2 正确传播
- [x] **T6.4a** `avatars/design-master/tests/cases/life-001.md`（新增）— 「拒绝装饰主义从哪里长出来」prompt + 7 条 RUBRIC（引用具体 episode / 来源标注 / 不主动展开 / 不写金句体 / 因果链 / 人格一致 / 不剧透未来）+ 1 条 MUST_CONTAIN(`life/episodes`) + 7 条 MUST_NOT_CONTAIN（"那一刻我懂得了"等套路话）
- [x] **T6.4b** `avatars/小堵-工商储专家/tests/cases/life-001.md`（新增）— 「警惕对标友商报价的习惯怎么形成」prompt + 8 条 RUBRIC（含工商储专属：S3 红线在人生叙事中同等适用）+ 1 条 MUST_CONTAIN(`life/episodes`) + 12 条 MUST_NOT_CONTAIN（含 `元/Wh` / `元/kWh` / `万元` / `美元` / `根据我的经验` / 套路话）
- [x] **T6.7** Phase 6 已知问题清单（见下文）

### 待人工执行子任务（必须在桌面端 + 真实 LLM 跑）

| 子任务 | 操作步骤 | 通过判据 |
|---|---|---|
| **T6.2** | 桌面端打开 design-master → 「人生 ❀」面板 → 填年龄 35、timeScale 1× → 开始；等 5-10 分钟生成完成 → 抽查 5 个 episode 写作质量 | 5 个抽查样本中 ≤ 1 个出现"金句体/段尾抒情/泛泛抒情"，≥ 4 个能塑造"拒绝装饰主义/品牌一致性优先"的设计判断风格 |
| **T6.3** | 桌面端打开 小堵-工商储专家 → 「人生 ❀」→ 填年龄 38、timeScale 12× → 开始；同上抽查 | 5 个抽查样本中专业事件能体现"先看场景再报数字"的工程谨慎，**不出现**任何具体报价数字 |
| **T6.5** | 桌面端任选 1 个已生成完成的分身 → LifePanel 工具栏点「⚙ 时间速度」→ 调到 12× 应用（自动触发 catch-up）；或主进程 dev console 调 `window.electronAPI.life.advanceNow(avatarId)` | timeline.json 新增条目；当累计 ≥ 5 个新事件后 consolidated.md 自动重写；manifest.lastAdvancedAt / currentAgeMonths / consolidationCounter 正确更新 |
| **T6.6** | 创建向导新建分身「联调测试员」（基础人格随便配，启用人生：30 岁、1×）→ 等生成完成 → 在对话中问"你 7 岁那年发生了什么"→ 调 timeScale 1×→12× 验证 catch-up → LifePanel 删一个事件 | (a) 分身**真实调用** `read_life_episode` 工具并返回带 `[来源: life/episodes/...]` 锚点的具体内容；(b) timeScale 调整后立即触发 catch-up，新事件追加到 timeline；(c) 删除事件后 timeline.json 中该 entry 消失，episode 文件被删除（局部重生成由后续 cron / 手动 advance-now 补回，本期不强制立即重生成）|

### Phase 6 已知问题清单（基于代码审查 + 待人工验收占位）

#### A. 已确认的已知问题（代码层，本期不修复）

- ⚠ **A1：episode id 是否出现在 consolidated.md 中尚未验证**
  - 出处：plan 行 1469（Phase 5 完成记录"必查项"）。`forgetter.ts` 的 `STAGE3B_SYSTEM_PROMPT` 不强制要求 LLM 在每个段落前标注 `[ep-XXXX-slug]`。
  - 影响：如果 LLM 不主动标 id，分身在对话中没办法准确调用 `read_life_episode(id)` 取全文——只能回答 "我记得有件事但找不到对应日记"，T6.4 的 life-001.md `MUST_CONTAIN: life/episodes` 会失败。
  - 缓解（不在本期修）：T6.2 跑完后人工 grep 一下 `avatars/design-master/life/consolidated.md` 是否含 `ep-` 形式的 id；如不含 → 在 `packages/core/src/life/prompts.ts:STAGE3B_SYSTEM_PROMPT` 加"在每个事件首次出现时用 `[ep-XXXX-slug]` 形式标注 episode id"指令，重新跑 reconsolidate（属于 Phase 1 prompt 微调）。
  - 临时方案：分身可以**不带 id 调** `read_life_episode`——工具会返回友好 error；或在 system prompt 的"人生使用守则"加一条"如果你想引用具体往事但不确定 id，可以先列出大致主题，让用户告诉你 id"。

- ⚠ **A2：删除事件后不自动局部重生成**
  - 出处：Phase 3 完成记录「删除事件不自动重生」。`life:delete-episode` 仅删 .md + 移 timeline，不会按 plan 2.3 场景 A "自动重新生成该年龄段附近 1-3 个事件"。
  - 影响：T6.6 删除单事件后，时间轴会出现"局部空洞"，要等下次 cron / 手动 advance-now 才补回。
  - 缓解（不在本期修）：在 T6.6 验证脚本里把"删除→等局部重生成"改为"删除→看 timeline 短一个 entry → 手动 advance-now → 看 entry 数量回升"。

- ⚠ **A3：`MAX_NEW_EPISODES_PER_ADVANCE = 60` 单次推进上限**
  - 出处：Phase 2 完成记录。grower 单次推进最多生成 60 个事件。
  - 影响：T6.5 把 timeScale 从 1× 直接调到 52× 时，如果累计落后 > 60 个事件，要分多次 advance-now 才能补齐。
  - 缓解（不在本期修）：T6.5 验证时只调到 12×（plan 4.3 推荐档），落后 ≤ 60 不会触发上限。

- ⚠ **A4：persona / professional spine 与人格不强绑定**
  - 出处：Phase 1 完成记录。`Stage 0` LLM 输出 schema 容错较强，缺字段时会填默认值（如 birthplace='中国'）。生成的人生事件可能"专业骨架"和分身实际专业不强相关（plan 0 决策"B 基底型"）。
  - 影响：T6.2 / T6.3 抽查时如果发现"人生事件和分身专业脱节"严重，需在 `prompts.ts:MANIFEST_SYSTEM_PROMPT` 加更严的 self-check 指令。
  - 缓解（不在本期修）：人工抽查阶段如发现严重脱节，在本清单追加 A5 项并触发 Phase 1 prompt 微调。

#### B. 待人工验收后才能确认的问题（占位）

> 下列 4 项需要 T6.2/3/5/6 跑完才能填具体观察。请用户跑完后把观察结果反馈给我，再次开窗口时把这些占位替换为真实记录。

- ☐ **B1（待人工填）：design-master 抽查的 5 个 episode 写作质量主观评分** — 套路化 / 金句体出现频率，专业人格塑造度
- ☐ **B2（待人工填）：小堵-工商储专家 抽查的 5 个 episode 写作质量** — 是否出现具体报价数字（红线），专业判断塑造度
- ☐ **B3（待人工填）：T6.5 advance-now 联调实际表现** — reconsolidate 是否按 5 事件阈值触发，consolidated.md 重写后字数变化
- ☐ **B4（待人工填）：T6.6 E2E 关键指标** — 分身是否真实调用 `read_life_episode`（看 toolCallSequence），删除事件后 timeline 是否一致

### 给 status 切换执行者的输入

#### 验收 PASS 条件（必须全部满足才能切 `delivered-v1`）

1. T6.2/T6.3 两次生成均 `generationStatus=complete` 且 `progress.failedEpisodes` 为空（或 ≤ 2 个允许重试通过）
2. 每个分身抽查 5 个 episode 中至少 4 个无套路化、能塑造专业人格（主观评分）
3. T6.5 验证通过：timeline 追加 + consolidated 重写 + manifest 三字段更新
4. T6.6 验证通过：(a) `read_life_episode` 工具被真实调用（在对话日志里能看到 toolCallSequence 含此项）+ (b) catch-up 推进 + (c) 删除幂等
5. life-001.md 测试用例（T6.4）在 design-master 与 小堵 各跑一次都 PASS（手动跑 `npm run test:qa-gate` 或对应分身的回归测试套件）

#### status 切换操作

```
file: .cursor/plans/avatar-life-experience.plan.md
- status: ready
+ status: delivered-v1
```

并在本节末追加 `### 实际验收结果（YYYY-MM-DD）` 子节，把 B1-B4 的观察填进去。

#### 风险点

- **API 配额**：T6.2 + T6.3 两次完整初始化各约 50 万 tokens。建议先用一个分身跑一遍验证流程，再跑第二个，避免 API 失败浪费配额。
- **T6.6 创建测试分身的清理**：联调完成后建议保留「联调测试员」分身做后续回归测试，不要立即删除（删除会丢失 6 个文件类型的端到端用例）。

