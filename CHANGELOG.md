# 更新日志

## v0.6.12 (2026-04-15)

### Process 目录验证 + 追加修复

8. **docx 表格 fallback** — `parseWord()` 当 mammoth 提取字数 < 500 且文件 > 20KB 时，直接解 zip 从 `word/document.xml` 抽 `<w:t>` 节点（按 `</w:p>` / `</w:tr>` / `<w:br/>` 作为块分隔符保留段落结构）。覆盖 mammoth `extractRawText` 不含表格单元格文本、文本框、SDT 内容控件的已知限制

9. **parser setTimeout 泄漏修复** — `parseFile()` 的超时保护用 `setTimeout` 但成功路径未 `clearTimeout`。批量处理 300+ 文件后每个文件留一个 5 分钟的 pending timer，导致 CLI dry-run 跑完后进程不退出。`try/finally` 中加 `clearTimeout` 修复（生产 Electron 长驻进程不受影响）

10. **dry-run 归档解压 walk-through** — `testdocs/dry-run-format-product.ts` 遇到 `.zip` / `.rar` 时解压到临时目录并递归扫描内部文件（含 zip 炸弹防护由 node 自身限制托底），报告路径用 `{archive}!/{inner}` 格式。和生产 folder-importer 行为一致，暴露归档内部的真实文件结构
    - 用 `createRequire('/Users/cnlm007398/AI/soul/desktop-app/package.json')` 解决 dry-run 脚本从 `testdocs/` 跑时 `require('adm-zip')` / `require('node-unrar-js')` 找不到依赖的问题

11. **dry-run 报告命名** — 报告文件名从固定 `dry-run-report-product.json` 改为按目标目录 basename 动态命名（`dry-run-report-{basename}.json`），多个目录跑 dry-run 时互不覆盖

12. **dry-run 清理临时目录** — 归档解压目录在 main 结束时自动 `rm -rf`，避免 /tmp 堆积

13. **🔥 纯图片 / 图片型 docx 的 OCR 结果被静默丢弃修复** — `main.ts` 批量导入、单文件导入、enhance 补跑 OCR 三处 merge 分支都有同一个 bug：`if (ocrOutcome.results.length > 0 && parsed.perPageChars)` — `parsed.perPageChars` 只对 PDF 有，`parseImage()` 和 `parseWord()` 都不设置此字段。导致**所有 .jpg / .png / .gif / .webp / .bmp 输入，以及图片型 docx** 的 Vision OCR 结果都被整段跳过，最终写入 md 永远是空的 `_（无文本内容）_`。修复：`perPageChars` 不存在时回退到"OCR 结果直接作正文"路径（`ocrTexts.join('\n\n')` 追加到 cleanedText）。此前小堵-工商储专家 knowledge 目录中 19 张 .png / .jpg 图片（OCV-SOC 曲线、电源规格书等）的 md 全部为空，实际 RAG 里完全没有这些图的内容

**Process 目录 107 文件（含归档内部 11 份）最终结果**：
- 解析失败 **2**（GBK 编码 zip，adm-zip 限制 — 生产 folder-importer 也受影响）
- 真空 **2**（空壳合同模板 `附件六 技术协议.docx`，文档本身只有"甲方/乙方/日期"签名栏，结构性无救）
- 真乱码 0 / 未切分 1（2591 字 `.doc` 检验报告无章节结构，embedding 完整覆盖 RAG 无影响）

## v0.6.11 (2026-04-15)

### 批量导入质量修复 — 章节切分 / 长文档 embedding / docx 图片 / pdfjs flake

经 `testdocs/dry-run-format-product.ts` 对 300 份工商储产品文档跑 4 轮 dry-run 暴露并修复：

1. **章节切分 6 处 regex 修复**
   - 新增 `第X条` / `第X节` 分支（合同/协议类文档）
   - 数字编号后允许可选句号（`1. 化学品...` 类中英混排文档）
   - 标题首字符允许英文大写（编号英文标题）
   - 新增 **英文独立标题分支**：首字母大写 + 前后空行孤立 + 非 key:value，覆盖 `Instructions`、`Round-Trip Efficiency (RTE)` 类裸标题
   - 新增 **孤立 CJK 短标题分支**：首字符 CJK + 前后空行孤立 + 2-30 字符，覆盖 `系统运行模式`、`离网模式` 这类无编号裸中文标题
   - 冒号 `:` / `：` 结尾排除（过滤 `Certificate Number:` 等 key:value 标签）

2. **章节切分早 return bug 修复** — `chapterBreaks.length === 0` 时直接 return 单个"全文"章节，跳过了整个 merge + 超长切分管线。导致 14k BOM / 17k 控制计划等超长单章节文档无法二次切分。改为 fall-through，让无章节文档也走切分逻辑

3. **长文档 embedding 覆盖修复**
   - `knowledge-indexer.ts` embedding 输入从 `slice(0, 500)` 改为 `slice(0, 3000)`
   - `document-formatter.ts` `MAX_CHAPTER_CHARS` 从 6000 改为 3000
   - 两者配合实现"隐式滑窗"：formatter 保证每章节 ≤ 3000 字，indexer 单向量完整覆盖章节语义
   - 修复 1000–6000 字章节的后半段无法向量召回的问题

4. **docx 图片提取** — `parseWord()` 补充 `word/media/*` 图片提取为 base64 dataURL，交给下游 Vision OCR。修复图片型 docx（如 `Test report key pages GB44240.docx`）解析为空的问题

5. **PDF 分页 fallback** — `parsePdf()` 当 `textResult.pages` 缺失或为空，且全文稀疏/乱码时，fallback 截图前 N 页交给 Vision。修复 `2025010041-3 IP 等级防水测试 CNAS.pdf` 这类 pdfjs 拿不到分页信息导致零截图的边界情况

6. **pdfjs 批量 flake 缓解** — `parsePdf()` 末尾调 `parser.destroy()` 释放底层 document 引用，消除批量导入 300+ 文件时 worker 状态累积导致的"0 截图"随机 flake（161 页 PCS 报告从批量 0 截图恢复到正常）

7. **dry-run 脚本升级**（`testdocs/dry-run-format-product.ts`）
   - 递归遍历目录 + 按相对路径显示
   - 新增分类：**Vision 兜底** / **短文档直送** / **表格型 PDF** / **真空** / **真乱码** — 把 dry-run 工件与真问题分离
   - 表格型检测：短行占比 > 45% 时跳过章节切分报警
   - `.dwg` 归入跳过（CAD 图纸 parser 不支持，不算失败）

**Product 目录 300 文件 dry-run 结果（v1 → v4）**：
- 解析失败 3 → **0**
- 真乱码 3 → **0**（全归 Vision 兜底）
- 真空文档 40 → **3**（剩余都是 pdfjs 小概率 flake，生产单文件处理路径不受影响）
- 未切分 38 → **2**（剩余 2 份是 < 3000 字 key:value 证书表单，embedding 完整覆盖 RAG 零影响）

## v0.6.10 (2026-04-15)

### UI 修复 + 乱码检测 + 章节切分优化 + README 增强

1. **移除 ENHANCE 按钮** — 批量导入已不需要补跑 LLM 格式化，清理相关死代码
2. **GEN TEST / FORMAT 按钮样式修复** — 从 `pixel-btn-outline-muted` 改为 `pixel-btn-outline-light`，深色背景下可见
3. **FORMAT 按钮智能显隐** — Excel / PPT / 图片文件自动隐藏 FORMAT 按钮（通过 frontmatter raw_file 扩展名判断）
4. **状态文字可见性** — PanelHeader subtitle 颜色从 `text-px-text-dim` 改为 `text-px-primary`；`isBusy` 时隐藏 subtitle 避免与进度条重复
5. **格式化进度动画** — `isFormatting` 加入 `isBusy`，FORMAT 操作时显示 spinner + 进度条
6. **PDF 乱码检测** — 新增 `isGarbledText()` 检测 CID 字体编码异常，乱码页强制 OCR；FORMAT 乱码内容时给出明确错误提示
7. **章节切分优化（v12）** — 经 35 文件 dry-run 测试验证：
   - 收紧 heading regex：每级最多 2 位数字 + 标题必须以 CJK 字符开头，排除表格数据（`220 94,5`）和列表项（句号结尾的行）
   - 微小章节自动合并：< 500 chars 的章节合并到前一章节
   - 效果：用户手册 130 章节 → 8-12 章节，电气原理图 46 → 1，技术协议 20 → 3
8. **FORMAT 跳过短内容** — 纯图 PDF（cleaned=0）和小文件（<500 chars）给出明确提示而非无效调 LLM
9. **README 增强** — 批量导入首次创建 README 时生成完整模板（使用说明、目录结构、命名规范、质量标准）
10. **LLM 超时调大** — `BACKEND_API_TIMEOUT_MS` 3 分钟 → 5 分钟，减少格式化超时失败
11. **TS 零错误** — 修复 `@soul/core` 缺少 `exports` 字段导致 `callVisionOcr` 在 bundler 模式下找不到的问题

## v0.6.9 (2026-04-15)

### 重构 — 批量导入去掉 LLM 格式化 + 单文件 FORMAT 按钮

#### 1. 批量导入回归快速模式

LLM 逐章格式化占批量导入 99% 耗时（183 文件预估 49 小时 vs 跳过仅 24 分钟），且频繁超时。实测确认格式化不影响检索质量（BM25 + 向量都作用在原始文本上）。

**改动**：批量导入只做解析 + 清洗 + OCR，不做 LLM 格式化。

#### 2. 单文件 FORMAT 按钮

在知识库文件查看器的 EDIT 按钮旁新增 FORMAT 按钮，用户可按需对单个重要文件执行 LLM 结构化格式化（从 _raw/ 重新解析 → OCR → LLM 格式化 → 数值校验 → 写回）。

#### 3. 智能 OCR 页面检测

旧方案（固定 300 字符阈值）导致工程图纸 PDF 只有 25% 的页被 OCR。新方案结合字符数 + 噪音比（单字符行占比）双重判断：
- < 300 chars → OCR（扫描件/纯图）
- 300-1000 chars + 噪音比 > 25% → OCR（工程图纸）
- 其他 → 文字页不 OCR

模拟验证 134 个 PDF：工程图纸全覆盖，文字文档不误触。

## v0.6.8 (2026-04-14)

### 优化 — 批量导入体验 + 格式化加速

1. **每文件完成即刷新文件树** — 不再等整个批量导入结束才显示，每完成一个文件左侧列表立即更新
2. **短章节跳过 LLM 格式化** — < 2000 字符的章节（签字页/目录页/端子图等）直接保留原文，不调 LLM，减少 50-70% API 调用
3. **格式化模型修复** — 优先用 creation 模型（qwen-plus）做格式化，不用 chat 模型（deepseek-chat）
4. **rag_only 按大小判断** — > 50KB 才标记 rag_only，小文件直接进 system prompt，与单文件导入一致
5. **README.md 自动更新** — 批量导入完成后自动更新知识文件索引表
6. **每文件计时统计** — 终端输出分步耗时（解析/OCR/格式化），便于诊断瓶颈

## v0.6.7 (2026-04-14)

### 重构 — 批量导入逐文件完整处理 + 多项修复

#### 1. 批量导入架构重构（中断安全）

之前批量导入只做快速写入（无 LLM 格式化），需要用户手动点 ENHANCE 补跑。ENHANCE 中断后文件处于半成品状态。

**重构**：逐文件完整处理（解析 → 清洗 → OCR → LLM 格式化 → 写入）。每完成一个文件立即可搜索，支持断点续导（跳过已完成文件）。导入完成后自动构建检索索引。无 API Key 时降级为原始文本写入。格式化优先用 creation 模型（qwen-plus），fallback 到 chat 模型。

#### 2. 知识库为空时直接告知用户

RAG 检索无结果时，在 user 消息中附加系统提示引导 LLM 直接回复"知识库中没有相关数据"，不再浪费 10 轮工具调用搜索不存在的数据。

