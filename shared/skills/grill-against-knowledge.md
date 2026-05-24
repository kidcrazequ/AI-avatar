---
name: grill-against-knowledge
description: 当用户**显式**说"grill me / 拷打一下 / 反问我"等且当前分身有 knowledge/ 知识库时，是 grill-me 升级版：grill 同时把用户措辞对照 knowledge/README.md 术语表（冲突即时澄清），并对"难回滚 + 离开上下文会困惑 + 有实质 trade-off"三条同时成立的决策落 ADR 到 knowledge/decisions/；显式触发，不主动 grill 默认对话。
---

# 知识库对齐式拷打 · grill-against-knowledge（公共版）

> **级别**：[■■■] 高阶
> **版本**：v1.0
> **最后更新**：2026-05-19
> **改造自**：[mattpocock/skills · engineering/grill-with-docs](https://github.com/mattpocock/skills)
>
> **改造要点**：
> 1. **CONTEXT.md → `knowledge/README.md`**：术语表不再造一份，直接用分身已有的知识库索引
> 2. **ADR 路径** = `knowledge/decisions/ADR-YYYYMMDD-xxx.md`（无 active project 时）  
>    = `knowledge/projects/<project_name>/decisions/ADR-YYYYMMDD-xxx.md`（**有 active project 时优先这里**）
> 3. **ADR 触发三条同时成立才写**（克制 ADR 数量，避免成为流水账）
> 4. **显式触发**（同 grill-me），不主动 grill 默认对话
>
> **任务包（project）感知**：当用户在某个任务包下对话时，ADR / notes / decisions 都应落到 `knowledge/projects/<project_name>/` 子树。判断方式：观察用户的对话上下文是否提到"项目 X / 客户 X / Project X"，或上下文已注入了 project README，**优先把决策记录写到 project 专属目录**，便于后续同 project 内的 decision-trace 检索。

---

## 触发条件

启动信号同 `grill-me`（见该技能的"触发关键词"）。

**额外前提**：当前分身存在 `knowledge/` 目录且 `knowledge/README.md` 不为空。若不满足，降级到普通 `grill-me`。

---

## 与 grill-me 的差异

继承 grill-me 的全部流程，**额外**做三件事：

### 差异 1：启动时加载术语表

进入 grill 流程前先读：
1. `avatars/<分身>/knowledge/README.md` — 主索引和术语
2. （可选）`avatars/<分身>/knowledge/glossary.md` 或 `terms.md` — 若存在
3. `avatars/<分身>/knowledge/decisions/` — 已有 ADR 列表（避免重复决策）

把术语表常驻在 grill 上下文中，提问时对照用户措辞。

### 差异 2：术语对齐 — 用户措辞与 knowledge/ 冲突时即时澄清

提问过程中，如果用户用了**与知识库定义不一致**的术语：

```markdown
**术语澄清**：

你刚才说的"[用户用词]"，在 knowledge/README.md 里的定义是 **[知识库定义]**。
你的意思是：
- A. 沿用知识库定义（推荐 — 保持术语一致性）
- B. 你说的是别的概念，我们引入新术语 "[建议名]" 并补充进 README.md
- C. 知识库定义需要更新

选哪个？
```

用户确认后：
- 选 A → 后续 grill 用知识库术语
- 选 B → 在「需求纪要」末尾标注"新增术语：…"，提议补充到 knowledge/README.md
- 选 C → 标注"待更新术语"，grill 结束后**询问**是否要改 README.md（不擅自改）

### 差异 3：决策结束时，挑出值得落 ADR 的决策

grill 结束输出「需求纪要」后，扫一遍「已确认决策」表，对每一行判断：

**ADR 触发条件（三条**同时**成立）**：
1. **难回滚** — 一旦实施再改要付出非琐碎代价（数据迁移 / 已签合同 / 已发布 API）
2. **离开当前上下文后会困惑** — 三个月后回看，光从代码 / 方案本身看不出为什么这么选
3. **有实质 trade-off** — 选 A 排除了 B/C，且 B/C 也有真实理由（不是显然劣解）

任一条不满足 → **不写 ADR**（克制）。

满足三条 → 在「需求纪要」末尾追加：

```markdown
### 建议落 ADR

以下决策建议沉淀为 ADR（满足"难回滚 + 离开上下文会困惑 + 实质 trade-off"三条）：

| 决策点 | 建议文件名 |
|---|---|
| [决策点描述] | `knowledge/decisions/ADR-2026-05-19-xxx.md` |

是否要我起草？（起草后由你确认再落盘）
```

用户同意后，按以下骨架起草 ADR，**不直接写盘**，先输出内容让用户审：

```markdown
# ADR-YYYY-MM-DD-[短标题]

**状态**：[已采纳 / 待评估 / 已废弃 / 已替代]
**日期**：YYYY-MM-DD
**决策人**：[姓名或角色]
**所属分身/知识域**：[avatar-id 或主题]

## 背景

[3-5 句：问题是什么、约束是什么、为什么现在需要决定]

## 决策

[1-2 句：最终选了什么]

## 备选方案

| 方案 | 利 | 弊 | 为何未选 |
|---|---|---|---|
| A. ... | ... | ... | ... |
| B. ... | ... | ... | ... |

## 后果

- 正面：[...]
- 负面 / 代价：[...]
- 回滚成本：[...]（明示难回滚程度）

## 相关知识 / 引用

- knowledge/xxx.md
- 来源文件 / 数据 / 标准

## 后续触发条件（可选）

[出现什么情况时应回看本 ADR]
```

---

## 完整执行流程

```
1. 触发判断（同 grill-me）
        ↓
2. 加载 knowledge/README.md + decisions/ 列表
        ↓
3. 内部扫一遍：哪些问题知识库能答 → 不问；术语怎么对齐 → 准备好对照
        ↓
4. 进入 grill-me 标准流程（逐题 + 推荐答案 + 复述确认）
        ↓
   过程中遇到术语冲突 → 立即插入「术语澄清」环节
        ↓
5. 输出「需求纪要」
        ↓
6. 扫描已确认决策，挑出满足 ADR 三条件的
        ↓
7. 起草 ADR（不直接写盘），用户确认后落到 knowledge/decisions/
        ↓
8. （可选）若有新增术语 / 术语更新，询问是否更新 knowledge/README.md
```

---

## 反模式（在 grill-me 基础上追加）

❌ **ADR 滥用**：任何决策都写 ADR，把 decisions/ 变成流水账 — 三条同时满足才写
❌ **擅自改 README**：grill 过程中直接编辑 knowledge/README.md — 必须等用户确认
❌ **忽略已有 ADR**：grill 出与既有 ADR 冲突的方案却不提示 — 启动时就该扫一遍 decisions/
❌ **新造术语不沉淀**：用户引入新概念却不补 README — 失去对齐价值
❌ **把 ADR 写成需求文档**：ADR 只记"决策本身 + 备选 + trade-off"，不要把整个方案塞进去

---

## 与其他技能的关系

| 技能 | 关系 |
|---|---|
| `grill-me` | 父技能，本技能在其上叠加术语对齐 + ADR |
| `decision-trace` | 强互补：本技能**写** ADR；decision-trace **读** ADR 做回溯 |
| 各分身的 `search_knowledge` / `query_excel` | grill 启动阶段用来扫知识库，避免把可查的问题甩给用户 |

---

## 示例

### 用户输入
> "我们想给小堵加一个'光伏自发自用率'指标。grill 一下要点。"

### 分身输出（节选）

> 已加载 knowledge/README.md。我注意到知识库里已有"自消纳率"和"自发自用比例"两个相近术语，先做术语澄清，再进入 grill。
>
> **术语澄清 Q0**：
>
> 你说的"自发自用率"，knowledge/README.md 里现有的是：
> - "**自消纳率**" = 光伏发电中被本地负载消纳的比例
> - "**自发自用比例**" = 同上，是历史沿用别名
>
> 你想：
> - A. 用"自消纳率"作为正式词，"自发自用率"作为别名加进 README（推荐 — 沿用项目语料）
> - B. 这是另一个概念，建议新名 "[?]"
> - C. 知识库定义需要更新
>
> 选哪个？

### 后续输出（grill 结束、ADR 提示）

> ## 需求纪要 · 自消纳率指标
> ...（决策表略）
>
> ### 建议落 ADR
>
> 以下两条决策建议沉淀 ADR：
>
> | 决策点 | 建议文件名 | 为何满足三条件 |
> |---|---|---|
> | 用"15 分钟级"而非"小时级"采样 | `knowledge/decisions/ADR-2026-05-19-self-consumption-sample-rate.md` | 难回滚（影响 6 个月历史数据回填）+ 三个月后回看会困惑 + 与"小时级"有计算精度 vs 存储成本的实质 trade-off |
> | 限定指标只对"工商业、装机 > 100kW"项目计算 | `knowledge/decisions/ADR-2026-05-19-self-consumption-scope.md` | 难回滚（已对外承诺范围）+ 离开上下文易误用 + 与"全场景适用"有 trade-off |
>
> 是否要我起草这两份 ADR？
