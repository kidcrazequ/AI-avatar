# AI 分身办公室 NPC 游戏化设计方案

> 版本：v0.1  
> 日期：2026-06-25  
> 目标：把「AI 分身办公室」从页面动画改成像素游戏视角的 NPC 办公室。  
> 关联：`docs/soul-pig-character-standard.md`、`desktop-app/src/components/AvatarOffice.tsx`

## 1. 方向判断

AI 分身办公室不应继续按普通产品页面做。它应按小游戏场景设计：

- 办公室是地图，不是背景图。
- AI 分身是 NPC，不是贴在图上的角色贴片。
- 工位、水吧、沙发、会议桌、书架、白板是交互点。
- NPC 有稳定身份、行动路径、状态机和动作姿态。
- 动画验收标准不是“动起来”，而是“像角色在场景里行动”。

当前视频暴露的问题：

- 人物比例仍不稳定，和家具/地砖没有统一度量。
- 走路抖动，像缩放或漂移，不像步行动画。
- NPC 只在几个区域之间动，没有明确走到交互位。
- 到达区域后没有稳定切换对应动作。
- 多分身时存在“走着走着换人”的感知风险。
- 当前精灵是 prototype，光源、像素密度、视角和办公室不完全一致。

## 2. 核心模型

### 地图

办公室地图由三层组成：

| 层 | 说明 |
|---|---|
| background | 固定办公室底图 |
| npc | 小猪 NPC、阴影、状态动作 |
| foreground | 需要遮挡 NPC 的桌面、椅背、沙发、柜台、会议桌前沿 |

现阶段不再增加半透明遮挡块。遮挡必须来自精确前景切片或 mask。

### NPC

每个分身对应一个稳定 NPC。

```ts
type OfficeNpc = {
  avatarId: string
  name: string
  currentSlotId: string
  targetSlotId: string | null
  state: 'idle' | 'walking' | 'acting'
  pose: OfficeNpcPose
  route: OfficeRoute | null
  actionStartedAt: number
}
```

原则：

- `avatarId` 绑定 NPC，不允许动画过程中换成另一个分身。
- NPC 的位置、状态、动作由状态机维护，不由 React list 顺序临时决定。
- 多 NPC 扩展前，先验证单 NPC 闭环。

### 状态机

```text
idle_at_slot
  -> choose_next_slot
  -> walking_to_slot
  -> arrive
  -> acting_at_slot
  -> choose_next_slot
```

状态说明：

| 状态 | 表现 |
|---|---|
| idle_at_slot | 在当前交互点待机 |
| walking_to_slot | 按路径行走，使用方向 walk 帧 |
| acting_at_slot | 到达固定交互位，播放对应动作 |

## 3. 区域与交互点

NPC 不是走到“区域中心”，而是走到固定交互点。

### 第一批交互点

| slotId | 区域 | 行为 | 姿态 | 说明 |
|---|---|---|---|---|
| workstation_chair | 工位 | 工作 | sit_work | 坐在电脑前处理任务 |
| water_bar_stand | 水吧 | 喝水 / 等候 | stand_drink | 站在咖啡机或饮水机前 |
| water_bar_seat | 水吧 | 休息 | sit_rest | 坐在水吧旁座位 |
| sofa_left | 沙发 | 思考 / 等待 | sit_sofa | 坐在沙发上 |
| meeting_chair | 会议桌 | 讨论 | sit_meeting | 坐在会议桌边 |
| knowledge_wall | 书架 / 白板 | 查资料 | stand_research | 站在书架或白板前 |
| file_cabinet | 文件柜 | 整理归档 | stand_file | 站在文件柜前 |

### 行为映射

| 任务语义 | 首选交互点 | 姿态 |
|---|---|---|
| 普通执行 / 生成 | workstation_chair | sit_work |
| 知识库 / 搜索 / 阅读 | knowledge_wall | stand_research |
| 会议 / 协作 / 评审 | meeting_chair | sit_meeting |
| 等待用户确认 / 暂停 | water_bar_stand 或 water_bar_seat | stand_drink 或 sit_rest |
| 思考 / 规划 | sofa_left | sit_sofa |
| 导出 / 文件 / 归档 | file_cabinet | stand_file |

## 4. 路径规则

第一版不做复杂寻路，采用固定路线表。

```ts
type OfficeRoute = {
  fromSlotId: string
  toSlotId: string
  waypoints: OfficePoint[]
  directionBySegment: OfficeWalkDirection[]
  durationMs: number
}
```

规则：

- 每条路线用 2-4 个 waypoint，不使用闭合小圆路线。
- 移动期间只播放 walk 帧，不播放业务动作。
- 到达交互点后停止位移，再播放动作。
- 路径终点必须是交互位脚底点，不是角色中心点。
- 每个路线段根据 `dx/dy` 选择方向帧。

## 5. 必需精灵资产

当前 `frames-prototype/` 只适合验证，不能作为最终游戏动画。

第一批必须补齐：