#### 3. 导入进度实时显示

状态栏文字跟随每个文件的处理阶段实时更新（解析中 → OCR → LLM 格式化 → done），不再停在"解压 + 批量导入中..."。

#### 4. unrar.wasm 路径修复

node-unrar-js 的 WASM 文件无法被 esbuild 打包，运行时报 ENOENT。构建时拷贝到 dist-electron/。

#### 5. tempDirs 作用域修复

import-archive 的 finally 块引用了 try 块内的 tempDirs 变量，extractArchive 抛出时报 ReferenceError。

#### 6. 异步预热 chunk 缓存

用 fs.promises.readFile 替代同步 readFileSync 预热 chunks，主线程不阻塞。

## v0.6.6 (2026-04-14)

### 性能 — 启动假死 + 提问卡顿 + 思考动画 + 图表视觉

#### 1. 启动假死修复

批量导入 416 个文件后，`loadAvatar()` 的 `readDirectory()` 同步读取所有 `.md` 文件完整内容（含 rag_only 大文件），阻塞主线程 10+ 秒导致 UI 假死。

**修复**：`readDirectory()` 对每个 .md 文件先读 512 字节探测 frontmatter，`rag_only: true` 的文件只保留头部元数据，跳过可能数 MB 的 body。500+ 文件场景从 10+ 秒降到 < 1 秒。

#### 2. RAG 提问加速

每次提问固定调一次 LLM 做实体提取（多跳检索），即使查询关键词已精准命中也要等 3-5 秒。

**修复**：检查第一跳 BM25 top-1 score，≥ 8 时跳过实体提取直接用第一跳结果。精准查询（如"215 机型设备侧效率"）省 3-5 秒。

#### 3. 思考动画修复

"思考中..."状态只显示一个静态小方块，`animate-pulse-glow` 是未定义的自定义动画类。

**修复**：改为 Tailwind 内置 `animate-bounce` 三点错时跳动，给用户明确的"正在处理"视觉反馈。

#### 4. 图表 markLine 标签截断

参考线末端标签"参考"被 `grid.right: 24` 截断。

**修复**：`grid.right` 24→64；新增 markLine 默认样式（暖黄虚线、无箭头、深底标签）；新增 markPoint 默认样式（LED 粉色）；splitLine 改为更微妙的虚线。

#### 5. warmUp 预热回滚

`setImmediate` 预热 chunk 缓存仍然阻塞主线程。如果用户在预热期间发消息，LLM fetch stream 会断开报 `BodyStreamBuffer was aborted`。

**修复**：回滚 warmUp，chunk 构建由 `searchChunks` 懒加载触发，发生在 async handler 内部不阻塞 UI。

## v0.6.5 (2026-04-14)

### 修复 — PDF Windows 打包兼容 + 批量导入增强

#### 1. PDF Windows 打包兼容

pdf-parse v2 内部通过 `import("./pdf.worker.mjs")` 动态加载 pdfjs worker。在 Windows 打包后 asar 内 `import()` 加载 `.mjs` 文件有兼容性问题，导致所有 PDF 导入失败。

**修复**：构建时把 pdfjs worker 预构建为 CJS（`pdf-worker.cjs`），主进程启动时通过 `require()` 加载到 `globalThis.pdfjsWorker`。pdfjs-dist 检测到后直接使用，跳过有兼容问题的动态 `import()`。

#### 2. 批量导入支持嵌套归档

之前批量导入文件夹时，遇到嵌套的 `.zip` / `.rar` / `.7z` / `.tar.gz` 会跳过并标记 `unsupported extension`。

**修复**：`walkFolder` BFS 遍历时遇到归档文件自动解压到临时目录并加入队列继续遍历。解压产物受原有深度 / 文件数 / 总字节限制约束，完成后自动清理临时目录。

#### 3. 支持 `.doc` 旧版 Word 格式

之前导入 `.doc` 文件直接报错"不支持旧版 .doc 格式"。mammoth 只支持 `.docx`（Office Open XML），无法处理旧版 OLE2 二进制格式。

**修复**：新增 `word-extractor` 依赖（纯 JS，MIT），提取 `.doc` 文件的正文、脚注、尾注。`.doc` 加入 `SUPPORTED_PARSE_EXTENSIONS`。

#### 4. UI 文案优化

"知识库质量优化中（完整管线：OCR → 清洗 → 格式化 → 校验）..." → "知识库质量优化中..."，去掉用户不需要感知的技术细节。

## v0.6.4 (2026-04-14)

### 修复 — `dist:mac` 也加自动 rebuild better-sqlite3

v0.5.13 给 `dist:win` / `dist:linux` / `dist:all` 加了自动 rebuild 兜底（避免跨平台打包污染 dev 环境），但**漏了 `dist:mac`**。当时假设"Mac 打 Mac 不会换 binding"。

实测发现 dist:mac 也会动 binding：当 codesign 失败 / 中途出错 / 目标 arch 和 host 不一致时，`electron-builder install-app-deps` 在打包流程中已经把 binding 换成了目标 arch，但因后续步骤失败没有恢复。重启后 `npm run dev` 报：

```
dlopen failed: incompatible architecture (have 'arm64', need 'x86_64h' or 'x86_64')
```

或者（之前 dist:win 失败遗留的情况）：

```
slice is not valid mach-o file （实际是 PE32+ Windows DLL）
```

**修复**：`desktop-app/package.json` 的 `dist:mac` 末尾追加 `&& npx @electron/rebuild -f -w better-sqlite3`。现在 4 个 dist 命令格式完全一致：打包结束后都自动 rebuild 回 host arch。

`@electron/rebuild` 默认用 host arch（Intel Mac → x64，Apple Silicon Mac → arm64），不需要硬编码 `--arch`。

## v0.6.3 (2026-04-14)

### 修复 — 图表 4 个剩余视觉问题（接 v0.6.2 Chart.js 自动转换）

v0.6.2 让 Chart.js drift 也能渲染了，但**图表本身的视觉质量仍有 4 个问题**（实测 215 机型截图）：

1. **长标题和右上角 legend 撞车** — 标题 `215机型设备侧效率趋势图（2025年7月-12月）` 28 字符，挤进了主题原本预留给 legend 的 right 区域
2. **Y 轴 0-100% 太宽** — 数据集中在 88-92%，0-100 让 4pp 差异看起来像直线
3. **decal pattern 太重** — `aria.decal: { show: true }` 给每个 series 加密集紫红色 dots，整张图 80% 被 pattern 覆盖
4. **多 series 折线图渐变 areaStyle 重叠成浑浊色块** — 主题默认开启 `line.areaStyle` 渐变，2 series 渐变叠加成一片紫红

### 修复 A — 主题（`echarts-pixel-theme.ts`）

| 改动 | 之前 | 之后 |
|---|---|---|
| `legend` 位置 | `top: 12, right: 16`（top-right）| `bottom: 12, left: 'center'`（底部居中）|
| `grid.top` | 72 | 64 |
| `grid.bottom` | 40 | 56（给底部 legend 留空间）|
| `aria.decal.show` | `true` | `false`（保留 aria 给屏幕阅读器，但不渲染视觉 pattern）|
| `line.areaStyle` | 默认渐变 | **删除默认**（多 series 时浑浊；单 series 想要让 LLM 显式 `series[0].areaStyle: {}` 主题会自动注入颜色）|

底部 legend 是更稳的默认，长标题 + 多 series 都不会冲突。

### 修复 B — `draw-chart.md` skill 加 4 条规则

`templates/skills/draw-chart.md` + `avatars/小堵-工商储专家/skills/draw-chart.md` 同步（343 → 357 行）：

#### 规则 3（新）：百分比/效率类数据自适应 Y 轴

```
如果数据是 % 类（设备效率、转化率、SOH、合格率），强制 0-100 会让 4-5pp
差异看起来像直线。规则：
- 计算数据 [min, max]
- yAxis.min: floor((min - 2) / 5) * 5  （向下取整到 5 的倍数，留 2pp buffer）
- yAxis.max: ceil((max + 2) / 5) * 5   （向上取整到 5 的倍数，留 2pp buffer）
- yAxis.axisLabel.formatter: "{value}%"
- 例：数据 88.25-90.6% → yAxis.min: 85, max: 95
```

这是 UED "禁止截断 Y 轴" 的合理例外：百分比本身就是相对量，不会误导。

#### 规则 4（强化）：标题 + 副标题必填，标题 ≤ 20 字符

```
- title.text 简洁（≤ 20 字符），不要把数据范围塞进 text
- title.subtext 必须有，写"数据来源 / 时间范围 / 项目数 / 单位"
- 错误反例：text: "215机型设备侧效率趋势图（2025年7月-12月）"（28 字符）
- 正确：text: "215 机型设备侧效率趋势"
        subtext: "数据源：xxx · 2025-07 至 2025-12 · 单位 %"
```

#### 配合规则 2 更新：areaStyle 默认关闭

```
v0.6.3 起主题不再默认给折线图加渐变 areaStyle。
- 单 series 折线图想要渐变：series[0].areaStyle: {} 显式开启
- 多 series 折线图：严禁 areaStyle
```

#### 高级视觉段同步描述

新增说明 "legend 自动放底部居中（v0.6.3 起）" + "aria 启用但不渲染 decal pattern（v0.6.3 起）"，让 LLM 知道主题已经接管这两件事。

### 验证

- desktop-app typecheck ✅ / lint ✅ / build ✅
- **实际效果需要用户重启 Soul** 让 LLM 看到新 skill 规则 + 重新走主题渲染。预期：
  - 长标题不再撞 legend（legend 在底部）
  - 百分比图表 Y 轴自适应（不再 0-100）
  - 没有紫红色 dots pattern
  - 多 series 折线图不再有重叠面积渐变

### 三轮图表修复进度

| 版本 | 修复 | 解决的问题 |
|---|---|---|
| v0.6.1 | draw-chart 数据守护规则 | < 3 数据点禁折线、markLine 门槛、稀疏告知、emoji legend icon |
| v0.6.2 | Chart.js drift 自动转换 + skill ECharts 警告 | "Cannot create property 'series' on boolean 'true'" 渲染失败 |
| v0.6.3 | 主题视觉打磨 + 百分比 Y 轴 + 标题长度 + decal 关闭 + areaStyle 关闭 | 长标题撞 legend / Y 轴范围浪费 / decal 太重 / 渐变叠加浑浊 |

## v0.6.2 (2026-04-14)

### 修复 — Chart.js 格式 LLM drift 导致渲染失败

**问题**：用户问 "215 机型最近 6 个月设备侧效率折线图"，LLM 输出了 **Chart.js 格式**而非 ECharts 格式：

```json
{
  "type": "line",
  "data": {
    "labels": ["2025年7月", "2025年8月", ...],
    "datasets": [{ "label": "星火项目设备侧效率", "data": [88.25, 88.28, ..., null] }]
  }
}
```

`ChartRenderer.setOption()` 直接喂给 ECharts，ECharts 内部某处做 `xxx.series = ...` 但 xxx 被 type coercion 成 boolean true，抛出 `Cannot create property 'series' on boolean 'true'`。

**根因**：LLM 训练数据里 Chart.js 远比 ECharts 流行，draw-chart skill 虽然有 ECharts 示例但**没明确说"不是 Chart.js"**，LLM 偶尔会下意识 drift 到更熟悉的 Chart.js 格式。

### 双管齐下修复

#### 修复 A — `ChartRenderer.tsx` 防御性 schema 转换

新增 3 个模块级 helper（**提到组件外避免 useEffect closure 问题**）：

