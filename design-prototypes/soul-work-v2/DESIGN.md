---
design_contract_version: 1
project:
  name: Soul AI 分身桌面端
  type: desktop-workspace
  audience:
    - 使用 AI 专家完成专业任务并审阅结果的桌面端用户
    - 配置、维护和验证专家包的管理员
  platform:
    - Electron desktop prototype
  page:
    id: expert-home
    route: "prototype://experts/小堵-工商储专家/home"
modes:
  density: medium
  motion: calm
  variance: systematic
compatibility:
  public_design_md: true
  structured_ui_schema: schemas/ued-ui-schema.json
verified_facts:
  - claim: 小堵是工商储产品解决方案专家，领域为工商业储能。
    source: expert-packs/小堵-工商储专家/expert-pack.json
    status: verified
  - claim: 小堵专家包使用知识库优先、数据可溯源和不替用户做决定的工作原则。
    source: expert-packs/小堵-工商储专家/soul.md
    status: verified
  - claim: 专家包正本包含人格、规则、知识、技能、测试和记忆结构。
    source: expert-packs/小堵-工商储专家/
    status: verified
brand_assets:
  - name: Soul prototype avatar
    path: assets/soul-avatar.png
    status: available
    usage: 仅用于 V2 原型品牌占位，不冒充小堵正式头像。
  - name: 小堵头像引用
    path: expert-packs/小堵-工商储专家/avatar.txt
    status: verified-reference
    usage: 正式实现通过资源解析器加载，不在渲染层暴露本地绝对路径。
tokens:
  colors:
    primitive:
      neutral-0: "#ffffff"
      neutral-25: "#fcfcfb"
      neutral-50: "#f7f6f3"
      neutral-100: "#efefed"
      neutral-200: "#e3e1dc"
      neutral-400: "#97979f"
      neutral-600: "#66666f"
      neutral-900: "#17171b"
      blue-500: "#2f6df6"
      pink-300: "#ff8fb5"
      green-500: "#24a36a"
      red-500: "#cf4b54"
    semantic:
      background-page: "#fcfcfb"
      background-surface: "#ffffff"
      background-subtle: "#f7f6f3"
      background-selected: "#efefed"
      text-primary: "#17171b"
      text-secondary: "#66666f"
      text-tertiary: "#97979f"
      border-subtle: "#e3e1dc"
      accent-primary: "#2f6df6"
      brand-accent: "#ff8fb5"
      status-positive: "#24a36a"
      status-danger: "#cf4b54"
  typography:
    font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif
    font-mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace
    body-size: 14px
    body-line-height: 1.57
    heading-weight: 650
  spacing:
    base-unit: 4px
    page-x-wide: 32px
    page-x-compact: 24px
    section-gap: 24px
    card-padding: 20px
    content-max: 1120px
  radius:
    control: 8px
    card: 10px
    avatar: 18px
    modal: 14px
  shadow:
    card: 0 1px 2px rgba(23, 23, 27, 0.06)
    popover: 0 18px 48px rgba(23, 23, 27, 0.14)
  motion:
    fast: 140ms
    standard: 180ms
components:
  expert-identity:
    avatar-size: 80px
    padding: 28px
    radius: 10px
  expert-section:
    gap: 16px
    padding: 20px
    radius: 10px
  control:
    min-height: 36px
    radius: 8px
  section-nav:
    width: 246px
    row-height: 44px
source_mapping:
  required: true
  attribute: data-ued-node
---

# Overview

Soul 专家主页是用户理解、选择和管理 AI 分身的可信入口，当前页面对象为工商储产品解决方案专家“小堵”。页面的核心任务不是展示虚构的人效数据，而是让用户快速确认“这个专家是谁、能做什么、依据什么工作、当前是否可用”，并能直接发起任务或进入能力管理。设计以用户提供的 Waker 管理页截图作为信息架构参考，以 Codex / Kimi 的克制桌面质感作为交互密度参考，但只呈现 Soul 专家包中可验证的内容。该页面属于 V2 HTML 原型，不代表正式 Electron 已完成实现。

