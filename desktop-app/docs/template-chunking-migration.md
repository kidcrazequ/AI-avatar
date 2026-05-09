/**
 * Template-based Chunking 升级迁移指南
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

# Template-based Chunking 升级迁移指南

> 配套主计划：`.cursor/plans/对手对比融合执行计划_2026-05.plan.md` §4.12
> 配套窗口：指挥官-W17-#14-2026-05-09
> 配套 CLI：`npm run knowledge:inspect`（详见 `desktop-app/docs/knowledge-inspect-cli.md`）

---

## 1. 升级做了什么

`desktop-app/electron/document-parser.ts` 在 2026-05-09 升级了两个 handler 的 Markdown 输出质量：

| 文档类型 | 升级前 | 升级后 |
|---|---|---|
| **PDF** | `pdf-parse` 返回平面 `fullText`，无任何 heading | 多页 PDF（`pages.length >= 2`）每页前注入 `### 第 N 页` 三级标题 |
| **Word .docx** | `mammoth.extractRawText` 返回纯文本，H1/H2/H3 全部丢失 | `mammoth.convertToHtml` + Turndown，保留 H1-H6 标题层级；中文「标题 1/2/3」与英文 "Heading 1/2/3" 都被 styleMap 显式映射 |
| PPTX | 已有 `## 第 N 页` ✅ | 不变 |
| Excel / 图片 / HTML / TXT | — | 不变 |

**核心目的**：让 `packages/core/src/knowledge-retriever.ts` 的 `buildChunks`（按 `##/###` 切分）在导入新 PDF / Word 文档时能自然按页 / 按标题层级切出独立 chunk，避免「一个 50 页 PDF → 一个超长 chunk」。

> ⚠️ 本升级**不解决手工写的超长 .md**（如 `README.md ## 知识文件索引（2）` 41,018 字）。  
> 那种情况只能由作者把单个 `##` 节内容拆成多个 `##` 子节。

---

## 2. 升级后是否需要重建分身索引？

**只有「老分身已经导入过 PDF / Word 知识文件」才需要重建索引。**

- ✅ **新分身**：直接导入文档，自动用新逻辑生成 .md
- ✅ **老分身但只导入过 .md / PPTX / Excel**：完全不影响，无需重建
- ⚠️ **老分身导入过 PDF / Word**：建议重建一次索引，让现存的 .md 用新逻辑重新生成 + 重新切 chunk + 重新跑 embedding

### 2.1 判断本分身是否需要重建

```bash
cd ~/AI/soul/desktop-app

# 1) 列出 chunks 现状（重点看二次切分数 + 超长 chunk 数）
npm run knowledge:inspect <你的分身ID>

# 2) 看具体哪些文件源自 PDF / Word（一般在 knowledge/ 目录下文件名带 .pdf.md / 直接 .md 但导入自 PDF）
#    Soul 当前的导入流程不在 .md 文件名里保留原始扩展名，所以最简单的做法是：
#    打开知识库目录手工辨认，或者用 git log 查看哪些 .md 是导入产生的（非手工写）
```

如果输出里：
- 「二次切分」数量大（说明很多 chunk 因超长被按段落兜底切了）
- 「超长（>4000）」非零（说明 chunking 阈值还撑不住）

→ 重建索引会带来明显改善。

### 2.2 如何重建索引

⚠️ **预计成本**：embedding 调用约 = chunk 总数 × 1。小堵分身约 2940 chunks，重建一次约 2940 次 API 调用。请确保 OCR / DashScope Key 配额充足。

**步骤**：

1. **备份**当前 `_index/` 目录（保险起见）：
   ```bash
   cd ~/AI/soul/avatars/<你的分身ID>/knowledge
   cp -r _index _index.backup-2026-05-09
   ```

2. **方案 A（推荐）：删 `_index/` 启动 Soul，自动增量重建**
   ```bash
   rm -rf _index
   # 启动 Soul Desktop App，进入分身后等首次 embedding 重算完成
   ```
   `KnowledgeIndexer` 会发现 `_index/contexts.json` / `embeddings.json` 缺失或 `hashes.json` 不匹配，自动按新 chunks 重新算。

3. **方案 B：用现成脚本一次性重建**
   ```bash
   cd ~/AI/soul/desktop-app
   npx tsx scripts/rebuild-knowledge-index.ts <你的分身ID>
   # 等结束后看输出：成功 chunk 数应与 #13 CLI 列出的总数一致
   ```

4. **重新导入 PDF / Word 文件**（如果你想让原始文档也用新逻辑重新转 .md）：
   - 进入 Soul UI → 分身 → 知识库 → 删除原文件 → 重新拖入
   - 此时 `parsePdf` / `parseWord` 会用升级后的逻辑生成 .md，写入 `knowledge/` 后再被 indexer 切 chunk + embed

> 注：方案 A/B 只是**重切 chunks + 重算 embedding**，原始 .md 文件不变。  
> 如果想让 PDF 内容真的带上 `### 第 N 页`，必须走方案 4（重新导入）。

---

## 3. 用 #13 CLI 验证升级效果

```bash
cd ~/AI/soul/desktop-app

# 升级前留底
npm run knowledge:inspect <你的分身ID> > /tmp/chunks-before.txt

# （执行升级 + 重建索引 + 重新导入 PDF/Word）

# 升级后留底
npm run knowledge:inspect <你的分身ID> > /tmp/chunks-after.txt

# 对比
diff /tmp/chunks-before.txt /tmp/chunks-after.txt
```

**期望看到的改善**：

| 指标 | 期望变化 |
|---|---|
| 「二次切分」总数 | ↓ 下降（多页 PDF 不再被合并成一个超长 section） |
| 「超长（>4000）」总数 | ↓ 下降 |
| 来自 PDF 的文件 | 出现 `### 第 1 页` / `### 第 2 页` …（heading 列） |
| 来自 Word 的文件 | 出现原文 H1/H2/H3 标题（heading 列） |
| 来自 PPTX 的文件 | 不变（仍是 `第 N 页`） |
| 来自 Excel 的文件 | 不变（仍走 `_excel/*.json` 结构化路径） |

---

## 4. 已知边界（不要踩坑）

### 4.1 引用溯源 URI 不携带页码

升级后 PDF 转 .md 含 `### 第 N 页` heading，但**引用溯源链路当前不识别页码**：

- `[来源: knowledge/policy.pdf.md#L12-L18]` 仍然是 .md 行号，**不是** `#page=2`
- 渲染层 chip UI 只能跳到 .md 行号锚点

**未来 follow-up**（不在本期范围）：
- 扩展 `packages/core/src/source-anchor.ts` URI 增加 `&page=N` 查询参数
- 渲染端 chip 解析 heading（如 `### 第 N 页`）提取页码并跳转 PDF 第 N 页

### 4.2 PPTX / Excel 路径完全没改

- PPTX：已有 `## 第 N 页`，本期不动
- Excel：走 `_excel/*.json` + `query_excel` 工具，本期不动

### 4.3 中文 Word styleMap 限定为「标题 1-6」

如果你的 Word 用了**自定义样式名**（如 "MyHeading1"），styleMap 不会识别，标题会被 turndown 当成普通段落输出。

**解决办法**：
- 改用 Word 内置「标题 1/2/3」样式
- 或给 `desktop-app/electron/document-parser.ts:parseWord` 的 `styleMap` 数组加自定义条目（需要改代码）

### 4.4 表格在 Turndown 默认配置下变成 tab 分隔文本

本期未引入 `turndown-plugin-gfm`。Word 内的表格被 Turndown 默认转成多行 tab 分隔文本（仍可读，但不是 GFM `| ... |` 表格格式）。

**未来 follow-up**：评估引入 `turndown-plugin-gfm` 启用 GFM 表格转换。

### 4.5 `CHUNK_SPLIT_THRESHOLD=4000` 未变

PDF 升级会让大多数页变成独立 chunk，每页通常 < 4000 字符；但若某一页文字密度极高（密集学术论文 2 栏排版），仍会触发二次切分。这是预期行为。

阈值常量在两处保存：
- `packages/core/src/knowledge-retriever.ts:25-27`
- `desktop-app/scripts/knowledge-inspect.ts` 文件头

如未来调整该值，**两处必须同步**（`docs/knowledge-inspect-cli.md` FAQ Q5 也已说明）。

---

## 5. 影响下游任务

| 下游 | 影响 |
|---|---|
| #13 Chunk Inspector CLI | 直接受益：升级后 chunks 数量分布更均匀，CLI 输出更易判断知识库健康度 |
| 引用溯源 chip UI | 暂无影响（不识别页码 URI） |
| #6 LangBot 互补 | 暂无影响（HTTP 协议层无关） |
| 模型调用与 RAG 召回 | 间接受益：embedding 粒度从「整篇 PDF」收敛到「每页」，召回更精准 |

---

## 6. FAQ

**Q1：升级后老分身的旧 .md 文件需要重新写吗？**  
A：不需要。老 .md 内容不变，只是 chunking 结果会变。

**Q2：升级后单页 PDF 的行为变了吗？**  
A：没变。`pages.length < 2` 时不注入 heading，与升级前一致。

**Q3：升级会破坏 PPTX / Excel 路径吗？**  
A：不会。两条路径完全不变，git diff 在 `parsePptx` / `parseExcel` 都为空。

**Q4：Word 升级后图片提取还在吗？**  
A：在。`word/media/*` 图片抽取（base64 dataURL）逻辑保留，只是主文本路径换了。

**Q5：如果 mammoth `convertToHtml` 抛错怎么办？**  
A：自动回退到现有 `extractRawText`，保证 Word 解析不会因升级新增失败模式。再不行则走第三级 fallback「adm-zip + word/document.xml 抽取 `<w:t>`」。

**Q6：Vision OCR 在 PDF 升级后还工作吗？**  
A：完全工作。OCR 截图判定基于 `rawFullText`（pdfjs 原始文字），不受 `### 第 N 页` 注入污染。Vision 数据合并的 HTML 注释 `<!-- 以下为第 N 页... -->` 依然有效。

---

## 7. 修订记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-05-09 | v1.0 | 初版（指挥官-W17-#14） |