- **`detectChartJsFormat(opt)`**: 检测 `{type, data: {labels, datasets}}` 模式 + 验证缺失 `series/xAxis/yAxis`（防 ECharts 误判）
- **`convertChartJsToECharts(opt)`**: 自动转换为 ECharts 等价格式
  - 笛卡尔系（line / bar / scatter / radar）→ `{title, tooltip, xAxis, yAxis, series}`
  - 饼图（pie / doughnut）→ `{title, series: [{type: 'pie', data: [{name, value}]}]}`
  - `null` → `'-'`（ECharts gap marker，折线图缺口正确显示）
  - `options.plugins.title.text` → `title.text`
  - 多 dataset 时自动加 `legend: {}`
- **`normalizeOption(opt)`**: 入口函数，先 detect → 命中则转换 + 控制台 warn 一次（方便排查 LLM drift），最后注入 `withSafeGrid`

`useEffect` 里的 `setOption(withSafeGrid(option))` 改为 `setOption(normalizeOption(option))`。LLM 即使输出 Chart.js 格式，图表仍能正确渲染。

#### 修复 B — `draw-chart.md` skill 顶部加技术栈警告

`templates/skills/draw-chart.md` + `avatars/小堵-工商储专家/skills/draw-chart.md` 同步更新（292 → 343 行），在 `## 技能说明` 段之前插入新段：

```
## ⚠️ 技术栈说明（关键 — 必读，输出前自检）

本项目使用 Apache ECharts 5+，不是 Chart.js / Plotly / Vega-Lite / D3 / Recharts。
LLM 训练数据里 Chart.js 比 ECharts 流行很多，你可能下意识写出 Chart.js 格式，
这会直接导致渲染失败。

❌ Chart.js 格式（绝对不要输出这种）：
{ "type": "line", "data": { "labels": [...], "datasets": [{...}] } }

✅ ECharts 格式（正确）：
{ "title": {...}, "xAxis": {...}, "yAxis": {...}, "series": [...] }

[关键差异对照表 7 行]

[输出前自检清单 4 条]
```

### 三层防御汇总

| 层 | 修复 | 作用 |
|---|---|---|
| **prompt 层** | skill 顶部技术栈警告 + 对照表 + 自检清单 | 让 LLM 知道项目用 ECharts 不是 Chart.js |
| **代码层** | ChartRenderer detectChartJsFormat + convertChartJsToECharts | LLM 即使 drift 也能自动转换不崩 |
| **错误层** | 之前已有的 ChartErrorBoundary（红框 + 原 JSON）| 转换失败时仍能展示原始 JSON 便于调试 |

### 顺带改进

- ChartRenderer 的 `withSafeGrid` 也提到模块级（之前在组件 body 内），消除 ESLint `react-hooks/exhaustive-deps` 警告
- 转换后的图自动加 `tooltip: { trigger: 'axis' }`（Chart.js 默认有 tooltip，转换时保留这个体验）

### 验证

- desktop-app typecheck ✅ / lint ✅（修复了之前 closure 引发的 hooks warning）/ build ✅
- 实际效果：用户重启后下次画图，即使 LLM 仍然写 Chart.js 格式也能正常渲染（控制台会有 warn 提示），同时 LLM 看到新 skill 警告后大概率不会再 drift

## v0.6.1 (2026-04-14)

### 修复 — draw-chart 技能数据守护规则（防丑图）

**问题**：用户问 "215 机型 2026 年 1-3 月设备侧效率折线图"，得到的图：
- 只有 1 个数据点 89.81 在 2026 年 1 月位置（Excel 数据源**实际只到 1 月**）
- LLM 不知道数据稀疏，硬画 3 月的 X 轴占位刻度
- markLine 拉了一条蓝色虚线箭头横穿到右边超出图表区域，标签溢出截断
- legend.icon 是个 emoji "⛑️" 字符（不是主题默认的 roundRect）
- 副标题 "数据来源：xxx" 和右上角 legend 在垂直位置上撞车

**根因不是主题美感**（`echarts-pixel-theme.ts` 已经有完整的 UED 风格 — 5 色板、Inter 字体、细 splitLine、毛玻璃 tooltip、smooth lines + 渐变 area、圆角 bar、aria decal），**是 LLM 不遵守 chart skill 规则**：
1. 不检查数据点数量就画折线图
2. 单点数据 + `markLine.type:'average'` → average 退化为水平线 → 箭头拉到画布外
3. 用 emoji 字符作 legend.icon
4. 手写 `legend.right` / `grid` 等位置参数覆盖主题
5. 数据稀疏不告知用户，硬画一个"看起来像 3 个月"的图

数据本身核实：Excel `00_工商储-产品质量指标dashboard_260303.xlsx` 的 "总原始表" sheet 共 912 行，215 机型 + 设备侧效率非空有 121 行，但**统计周期最大值是 `2601`（YYMM 格式）**—— 即 2026 年 1 月就是数据上限，2602/2603 真的不存在。

### 修复内容

**`templates/skills/draw-chart.md`** + **`avatars/小堵-工商储专家/skills/draw-chart.md`** 同步更新（247 → 292 行），新增 **"数据完整性守护"** 段（4 条强制规则）+ 强化 **"❌ 严禁"** 段（4 条新禁止）：

#### 数据完整性守护（画图前必检）

1. **数据点数量门槛**：

   | N | 允许图表 | 禁止 |
   |---|---|---|
   | N=0 | 不画图，输出文字提示 | 全部 |
   | N=1 | KPI 卡片（标题大字 + 单值 + 副标）| line / scatter / pie |
   | N=2 | bar 对比图（2 柱 + 涨跌幅）| line（折线至少需 3 点形成趋势）|
   | N≥3 | 全部允许 | — |

2. **数据稀疏诚实告知**：query_excel 返回行数远少于用户预期时，文字部分必须明确说"数据源中仅有 N 个月可用"，并改用近 6 个月历史数据补够 ≥3 点，**禁止硬画"看起来像 X 个月"但实际只有 N 个点的图**。

3. **markLine / markPoint 数据点门槛**：
   - `markPoint type: 'max' / 'min'` 仅在 N≥3 时启用
   - `markLine type: 'average'` 仅在 N≥3 时启用
   - **反例**：单点 + average markLine → 水平线 + 箭头拉到画布外（v0.6.0 之前的 215 截图就是这样）

4. **X 轴不补空刻度**：数据只到 1 月，X 轴只显示 1 月，不要写 `xAxis.data: ['2026年1月', '2月', '3月']` 占位。

#### 强化 ❌ 严禁

- **手动写 `legend.right` / `legend.top` / `grid.left` / `grid.top` / `grid.right` / `grid.bottom`** —— 主题已经精确计算了位置，手动覆盖会让 legend 撞副标题、grid 把数据挤出图表。
- **`legend.icon` 用 emoji / 符号字符**（⛑️ 🔵 ▲ 之类）—— 只能用 ECharts 内置形状字符串（`'roundRect' / 'circle' / 'rect' / 'triangle' / 'line' / 'pin' / 'arrow' / 'none'`），最好不写让主题接管为 `roundRect`。
- **`series[].name` 含 emoji** —— 部分渲染器把 series.name 当 legend label 渲染，emoji 污染图例。
- **`markLine` / `markPoint` 不检查数据点数量** —— 见数据完整性守护 §3。

### 验证

无代码改动，纯技能 markdown。typecheck / lint / build 跳过。
**实际效果需要用户重启 Soul（让新 skill 生效）后**重问"215 机型最近 12 个月设备侧效率折线图"（避开"1-3 月"那段稀疏数据）观察。

### 附带：图表问题的真凶不是主题 — 长尾观察

```
当用户感觉"图表不高级"时，先排查：
  1. LLM 是否硬写了 legend.icon / grid / legend.right 等位置参数（覆盖主题）
  2. 数据点数量是否充足（< 3 点就不应该用折线图）
  3. markLine / markPoint 是否合理（单点数据用 average 会拉横线）
  4. 数据真实情况是否和用户预期匹配（数据源缺月份就应该告知，而不是占位）

主题层面 (echarts-pixel-theme.ts) 通常已经够用，问题大多在 LLM 不遵守 skill。
```

## v0.6.0 (2026-04-14)

### 性能 — 知识库检索 BM25 token 持久化缓存

**问题**：批量导入大量知识文件后（实测：233 个 .md / 4.5 MB CJK 文本），**第一次** `search_knowledge` 调用让 Electron main process **单线程 CPU 100% 跑 30-180 秒**，UI 出现 macOS beach ball 看起来像死机。原因是 `KnowledgeRetriever.searchChunks()` 的 lazy tokenize 阶段对所有 chunks 用 `segmentit` 中文分词器跑一遍，每次重启都要重做。

**修复**：把分词结果持久化到 `_index/tokens.json`，跨 session 复用。

#### 三层缓存策略

| 层 | 存储 | 失效条件 |
|---|---|---|
| 1 | `chunk.tokens` 内存缓存 | retriever 实例销毁 |
| 2 | `tokensMap` per-retriever 内存 Map | retriever 实例销毁 |
| 3 | `_index/tokens.json` 磁盘 | 文件删除 / 损坏 / chunk key 变化 |

`searchChunks` 的 lazy tokenize 阶段优先查 `tokensMap`，cache miss 才调 segmentit + 回填 + 标记 `tokensDirty`。`ToolRouter.execute()` 在每次工具调用后检测 `isTokensDirty()`，dirty 时同步落盘到 `_index/tokens.json`。

#### 性能预期

| 场景 | v0.5.15 | v0.6.0 |
|---|---|---|
| 冷启动首查（无 tokens.json，233 文件 / 4.5 MB CJK）| 30-180 秒 | 30-180 秒**首次**+ 自动落盘 |
| 热启动首查（tokens.json 存在）| 30-180 秒 | **< 2 秒** |
| 重启后第二次查询 | 慢 → 快 | 始终快 |
| 增量导入 1 个新文件后查询 | 全部重新分词 | 只分词新增 chunks |

**主要收益**：每次重启 Soul 不再付 30-180 秒分词税。批量导入后第一次查询仍然慢一次（构建初始 cache），但**只需要付一次**。

#### 改动文件

- **`packages/core/src/utils/chunk-cache.ts`**（新建）—— `loadTokensCache` / `saveTokensCache` / `TOKENS_FILE` / `PersistedTokens` interface。原子写入复用 knowledge-indexer 的 `tmpPath + rename` 模式，防止崩溃损坏 tokens.json。损坏 / 类型不合法时静默 fallback 到全量重新分词，不抛错。
- **`packages/core/src/knowledge-retriever.ts`** —— 新增 `tokensMap: Map<string, string[]>` 字段、`setTokens` / `getTokens` / `isTokensDirty` / `clearTokensDirty` 方法。`searchChunks` 的 lazy tokenize 循环从"只查 `chunk.tokens`"扩展为"查 `chunk.tokens` → 查 `tokensMap` → 调 segmentit + 回填 map 标记 dirty"。
- **`packages/core/src/knowledge-indexer.ts`** —— `saveIndex` 新增可选 `tokens?: Map<string, string[]>` 参数，存在时调 `saveTokensCache` 一并写盘。`loadIndex` 返回类型新增 `tokens: Map<string, string[]>` 字段，自动调 `loadTokensCache`，缺失或损坏时返回空 Map（向后兼容旧 `_index/`）。
- **`packages/core/src/tool-router.ts`** —— `getRetriever` 在加载 `index` 后调 `retriever.setTokens(index.tokens)` 注入持久化缓存。新增 `saveRetrieverTokens(avatarId)` 方法封装"检测 dirty → 落盘 → 清 dirty"逻辑。`execute()` 在每次工具调用后调用此方法，覆盖所有可能触发 lazy tokenize 的工具（`search_knowledge` / 内部 wiki 注入 / `compare_products` 等）。
- **`packages/core/src/index.ts`** —— 导出 `loadTokensCache` / `saveTokensCache` / `TOKENS_FILE` / `PersistedTokens`。

#### 单元测试（新建 `chunk-cache.test.ts`，8 cases 全通过）

