---
name: draw-infographic
description: 当用户要叙事型 / 汇报型可视化——信息图、演示图、卡片、列表展示、SWOT、对比图 / 对比卡、流程卡、思维导图、金字塔、词云、阶梯图、时间线、组织架构 / 层级图、「给领导看的漂亮图」时使用，输出 ```infographic 代码块（@antv/infographic 私有 DSL，格式规则必须读正文，不是 YAML/JSON）。精确数据图表（柱/折/饼/趋势）用 draw-chart；流程 / 时序 / 关系图用 draw-mermaid。数据必须来自知识库或用户提供，禁止编造。
---

# 信息图渲染技能 · draw-infographic

> **级别**：[■■] 进阶
> **版本**：v1.0
> **最后更新**：2026-04-16

---

## 触发条件 — 何时用这个 skill（vs draw-chart vs draw-mermaid）

**这是 3 个图表 skill 之一**。先按下面的速查表选对 skill：

| 用户意图 / 关键词 | 用哪个 skill | 引擎 |
|---|---|---|
| **柱状图 / 折线图 / 饼图 / 散点图 / 热力图 / 雷达图 / 趋势 / 数据可视化 / 数据图表** | `draw-chart` | ECharts |
| **甘特图 / 项目计划 / 时间线（数据型）/ 工作流 / 时序图 / 调用链 / 状态机 / ER 图 / 类图 / Git 图** | `draw-mermaid` | mermaid |
| **信息图 / 演示图 / 卡片 / 列表展示 / SWOT / 对比图 / 流程卡 / 思维导图（叙事型）/ 金字塔 / 词云 / 汇报材料** | **`draw-infographic`（本技能）** | **@antv/infographic** |

### 这个 skill 的核心定位

`@antv/infographic` 是**信息图叙事引擎**，**不是数据图表库**。它擅长把"信息结构 + 视觉表达"组合成漂亮的演示用图：

- ✅ "做一个汇报用的产品对比卡片"
- ✅ "把项目里程碑做成时间线"
- ✅ "整理这次会议的核心结论成一个 SWOT 信息图"
- ✅ "把 EDV 流程的 5 个阶段做成阶梯图"
- ✅ "我要一个金字塔图说明储能行业的 4 层市场结构"
- ❌ "画一个 215 机型 12 个月的效率折线图"（用 `draw-chart`）
- ❌ "画一个甘特图列出 ITR 任务的时间安排"（用 `draw-mermaid`）

**简单判定**：如果是**叙事 / 汇报 / 卡片 / 演示** → 本技能；如果是**精确数据 / 趋势 / 统计** → `draw-chart`；如果是**流程 / 时序 / 关系** → `draw-mermaid`。

---

## 输出格式（**必须遵守**）

### ⚠️ 最常见错误 · 90% 的失败都因为下面这个

**这是 @antv/infographic 私有 DSL，不是 YAML、不是 JSON、不是 Markdown frontmatter。**

| ❌ 错误：YAML 风格（LLM 最容易犯的错） | ✅ 正确：infographic DSL |
|---|---|
| <pre>template: compare-swot<br>title: 工商储 EMC 模式 SWOT<br>subtitle: 合同能源管理<br>metadata:<br>  author: 小堵<br>data:<br>  strengths:<br>    - 客户黏性高</pre> | <pre>infographic compare-swot<br>data<br>  title 工商储 EMC 模式 SWOT<br>  compares<br>    - label 优势<br>      text 客户黏性高、风险转移、轻资产模式<br>    - label 劣势<br>      text 利润率薄、电价波动暴露大</pre> |

**关键差异**（每一条都会导致整图渲染失败）：
1. 首行：**`infographic <template>`**，不是 `template: <name>`
2. key 和 value 之间用**空格**分隔，**不是冒号**（`title 文本` ✓ ／ `title: 文本` ✗）
3. **不写** `metadata` / `subtitle` / `tags` / `date` / `author` 这种 markdown frontmatter 字段，DSL 不认
4. 数组项前面是 `-` 空格 + 内容（DSL 形式），不是 YAML 的 `- "字符串"`
5. 缩进**严格 2 空格**，不能 tab / 4 空格 / 0 缩进
6. 字段名按"模板**精确名称**"决定（`compare-swot` 每块用 `text 一段` ／ `compare-hierarchy-row-letter-card-rounded-rect-node` 每块用 `items` 数组 — **不同模板字段名规则不同**）

如果你（LLM）发现自己想输出 `template:` / `metadata:` / 冒号 key-value——立刻停下，回去看下面"DSL 语法核心规则"。

### ⚠️ SWOT 模板选择陷阱 · 第二高频踩坑

**`compare-swot` 每个 label 块只支持 1 段 text**（来自 antv 源码：letter-card + plain-text 双组件）。LLM 习惯按"每象限 4 条 bullet"输出 items 数组 → **渲染出 4 个空白色块**（很常见的失败症状）。

- 想要"4 块各 1 段精简概述" → 用 `compare-swot`，字段 `text` 而非 `items`
- 想要"4 块各多条 bullet" → 换 `compare-hierarchy-row-letter-card-rounded-rect-node`，字段 `items`

### 标准输出形式

用三反引号 + `infographic` 标记输出代码块，前端会自动渲染：

    ```infographic
    infographic list-grid-badge-card
    data
      title 储能产品分类
      lists
        - label 工商业储能
          desc 100kWh-1MWh
        - label 户用储能
          desc 5-30kWh
        - label 大型集装箱
          desc 1MWh+
    ```

前端 InfographicRenderer 会把它渲染成 SVG。

#### ⚠️ list-grid-badge-card 字段警示（2026-05-22 真实事故）

LLM 经常给 `list-grid-badge-card` 模板的每个 list item **凭空发明**字段（`badge`、`tag`、`status`、`verdict` 等多个 sibling 字段），这些 antv BadgeCard 实际**不读**，直接被丢弃。

**antv BadgeCard 真实读的字段（从源码 BadgeCard.js 确认）**：
- `label`（必需，主标题）
- `desc`（可选，描述段）
- `value`（可选，大数字）
- `icon`（可选，icon 名）
- **就这 4 个**——其他字段（badge / tag / status / verdict / category）都会被忽略。

✅ **正确**（要在 desc 里写完整信息）：

    ```infographic
    infographic list-grid-badge-card
    data
      title 工商储三种商业模式
      description 基于知识库的核心差异
      lists
        - label EMC·合同能源管理
          desc 资方出资、用户零投入、收益按比例分成。益企储模式下14项目还款期，电价政策调整直接腐蚀收益基础。
        - label BOO·建设-拥有-运营
          desc 用户自持资产、享有全部收益、承担投资风险。知识库暂无项目数据。
        - label BOT·建设-运营-移交
          desc 资方建设运营、特许期后移交。平衡资金压力与长期资产归属。知识库暂无项目数据。
    ```

❌ **错法**（这种 LLM 经常写、antv 直接丢失 badge 信息）：

    infographic list-grid-badge-card
    data
      lists
        - label EMC·合同能源管理
          desc 一段简短描述
          badge 资方持有                 ← 被丢
          badge 收益分成                 ← 被丢
          badge 电价风险高               ← 被丢

**经验法则**：list-grid-badge-card 想表达"多个 tag"时，**把所有 tag 拼进 desc 用 ` · ` 或 ` / ` 分隔**，不要每个 tag 一个字段。

---

## DSL 语法核心规则

### 1. 首行格式（**必须**）

```
infographic <template-name>
```

例如：`infographic list-grid-badge-card` / `infographic compare-swot` / `infographic sequence-stairs-...`

模板名不能编造，必须从下面"可用模板列表"中挑。

**反例（高频踩坑，全部错）**：

```
❌ template: compare-swot              // YAML 化 — 不认 "template:" key
❌ template = compare-swot             // INI 风格 — 也不认
❌ "infographic": "compare-swot"       // JSON 化 — 也不认
❌ # compare-swot                      // markdown 注释 — 不认
❌ INFOGRAPHIC compare-swot            // 大写 — DSL 区分大小写
❌ infographic compare_swot            // 下划线 — 模板名只支持连字符 -
✅ infographic compare-swot            // 唯一正确形式
```

### 2. 缩进规则

- **2 空格缩进**（不是 4 空格、不是 tab）
- 数组项以 `-` 开头
- key 和 value 之间用 **空格** 分隔（不是冒号 `:`）

### 3. 数据块字段映射（按模板前缀选）

| 模板前缀 | 顶级数据字段 | 数据项结构 |
|---|---|---|
| `list-*` | `lists` | `- label 文本\n  desc 描述`（每项独立条目） |
| `sequence-*` | `sequences` | `- label 阶段名\n  desc 描述` |
| `sequence-interaction-*` | `sequences` + `relations` | 同上 + 关系数组 |
| **`compare-swot`** | `compares` | **`- label 类别名\n  text 一段精简文本`**（**每块仅 1 段，不是 items 数组**！） |
| `compare-hierarchy-row-letter-card-rounded-rect-node` 等其它 compare-* | `compares` | `- label 类别名\n  items\n    - 子项1\n    - 子项2`（支持每块多条） |
| `hierarchy-*` | `root` 单根 + 递归 `children` | `root\n  label 根\n  children\n    - label 子1` |
| `relation-*` | `nodes` + `relations` | `nodes` 是节点数组，`relations` 是连线数组 |
| `chart-*` | `values` | 单组值 `- label 文本\n  value 数字` |
| `word-cloud` | `items` | `- text 词\n  weight 数字` |

**写错字段 = 渲染失败 或 数据丢失**。LLM 必须按模板**精确名称**决定数据字段名 + 数据项的内部结构。

#### ⚠️ `compare-swot` 完整示例（最常踩坑模板）

**关键事实**：`compare-swot` 模板源自 @antv/infographic 的 `compare-hierarchy-row` 结构 + `[letter-card + plain-text]` 双组件渲染。

底层数据流（看 antv 源码 `compare-hierarchy-row.js`）：
- `RootItem` 用 `datum: rootItem`（即 compares 数组每项）→ letter-card 渲染首字符
- `Item` 用 `datum: child`（即 rootItem.**children** 数组每项）→ plain-text 渲染 child.label

**所以 compare-swot 真正期望的字段是 `children`，每个 child 用 `label` 字段填具体内容**。不是 text / items / desc。

**❌ 错法 1（把 4 个 SWOT 关键字当字段名）**：
```
compares
  strengths
    - 客户黏性高
