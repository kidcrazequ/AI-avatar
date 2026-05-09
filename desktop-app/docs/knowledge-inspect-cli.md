# Chunk Inspector CLI 用户文档

> **作者**：zhi.qu  
> **日期**：2026-05-09  
> **配套主计划**：`.cursor/plans/对手对比融合执行计划_2026-05.plan.md` §4.11  
> **适用版本**：Soul Desktop（Electron）2026-05-09 之后  
> **读者**：开发者 / 知识库维护者  

在命令行查看某个分身的知识库被切成的 chunks，配合 RAG 召回排查与 #14 Template chunking 改动验证。**只读**，不修改任何 `.md` / `_index/`。

---

## 1. 5 分钟快速上手

四种模式（注意 `npm run` 透传额外参数需用 `--`）：

```bash
cd desktop-app
npm run knowledge:inspect 小堵-工商储专家                      # 默认：汇总 + 80 字预览
npm run knowledge:inspect 小堵-工商储专家 cbsa                 # 过滤路径含 cbsa 的文件
npm run knowledge:inspect 小堵-工商储专家 -- --full            # 完整内容
npm run knowledge:inspect 小堵-工商储专家 -- --metadata        # 仅查索引元数据
```

默认模式输出片段（汇总形态）：

```
[knowledge-inspect] avatar:        小堵-工商储专家
[knowledge-inspect] knowledgePath: /Users/.../soul/avatars/小堵-工商储专家/knowledge
[knowledge-inspect] filter:        (none)

== 文件 → chunks ==

policies/2024-工商储补贴.md
  ## 概述                                           1234 字  概述：截至 2024 年 ...
  ## 补贴政策（1）                                  3892 字  本节按城市维度梳理 ...  [二次切分]
  ## 补贴政策（2）                                  2105 字  续上：杭州 / 苏州 ...    [二次切分]

products/cbsa-power-system.md
  cbsa-power-system                                  876 字  CBSA 储能系统是 ...

== 汇总 ==

文件数:           12
chunks:           47
字符总数:         183,420
平均字符:         3,902
最长 chunk:       5,142 字 @ products/foo.md ## 大段落（4）  [⚠️ 超过 CHUNK_SPLIT_THRESHOLD(4000)]
二次切分:         8 个（heading 末尾含「（n）」）
超长（>4000）:    3 个

== 索引元数据（_index/）==

  contexts.json:    ✓  47 entries
  embeddings.json:  ✓  47 entries
  ... (省略 hashes / tokens，格式同上)
```

---

## 2. 输出字段说明

- **文件数 / chunks / 字符总数 / 平均字符 / 最长 chunk**：基础统计；最长 chunk 会标注所在文件与 heading，超过阈值时打 ⚠️。
- **二次切分: `<n>` 个**：`KnowledgeRetriever.pushChunks` 把单段超过 `CHUNK_SPLIT_THRESHOLD=4000` 的 chunk 切成多段时，会在 heading 末尾追加全角「（1）」「（2）」标记（来自 `packages/core/src/knowledge-retriever.ts:638-669`，**只读引用**，不要为了改字段格式去动 core）。
- **超长（>4000）**：单段落本身就超过阈值、`pushChunks` 也无法再切的边界 chunk，常见来源是单个超长段落或表格未换行。出现时建议在源 `.md` 里手动加二级 / 三级 heading 切开。
- **`_index/` 4 个 json 文件状态**：`✓ N entries`（正常）/ `✗ (missing)`（未生成）/ `✗ [damaged]`（JSON 解析失败）/ `✗ [unreadable]`（IO 失败）/ `✗ [unexpected shape]`（不是对象）。

---

## 3. 三种模式何时使用

- **默认模式**：日常排查"某文档被切成什么样"，看汇总 + 80 字预览。
- **`--full`**：需要逐字看 chunk 内容；建议重定向到文件，单分身可能十万字级别（`> chunks.txt` 或 `| less`）。
- **`--metadata`**：只想知道索引是否齐备；**不**重建索引、**不**打印 chunk，秒级返回。

---

## 4. 配合 #14 Template chunking 验证改动效果

本工具最大价值是给 `packages/core/src/document-parser.ts` 的 chunking 改动做前后对比：