- ✅ saveTokensCache → loadTokensCache 完整 round-trip（含 CJK 字符串、空数组）
- ✅ 文件不存在返回 null
- ✅ 损坏 JSON 返回 null 而不抛错（静默 fallback）
- ✅ 类型不合法的项被跳过，合法项保留（防御外部篡改）
- ✅ 不残留 `.tmp` 文件（atomic write 验证）
- ✅ 自动创建不存在的 `_index` 目录
- ✅ 覆盖已存在的 tokens.json
- ✅ 空 Map 也能保存和加载

回归：vision-ocr 26/26 测试全部通过，无副作用。

#### 向后兼容

- 旧 `_index/` 目录（无 tokens.json）→ `loadIndex` 返回空 Map → 首次查询走完整 lazy tokenize → 完成后自动落盘
- 旧版本升级到 v0.6.0 后**第一次查询仍慢**（构建初始 cache），**之后所有查询和重启都快**
- `_index/tokens.json` 损坏 / 缺失 / chunk key 不匹配 → 静默 fallback 到重新分词，不影响功能

#### 不在 v0.6.0 范围（推迟到 Phase 2）

- **进度事件反馈**（方案 3）—— 让 UI 显示 "正在索引知识库 N/233" 而非 beach ball。需要扩展 `KnowledgeRetriever.searchChunks` 加 `onProgress` 回调，通过 IPC 转发到渲染进程显示 toast。改动跨 5 个文件，单独立项实施。
- **App 启动后台预热 retriever**（方案 2）—— 方案 1 的 cache 命中后首查已经 < 2 秒，预热边际收益小。视用户反馈再决定。

### 验证

- core build ✅ + chunk-cache tests **8/8 ✅** + vision-ocr tests **26/26 ✅**（无回归）
- desktop-app typecheck ✅ / lint ✅ / build ✅

## v0.5.15 (2026-04-14)

### 修复 — 工具轮数耗尽 regression 根因

**问题**：用户问 "画 215 机型 2026 年 1-3 月设备侧效率折线图" 时，LLM 仍然撞 `MAX_TOOL_ROUNDS = 10` 报错 `[系统提示] 工具调用轮数达到上限，已提前结束本轮。`，v0.5.14 的 Excel 查询纪律没能完全遏制。

**真正根因**（`git blame` 追溯到 `261d629` commit，2026-04-13）：`chatStore.ts` 的 `compressOldToolResults` 函数在压缩旧 tool 结果时，末尾的摘要文字是**诱导性指令**：

```
[... 已压缩，原文 N 字符。如需完整数据请重新调用工具查询]
```

"**如需完整数据请重新调用工具查询**" 对 LLM 来说是一条**反向指令** —— 每压缩一次就明确叫 LLM 重新调用工具。这在 "query_excel → load_skill → draw_chart" 这类多工具流程中触发死循环：

| Round | LLM 动作 | LLM 看到的 |
|---|---|---|
| 1 | `query_excel(机型=215)` → 3 行数据 | 完整数据 ✓ |
| 2 | `load_skill('draw-chart')` | Round 1 结果被压缩 + "请重新调用工具查询" ⚠️ |
| 3 | LLM 看到提示 → 重新 `query_excel` | Round 2 也被压缩 |
| ... | 重复 | **死循环耗尽 10 轮** |

这是 `261d629` 引入的文案错误，当时只测了"两轮简单流程"，没覆盖多工具流程。

### 修复 A — `compressOldToolResults` 压缩文字从"诱导"改"禁止"

`desktop-app/src/stores/chatStore.ts` 压缩摘要末尾文字：

- ❌ 旧：`"如需完整数据请重新调用工具查询"`
- ✅ 新：`"⚠️ 不要因为这段被压缩就重新调用相同参数的工具 —— 这是你之前已经查询过的数据，结果的要点应该还在你的推理链路和最近轮次回答里。仅当你需要不同 filter / sheet / file 的新数据时才调用工具。"`

从"请重新调用"反向改成"**不要**因为压缩就重调相同参数"，消除了 LLM 的死循环诱因。

### 修复 B — `compressOldToolResults` 保留最近 2 轮 tool 结果而非 1 轮

原逻辑：找 **最后一个** assistant 消息，压缩它之前的所有 tool 结果（保留 1 轮）。
新逻辑：找 **倒数第 2 个** assistant 消息，压缩它之前的 tool 结果（保留 2 轮）。

代码改动（`chatStore.ts:compressOldToolResults`）：
- 扫描时计数 `assistantsSeen`，命中 2 个才设 `preserveFromIdx`
- 其他逻辑（压缩阈值 2000 字符、截断长度 500 字符、调用点、函数签名）**完全不变**

**边界情况保证**（所有场景都是旧逻辑的弱化版，永远不会压得比原来更多）：
- 0 个 assistant → 同旧：不压缩
- 1 个 assistant → 旧会压缩前置 tool（但前置本就无 tool，实际等价无操作），新不压缩
- 2+ 个 assistant → 新的永远多保留 1 轮 = ~16KB tool 结果（Excel 场景 1 次 query_excel ≤ 8KB），占 131k tokens context 的 ~6%，安全

### 修复 C — system prompt 加"工具顺序"纪律

`packages/core/src/soul-loader.ts` 的 Excel 查询纪律段新增规则 5：

```
5. 画图/图表需求的工具顺序（关键）：当用户要求生成图表（折线图/柱状图/饼图/趋势对比等），
   必须先 load_skill('draw-chart') 再 query_excel，不要反过来。
   draw-chart 技能内部会告诉你图表 JSON 格式、数据过滤策略、"最多 2 次 query_excel"的纪律。
   - ❌ 错误顺序：query_excel × 多次 → 想起要加载 draw-chart 技能 → 轮数已耗尽
   - ✅ 正确顺序：load_skill('draw-chart') → query_excel × 1-2 次（带精确 filter）→ 输出 chart 代码块
```

**为什么需要 C**：原先 `draw-chart` 技能文件里的 "最多 2 次 query_excel" 纪律只在技能**加载后**才进入 LLM 上下文。LLM 在加载技能前可以自由浪费轮数。这条规则强制 LLM **先** load_skill **再** query_excel，让技能纪律第一时间生效。

### 三项修复的关系

| 修复 | 治什么 |
|---|---|
| A. 压缩文字从"诱导"改"禁止" | **治根因** —— 直接阻断 LLM 看到压缩摘要后重调工具的循环 |
| B. 保留最近 2 轮 tool 结果 | **加缓冲** —— 给 LLM 短期记忆，减少被压缩触发的重调机会 |
| C. 强制 load_skill 先于 query_excel | **防御性前置** —— 让技能纪律第一时间激活，从源头约束 LLM 行为 |

A 是主修，B 和 C 是辅助。即使 A 失效，B 减少触发，C 让技能纪律提前生效。**三层防御**。

### 不影响原有逻辑的保证

- `compressOldToolResults` 函数签名、调用点、阈值、压缩后长度**全部不变**
- 其他压缩机制（`compressedRecentMessages` 的 4 条 assistant 保留）**完全不碰**
- apiMessages 结构、mutation 方式**完全一致**
- 边界情况（0/1 个 assistant）新旧行为**等价**
- 所有场景下新逻辑都是**旧逻辑的弱化版**，永远不会更激进

### 验证

core build ✅ + desktop-app typecheck ✅ / lint ✅ / build ✅。
实际效果需要用户重启应用（让新 system prompt + 新 chatStore 生效）后重试画图请求观察。

## v0.5.14 (2026-04-14)

### 修复 — Excel 查询工具轮数耗尽

**问题**：用户问 "Summary 总表是否有月份数据" 等 schema 类 meta 问题时，LLM 反复调 `query_excel` 试探列名，撞到 `MAX_TOOL_ROUNDS = 10` 上限报错 `[系统提示] 工具调用轮数达到上限，已提前结束本轮。`。

**根因**（排查多轮确认，非代码 bug）：
- `soul-loader.ts:formatExcelSchema` 输出的 Schema 摘要实际非常详尽（列名 / dtype / 唯一值数 / 范围 / 样例），system prompt 里一直完整存在（`compressOldToolResults` 只压缩 `tool` 消息，不动 system prompt）
- 但 LLM **没意识到 Schema 摘要已经能回答 meta 问题**，选择了"用 `query_excel` 去验证"的试探路径
- 用户本次没加载 `draw-chart` 技能，所以"最多 2 次 `query_excel` + 4 轮内必须出图"的纪律没生效，LLM 没有刹车
- 早先的 tool 结果经 `compressOldToolResults` 压缩后，LLM "记忆模糊"又从头探索列名

**修复 A — system prompt 加全局 Excel 查询纪律**（`packages/core/src/soul-loader.ts`）：
在 `# 可查询 Excel 数据源` 段里加入不依赖技能加载的 5 条纪律：
1. schema 相关问题（列名 / 类型 / 是否含月份 / 字段列表 / 数据范围）→ **直接从 Schema 摘要回答，不要调 `query_excel`**
2. 具体数据问题 → 必须带 filter 调 `query_excel`
3. 单次回答**最多 3 次** `query_excel` 调用
4. 禁止"探索式试探"（不带 filter 的 `limit: 5`）
5. 违反纪律会导致工具轮数耗尽

**修复 B — `query_excel` 返回值带精简 Schema**（`packages/core/src/tool-router.ts`）：
`queryExcel` 返回的 payload 新增两个字段：
- `sheet_row_count`: sheet 总行数（原先没返回）
- `schema`: 精简列定义 `Array<{name, dtype}>`，让 LLM 每次查询后都能看到完整列表

这样即使早先的 tool 结果被压缩，LLM 在新一次 query_excel 响应里依然能看到当前 sheet 的所有列名和类型，不会因"记忆模糊"重新试探。不包含 samples / uniqueCount / range（这些在 system prompt Schema 摘要里），避免膨胀 response payload 超过 `QUERY_EXCEL_MAX_CONTENT_CHARS = 8000` 字符上限。

**验证**：core build ✅ + vision-ocr tests 26/26 ✅ + desktop-app typecheck / lint / build 全绿。实际效果需要用户下次问 schema 类 meta 问题时观察 LLM 是否不再调 `query_excel`。

## v0.5.13 (2026-04-14)

### 构建脚本

- **跨平台打包后自动 rebuild better-sqlite3 恢复本机 native binding** — `dist:win` / `dist:linux` / `dist:all` 三个 script 末尾追加 `&& npx @electron/rebuild -f -w better-sqlite3`。**根因**：`electron-builder --win` / `--linux` 会原地 rebuild `node_modules/better-sqlite3/build/Release/better_sqlite3.node` 为目标平台的二进制（为了打进安装包），但打包结束后**不会**恢复本机版本。下次 `npm run dev` 时 Electron 加载的是上一次打包目标平台的 `.node` 文件，macOS 会报 `dlopen failed: slice is not valid mach-o file`（因为实际是 Windows PE32+ DLL 或 Linux ELF）。自动 rebuild 后副作用消除，开发/打包可以自由切换。`dist:mac` 不需要这个步骤（本机打包本机，native binding 不变）。

## v0.5.12 (2026-04-14)

### 修复 — vision-ocr 第四轮代码审查（8 项）

