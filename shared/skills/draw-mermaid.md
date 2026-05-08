---
name: draw-mermaid
description: 当用户需要结构化可视化（甘特图 / 流程图 / 时序图 / 思维导图 / 看板 / 状态机 / ER 图等非数值类）时，输出 mermaid 代码块在聊天里直接渲染为 SVG。数据来源必须是知识库或用户提供，禁止编造。
---

# 结构可视化技能 · draw-mermaid

> **级别**：[■■] 进阶
> **版本**：v1.0
> **最后更新**：2026-04-15

---

## 触发条件

用户问题包含以下关键词或意图时使用本技能：

| 关键词 | 对应 mermaid 图表 |
|---|---|
| 甘特图 / 时间线 / 任务计划 / 项目排期 | `gantt` |
| 流程图 / 工作流 / 架构图 / 全景图 / 模块关系 | `flowchart` / `graph` |
| 时序图 / 交互流程 / 调用顺序 | `sequenceDiagram` |
| 思维导图 / 知识图谱 / 概念地图 | `mindmap` |
| 看板 / Kanban / 任务状态 | `kanban` |
| 状态机 / 状态流转 | `stateDiagram-v2` |
| 实体关系 / 数据模型 / ER 图 | `erDiagram` |
| 饼图 / 占比（简单类型，复杂的用 draw-chart） | `pie` |
| 类图 / OOP 结构 | `classDiagram` |
| Git 分支 / 版本历史 | `gitGraph` |

如果用户要的是**纯数值图表**（柱状图 / 折线图 / 散点图 / 趋势对比 / 多序列），用 `draw-chart` skill 输出 ECharts。**两个技能的分工**：
- `draw-chart` = 数据 / 数值 / 统计 / 趋势
- `draw-mermaid` = 结构 / 关系 / 流程 / 时间规划

---

## 输出格式（**必须遵守**）

用三反引号 + `mermaid` 标记输出代码块，前端会自动渲染：

    ```mermaid
    gantt
        title 项目计划
        dateFormat YYYY-MM-DD
        section 需求阶段
        需求调研 :a1, 2026-04-01, 7d
        需求评审 :after a1, 3d
    ```

前端 MermaidRenderer 会把它渲染成 SVG 图表。

---

## 数据来源约束（**最高准则**）

按 CLAUDE.md 最高准则：**数据必须来源于知识库或用户消息**，不准编造。

### 正确做法

1. 先调用 `rag_retrieve` / `search_knowledge` 检索相关知识文件（比如会议纪要、项目计划）
2. 从召回内容里抽取任务名、时间节点、状态、依赖关系
3. 按 mermaid 语法组装
4. 输出时在图表**下方**标注来源：`> 数据来源：knowledge/xxx.md`

### 错误做法（**禁止**）

- ❌ 凭空造任务名和时间（比如"需求调研 2 周"这种模糊编造）
- ❌ 把通用项目管理模板当作"真实数据"输出
- ❌ 忽略用户消息里明确给出的时间 / 状态 / 责任人

### 知识库缺口处理

如果用户让你画甘特图，但知识库里没有足够的时间线信息，**不要编**。应该：
1. 明确告知："当前知识库里没有 [文档名] 的具体时间节点"
2. 列出你需要哪些字段（任务名 / 开始时间 / 工期 / 依赖）
3. 让用户补充后再画

---

## mermaid 语法速查（常用子集）

### 甘特图 gantt

```
gantt
    title 标题
    dateFormat YYYY-MM-DD
    axisFormat %m/%d

    section 阶段名
    任务名 :状态, id, 开始时间, 持续时间
    另一任务 :done, id2, after id, 3d
    进行中任务 :active, 2026-04-20, 5d
    严重任务 :crit, 2026-05-01, 7d
```

状态标签：`done`（已完成）/ `active`（进行中）/ `crit`（关键路径）/ 无标签（未开始）

### 流程图 flowchart

```
flowchart TD
    A[起点] --> B{判断条件}
    B -->|是| C[路径一]
    B -->|否| D[路径二]
    C --> E[终点]
    D --> E
```

方向：`TD`（上下）/ `LR`（左右）/ `BT` / `RL`