## Verified Facts

| Claim | Source | Status | Notes |
| --- | --- | --- | --- |
| 小堵的正式名称为“工商储产品解决方案专家（小堵）” | `expert-packs/小堵-工商储专家/expert-pack.json` | verified | 页面简称显示“小堵” |
| 专业领域为工商业储能，能力描述覆盖方案设计、收益测算、政策解读和可追溯产品数据 | `expert-packs/小堵-工商储专家/expert-pack.json` | verified | 不扩写为知识库未覆盖的能力 |
| 专家回答需遵守知识库优先、数据可溯源、诚实说明缺口和不替用户做决定 | `expert-packs/小堵-工商储专家/soul.md` | verified | “关于我”的工作原则必须由此归纳 |
| 专家包含 `soul.md`、`AGENTS.md`、`expert-pack.json`、`knowledge/`、`skills/`、`tests/` 和 `memory/` | `expert-packs/小堵-工商储专家/` | verified | 原始档案只显示安全相对路径 |
| 技能路由包含 local、local override、shared 等来源 | `expert-packs/小堵-工商储专家/skills/skill-index.yaml` | verified | 能力区按来源展示，不混成一个无来源标签池 |
| 专家头像当前引用 `default:data-analyst` | `expert-packs/小堵-工商储专家/avatar.txt` | verified | 未配置专属头像时使用明确占位，不编造人物信息 |
| V2 必须保留 15 项专家功能入口 | 本文件“专家原有能力”清单与现有 V2 原型 | verified | 主页重构不得删除旧能力 |

## Brand Assets

| Asset | Path / Source | Status | Usage Rule |
| --- | --- | --- | --- |
| Soul 原型头像 | `assets/soul-avatar.png` | available | 仅作 Soul 品牌或头像占位；不得暗示为小堵真人照片 |
| 小堵头像引用 | `expert-packs/小堵-工商储专家/avatar.txt` | verified-reference | 通过资源标识解析；UI 不显示本地绝对路径 |
| Waker 管理页参考截图 | 用户在当前任务提供的截图 | reference-only | 只借鉴结构、密度和留白，不复制名称、指标或绿色品牌视觉 |
| 图标 | 原型现有内联 SVG 图标集 | available | 统一 18–20px、1.75px 描边；不混用字母方块代替图标 |

## Design Thesis

**纵向专家档案，而不是横向功能标签堆叠。** 首页沿“身份与任务入口 → 工作记录 → 记忆与积累 → 关于我 → 能力与工具 → 连接器 → 原始档案 → 更多专家能力”的顺序组织，让用户先建立信任，再进入配置。首页只展示可验证状态和真实内容；加入天数、虚构通过率、虚构工作量、空知识库的“已连接”等装饰性指标一律禁止。原有 15 项能力保留在次级专家工作区中，主页负责总览和分流，不重复实现每个深层功能。

### 页面结构

1. **专家身份区**：头像、姓名、角色、领域、来源、可用状态、简短介绍，以及“交给小堵”“管理专家”操作。
2. **工作记录区**：真实任务、对话和定时任务记录；无数据时使用缺省页，不用伪造 0 指标或热力图。
3. **记忆与积累区**：仅展示真实记忆事件、学习记录或能力更新；每条必须有类型、来源与时间。
4. **关于我区**：固定三栏“擅长领域 / 工作原则 / 工作模式”，内容从专家包归纳。
5. **能力与工具区**：技能按 local / shared / community 分组并显示启用、覆盖和不可用状态。
6. **连接器区**：与能力区分离，显示真实连接状态、授权范围和管理入口；知识文件不得伪装成连接器。
7. **原始档案区**：展示安全的专家包相对结构和查看入口，不暴露绝对路径。
8. **更多专家能力**：承接人设、记忆、测试、办公室等原有 15 项入口。

### “关于我”内容边界