- **Interruptible sleep：overall timeout 升级为硬上限** — 原 `sleep(delayMs)` 不可中断，overall timeout 触发后 worker 仍会等完 retry 退避才 bail，实际 overall 耗时 = `overallTimeoutMs + max_retry_backoff_duration`（最坏可超 10 秒）。新增 `interruptibleSleep(ms, signal)` helper：监听 `signal.abort` 事件立即 resolve（不 reject，让 retry loop 统一走 `overallAborted` 检查）。retry 退避改用 interruptibleSleep，overall timeout 成为真正硬上限。
- **参数校验：`concurrency < 1` / `maxRetries < 0` 抛错** — 原先 `concurrency=0` 静默早退返回空 results（最糟糕组合：既不工作又不报错），`maxRetries=-1` 直接进入 for loop 条件 `attempt <= -1` 为假从不执行。现在两个参数都在开头校验并抛明确的 Error。
- **`callOnce` → `sendRequestOnce` 重命名** — 函数已重构为接收预序列化的 bodyStr，"callOnce" 的旧语义（"调用一次 Vision"）已不精确，新名字更准确反映"发送一次 HTTP 请求"。
- **`buildOpenAICompletionBody` 返回类型收紧** — 从 `object` 改为内部 interface `OpenAIVisionRequestBody`，字段类型安全，未来改协议字段时 TypeScript 能帮忙。
- **`overallController.abort()` 无参数** — 原先传 `new Error('vision-ocr overall timeout')` 作为 abort reason，但实际下游（`fetchWithTimeout` / `interruptibleSleep`）都通过 `overallAborted` 标志和 `classifyError` 统一映射到 `overall-timeout` 类别，不依赖 `signal.reason`。无参数 `abort()` 更简洁，避免 Error 对象在 `signal.reason` 中挂一个永不被读取的字段。
- **`onRetry` / `onProgress` 契约文档完善** — 明确写出两个易踩坑的点：(1) `onProgress.completed` 在多 worker 并发下**顺序非确定**，UI 应按"显示最新值"策略而非假设严格 1,2,3... 递增；(2) `onRetry.nextDelayMs` 是纯退避时间，不含 onRetry 回调自身耗时 —— **实际 retry 间隔 = onRetry 耗时 + nextDelayMs**，回调内部请保持轻量（建议 <10ms）。

### 测试（vision-ocr.test.ts +5 个 case，共 21 → 26）

- **新测试 1：interruptibleSleep 硬上限验证** — `retryBaseMs: 5000`（退避 2500-5000ms）+ `overallTimeoutMs: 200`（200ms overall cap），断言实际耗时 < 1000ms，证明 retry sleep 被 overall timeout 中断唤醒而非等到自然结束。
- **新测试 2：`maxRetries=0` 首次失败立即终态** — 断言 `attempts=1`（无 retry）+ `category='rate-limit'`。
- **新测试 3：`maxRetries=0` 首次成功** — 断言无 failures。
- **新测试 4：`concurrency=0` 抛错** — 验证参数校验。
- **新测试 5：`maxRetries=-1` 抛错** — 验证参数校验。
- **修复 flaky 测试** — "Retry-After: HTTP date 格式" 原先用 `Date.now() + 1500` 偶发失败（HTTP date 精度到秒，toUTCString 丢 ms 后 Date.parse 回来最多少 999ms，实际等待可能低至 501ms）。改为 `+3000ms` 保证最小等待 2001ms，断言 `>= 1900ms` 稳定通过。

## v0.5.11 (2026-04-14)

### 修复 — vision-ocr 第三轮代码审查（12 项）

- **Full jitter → Equal jitter** — 原 `random(0, base * 2^n)` 可能返回 0ms 等于没退避。改为 AWS Architecture Blog 推荐的 Equal Jitter `delay/2 + random(0, delay/2)`，保证最小退避 delay/2（attempt=0 时 500-1000ms），同时保留随机分散 retry 风暴的能力。
- **SyntaxError（畸形 JSON 响应）可重试** — DashScope 偶发返回 HTML 错误页、gzip 解压失败或截断的响应体，`response.json()` 抛 `SyntaxError`。原先归入 `parse-error` 类别后直接终态失败，现在识别为瞬时错误允许 retry。`isRetryable` 对 `SyntaxError` 返回 true。
- **`aborted` 归到 `overall-timeout` 而非 `unknown`** — `classifyError` 对 `HttpError.type === 'aborted'` 原返回 `'unknown'`（callVisionOcr 不接受外部 signal，所有 aborted 都来自 overall timeout，归 unknown 不精确）。改为返回 `'overall-timeout'`。
- **`onRetry` / `onProgress` 回调支持 async** — 返回类型从 `void` 改为 `void | Promise<void>`，回调内部会被 `await`。允许用户做 I/O（如写日志文件）而不产生 fire-and-forget unhandled rejection。文档明确 `completed` 含失败的图、`onRetry.category` 是**上一次失败**的分类。
- **`finalAttempt` 重命名为 `lastAttemptIdx`** — "final" 暗示"决定性的"，实际语义是"循环最后一次执行到的 attempt 编号"。`lastAttemptIdx` 更准确。
- **body 构造在 retry loop 外 once-ify** — 一张图 base64 ~6-7 MB，原代码在 `callOnce` 内 `JSON.stringify(body)`，3 次 retry 重复 stringify 3 次 ~20 MB 字符串。现在 processOne 外 build+stringify once，callOnce 接收 `bodyStr: string`。
- **`VisionOcrKnownError` 内部类注释补全** — 说明这是文件内部类（不导出）、外部消费方通过 `VisionOcrFailure.category` 字符串判断分类。

### 测试（vision-ocr.test.ts +5 个 case，共 21 个）

- **Mock fetch 正确响应 AbortSignal** — 原 `delayMs` 实现傻等 setTimeout，不检查 `init.signal.aborted`，导致 overall timeout 测试**没真正覆盖 abort 中断 in-flight fetch 的路径**（如果代码忘了传 signal 给 fetchWithTimeout，测试依然通过）。现在 mock fetch 监听 `signal.abort` 事件并抛 AbortError，真实反映 fetch 被中断的行为。
- **新测试 1：畸形 JSON 响应 → SyntaxError retry** — 断言第一次返回 `<html>not json</html>` 后第二次返回成功，验证 SyntaxError 被识别为 retryable。
- **新测试 2：`Retry-After: 2` → 实际等待 ≥1900ms** — 原测试只用 `Retry-After: 0` 验证解析代码不抛错，**没验证值真的被用了**。新测试断言 elapsed 实测时间接近 2000ms，证明 Retry-After 值确实驱动了等待。
- **新测试 3：`Retry-After: HTTP date 格式`** — 构造未来 1.5 秒的 HTTP date 字符串，断言实际等待 ≥1000ms，覆盖 `parseRetryAfter` 的 date 解析分支（原先是死代码）。
- **新测试 4：Overall timeout 在 retry sleep 期间触发** — 设置 `retryBaseMs: 2000` 让 retry 退避 1-2 秒、`overallTimeoutMs: 100` 强制 sleep 中触发 abort，验证 for-loop 顶部的 `overallAborted` 检查能正确短路退出。
- **新测试 5：Overall timeout 中断 in-flight fetch** — 单个 fetch 延迟 500ms、overall timeout 100ms，断言 elapsed < 400ms，证明 AbortSignal 确实触达到正在 fly 的 fetch 上（而不是等 fetch 完成后才发现 overallAborted）。

## v0.5.10 (2026-04-14)

### 修复 — vision-ocr 第二轮代码审查（12 项）

- **自定义 Error 类替代 monkey-patch** — 原先在 Error 对象上动态加 `__visionCategory` / `__visionPartial` 属性再强制 cast 读出，是 TypeScript 反模式。现改用 `VisionOcrKnownError` 内部 class，字段类型安全、`instanceof` 检测不需要 cast，日志序列化时也不会泄漏私有字段。
- **empty-response 现在可重试** — 原先 empty content 被当作终态直接失败，但实际可能是 DashScope 瞬时抽风（内部限流返回空、代理吃响应体等）。现设置 `VisionOcrKnownError.retryable=true`，受 `maxRetries` 控制，连续失败才视为真终态。
- **整批 overall timeout cap** — 防御 worst case：单图 3 次 retry × 300s timeout = 15 分钟/图，50 张图理论最坏 4+ 小时。新增 `DEFAULT_VISION_OVERALL_TIMEOUT_MS = 20 * 60 * 1000`（20 分钟）和 `overallTimeoutMs` option。触发后：已完成的保留、进行中的 fetch 被 `AbortSignal` 中断、未启动的 slot 标记为 `overall-timeout` 类别失败提前返回。
- **尊重 `Retry-After` 头** — 429 限流响应通常带 `Retry-After: N` 头告知客户端等多久。原先完全忽略。改造 `fetchWithTimeout`：非 2xx 响应时把 response headers 规范化为小写 key 后附到 `HttpError.headers`；vision-ocr 在 429 retry 时读取 `retry-after`（支持秒数和 HTTP date 两种格式），取服务器建议和本地 full-jitter 退避中的**较大**值作为实际等待时间。
- **Full jitter 指数退避** — 原先公式 `base * 2^attempt + random(0, 500)` 是 "fixed jitter"，当 base delay 较大时打散效果差（attempt=2 时 4000ms delay 只有 12.5% 方差）。改为 AWS 推荐的 full jitter: `random(0, base * 2^attempt)`，更能分散 retry 风暴，避免所有 worker 同时醒来再次打 API。
- **`onRetry` 回调 + retry sleep 期间 UI 反馈** — 新增 `onRetry?: (info) => void` option，每次决定 retry 前触发（在 sleep 之前），info 包含 `index / attempt / category / nextDelayMs`，上层 UI 可以显示 "图 23 正在重试 (第 2 次 / 限流退避 1500ms)"，不再出现进度条无故冻结。
- **`finish_reason === 'length'` 截断检测顺序调整** — 原先先检查 `!text`（空）再检查 truncated，导致"0 tokens 就截断"被归类为 empty 而非 truncated。现调整为先检查 truncated，保证 finish_reason=length 总被正确分类。
- **OpenAI 协议细节抽象** — 把请求体构造（`buildOpenAICompletionBody`）和响应解析（`parseOpenAICompletionResponse`）抽成内部 helper，"协议细节"和"retry 逻辑"解耦。不引入 provider interface（避免过度设计），但未来替换 vision provider 只需换这两个函数。
- **孤儿 JSDoc 搬家** — 上一轮重构把 `callVisionOcr` 主函数的 JSDoc 块留在了中段、与函数本体断联。现整块挪到函数正上方。
- **`while` 循环改 `for`** — retry loop 改用 `for (let attempt = 0; attempt <= maxRetries; attempt++)`，意图更显式、更符合约定。
- **新增单元测试 16 个（覆盖所有 retry 分支）** — `packages/core/src/tests/vision-ocr.test.ts`，用 Node 原生 `node:test` runner + mock `globalThis.fetch`。覆盖：成功路径、429/5xx/network retry、4xx 不重试、连续失败分类、truncated 保留 partial、empty retry、Retry-After 头、onRetry/onProgress 回调、并发 cursor 原子性、overall timeout 触发、参数校验、baseUrl 归一化。
- **`HttpError.headers` 字段（向后兼容）** — `HttpError` 构造函数第 4 参数新增可选 `headers?: Record<string, string>`（小写 key）。所有现有 `new HttpError(...)` 调用无需修改。`fetchWithTimeout` 非 2xx 分支自动填充规范化后的 headers，供上层做智能退避。

## v0.5.9 (2026-04-14)

### 修复

- **Vision OCR 加入 retry + 错误分类** — 批量 ENHANCE 场景下偶发的 OCR 单图失败，根因主要是瞬时错误（DashScope 限流 429、5xx 服务端、网络层抖动、超时），原 `callVisionOcr` 对单图失败只 `logger.error` 后继续下一张、完全不重试。现加入指数退避 retry（默认 2 次 = 最多 3 次 attempt，基数 1000ms + jitter），按 `HttpError.type/status` 分类：`timeout` / `network` / `429` / `5xx` → 可重试；`4xx`（非 429）/ `aborted` → 不重试。预期失败率显著下降。
- **Vision OCR 失败类别化** — `VisionOcrFailure` 新增 `category` 字段（`timeout` / `rate-limit` / `server-error` / `network` / `client-error` / `empty-response` / `truncated` / `parse-error` / `unknown` 共 9 类）、`attempts` 字段（实际尝试次数）、`httpStatus` 字段。上层 UI 和日志可按类别聚合展示，便于排查。
- **Vision OCR 默认参数上调** — `DEFAULT_VISION_TIMEOUT_MS`: 180s → 300s（极端复杂图偶有 180-240s 耗时）；`DEFAULT_VISION_MAX_TOKENS`: 4096 → 8192（密集技术图原常被截断）；新增 `DEFAULT_VISION_MAX_RETRIES` / `DEFAULT_VISION_RETRY_BASE_MS` 常量及 `maxRetries` / `retryBaseMs` options 供上层覆盖。
- **`finish_reason === 'length'` 截断检测** — 原本输出被 `max_tokens` 截断时只返回部分内容不报错，上层拿到残缺数据不知情。现识别此情况记为 `truncated` 类别失败，但 `results` 仍保留已截断的部分内容（供调用方判断是否使用），`failures` 里同时登记。
- **`baseUrl` 归一化** — 去掉尾部斜杠避免拼接出 `//chat/completions` 双斜杠。
- **HTTP `Accept` 头补齐** — 显式 `Accept: application/json`。