节点形状：`[矩形]` / `(圆角)` / `((圆))` / `{菱形}` / `[[子流程]]` / `[(数据库)]`

### 时序图 sequenceDiagram

```
sequenceDiagram
    participant 用户
    participant 系统
    用户->>系统: 发起请求
    系统-->>用户: 返回结果
    Note over 系统: 处理中
```

### 思维导图 mindmap

```
mindmap
    root((中心主题))
        主题一
            子主题 1.1
            子主题 1.2
        主题二
            子主题 2.1
```

### 看板 kanban

```
kanban
    待办
        任务 A
        任务 B
    进行中
        任务 C
    已完成
        任务 D
```

### 状态机 stateDiagram-v2

```
stateDiagram-v2
    [*] --> 初始化
    初始化 --> 运行中 : 启动
    运行中 --> 暂停 : 暂停
    暂停 --> 运行中 : 恢复
    运行中 --> [*] : 停止
```

### ER 图 erDiagram

```
erDiagram
    用户 ||--o{ 订单 : 下单
    订单 ||--|{ 订单项 : 包含
    订单项 }|--|| 商品 : 对应
```

### 饼图 pie

```
pie title 占比分布
    "类别 A" : 42
    "类别 B" : 30
    "类别 C" : 28
```

---

## 工作流示例

### 例 1：用户问"把储充车网 ITR 会议纪要里 ODM 含充电桩、状态 open 的 E 务条目输出为甘特图"

1. **检索**：`rag_retrieve("储充车网 ITR 会议纪要 E 务 ODM 充电桩")`
2. **筛选**：从召回 chunks 里找 ODM 字段含"充电桩"且状态是 open 的条目
3. **抽字段**：任务名、负责人、预计完成时间、依赖关系
4. **构造 mermaid**：

    ```mermaid
    gantt
        title 储充车网 ITR 问题分析会 - ODM 充电桩开放项
        dateFormat YYYY-MM-DD
        section 充电桩硬件
        接插件选型 :active, a1, 2026-04-10, 14d
        模组验证 :after a1, 10d
        section 软件
        BMS 适配 :active, b1, 2026-04-15, 21d
    ```

5. **图下标注来源**：`> 数据来源：knowledge/储充车网_ITR_问题分析会_会议纪要.md`
6. **结尾列出遗漏**（如果有）：如果某些条目没有具体时间信息，在图表下方的"待补充"列表里列出

### 例 2：用户问"画一下工商储产品开发的 EDV 流程全景图"

1. `rag_retrieve("EDV 流程 工商储")` 取会议文件 / 流程规范
2. 从召回内容里找 EDV 的各阶段名、阶段顺序、关键决策点
3. 用 `flowchart TD` 构造
4. 标注来源

---

## 常见错误

- ❌ **编时间**：知识库没说"2 周"就不要写"2 周"
- ❌ **甘特图没有 dateFormat**：mermaid 会渲染失败
- ❌ **中文标点进语法**（`，`代替 `,`）：mermaid 是英文语法
- ❌ **flowchart 节点 id 用中文**：建议用 A / B / step1 这种英文 id，中文放节点 label
- ❌ **超长节点文本**：超过 50 字会让图变形，应该拆成多个节点或用 `<br/>` 换行

---

## 和其他技能的协作

- 数据检索 → `rag_retrieve` / `search_knowledge`
- 数值图表 → `draw-chart`（ECharts）
- 结构 / 流程 / 时间规划图 → **`draw-mermaid`（本技能）**
- 复合任务（检索 + 画图）→ 可以参考 `chart-from-knowledge` 的模式组合

---

## 自检清单（输出前过一遍）

- [ ] 我是不是真的有知识库或用户消息里的数据？没有就说没有。
- [ ] 代码块用的是 ` ```mermaid ` 而不是 ` ```json ` / ` ```chart `
- [ ] 第一行关键字拼对了（`gantt` / `flowchart TD` / `sequenceDiagram` 等）
- [ ] 甘特图写了 `dateFormat`
- [ ] 节点 id 用英文字母数字
- [ ] 图下面有 `> 数据来源：knowledge/xxx` 标注
- [ ] 如果知识库有缺口，结尾列出了"待补充"