| 栏目 | 允许内容 | 禁止内容 |
| --- | --- | --- |
| 擅长领域 | 工商业储能方案、收益测算、政策解读、质量/BOM 数据检索与可视化 | 专家包没有证据的海外市场、施工签证、正式报价能力 |
| 工作原则 | 知识库优先、关键数据可溯源、缺数据明确说明、第一性原理、不替用户决策 | “行业通常如此”等无依据判断或虚构成功率 |
| 工作模式 | 澄清需求 → 检索知识 → 归并事实与缺口 → 形成计划 → 交付并审阅 | 把计划、结果和风险混在一段营销文案中 |

## Tokens

本页复用 V2 中性桌面令牌，数值正本位于 YAML frontmatter。页面使用 4px 基础网格、白色内容面与浅灰导航面，模块之间依靠间距和 `border-subtle` 分层，不用大面积阴影。交互蓝只用于焦点、链接和确认选择；Soul 粉只用于品牌细节；成功绿仅表示已经从真实状态确认的“在线 / 已连接 / 已通过”。

## Colors

- 页面与卡片分别使用 `tokens.colors.semantic.background-page` 和 `background-surface`。
- 选中态与 hover 共用浅灰色 `background-selected`，选中可增加字重，但不使用左侧竖线或蓝色描边。
- 主文字、说明文字和辅助文字依次使用 `text-primary`、`text-secondary`、`text-tertiary`。
- 状态不能仅靠颜色区分；绿色只配合“在线 / 已连接”等文本或图标出现。
- 高风险删除使用 `status-danger`，且只在确认操作和危险菜单项中出现。

## Typography

| Role | Size / Line height | Weight | Usage |
| --- | --- | --- | --- |
| 专家姓名 / 页面标题 | 24px / 32px | 680 | 每页仅一个主标题 |
| 模块标题 | 18px / 26px | 650 | 工作记录、关于我、能力与工具等 |
| 卡片标题 | 15px / 22px | 620 | 能力名、文件名、连接器名 |
| 正文 | 14px / 22px | 450 | 描述、工作原则和工作模式 |
| 元数据 | 13px / 20px | 450 | 来源、时间、状态与范围 |
| 辅助标签 | 12px / 18px | 520 | 文件类型、技能来源、小型徽标 |
| 路径 / 标识 | 12px / 18px | 500 mono | 安全相对路径与专家包标识 |

- 中文优先使用系统字体栈；不单独加载网络字体。
- 可见文字下限为 12px，禁止以 9–11px 承载功能名称或状态。
- 标题不使用全大写英文；“专家工作区”等辅助英文仅在确有必要时出现。
- 长描述最多三行；名称和路径单行截断后必须提供完整 tooltip 或详情查看入口。

## Elevation & Depth

- 主页面保持平面化：模块容器使用 1px 分割线，默认无阴影或仅使用 `tokens.shadow.card`。
- 浮层、菜单和确认框才使用 `tokens.shadow.popover`，不得把每个内容块做成悬浮卡片。
- 专家身份区可使用独立白色表面，但不使用玻璃拟态、渐变光晕或装饰性大背景。
- 页面滚动发生在主内容区；模块内部不得创建第二个长滚动容器。

## Shapes

- 模块卡片圆角 10px，控件 8px，弹层 14px；避免 20px 以上的胶囊卡片。
- 专家头像容器 80×80px、18px 圆角；头像不足时使用中性占位，不用字母方块伪装完整头像。
- 图标统一 18–20px，描边 1.75px；状态图标最多 16px，并配文本或可访问名称。
- 标签只用于来源、文件类型和已验证状态，不把整句描述放进胶囊。

## Components