## v0.5.8 (2026-04-14)

### 修复与重构

- **抽取共享 Vision OCR 管线到 core** — 新建 `packages/core/src/utils/vision-ocr.ts`，导出 `callVisionOcr(images, options)`。主进程 ENHANCE 路径和渲染进程单文件导入路径原先各自维护一份 Vision 调用（prompt/模型名/参数硬编码、容易漂移），现合并为同一实现，消除重复代码约 80 行。
- **Vision OCR 并发化** — 从串行循环改为 worker-based 并发（默认 3 路），一份 50 图表页 PDF 的 OCR 时间由 5-12 分钟降至约 1/3。单图失败不中断其他图，失败详情通过 `failures` 数组上报。
- **Vision 模型名参数化** — 原先两处硬编码 `qwen-vl-max`，现通过 options 注入，保留默认值。
- **`findRawFile` 脆弱匹配改为 frontmatter 索引** — 批量导入时把 `preserveRawFile` 返回的精确路径写入 `.md` 文件的 `raw_file: _raw/xxx.pdf` 字段，ENHANCE 时直接读取定位原始文件，避免按文件名反查可能命中错误扩展名（`foo.pdf` vs `foo.xlsx`）、基名碰撞、时间戳正则误伤等问题。老文件（无 `raw_file` 字段）自动回退到 `findRawFile` 按名匹配，保证向后兼容。
- **`preserveRawFile` 原子性** — 解析顺序调整为"先 `parseFile` 后 `preserveRawFile`"，解析失败时不再产生 `_raw/` 孤儿文件。
- **`enhance-knowledge-files` 签名 options 化** — 由 7 个位置参数 `(avatarId, apiKey, baseUrl, model, ocrApiKey?, ocrBaseUrl?, targetFiles?)` 改为 `(avatarId, { llm, ocr?, targetFiles? })`，消除 `undefined` 占位，类型更强。返回值从 4 字段扩展到 8 字段：新增 `fabricatedDetails`（每文件的疑似编造值清单）、`ocrFailures`（跨文件 OCR 失败计数）、`indexBuilt` / `contextCount` / `embeddingCount`（索引重建结果）。
- **索引重建挪进主进程 handler** — 原先 ENHANCE 完成后由渲染进程再发起一次 `buildKnowledgeIndex` IPC 调用，有"用户在 ENHANCE 完成前关窗口导致索引漏建"的风险。现改由主进程 handler 在 for-loop 后直接调用 `buildKnowledgeIndex + saveIndex + invalidateRetriever`，原子化 + 减少一次 IPC round trip。
- **OCR 单图失败静默吞掉** — 原先单图调用异常只 `logger.error` 然后继续下一张，前端完全看不见。现通过 `ocrFailures` 返回字段汇总上报，ENHANCE 结束时在 toast 显示 `N 张 OCR 失败`。

## v0.5.7 (2026-04-14)

### 增强

- **批量导入保留原始文件** — `batchImportFiles` 新增 `preserveRawFile` 调用，将原始文件（PDF/Word/图片等）复制到 `knowledge/_raw/`，供 ENHANCE 补跑 OCR / 数值校验时使用。
- **ENHANCE 走完整管线** — `enhance-knowledge-files` 从原来的"仅 LLM 格式化"升级为完整管线：从 `_raw/` 重新解析原始文件 → Vision OCR（图表页识别）→ 文本清洗（cleanPdfFullText / stripDocxToc）→ Vision 结果语义融合（mergeVisionIntoText）→ LLM 逐章格式化 → 数值校验（detectFabricatedNumbers）→ 写回。ENHANCE 完成后自动触发检索索引重建（上下文摘要 + 向量嵌入），确保 RAG 检索使用最新内容。无 `_raw/` 原始文件时自动回退到旧的纯文本格式化模式。

## v0.5.6 (2026-04-14)

### 修复

- **pptx 导入产生 OOXML 乱码** — `parsePptx` 的 `<a:t>` 正则 `<a:t[^>]*>` 会误匹配 `<a:tblPr>`/`<a:tbl>`/`<a:tableStyleId>` 等以 `a:t` 开头的其他 DrawingML 标签，导致导入结果里混入大段 OOXML 样式 XML。改为 `<a:t(?:\s[^>]*)?>`（`a:t` 后必须是空白字符或直接 `>`），并补上 XML 实体反转义（`&amp;` `&lt;` `&gt;` `&quot;` `&apos;`）。
- **Viewer/Editor 把 pptx 误标为 Excel 数据源** — pptx 快速路径写入 `source: pptx` + `rag_only: true`，但 `KnowledgeViewer` 旧逻辑只按 `rag_only` 分支，统一显示 "📊 EXCEL 数据源"，还建议用 `query_excel` 工具（pptx 根本不支持）。现按 `source` 字段分类渲染：excel → 📊 EXCEL 数据源（`query_excel`），pptx → 📽️ POWERPOINT 数据源（`search_knowledge`），其他 `rag_only` → 📄 大文件数据源。`KnowledgeEditor` 的 `detectExcelSource` 同步推广为 `detectAutoSource`，pptx/其他自动生成文件一并进入只读态。

## v0.5.5 (2026-04-13)

### 新功能

- **UI 全面改造：粉色点阵 LED 风格** — 全局色板从暖金像素风 (`#E8A830`) 改为 LED 粉 (`#FFB0C8`) + void-black (`#0A0A0F`)，新增全局 CRT 扫描线纹理叠加层，按钮/导航/输入框 hover 改为粉色 glow 光晕，ECharts 图表配色同步粉色系，Markdown prose 链接/列表符号同步粉色。

- **pptx 快速导入** — pptx 导入走快速路径跳过 LLM 格式化（文本已按幻灯片页分好结构），秒级完成。之前 100 页 pptx 需要 20+ 分钟（每页当作一个章节逐个调 LLM）。

- **ENHANCE 断点续跑** — 格式化中断后重新运行，自动跳过已增强的文件（检测 `source: enhanced` frontmatter），不从头重来。

- **单文件导入 filter 同步** — UI 文件选择器新增 `.pptx`、`.xls`、`.bmp`，去掉不支持的 `.doc`，与后端 `SUPPORTED_PARSE_EXTENSIONS` 保持一致。

### 代码质量（两轮审查 + 14 项修复）

- **CRITICAL 修复**：PDF 截图上限 `Infinity` → 200（防 OOM）；zip/tar/rar slip 检测改用 `path.resolve` 验证目标目录（防路径穿越）；跨轮次 assistant 压缩逻辑重写（用 Set 标记最近 4 条索引）
- **HIGH 修复**：chart JSON 完整性检测改为花括号计数；enhance body 提取改用 `indexOf` 替代脆弱正则；ChartRenderer grid 注入抽取为 `withSafeGrid()` 去重；`promptEnhanceAfterBatch` 加 `.catch()` 防 unhandled rejection
- **MEDIUM 修复**：单轮 LLM 调用加 3 分钟超时 + 超时后 `abort()` 底层 fetch；批量日志成功/跳过/失败列表统一限 50 条 DOM；delete-avatar 时清理 retriever 缓存；大文件解析加 5 分钟超时 + `_aborted` 标志跳过截图操作

### Bug 修复

- **ENHANCE 数量不一致** — 导入 378 个文件但 ENHANCE 显示 424 个。改为传入本次导入文件列表，只处理当前批次。

---

## v0.5.3 (2026-04-13)

### 新功能

- **知识库质量优化（ENHANCE）** — 批量导入完成后自动进入 LLM 格式化优化，逐个对未格式化文件跑 `formatDocument`（章节切分 + 并发 3 路 LLM 排版），质量与单个导入一致。新增 IPC `enhance-knowledge-files` + 进度事件 `knowledge-enhance-progress` + KnowledgePanel `[✨] ENHANCE` 按钮。

- **启动时检查更新** — 启动时静默请求 GitHub Releases 最新版本号，有新版在顶部显示横幅（版本号 + 更新说明 + 下载链接），点击跳转 GitHub Release 页面。网络失败静默不影响使用。

- **新增 .pptx / .xls 文件导入** — `.pptx`：解析 slide XML 提取 `<a:t>` 文本节点，按幻灯片编号组织。`.xls`：SheetJS 已支持旧版 Excel 格式，加入扩展名白名单。

### Bug 修复

- **批量导入默认 rag_only** — 批量导入的文件自动加 `rag_only: true` frontmatter，不再塞进 system prompt（之前 405 个文件 2.9M 字符全部 stuff 进去导致 context 溢出）。
- **zip slip 检测误判** — 文件名中含 `..` 的文件（如 `10..附件十.docx`）被误判为路径穿越攻击。改为按路径段检测，只有段恰好等于 `..` 才拒绝。同步修复 zip/tar/rar 三种格式。
- **归档导入上限调大** — 单文件 500MB → 2GB，解压上限 1GB → 4GB。
- **单文件导入上限调大** — 80MB → 200MB。
- **PDF 图表页截图取消上限** — 不再截取前 20 页，全部图表页都截图。
- **工具调用纪律** — draw-chart / chart-from-knowledge 技能加入"最多 2 次 query_excel + 4 轮内必须出图"约束，防止 LLM 浪费轮数找数据不画图。

---

## v0.5.2 (2026-04-13)

### Bug 修复

- **修复分身"根据我的经验"语气矛盾** — `soul.md` 中定义的口头禅"根据我的经验..."与 `CLAUDE.md` 中"禁止使用根据我的经验"的规则互相矛盾，导致 LLM 回答时随机冒出不可追溯的个人经验措辞。修复：
  - 说话方式从"总是以根据我的经验开头"改为"结论先行 + 基于知识库数据"
  - 3 个好回答示例全部改为知识库溯源风格，带 `[来源:]` 标注
  - 口头禅从"根据我的经验"改为"根据知识库数据"
  - 现在与 CLAUDE.md 的回答规范完全一致（`avatars/小堵-工商储专家/soul.md`）

- **图表视觉升级：融入 UED 高级审美** — 融合 ued-agent 数据可视化规范，全面提升图表视觉品质：
  - ECharts 主题升级（`echarts-pixel-theme.ts`）：折线图平滑曲线 + 渐变面积填充、柱状图圆角顶部、毛玻璃 tooltip（`backdrop-filter: blur(12px)` + 圆角 8px）、配色新增暗底蓝 `#5E9FD6` 和淡紫 `#B89AE8` 冷暖平衡、Y 轴隐藏轴线极简风、圆形 symbol 替代方块、hover 发光效果
  - draw-chart 技能升级：新增"高级视觉"章节，指导 LLM 配合主题内置效果（不手写 areaStyle/borderRadius/tooltip）、饼图默认环形、markPoint 标注极值
  - 模板同步更新

- **修复多轮工具调用时重复输出** — 倒数第 2 轮 LLM 拿到 query_excel 数据后输出半成品分析 + tool_call，最终轮又重复一遍相同分析。修复：工具调用中间轮次不实时显示 assistant 文字，只在最终轮（无 tool_calls）才渲染完整回答，中间轮用 toolCallStatus 指示器代替（`chatStore.ts`）。