```
错因：`compares` 是数组，不是有 4 个固定 key 的对象。

**❌ 错法 2（每块用 items 数组）**：
```
compares
  - label 优势
    items
      - 客户零初始投资
```
错因：compare-swot 的 design.items 是组件配置，不是数据字段名。**用户数据字段是 children**。

**❌ 错法 3（用 text 字段）**：
```
compares
  - label 优势
    text 客户零初始投资、合同长期绑定
```
错因：itemDatumSchema 没有 text 字段。allowUnknown 会保留它但 plain-text 拿不到。

**✅ 唯一正确写法（children 数组）**：
```
infographic compare-swot
data
  title 工商储 EMC 模式 SWOT
  compares
    - label 优势
      children
        - label 客户零初始投资
        - label 合同长期绑定（8-10 年）
        - label 风险转移至能源服务公司
    - label 劣势
      children
        - label 利润率薄（资方分成 60-70%）
        - label 电价波动暴露大
        - label IRR 容错空间窄
    - label 机会
      children
        - label VPP / 需求响应叠加收益
        - label 工商业电价改革
        - label 双碳目标驱动刚需化
    - label 威胁
      children
        - label 政策调整 / 补贴退坡
        - label 收益覆盖率跌破警戒线
        - label 竞品在能量密度上领先
