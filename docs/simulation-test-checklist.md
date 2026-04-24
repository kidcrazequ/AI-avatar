# AI-avatar 模拟测试清单

这份清单用于在当前裁剪仓库上做“自动化 smoke + 手工场景验证”。

## 一、先跑自动化 smoke

在 `desktop-app/` 下执行：

```bash
npm run test:simulation
npm run test:source-smoke
npm run test:conversation-smoke
```

预期结果：

- `test:simulation` 通过，说明来源锚点解析、答案引用校验、历史消息补注释、引用动作与预览链路可用。
- `test:source-smoke` 输出 `PASS`，并打印一份简化 JSON 摘要，确认“用户消息 -> tool 消息 -> assistant 引用 -> 主引用预览”链路打通。

## 二、建议的手工模拟场景

### 场景 1：普通事实问答

输入一个带明确知识来源的问题，确认：

- 首条回答能带 `[来源: ...]`
- 回答末尾不会重复堆同一来源
- `sourceAnnotation.summary.status` 为 `all-current-context` 或 `partially-supported`

### 场景 2：Excel / 图表追问

先问一次表格问题，再追问“再解释一下这两个数值的区别”。

确认：

- `query_excel` 不会无限重复调用
- 历史 tool 结果被压缩后，仍保留可复用来源锚点
- 最终回答里仍能引用 `knowledge/_excel/...#sheet=...&rows=...`

### 场景 3：历史会话重载

加载已有会话，调用 `hydrateMessages(avatarId, messages)`。

确认：

- 旧 assistant 消息能重新补上 `sourceAnnotation`
- 底层 `referenceCards` / `references` 能恢复
- 打开某条历史消息的来源预览，不依赖新一轮回答也能工作

### 场景 4：无效来源过滤

故意让模型生成一个不存在的 `[来源: ...]`。

确认：

- 最终展示前该来源会被移除
- 如果本轮上下文里有可用来源，但正文没引用，会补温和兜底提示或参考来源

## 三、准备接 renderer 时看什么

当前仓库已经把这些数据准备好了：

- `message.sourceAnnotation.inlineDisplayText`
- `message.sourceAnnotation.references`
- `message.sourceAnnotation.referenceCards`
- `message.sourceAnnotation.primaryReferenceCards`
- `chatStore.openSourceReference()`
- `chatStore.activeSourceReference`

renderer 接入时，建议优先做：

1. 消息内 `[1] / [2]` 可点击
2. 消息底部来源卡片列表
3. 点击后弹出 `activeSourceReference` 预览面板

## 四、当前“已可开始模拟测试”的边界

在这份裁剪仓库里，以下部分已经具备自动化验证入口：

- Router / Context strategy / Prompt 预算
- 来源锚点解析与校验
- 历史消息来源重建
- 来源动作执行与预览模型
- store 级来源预览状态

暂未在这份裁剪仓库里直接落地的是：

- renderer 组件本身
- 真正的 MessageBubble / KnowledgeViewer 点击交互
- 完整 Electron 打包回归