- **修复图表流式输出时红框闪烁 + Y 轴标题重叠** — 流式输出 chart 代码块时，JSON 未写完就触发 JSON.parse 导致红框"解析失败"闪烁，完成后又消失。修复：检测到 JSON 未闭合时显示"图表生成中..."加载态，不报错。Y 轴 name 和 title/subtext 重叠：ChartRenderer 注入默认 grid `{top: 80, left: 80}` 防止重叠（`MessageBubble.tsx` + `ChartRenderer.tsx`）。

- **修复图表 JSON 解析失败 + 图表类型不遵从用户指定** — LLM 在 chart JSON 中输出 JavaScript 函数（如 `"color": function()`），导致前端 JSON.parse 失败显示红框。根因是 draw-chart 技能示例中含 `"valueFormatter": "(v) => v + ' 万'"`，LLM 模仿后输出真正的 JS 函数。同时用户明确要"折线图"但 LLM 自行选了柱状图。修复：
  - 删除示例中的 `valueFormatter` 函数字符串
  - 禁止列表新增"严禁 `function` 关键字"，明确 formatter/color 等字段只能用 ECharts 字符串模板
  - 图表类型约束改为"用户指定时必须严格遵从"
  - 同步修复 `templates/skills/draw-chart.md` 模板

- **修复多轮对话 context 爆掉** — 用户多次查询 Excel 数据 + 生成图表后，工具返回值和长回答累积撑爆 LLM context 上限。新增两层压缩机制（`chatStore.ts`）：
  - **同轮工具结果压缩**：每次进入下一轮 LLM 调用前，把更早轮次中超过 2000 字符的 tool 结果截断为 500 字符摘要（`compressOldToolResults`）
  - **跨轮次 assistant 消息压缩**：构建 apiMessages 时，只保留最近 4 条 assistant 消息的完整内容，更早的超过 3000 字符的回答截断为 800 字符摘要
  - 新增常量：`TOOL_RESULT_COMPRESS_THRESHOLD`（2000）、`RECENT_FULL_ASSISTANT_COUNT`（4）、`ASSISTANT_COMPRESS_THRESHOLD`（3000）

---

## v0.5.1 (2026-04-13)

### Bug 修复

- **`query_excel` 返回值大小硬限制（防 context 炸）** — 用户问"215 机型..."报 187k token 错误（context 上限 131k）。诊断后发现 system prompt 实际只有 41k 字符 ≈ 10k token（rag_only 工作正常），187k 是因为 LLM 多次调 `query_excel` 不带 filter dump 出大量数据进 chat history 累积起来。修复：
  - 默认 limit `100 → 50`，硬上限 `1000 → 200`
  - 新增**返回内容字符数硬上限 8000 字符**（约 2k token），超出按行二次截断，附 `truncated_by_size: true` 和明确提示
  - 不传 filter + 不传 columns + 不传 limit 时 → **直接拒绝执行**并报错"会一次性返回整张表 N 行污染 context"
  - 工具描述强化警告：「**Excel 数据必须用此工具，禁止用 search_knowledge**」「必须用 filter 把结果缩小到几行到几十行」「画图通常 12-30 行就够了」
  - 三个新常量集中在 tool-router.ts 顶部：`QUERY_EXCEL_DEFAULT_LIMIT` / `QUERY_EXCEL_HARD_LIMIT` / `QUERY_EXCEL_MAX_CONTENT_CHARS`

- **`MAX_TOOL_ROUNDS` 5 → 10** — 修复用户提问 "215 机型 2026 年 1~3 月设备侧效率折线图" 后看到 `[系统提示] 工具调用轮数达到上限，已提前结束本轮` 但没有真正的图表回答。`query_excel` + `draw-chart` 这类组合流程典型需要 5+ 轮（load_skill 1-2 轮 + query_excel 1-2 轮 + 容错修正 1-2 轮 + 最终带 ```chart 代码块的回答），原来 5 轮上限留 0 容错就被吃完。改为 10 轮给探索和容错留余量，仍能兜底防真死循环（`chatStore.ts:MAX_TOOL_ROUNDS`）。

- **Excel 导入后 UI 卡死 / 上下文未刷新** — 修复 v0.5.0 方案 C 落地后用户反馈的 3 个连锁问题：
  - 导入大 Excel（250 KB+ 含 1000+ 行 markdown 表格）后**无法关闭知识库面板**
  - 同一文件**无法编辑**
  - 立刻发问 "生成 215 机型 2026 年 1~3 月设备侧效率折线图" **仍报 context 超限错误**

  根因：导入完成后 `handleSelectFile` 自动加载 250 KB 的 .md 到 `KnowledgeViewer`，react-markdown 渲染巨型表格阻塞渲染器 → UI 操作全部卡死；同时 `onSaved?.()` 是 fire-and-forget，没等 `loadAvatarConfig` 重建 system prompt 就返回，用户立刻发问会用旧的 stale system prompt（仍含 248k 字符的旧 Excel 内容）。

  修复（4 个文件）：
  - **`KnowledgePanel.tsx`** Excel 快速路径不再 `handleSelectFile`，且改为 `await onSaved?.()` 等 system prompt 刷新完成才返回，状态文案改为 "✓ 已导入并刷新上下文"
  - **`KnowledgeViewer.tsx`** 新增 frontmatter 解析 + 检测 `source: excel` / `rag_only: true` → 显示 Excel 数据源摘要卡片（sheets 标签 + 使用 `query_excel` 的提示），不再 react-markdown 渲染原表；同时为任何 > 50k 字符的普通文件显示截断警告 + 纯文本预览（不走 markdown 解析）
  - **`KnowledgeEditor.tsx`** Excel 文件 / > 100k 字符文件 → 显示只读提示卡片，不加载 Monaco（避免"无法编辑"问题），文案明确告知 Excel 文件应"编辑源 .xlsx 后重新导入"
  - **`document-parser.ts`** 智能表头检测：扫描前 5 行选最像表头的一行（评分 = `字符串单元格 ×2 − 数字单元格 − 空格 ×0.3`，要求填充率 ≥50% 且字符串多于数字），跳过表头行之前的所有合并标题/空行；多行 merged 表头里的 `\n` 替换为空格；同名列加 `_2`/`_3` 后缀去重。修复 v0.5.0 导入的 5 sheets 中有 4 个变成 `col1..colN` 的问题（合并单元格让 row 0 留空导致原检测失败）

### 关于"不要直接编辑 Excel 自动文件"

Excel 导入产生两份资产：`knowledge/<name>.md`（可视化）+ `knowledge/_excel/<name>.json`（结构化）。**手动编辑 .md 不会同步到 .json**，且会被下次重新导入覆盖。Viewer 和 Editor 都已加提示。如需修改数据，请编辑源 .xlsx 后重新导入。

---

## v0.5.0 (2026-04-13)

### 新功能

- **Excel / CSV 知识库导入** — 知识库现在吃 `.xlsx` 和 `.csv` 文件；每个 sheet 自动转 GFM markdown 表格（表头识别、5000 行/sheet 截断、单元格 `|` 换行转义），写入 `avatars/<id>/knowledge/<name>.md`。Excel 导入绕过 LLM 重格式化管线，因为源数据已是结构化。依赖：SheetJS (`xlsx` 0.20.3) 纯 JS 无原生模块（`document-parser.ts`：`parseExcel()` + `rowsToMarkdownTable()`）。
- **批量 / 归档导入** — KnowledgePanel 新增 `FOLDER` 和 `ARCHIVE` 按钮：
  - **文件夹** — 选一个文件夹后 BFS 递归遍历，自动过滤支持的扩展名、跳过 `node_modules`/`.git`/`.DS_Store` 等噪声、硬上限（深度 8、文件数 500、总字节 2 GB、单文件 80 MB），一把梭式在主进程批量 parse + 写入，渲染进程通过 `knowledge-import-progress` 事件实时收进度
  - **归档** — 自动识别 `.zip` / `.tar.gz` / `.tgz` / `.7z` / `.rar`，解压到 `$TMPDIR/soul-import-<uuid>`，`try/finally` 清理 temp，全链路 zip 炸弹防护（解压后总大小 > 1 GB 拒绝）和 zip slip 防护（`..`/绝对路径拒绝）
  - 批量结果抽屉展示每个文件的成功/跳过/失败明细，继续执行不因单文件失败中断
  - 批量导入跳过 LLM 格式化（保证速度，单文件导入仍享受完整管线）
  - 依赖：`adm-zip`（zip，纯 JS）、`tar`（tar.gz，纯 JS）、`node-7z` + `7zip-bin`（7z，平台二进制 asar 外打包）、`node-unrar-js`（rar，WASM 端口）
  - 新模块：`desktop-app/electron/folder-importer.ts`
- **ECharts 图表技能（draw-chart）** — 聊天中直接内联渲染高级感图表：
  - 新增 `templates/skills/draw-chart.md`，含 UED 设计硬约束（禁 3D、Y 轴从 0、标题副标题必填、系列 ≤5 色、X 类目 >12 改横向、不得硬编码颜色、KPI 单值必须带对比）+ 3 组 few-shot 示例（月度折线、品类饼图、站点横向对比）
  - 新增 `templates/skills/chart-from-knowledge.md` 串联 `search_knowledge` + `draw-chart` 的高阶技能
  - 自动安装到**所有现有分身**（通过 `scripts/retrofit-skills.ts` 幂等回填）和**未来分身**（`create-avatar` IPC 自动调 `installDefaultSkillsSync` 复制模板）
  - LLM 输出 ` ```chart ` 代码块（JSON 格式 ECharts option）由 `MessageBubble.tsx` 的 `ChartCodeBlock` 拦截，JSON 解析后交给 `ChartRenderer.tsx` 懒加载 `echarts/core` + `charts` + `components` + `renderers` 子模块渲染（首次加载后缓存）
  - 新增 `src/lib/echarts-pixel-theme.ts` — 从 tailwind `px` 色板构建 ECharts 主题（暖金/薄荷/绿/红/灰 5 色 60-30-10 palette、像素方块 symbol、暗底透明背景、color-decal 色盲友好）
  - 错误处理：JSON 解析失败降级为带红框的原 `<pre>`；渲染异常由 ErrorBoundary 兜底
  - 依赖：`echarts` 5.5 + `echarts-for-react` 3.0
- **对话消息折叠** — 助手消息超过 600 字符时自动显示 `[▼] 收起` / `[▶] 展开` 按钮，折叠态只展示前 ~300 字符（按段落/行/中文标点优先次序智能断开），附字数统计。用户消息通常较短不折叠；折叠状态放在 `chatStore` 的 `collapsedMessageIds: Set<string>`，跨 react-virtuoso 卸载/重新挂载持久（`MessageBubble.tsx` + `chatStore.ts`）。

- **Excel 作结构化数据源（query_excel 工具）** — 导入 Excel 时同时产出两份资产：
  - `knowledge/<name>.md` — GFM 表格可视化，顶部加 `rag_only: true` frontmatter，SoulLoader 跳过不拼入 system prompt（避免大 Excel 炸上下文）
  - `knowledge/_excel/<basename>.json` — 结构化数据（schema + 全量行对象数组），供 `query_excel` 工具使用
  - `SoulLoader` 在 system prompt 中只拼入 Excel **schema 摘要**（列名 / 类型 / 范围 / samples），不拼入原始行数据
  - 新增 `query_excel` 工具（`packages/core/src/tool-router.ts`）：支持 MongoDB 风格 filter（`$eq`/`$ne`/`$gt`/`$gte`/`$lt`/`$lte`/`$in`）、列选择、行数上限（默认 100，硬上限 1000）
  - `chatStore.ts` 的 `AVATAR_TOOLS` 注册 `query_excel` 为新 LLM tool
  - `templates/skills/draw-chart.md` 与 `chart-from-knowledge.md` 新增 query_excel 用法示例
  - 新增 frontmatter 解析器（`soul-loader.ts` 内联，~40 行，不引 yaml 依赖）
  - 新 IPC：`write-excel-data(avatarId, basename, data)` 把结构化 JSON 落盘到 `knowledge/_excel/`
  - **解决的实际问题**：用户导入 248k 字符的"产品质量指标 dashboard" Excel 后，第一次对话就撞破 Qwen-Plus 131k context 限制（报 173k token invalid_request_error）。方案 C 后，同一份 Excel 在 system prompt 中只占几百字 schema，用户问「215 机型 2026 年 1~3 月设备侧效率折线图」时 LLM 直接 `query_excel` 精确过滤 3 行数据，配合 `draw-chart` 技能生成折线图。