```

**记忆口诀**：`compares` 是数组，每项 `- label 类别` 下接 `children` 数组，每个 child 一个 `- label 具体内容`。**两层嵌套都用 `- label` + `children`**。SWOT 字母由模板自动从 compares 项的 label 首字符生成，**不用 LLM 手动加 S/W/O/T**。

### 4. 调色板 / 主题（可选）

```
theme
  palette #4f46e5 #06b6d4 #10b981
```

**颜色用裸 hex 值**，不加引号、不加逗号、空格分隔。

theme 块可以省略，省略时用 infographic 默认主题（已经很美观）。

### 5. 图标（可选）

```
- label 服务器
  icon mingcute/server-line
- label 安全
  icon star fill
```

icon 用 mingcute 库的图标名，或预设关键字 `star fill` 等。**不确定时不写**，让模板用默认图标。

---

## 可用模板（93 个，按类别）

### 🔢 数据图表类（**只有 9 个，覆盖少**，复杂数据用 `draw-chart`）

- `chart-bar-plain-text` — 横向柱状
- `chart-column-simple` — 简单柱状
- `chart-line-plain-text` — 简单折线
- `chart-pie` / `chart-pie-plain-text` / `chart-pie-pill-badge` / `chart-pie-compact-card` — 饼图
- `chart-pie-donut-plain-text` / `chart-pie-donut-pill-badge` / `chart-pie-donut-compact-card` — 环形饼图

**仅适合简单数据展示**。复杂数据图（散点/雷达/热力/桑基/多 series 折线）用 `draw-chart`。

### 📋 列表类（25 个，最常用）

适合"展示一组并列要点 / 产品特性 / 服务列表"。

- **网格风格**：`list-grid-badge-card` / `list-grid-compact-card` / `list-grid-circular-progress` / `list-grid-progress-card` / `list-grid-candy-card-lite` / `list-grid-done-list` / `list-grid-horizontal-icon-arrow`
- **行/列风格**：`list-row-*` / `list-column-vertical-icon-arrow` / `list-column-simple-vertical-arrow` / `list-column-done-list`
- **金字塔**：`list-pyramid-rounded-rect-node` / `list-pyramid-badge-card` / `list-pyramid-compact-card`
- **特殊**：`list-zigzag-*`（之字形）

### 🔄 序列类（44 个，最丰富）

适合"按顺序展示步骤 / 流程 / 时间线 / 阶梯式发展"。

- **阶梯**：`sequence-stairs-*`（最常用 `sequence-stairs-rounded-rect-node`）
- **交互**：`sequence-interaction-*`（带连线箭头的步骤）
- **其他**：流程链、漏斗、时间轴变体

### ⚖️ 对比类（17 个）

- **二元横向对比**：`compare-binary-horizontal-badge-card-vs` / `compare-binary-horizontal-simple-vs` / 等（vs / arrow / fold 三种连接方式）
- **SWOT**：`compare-swot`（必须给 4 项 strengths/weaknesses/opportunities/threats）
- **层级对比**：`compare-hierarchy-left-right-circle-node-pill-badge` / `compare-hierarchy-row-letter-card-compact-card`

### 🌳 层级类（hierarchy）

- `hierarchy-mindmap` — 思维导图（注意：和 mermaid mindmap 视觉不同，infographic 风格更精致）
- `hierarchy-tree` — 树形
- `hierarchy-structure` — 组织结构图

### 🔗 关系类（relation，4 个）

- `relation-dagre-flow-tb-simple-circle-node` / `relation-dagre-flow-lr-*` 等（Dagre 自动布局的流程图，比 mermaid flowchart 更精致）

### ☁️ 词云

- `word-cloud`

---

## 数据来源约束（**最高准则**）

按 CLAUDE.md 最高准则：**数据必须来源于知识库或用户消息**，不准编造。

### 正确做法

1. 先调用 `rag_retrieve` / `search_knowledge` 检索相关知识文件
2. 从召回内容里抽取要展示的标题、描述、数据
3. 选合适模板 + 按数据字段填入
4. 输出时在图下方标注来源：`> 数据来源：knowledge/xxx.md`

### 错误做法（**禁止**）

- ❌ 凭空造产品名 / 项目名 / 数字
- ❌ 把通用行业模板套上"假数据"输出
- ❌ 忽略用户消息里明确给出的字段

### 知识库缺口处理

如果用户让你做信息图但知识库没有具体内容，**不要编**。应该：
1. 明确告知"当前知识库里没有 [文档名] 的具体内容"
2. 列出你需要哪些字段
3. 让用户补充后再画

---

## 工作流示例

### 例 1：用户问"做一个 EDV 流程的 5 阶段阶梯图给领导汇报"

1. **检索**：`rag_retrieve("EDV 流程 阶段")` 取流程文件
2. **抽字段**：从召回内容里抽 5 个阶段名 + 简短描述
3. **选模板**：流程顺序 → `sequence-stairs-rounded-rect-node`
4. **构造 DSL**：

    ```infographic
    infographic sequence-stairs-rounded-rect-node
    data
      title EDV 流程 5 阶段
      sequences
        - label PDTR1-2
          desc 概念设计与验证
        - label PDTR3
          desc 系统设计
        - label PDTR4A
          desc CBB/TBB 详细设计
        - label PDTR5
          desc 样机功能验证
        - label PDTR6
          desc 小批量与批量发布
    ```

5. **图下标注**：`> 数据来源：knowledge/EDV流程概览.md`

### 例 2：用户问"把工商储 / 户用 / 大型集装箱 3 个市场对比成一个对比图"

1. 选模板：3 项并列对比 → `compare-binary-horizontal-badge-card-vs`（虽然叫 binary 但可以放多项）或 `list-grid-badge-card`
2. 检索每个市场的特征
3. 输出列表/对比 DSL
4. 标注来源

### 例 3：用户问"用思维导图组织 ODM 2.0 的变更点"

1. **检索**：`rag_retrieve("ODM 2.0 变更点")`
2. **选模板**：思维导图 → `hierarchy-mindmap`（**或考虑用 `draw-mermaid` 的 mindmap，这个更适合树状层级**）
3. 构造 DSL，按 root + children 递归
4. 标注来源

**注意**：思维导图场景，`draw-mermaid` 的 mindmap 通常更合适（更专业、LLM 训练更多）。infographic 的 hierarchy-mindmap 更偏视觉演示。

---

## 自检清单（输出前过一遍）

- [ ] 我用的是 ` ```infographic ` 不是 ` ```chart ` / ` ```mermaid `
- [ ] 我的需求确实是"叙事 / 演示 / 卡片"而非"数据图表"或"流程时序"（否则换 skill）
- [ ] 第一行是 `infographic <template-name>`，模板名在 93 个内置列表中
- [ ] 缩进是 **2 空格**，不是 tab，不是 4 空格
- [ ] 数据字段名和模板前缀匹配（list-* → lists，sequence-* → sequences，compare-* → compares 等）
- [ ] 数组项以 `-` 开头
- [ ] key value 之间用空格，不是冒号
- [ ] 数据来源于 knowledge/ 或用户消息，不是凭空编造
- [ ] 图下面有 `> 数据来源：knowledge/xxx` 标注
- [ ] 知识库有缺口时列出"待补充"

