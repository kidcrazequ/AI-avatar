# Conversation 路由与 Prompt 预算 smoke 清单

这份清单用于在当前裁剪仓库里，快速确认“快路径是否真的生效、Prompt 是否被预算裁剪”。

## 一、自动化入口

在 `desktop-app/` 下执行：

```bash
npm run test:conversation-smoke
```

预期结果：

- 输出 `[conversation-route-smoke] PASS`
- 典型问题会被分流到预期策略：
  - `no-rag`
  - `cache-only`
  - `excel-first`
  - `full-rag`
- 输出 JSON 摘要中，能看到：
  - `contextStrategy`
  - `toolProfile`
  - `reason`
  - `estimatedChars`
  - `historyRetainedCount`
  - `fastPath`

## 二、推荐一起跑的质量闸门

```bash
npm run test:qa-gate
```

它会顺序执行：

1. `test:simulation`
2. `test:source-smoke`
3. `test:conversation-smoke`

全部通过，说明：

- 来源锚点与引用链路可用
- 历史消息补注释链路可用
- 来源动作与预览链路可用
- Router / Context strategy / Prompt 预算 smoke 可用

## 三、手工关注点

### 场景 1：短确认句

输入“好的 / 继续 / 明白了”之类的短句。

确认：

- 不应走重 RAG
- `contextStrategy` 应趋向 `no-rag`

### 场景 2：图表追问

输入“把上面的图换成柱状图”。

确认：

- 优先命中 `cache-only`
- `shouldCheckChartCache = true`

### 场景 3：精确表格数值

输入“请给出 215 机型 2026 年 1 月到 3 月分别是多少”。

确认：

- 优先命中 `excel-first`
- 不要先走一大圈泛化 RAG

### 场景 4：跨文件综合问题

输入“结合政策手册和销售手册，总结返点规则差异”。

确认：

- 命中 `full-rag`
- 不要误走 `no-rag`

### 场景 5：长历史对话

构造多轮历史，再发一条“继续总结一下”。

确认：

- `historyRetainedCount` 会下降
- `estimatedChars` 不会无限膨胀
- 更早历史会被预算裁掉，而不是始终硬塞最近 40 条