| Component | Variant | Key States | `data-ued-node` | Notes |
| --- | --- | --- | --- | --- |
| Expert identity | installed expert | loading, ready, unavailable, error | `expert.identity` | 始终展示真实名称、角色和来源 |
| Task launcher | primary / secondary | default, hover, focus, disabled | `expert.create-task` | 进入统一任务/对话消息流 |
| Work records | list / empty | loading, populated, empty, error | `expert.work-records` | 无真实数据时不显示伪造热力图 |
| Memory timeline | event timeline / empty | loading, populated, empty | `expert.memory-timeline` | 事件必须含来源和时间 |
| About grid | expertise / principles / workflow | default, collapsed | `expert.about` | 1280px 以上保持三栏 |
| Skill directory | local / shared / community | enabled, overridden, disabled, missing | `expert.capabilities` | 显示来源与覆盖关系 |
| Connector list | local / external | connected, disconnected, permission-needed, error | `expert.connectors` | 与知识文件分区显示 |
| Raw archive | file / directory | available, empty, unreadable | `expert.raw-files` | 只展示相对路径和安全查看入口 |
| Legacy capability nav | 15 existing features | default, hover, selected, unavailable | `expert.more-capabilities` | 不显示 01、02 等装饰编号 |

### 必需子节点

- `expert.home`
- `expert.identity.avatar`
- `expert.identity.summary`
- `expert.identity.actions`
- `expert.work-records.list`
- `expert.memory-timeline.list`
- `expert.about.expertise`
- `expert.about.principles`
- `expert.about.workflow`
- `expert.capabilities.local`
- `expert.capabilities.shared`
- `expert.capabilities.community`
- `expert.connectors.list`
- `expert.raw-files.tree`
- `expert.more-capabilities.nav`

## Layout and Responsive

### Desktop grid

- 保留 Soul V2 全局主导航，不在专家主页内再复制一套全局导航。
- 深层专家功能使用 246px 次级导航栏；专家主页本身采用单列纵向内容，内容最大宽度 1120px。
- `1440×900`：主内容左右内边距 32px；身份区为“身份信息 + 右侧操作”；“关于我”固定三栏；能力与连接器可双栏。
- `1280×800`：主内容左右内边距 24px；身份区仍保持操作可见；“关于我”保持三栏但每栏最小 220px；能力与连接器改为单列时不得遮挡入口。
- 主页纵向区块间距 24px，卡片内边距 20px，内部网格间距 16px。
- 页面使用主内容区单一垂直滚动；工作记录、关于我、能力、连接器和档案均直接展开，不创建模块内滚动。

### Breakpoints

| Width | Behavior |
| --- | --- |
| `≥1440px` | 32px 页面边距，三栏关于我，双栏能力/连接器 |
| `1280–1439px` | 24px 页面边距，三栏关于我，必要时单栏能力/连接器 |
| `1024–1279px` | 次级专家导航可收起，关于我两栏，工作模式横跨整行 |
| `<1024px` | 单列纵向内容，操作随身份信息换行；仅作为兼容，不是本轮验收基线 |

### 垂直节奏

- 首屏应看到完整身份区和下一模块标题，不以巨型头像或空白占满窗口。
- 页面标题至身份区 20px；身份区至工作记录 24px；模块标题至内容 14–16px。
- 1280×800 下“交给小堵”和“管理专家”不能被滚动容器或固定栏遮挡。

## Interaction States

| State | UI rule |
| --- | --- |
| Loading | 使用与最终布局同尺寸的骨架，不闪烁虚构内容 |
| Empty work records | 中性图标 + “暂无工作记录” + “交给小堵”操作，不显示 0 天、0 任务热力图 |
| Empty memory | 显示“暂无可展示的记忆事件”，保留查看完整记忆入口 |
| Expert unavailable | 身份区显示中性不可用图标与原因，主任务按钮 disabled，提供修复或切换入口 |
| Connected | 仅当真实连接探测成功时显示绿色图标和“已连接” |
| Disconnected | 使用中性断开图标和说明；不将其渲染成失败红色，除非发生错误 |
| Missing knowledge | 明示“知识库为空 / 能力受限”，不得用“已就绪”替代 |
| Error | 模块内联错误、原因摘要、重试入口；不让整个主页空白 |
| Hover / selected | 同一浅灰背景；selected 可加字重，不使用前置竖线、彩色点或描边 |
| Destructive action | 删除、归档、重置在发生前单独确认，并说明影响范围 |