---

## 常见错误

### A. 格式错误（最高频，直接渲染失败 / 卡 loading）

- ❌ **首行写成 `template: xxx`**（YAML 风格）→ 前端检测能容忍，但 renderer 抛"无法解析"
- ❌ **整体 YAML 化**：使用 `metadata:` / `subtitle:` / `tags:` / `author:` 等字段
  ```
  ❌ 错误整体：
  template: compare-swot
  title: SWOT
  metadata:
    tags: [a, b]
  data:
    strengths: [...]
  ```
- ❌ **key value 用冒号**：`label: 阶段一` → 应 `label 阶段一`（**空格**而非 `:`）
- ❌ **缩进用 tab** 或 **4 空格**：必须 **严格 2 空格**
- ❌ **数组项加引号**：`- "客户黏性高"` → 应 `- 客户黏性高`
- ❌ **theme palette 加引号 / 逗号**：`palette: '#4f46e5', '#06b6d4'` → 应 `palette #4f46e5 #06b6d4`

### B. 内容错误（能渲染但失真）

- ❌ **模板名编造**：`infographic super-cool-chart` → 渲染失败
- ❌ **数据字段写错**：`list-grid-*` 模板用 `sequences` 字段 → 数据丢失
- ❌ **数据字段不按模板前缀**：`compare-swot` 用顶级 `strengths` / `weaknesses` → 应放在 `compares` 数组里
- ❌ **`compare-swot` 每块用 items 数组多条**：模板只支持 1 段 plain-text，items 数组会**渲染出 4 个空白块**。多条内容必须用「、」拼成一段 text，或者换 `compare-hierarchy-row-letter-card-rounded-rect-node` 模板
- ❌ **`compare-swot` 的 label 里手动加 S/W/O/T 字母**：`- label 优势 S` → 字母由 letter-card 组件自动生成，多写一个反而冲突。直接 `- label 优势`
- ❌ **用本技能画散点图 / 雷达图 / 热力图**：infographic 不支持，必须用 `draw-chart`

### C. 输出前 30 秒自检

输出代码块前默念以下 5 条；任何一条不满足就重写：

1. 第一行是 `infographic <连字符模板名>`？（不是 `template:` / 不是大写 / 不是 JSON）
2. 全文有没有冒号 `:` 作为 key-value 分隔符？（**应该没有**，仅 hex 颜色和示例 URL 可以含 `:`）
3. 缩进是否都是 2 空格？（数一下）
4. 数组项是否都是 `- ` 开头（短横线 + 空格）？
5. 数据字段名和模板前缀匹配（`list-*` → `lists`，`compare-*` → `compares`，etc）？

---

## 给 LLM 的最后提醒

**这套 DSL 是手写规则，不是任何流行配置语言**。你的训练偏好可能让你想用 YAML（最常见的"配置型代码块"模式），但**必须按本文档的 DSL 输出**。如果文档说"用空格分隔"，就用空格；说"首行 `infographic xxx`"，就那样写。

输出后如果前端报 "INFOGRAPHIC RENDER FAILED"，**根因 95% 在格式而非内容**。重新对照"输出格式"段的对照表逐条核对。
