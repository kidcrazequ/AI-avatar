---
name: draw-infographic
description: 当用户需要"信息图 / 叙事可视化 / 演示卡片"（非数据图表）时，输出 @antv/infographic 声明式 DSL 代码块在聊天里直接渲染为 SVG。覆盖列表 / 对比 / 序列 / SWOT / 时间线 / 思维导图 / 流程图 / 金字塔 / 词云 / 进度卡 等 84+ 信息图模板。数据来源必须是知识库或用户提供，禁止编造。
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

---

## DSL 语法核心规则

### 1. 首行格式（**必须**）

```
infographic <template-name>
```

例如：`infographic list-grid-badge-card` / `infographic compare-swot` / `infographic sequence-stairs-...`

模板名不能编造，必须从下面"可用模板列表"中挑。

### 2. 缩进规则

- **2 空格缩进**（不是 4 空格、不是 tab）
- 数组项以 `-` 开头
- key 和 value 之间用 **空格** 分隔（不是冒号 `:`）

### 3. 数据块字段映射（按模板前缀选）

| 模板前缀 | 数据字段 |
|---|---|
| `list-*` | `lists` |
| `sequence-*` | `sequences` |
| `sequence-interaction-*` | `sequences` + `relations` |
| `compare-*` | `compares` |
| `compare-swot` | `compares`（4 项 strengths/weaknesses/opportunities/threats）|
| `hierarchy-*` | `root` 单根 + 递归 `children` |
| `relation-*` | `nodes` + `relations` |
| `chart-*` | `values`（单组值）|
| `word-cloud` | `items`（含 text + weight）|

**写错字段 = 渲染失败**。LLM 必须按模板前缀决定数据字段名。

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

- ❌ **模板名编造**：`infographic super-cool-chart` → 渲染失败
- ❌ **数据字段写错**：`list-grid-*` 模板用 `sequences` 字段 → 数据丢失
- ❌ **缩进用 tab**：DSL 解析失败
- ❌ **key value 用冒号**：`label: 阶段一` → 解析失败，应该 `label 阶段一`
- ❌ **theme palette 加引号 / 逗号**：`palette: '#4f46e5', '#06b6d4'` → 失败
- ❌ **用本技能画散点图 / 雷达图 / 热力图**：infographic 不支持，必须用 `draw-chart`