### 改进

- **分身创建流程** — `CreateAvatarWizard` 创建新分身时，`create-avatar` IPC 在写完用户自定义技能后自动把 `templates/skills/*.md` 复制到新分身的 `skills/`，不覆盖同名文件（保护用户自定义）
- **electron-builder 打包配置** — 新增 `asarUnpack` 规则把 `7zip-bin` 平台二进制和 `node-unrar-js` WASM 文件从 asar 包内解出，让运行时可正常执行
- **ESLint 配置修复** — `eslint.config.js` 重命名为 `eslint.config.mjs`，修复 `"type": "commonjs"` 下 ESM import 无法加载的问题，`npm run lint` 现在可以正常运行

### 代码质量

- 新增 IPC 通道：`import-folder` / `import-archive` / `install-default-skills`
- 新增 IPC 事件：`knowledge-import-progress`
- `ParsedDocument.fileType` 扩展 `'excel'` 类型 + 新增 `sheetNames?: string[]` 字段
- `SUPPORTED_PARSE_EXTENSIONS` 从 `document-parser.ts` 导出供 `folder-importer.ts` 复用，作为文件过滤 single source of truth
- `installDefaultSkillsSync()` 幂等：已存在的技能不会被覆盖
- 所有新增 `.ts`/`.tsx` 文件通过 `npm run typecheck` 和 `npm run lint` 零错误零警告
- 修复触及的既有文件中几处历史 lint 问题（`main.ts` 合并 `import type`、空 catch 块加 void 标记；`KnowledgePanel.tsx` 合并 `import type`、补 useEffect 依赖；`MessageBubble.tsx` 合并 react import）

---

## v0.4.0 (2026-04-10)

### 新功能

- **分身头像系统** — 支持预置像素头像和自定义上传头像，创建分身时可选头像，已有分身可通过选择器下拉菜单「换头像」（`AvatarImage`、`AvatarPicker`、`DefaultAvatars`）
- **AI 消息气泡头像** — 对话中 AI 消息左侧显示分身头像和名称，替代原来的"专家"通用标签
- **像素风导航栏** — 顶栏导航重构为 RPG 菜单风格 tab 导航，带图标、光标动画和徽章（`PixelNavBar`）
- **版本号动态注入** — 设置面板底部显示实际版本号（通过 Vite define 注入 `__APP_VERSION__`）

### 改进

- **窗口尺寸优化** — 默认窗口调大至 1280×820，最小尺寸提升至 1024×680，适配更多内容
- **提示词模板面板重构** — 从内联弹窗重构为 Modal + PanelHeader 组件化，交互更统一
- **知识面板进度增强** — 异步任务（百科编译、知识自检）增加计时器和不定进度条，操作过程可感知
- **设置面板文案优化** — 用面向用户的友好语言替换技术术语（如"注入百科到 RAG"→"回答时参考百科"）
- **用户画像面板** — PanelHeader 增加 EDIT 按钮，空状态引导文案更清晰
- **设置面板 Tab** — 左侧标签栏支持滚动，修复 Tab 过多时被截断的问题

### 代码质量

- `AvatarManager` 新增 `saveAvatarImage` / `getAvatarImage` 方法和 `parseImageDataUrlBase64` 静态工具
- 新增头像相关单元测试（data URL 解析、头像保存）
- 新增 IPC 通道：`save-avatar-image`、`get-avatar-image`
- CSS 新增像素导航标签组件样式（`.pixel-nav-*`）和不定进度条动画

---

## v0.3.0 (2026-04-10)

### 新功能

- **提示词模板库** — 创建/编辑/填充模板，一键套用到输入框（`PromptTemplatePanel`）
- **用户画像面板** — 管理分身对用户的了解（`UserProfilePanel`）
- **技能建议卡片** — 技能创建建议确认交互（`SkillProposalCard`）
- **定时任务调度器** — 统一调度记忆整理、知识检查、定时自检（`CronScheduler`）
- **LLM 工厂** — 抽取 LLM/Embedding 调用为可复用工厂（`llm-factory.ts`）
- **记忆管理器** — 容量统计、LLM 自动整理、阈值预警（`memory-manager.ts`）
- **子代理管理** — 任务委派与并行执行（`sub-agent-manager.ts`）
- **数据库自动备份** — 定期备份 SQLite 数据文件
- **对话导出** — 支持导出会话为文件
- **消息全文搜索** — SQLite FTS5 全文索引 + 触发器自动同步
- **虚拟滚动** — react-virtuoso 优化长对话渲染性能

### 重构

- 删除 `deepseek.ts`，统一走 LLM Service（OpenAI 兼容接口）
- 面板状态从多个 boolean 重构为单一 `activePanel` 枚举
- Zustand 使用 `useShallow` 避免不必要的重渲染
- DB schema 升级至 v4：预编译 Statement 缓存、提示词模板表、WAL 模式
- 抽取公共工具到 `@soul/core`：`fetchWithTimeout` / `assertSafeSegment` / `resolveUnderRoot` / `localDateString`

### 代码质量

- 新增 ESLint + TypeScript-eslint 配置（`desktop-app` & `packages/core`）
- 新增 `typecheck` / `lint` / `quality` npm scripts
- 新增 `CONVENTIONS.md` 编码约定 + `.cursor/rules` 工作区规则
- IPC 敏感参数日志脱敏（apiKey 等不再写入日志）
- 错误处理增强：初始化失败弹窗提示、统一 Error 类型守卫

### 清理

- 删除 `desktop-app/build/ios-icons/`（Electron 不使用的 iOS 图标）
- 删除 `PHASE*_VERIFICATION_REPORT.md`（5 个过时的阶段验证报告）
- 删除 `TEST_PLAN.md`、`auto-test-fix-loop.js`、`main.d.ts` 等过时文件
- 删除根目录旧版 CLI 测试脚本（`test-avatar.sh` / `generate-knowledge-tests.sh` / `batch-generate-knowledge-tests.sh`），已被桌面端测试系统替代
- 删除 `docs/phases/`（已完成的开发阶段计划）和 `docs/desktop-app-implementation-plan.md`（初始实施方案）
- 删除 `deploy/wechat-bot/`（未完成的企业微信机器人草稿，缺少核心模块）
- 删除 `plans/`（空目录）
- 清理磁盘构建产物：`release/`（2.1 GB）、`dist/`、`dist-electron/`、`test-output/`、`.DS_Store` 等

### 文档

- 架构设计文档更新至 v1.2：同步代码实际状态，补充提示词模板/用户画像/定时任务/数据备份/对话导出/子代理委派等模块

---

## v0.2.0 (2026-04-09)

### 新功能：知识百科融合（Karpathy Wiki 思想）

在保持 Soul 的无损保真和精确溯源优势的前提下，引入 Karpathy LLM Wiki 的知识积累和自演化能力。所有功能默认关闭，通过设置开关或手动触发启用，不影响现有回答结果。

#### Phase 1 — 百科基础层

- **原始文件保留** — 导入文档时自动将原始 PDF/Word/图片复制到 `knowledge/_raw/`，确保 source of truth 可追溯
- **实体提取** — 基于词频 × 跨文件分布的本地算法，从知识库中识别高频技术实体
- **概念页生成** — 为跨文件实体调用 LLM 生成聚合概念页，保存到 `wiki/concepts/`
- **知识自检（Lint）** — LLM 矛盾检测 + 内容指纹重复检测，报告保存到 `wiki/lint-report.json`
- **知识库面板** — 新增 WIKI 和 LINT 按钮，手动触发编译和自检

#### Phase 2 — 深度融合

- **Wiki 注入 RAG** — 设置中新增 WIKI Tab，启用"注入百科到 RAG"开关后，RAG 检索同时搜索 `wiki/concepts/` 概念页作为补充参考
- **答案手动沉淀** — 助手消息气泡上 hover 显示 SAVE 按钮，一键将优质问答沉淀到 `wiki/qa/`
- **答案自动沉淀** — 设置中开启后，满足启发式规则的高质量回答（长度 > 300 字、含来源引用）自动保存
- **知识演化检测** — 导入新文件后自动检测与已有知识的差异（新增/更新/矛盾），在状态栏显示差异统计
- **概念页交叉引用** — 百科编译后自动为概念页生成 `## 相关概念页` 反向链接段落

### 新增核心模块

- **WikiCompiler** (`packages/core/src/wiki-compiler.ts`) — 知识百科编译器，封装实体提取、概念页生成、交叉引用、知识自检、答案沉淀、知识演化检测全部逻辑
- **KnowledgeRetriever.getFullChunks()** — 提供完整 chunk 数据供外部模块使用

### 改进

- **设置面板** — 新增 WIKI Tab（注入百科到 RAG 开关 + 自动沉淀开关 + 功能说明）
- **消息气泡** — 助手消息支持 hover 显示 SAVE 按钮
- **知识树** — `KnowledgeManager.buildTree` 跳过 `_` 前缀目录（`_index`、`_raw`），知识树更简洁
- **RAG 增强** — `retrieveAndBuildPrompt` 支持可选 `wikiChunks` 参数注入百科参考

### Bug 修复

- 修复 `KnowledgePanel.tsx` 中 `fileType === 'docx'` 类型比较错误（应为 `'word'`）
- 修复 `soul-validator.ts` 中未使用的 `patterns` 变量导致的编译警告
- 修复 `chatStore.ts` 中 `.at()` 方法不可用的 TypeScript 兼容性错误（tsconfig target/lib 升级到 ES2022）

### 文档

- 新增 `docs/architecture.md` 完整架构设计文档（v1.1），涵盖工程结构、进程模型、数据流、RAG Pipeline 全链路、Karpathy 方法对比与融合方案

### 技术细节

- 新增 IPC 通道：`compile-wiki`、`get-wiki-status`、`get-concept-pages`、`read-concept-page`、`lint-knowledge`、`get-lint-report`、`save-wiki-answer`、`get-wiki-answers`、`preserve-raw-file`、`detect-evolution`、`get-evolution-report`
- 变更文件：16 个文件，新增 626 行，其中 `wiki-compiler.ts` 为全新模块（~780 行）
- 安全保证：所有 wiki 数据存放在独立的 `wiki/` 目录，不修改 `knowledge/` 中的任何文件；SoulLoader、KnowledgeRetriever、现有 RAG 完全无感知

---

## v0.1.0 (2026-04-03)

### 初始版本

- Electron + React + TypeScript + Vite 桌面应用
- @soul/core 核心 SDK：SoulLoader、KnowledgeRetriever（BM25 + 向量 RRF 融合）、ToolRouter、DocumentFormatter
- 多模型支持：Chat / Vision / OCR / Creation 四类独立配置
- RAG Pipeline：三通道知识注入（全量 System Prompt + 精准检索 + 工具按需补充）
- 知识导入：PDF/Word/图片解析 → OCR → LLM 格式化 → 数值校验
- Function Calling：6 个工具函数 + 最多 5 轮调用循环
- 分身管理：创建向导、人格编辑、技能管理、记忆系统
- 测试体系：测试用例管理 + AI 评分 + 定时自检
- 像素风 UI 设计语言