- “交给小堵”默认创建普通对话；用户选择项目或设置执行状态后，才成为项目任务。
- 技能、连接器和档案条目点击后进入详情或安全查看器，不直接暴露文件系统。
- 折叠只用于次要长列表；“关于我”、核心能力摘要和连接状态默认展开。
- 所有异步操作提供 loading、success 和 error 反馈；成功 toast 不替代页面状态更新。

## Accessibility

- 所有按钮、图标按钮、列表项和折叠标题必须有可访问名称；纯图标按钮提供 tooltip。
- 键盘顺序：返回/切换专家 → 身份操作 → 工作记录 → 关于我 → 能力 → 连接器 → 档案 → 更多能力。
- `:focus-visible` 使用 2px `accent-primary` 外框与 2px offset，不以 hover 样式替代焦点。
- 点击目标最小 36×36px；主要任务按钮最小高度 36px。
- 主文字与页面背景对比度不低于 4.5:1；状态同时使用图标/文字和颜色。
- 尊重 `prefers-reduced-motion`；关闭位移和缩放动画，仅保留 100ms 以内透明度变化。
- 中文文案不依赖英文缩写理解；BOM、ROI 等缩写首次出现时提供说明或 tooltip。
- 1440×900 与 1280×800 均不得出现页面横向滚动，缩放至 200% 时核心操作仍可达。

## Do and Dont

| Do | Dont |
| --- | --- |
| 从 `expert-pack.json`、`soul.md` 和技能索引生成可追溯内容 | 根据参考截图编造入职时间、天数、技能数量或测试通过率 |
| 用纵向专家主页建立身份、工作、能力和证据的连续阅读路径 | 恢复密集横向 Tab 或编号为 01–15 的装饰列表 |
| 将技能、连接器、知识文件和原始档案分清语义 | 把知识文件伪装成外部连接器或已连接状态 |
| 保留 15 项旧能力并放入次级工作区 | 为了页面简洁删除人格、知识、记忆、测试、轨迹或办公室 |
| 无数据时使用诚实缺省页 | 用 0、彩色点和空热力图制造“有数据”的感觉 |
| 只展示安全相对路径，并通过受控查看器打开 | 在渲染层展示或复制本地绝对路径 |
| 使用 12px 以上的系统字体和舒展行高 | 使用 9–11px 字体承载功能名称、状态和说明 |
| 让主页面承担唯一长滚动 | 在每个卡片内增加独立滚动条 |

## Agent Guide

- 本契约当前只约束 `design-prototypes/soul-work-v2/index.html` 的专家主页原型，不授权修改正式 Electron 页面。
- 实施前必须读取 `expert-packs/小堵-工商储专家/expert-pack.json`、`soul.md`、`skills/skill-index.yaml` 和安全目录结构；不得从参考截图复制业务数据。
- 专家主页使用本契约的纵向区块顺序；页面专属规则优先于本文件后续“Existing V2 Coverage”中的通用说明。
- 未来子任务分别处理“关于我”“能力与工具 / 连接器”“原始档案”，每次只修改约定范围并单独提交。
- 为上述必需节点添加 `data-ued-node`，保证截图反馈可以映射到具体源节点。
- 视觉实现需验证 1440×900 与 1280×800，记录首屏、完整纵向页、空状态、错误状态和 hover/focus 状态截图。
- 运行设计契约校验：`python3 /Users/kian/.codex/skills/ued-agent/scripts/ued_design_contract.py lint DESIGN.md`。
- 运行公开 `design.md` 兼容检查：`python3 /Users/kian/.codex/skills/ued-agent/scripts/ued_design_md_compat.py DESIGN.md`。
- Stitch / HTML 导出只作为视觉参考；不得把原型 CSS/JavaScript 直接合入 Electron / React 工程。

# Existing V2 Coverage

以下内容保留 Soul Task-first V2 的全局页面、流程与兼容边界；专家主页实现以本文件前半部分的页面契约为准。