| pose | 方向 | 帧数 | 用途 |
|---|---|---:|---|
| idle | front / back / left / right | 4 | 站立待命 |
| walk | nw / ne / sw / se | 4 each | 等距地图行走 |
| sit_work | right 或 back-right | 4 | 坐在工位电脑前 |
| stand_drink | front-right | 4 | 水吧站着喝水 |
| sit_rest | front-left / front-right | 4 | 水吧座位休息 |
| sit_sofa | front-right | 4 | 坐沙发思考 |
| sit_meeting | front-left / front-right | 4 | 会议桌讨论 |
| stand_research | back-right | 4 | 书架 / 白板前查资料 |
| stand_file | front-right | 4 | 文件柜整理 |

精灵生产要求：

- 和办公室同一像素密度、同一光源方向、同一描边粗细。
- 不允许动作帧自带桌子、椅子、沙发等场景家具。
- 坐姿必须能和办公室已有椅子/沙发对齐。
- 每帧脚底锚点一致，避免抖动。
- 每个动作单独 sprite sheet，禁止临时裁图混用。

## 6. 角色比例标准

以办公室地砖和椅子作为比例基准：

- 站立小猪高度约等于椅背高度的 `1.15 - 1.30` 倍。
- 前景角色可以比后景大 `8% - 12%`。
- 不使用 CSS 反复缩放修正角色比例，最终比例应主要来自原始精灵尺寸。
- SVG / canvas 渲染只允许做景深级别的小比例调整。

当前临时代码里的 `scale` 只能作为调试参数，不能作为最终美术解决方案。

## 7. 层级与遮挡

必须实现的遮挡点：

| 物体 | 遮挡场景 |
|---|---|
| 工位桌面 / 显示器 | 小猪坐在工位时遮挡下半身和手部部分区域 |
| 会议桌前沿 | 坐会议桌时遮挡腿部 |
| 沙发前沿 | 坐沙发时遮挡腿部 |
| 水吧柜台 | 站在柜台后侧时遮挡脚部 |
| 文件柜 / 书架 | 不遮挡角色，角色站在前方 |

第一版可先做静态前景切片，不做动态深度排序。

## 8. 实施阶段

### 阶段 1：设计冻结

产物：

- 本文档。
- 交互点坐标表。
- 路径表。
- 精灵资产清单。

验收：

- 能说明每个区域 NPC 应站/坐在哪里。
- 能说明每个行为对应哪个姿态。
- 能说明当前 prototype 缺哪些最终资产。

### 阶段 2：单 NPC 原型

只做一个小猪：

```text
workstation_chair
-> water_bar_stand
-> sofa_left
-> knowledge_wall
-> workstation_chair
```

验收：

- 不换人。
- 不抖动。
- 走路和动作不会同时播放。
- 到水吧站着喝水。
- 到沙发坐下。
- 回工位坐下工作。

### 阶段 3：补正式精灵

产物：

- 四向 walk。
- sit_work。
- stand_drink。
- sit_sofa。
- stand_research。
- sit_meeting。

验收：

- 缩放到办公室后不贴图。
- 脚底锚点稳定。
- 坐姿能和家具对齐。

### 阶段 4：多 NPC

规则：

- 每个 `avatarId` 固定绑定一个 NPC。
- NPC 初始交互点错开，避免重叠。
- 同一交互点最多一个 NPC，会议桌除外。
- 多 NPC 路线错峰，避免同步游行。

验收：

- 三个分身同时存在时不会换人。
- 行为不会完全同步。
- 不会穿过主要家具。

### 阶段 5：接真实任务

输入：

- 当前活跃分身。
- 最近会话标题。
- 今日任务数。
- 工具调用状态。
- 错误 / 等待用户状态。

输出：

- 状态机目标交互点。
- 动作姿态。
- 状态标签。

原则：

- 角色表现可以拟物化，但数据不能编造。
- 没有任务时 NPC 走日常循环。
- 有任务时优先回工位或对应交互点。

## 9. 代码改造建议

先新增独立模块，不继续把逻辑堆在 `AvatarOffice.tsx`：

```text
desktop-app/src/components/office-game/
  OfficeGame.tsx
  officeMap.ts
  officeNpcState.ts
  officeSprites.ts
  officeRoutes.ts
  officeSlots.ts
```

职责：

| 文件 | 职责 |
|---|---|
| officeSlots.ts | 交互点坐标、姿态、层级 |
| officeRoutes.ts | 固定路线和方向段 |
| officeNpcState.ts | NPC 状态机 |
| officeSprites.ts | pose 到 sprite sheet 的映射 |
| OfficeGame.tsx | 渲染地图、NPC、遮挡层 |

`AvatarOffice.tsx` 最终只负责打开 Modal 和传入 avatars / conversations。

## 10. 不再继续的方向

停止以下做法：

- 用 CSS scale 反复调整角色大小。
- 用同一套正面 walk 帧模拟所有方向。
- 用 `animateMotion` 拖着动作帧沿路径漂移。
- 让角色站在区域中心播放动作。
- 用半透明多边形模拟遮挡。
- 多 NPC 直接从座位数组临时生成动画实体。

## 11. 下一步执行建议

下一步先做阶段 2 的单 NPC 原型，但必须先补一个最小可用的 `officeSlots.ts` 和 `officeNpcState.ts`。

建议第一条可验收链路：

```text
工位坐着工作
-> 起身
-> 走到水吧
-> 站着喝水
-> 走到沙发
-> 坐下思考
-> 走回工位
-> 坐下工作
```

这条链路通过后，再扩展会议桌、书架、文件柜和多 NPC。