```bash
cd desktop-app

# 步骤 1：改动前先扫一遍基线
npm run knowledge:inspect <avatar> > /tmp/before.txt

# 步骤 2：改 packages/core/src/document-parser.ts（#14 Template chunking）
#         然后用 desktop-app/scripts/rebuild-knowledge-index.ts <avatar> 重建索引

# 步骤 3：再扫一遍并 diff
npm run knowledge:inspect <avatar> > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt
```

我们关心的指标是：① **chunks 数变化**；② **二次切分数变化**（heading 应保留更多原始结构，二次切分应**减少**）；③ **超长 chunk 数应不增加**（不应把更多内容塞进单 chunk）。

---

## 5. FAQ

**Q1：为什么不做 GUI 可视化面板？**  
A：2026-05-09 决议（主计划 §2 / 收官指挥官启动卡 序 4 #13）将原 Chunk 可视化面板（S~M, 3-5 天）降级为 CLI 轻量版（XS, 0.5 天）。Soul 现有 chunking 元数据简洁（`{file, heading, content}`），CLI + 重定向已能覆盖 90% 调试场景。

**Q2：和 `desktop-app/scripts/rebuild-knowledge-index.ts` 是什么关系？**  
A：`rebuild-knowledge-index` **重建**索引（contexts / embeddings / hashes / tokens 落盘），需要 LLM API Key、耗时数分钟到数十分钟；`knowledge-inspect` **只读**展示 chunk 切分结果，秒级返回、不需要 API Key、不写任何文件。两者配合：先 `rebuild-` 重建，再 `inspect` 验证。

**Q3：支持 Project overlay 吗？**  
A：本期**不支持**。CLI 只扫 `avatars/<id>/knowledge/`，不扫 `avatars/<id>/projects/<pid>/knowledge/`。原因：`CompositeKnowledgeRetriever`（#4）未导出 `getFullChunks` / `getChunkKeys`，CLI 层无法用同样接口列出 overlay chunks。未来可加 `--project <id>` 参数（follow-up）。

**Q4：`--full` 输出太长怎么办？**  
A：CLI 不内置分页；用 shell 重定向：`npm run knowledge:inspect <avatar> -- --full > chunks.txt` 或 `... -- --full | less`。

**Q5：`CHUNK_SPLIT_THRESHOLD` 在哪？为什么 CLI 自己保存了一份？**  
A：源头在 `packages/core/src/knowledge-retriever.ts:25-27`（默认 4000）。该常量未被 `@soul/core` 导出，CLI 在 `desktop-app/scripts/knowledge-inspect.ts` 头部本地复制了一份并注释「与 core 同步」。⚠️ #14 若调整该值，请**同时**改这两处。

**Q6：跑了几秒还没出结果？**  
A：`KnowledgeRetriever` 构造时同步扫所有 `.md` 并切 chunk，100MB+ 知识库可能阻塞 5-15 秒。CLI 已先打印 `[knowledge-inspect] building chunks...`，正常等待即可。

---

## 6. 退出码

| 退出码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 用法错误（`avatar-id` 缺失 / 未知 flag / 非法 `avatar-id`） |
| 2 | 路径不存在（`avatars/<id>/knowledge` 不存在） |
| 3 | 运行时异常（构造 retriever / 读 `_index` 抛错） |

---

## 7. 技术参考（开发者）

- CLI 实现：`desktop-app/scripts/knowledge-inspect.ts`
- chunking 主逻辑（**不应被本工具修改**）：`packages/core/src/knowledge-retriever.ts`
- 最佳模板（同 lane 既有脚本）：`desktop-app/scripts/rebuild-knowledge-index.ts`
- 完整方案：`.cursor/plans/对手对比融合执行计划_2026-05.plan.md` §4.11
- 决议背景：启动卡 `.cursor/plans/对手对比融合-收官指挥官启动卡.md` 序 4 #13

---

## 修订记录

| 日期 | 版本 | 修改内容 | 作者 |
|---|---|---|---|
| 2026-05-09 | v1.0 | 初版：4 模式 / FAQ / 与 #14 配合验证流程 | zhi.qu |