## V2 Positioning — 定位

- 设计基线：Stitch V2，未采用 huashu-design V3。
- 产品主路径：提出目标 → 进入项目 → 匹配专家 → 执行任务 → 在同一对话中审阅结果。
- 主导航：新建 / 看板 / 定时任务 / 专家，设置置底；项目和项目内对话独立成组展示。
- 信息关系：项目是长期上下文，任务是项目对话的执行状态；普通对话可原地升级为任务，不生成第二条记录。
- 原型入口：`index.html`，无依赖、可直接用浏览器打开。
- 本目录只用于视觉与交互验收；HTML、CSS 和 JavaScript 不直接合入 Electron / React 正式工程。

## Existing Visual System — 视觉系统

### 设计原则

1. 任务优先：任务目标、执行状态和成果始终高于聊天装饰。
2. 中性桌面质感：按钮、表单和信息层级参考 Codex / Claude 桌面端的克制表达。
3. 品牌轻量出现：Soul 粉色只用于品牌标识；交互强调使用克制的蓝色，主操作使用中性深色。
4. 信息可读：可见文字下限为 12px；按钮和导航 14px；正文 14–16px，中文内容保持舒展行高。
5. 状态可解释：低风险自动执行，中风险确认一次，高风险在操作发生前单独确认。

### 核心令牌

| 用途 | 值 |
| --- | --- |
| 工作区背景 | `#fcfcfb` |
| 面板背景 | `#ffffff` |
| 导航背景 | `#f7f6f3` |
| 主文字 | `#17171b` |
| 次文字 | `#66666f` |
| 分割线 | `#e3e1dc` |
| 主操作 | `#25262b` |
| Soul 品牌粉 | `#ff8fb5` |
| 交互蓝 | `#2f6df6` |
| 浅选中背景 | `#efefed` |
| 危险状态 | `#cf4b54` |

### 控件规则

- 主按钮：深色实底、36px 高、7px 圆角。
- 次按钮：白底描边、34px 高、7px 圆角。
- 表单：最小 34px 高，焦点使用中性描边，不用高饱和光晕。
- 卡片：8–10px 圆角，弱阴影或无阴影，依靠分割线建立层级。
- 导航选中态：与 hover 使用同一层浅灰背景；不用前置竖线、描边或高饱和底色。
- 项目、对话操作：加号、编辑和更多按钮默认隐藏，鼠标移入对应标题或条目后显示。
- 任务状态：放在条目右侧，以中性文字区分；不使用彩色圆点承担状态语义。
- 右侧任务栏：默认关闭；通过标题栏按钮或 `⌥⌘B` 打开。
- 全局搜索：按钮、`⌘K` 或 `⌘P` 打开，按页面名称优先排序。

## Existing Page Coverage — 页面与功能覆盖

### 主工作台

| 页面 | 已覆盖功能 |
| --- | --- |
| 新建 | Kimi 式大输入框、附件、项目、专家路由、权限、模型、开始任务 |
| 看板 | 无看板缺省页、看板列表、模板/对话创建、组件添加、删除、排序、缩放和编辑模式 |
| 项目 | 项目条目、项目内对话/任务、共享上下文、文件、专家组、设置和项目管理 |
| 任务消息流 | 用户消息、专家回复、计划、进度、确认、来源、成果与继续输入共用一条消息流 |
| 定时任务 | 缺省页、手动/对话创建、项目关联、执行时间、编辑、启停和触发结果 |
| 专家 | 已安装专家、完整能力导航、新建专家、导入/导出专家包 |
| 设置 | 12 类实际设置页面和可操作入口 |

### 侧栏层级

- 项目标题下展示项目条目；项目条目下直接展示具体任务和普通对话名称。
- “对话”标题带折叠箭头，移入标题时显示新建按钮。
- 项目移入时显示更多和新建按钮；对话移入时显示更多按钮。
- 任务状态固定在名称右侧；移入条目时由更多按钮接替状态位置。
- 顶部不重复展示当前项目标题，也不在消息流工具栏放置“新对话”。

### 专家原有能力

专家功能面板保留以下 15 项入口：

1. 人设
2. 技能
3. 知识库
4. 记忆
5. 职场
6. 人生
7. 用户画像
8. 话术
9. 定时任务
10. 执行轨迹
11. 专家台账
12. 专家测试
13. 批量回归
14. 办公室
15. 专家包

### 设置实际能力

设置页按现有桌面端能力分为：

1. 对话模型
2. 创作模型
3. 视觉模型
4. OCR 模型
5. 本地模型
6. Wiki
7. 记忆
8. 定时任务
9. 主题外观
10. 工具与集成（外部 API、WebBridge、WebDAV、MCP）
11. 文件目录
12. 日志与诊断（工作空间、应用日志、错误导出、工具审计、性能日志）

## Existing Key Flows — 关键流程

### 新建任务

新建 → 输入目标 → 选择项目/专家/权限/模型 → 开始任务 → 在所选项目下生成具体任务名 → 进入同一条对话消息流查看计划、进度、待确认事项和结果。

### 缺少专家

任务详情 → 重新匹配专家 → 展示能力缺口与空知识库 → 创建项目临时专家 → 补充知识 → 运行五类测试 → 回到原对话恢复任务。

### 对话设为任务

选择历史对话 → 在当前对话中设为任务 → 原消息、项目上下文和附件保持不变 → 在同一消息流中确认计划并开始执行。整个过程不复制对话，也不创建第二条任务记录。

### 任务与对话层级

- 任务本质上是项目下具备执行状态的对话；项目侧栏中的任务和普通对话共用一个列表，不再设一级「任务」导航。
- 普通对话不显示任务状态；设为任务后才显示草稿、执行中、待确认或已完成。
- 旧三栏任务页仅作为右侧可开关的「执行详情」，不再承担主要消息流。

### 定时任务

缺省页手动添加或通过对话创建 → 填写名称和需求 → 选择项目 → 设置一次/每天/每周/每月/自定义执行时间 → 保存并启用 → 每次触发在所属项目生成独立任务对话。

定时任务表单只保留名称、需求说明、所属项目和执行时间；不展示目标类型、权限模式等可由项目和系统推导的字段。

### 高风险操作

删除项目、重置本地数据、外部发送等 → 展示计划和影响范围 → 单独确认 → 原型仅反馈，不产生真实副作用。

## Existing Acceptance Record — 验收记录

- `1440×900`：主页面、项目层级、看板、消息流和定时任务无横向溢出。
- `1280×800`：核心操作无遮挡；定时任务弹窗完整展开，不产生内部滚动。
- 可见文字下限：12px。
- 原型按钮：229 个；可访问名称缺失 0 个。
- 设置页：12 / 12 可切换。
- 专家功能：15 / 15 可打开。
- 浏览器控制台：无错误日志。
- HTML 脚本语法检查通过；161 个静态 DOM ID 无重复。

### 任务与 Chat 合并验收（2026-08-02）

- 任务从一级导航移入项目层级，以具体任务名和右侧中性状态展示。
- 项目页、专家页、新建入口和定时任务结果均回到统一任务消息流。
- 普通对话可原地设为任务，升级前后侧栏记录数量不变。
- 草稿和等待确认状态可在消息流内开始或恢复执行；任务详情可回退旧三栏页。
- 项目、对话的新增和更多操作仅在 hover/focus 时出现，默认界面保持安静。
- `1440×900` 与 `1280×800` 均无页面横向溢出、弹窗内部滚动或输入框遮挡。

## Existing Production Boundary — 正式开发边界

- 原型中的数据和运行结果均为交互示例，不代表真实专业结论或测试成绩。
- 正式开发继续使用现有 Electron / React / TypeScript 架构。
- 正式实现必须从主进程读取安全配置、文件权限和真实运行状态。
- 渲染层不得接触凭据或绝对文件路径。
- Stitch / HTML 导出代码只用于视觉参考，不直接复制进正式产品。
