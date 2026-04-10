/**
 * 小堵·工商储专家 完整模拟测试 v11
 *
 * 全文知识格式化流程（从 LLM 提炼 → LLM 格式化）：
 *   1. PDF 文本提取 + 图表页截图
 *   2. Vision Model（qwen-vl-max）解读图纸 → 尺寸/布局/流向
 *   3. Vision 结果按页码位置融入原文
 *   4. DOCX 目录清洗
 *   5. 程序化章节切分 → 逐章 LLM 格式化（保留全文，只做 Markdown 排版）
 *   6. 数值校验 + 多文档对比表生成
 *   7. 问答验证
 *
 * v11 核心改变（相对 v10）：
 *   - 放弃 LLM "提炼"（必然丢信息），改为 LLM "格式化"（保留全文，只做排版）
 *   - splitIntoChapters：程序化识别章节边界，拆成独立段落
 *   - formatChapter：每章节独立送 LLM 做 Markdown 格式化，token 预算充裕
 *   - FORMAT_SYSTEM_PROMPT：保留第一性原理思维，严禁删减/改写/概括原文
 *   - generateComparisonTable：多文档自动对比表，不硬编码产品型号
 *   - 输出从 ~14000 字（提炼损失 50%+）提升至 ~30000 字（零信息丢失）
 *
 * @author zhi.qu
 * @date 2026-04-03
 */

import { createRequire } from 'module'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { AvatarManager } from '../avatar-manager'
import { SoulLoader } from '../soul-loader'
import { KnowledgeManager } from '../knowledge-manager'
import { KnowledgeRetriever } from '../knowledge-retriever'
import { cleanOcrHtml, cleanPdfFullText, cleanLlmOutput, detectFabricatedNumbers, stripDocxToc, mergeVisionIntoText } from '../utils/ocr-html-cleaner'
import { formatDocument, FORMAT_SYSTEM_PROMPT } from '../document-formatter'
import type { LLMCallFn } from '../document-formatter'
import { buildKnowledgeIndex, saveIndex } from '../knowledge-indexer'
import { retrieveAndBuildPrompt } from '../rag-answerer'

// ── 路径常量 ──────────────────────────────────────────────────────────────────
// dist/tests/ → core/ → packages/ → soul/
const SOUL_ROOT = path.join(__dirname, '../../../../')
const DESKTOP_APP = path.join(SOUL_ROOT, 'desktop-app')
const TEMPLATES_PATH = path.join(SOUL_ROOT, 'templates')
const OUTPUT_DIR = path.join(os.tmpdir(), 'soul-xiaodu-sim-v11')
const AVATAR_ID = 'xiaodu-ci-storage'

const PDF_PATH = '/Users/cnlm007398/Downloads/ENS-L262-01用户手册 -V1.pdf'
const DOCX_PATH = '/Users/cnlm007398/Downloads/远景能源ENS-L419工商业储能一体机用户手册.docx'

const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY
if (!DASHSCOPE_API_KEY) {
  console.error('❌ 请设置环境变量 DASHSCOPE_API_KEY')
  process.exit(1)
}
const DASHSCOPE_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
const VISION_MODEL = 'qwen-vl-max'
const RESTRUCTURE_MODEL = 'qwen-plus'

const require2 = createRequire(path.join(DESKTOP_APP, 'node_modules/pdf-parse/package.json'))

// ── 日志工具 ──────────────────────────────────────────────────────────────────
const reportLines: string[] = []

function log(level: 'step' | 'ok' | 'info' | 'warn' | 'error', msg: string) {
  const prefix = { step: '\n▶', ok: '  ✓', info: '  ℹ', warn: '  ⚠', error: '  ✗' }[level]
  const line = `${prefix} ${msg}`
  console.log(line)
  reportLines.push(line)
}

function section(title: string) {
  const bar = '─'.repeat(60)
  console.log(`\n${bar}`)
  console.log(`  ${title}`)
  console.log(bar)
  reportLines.push(`\n${'─'.repeat(60)}\n  ${title}\n${'─'.repeat(60)}`)
}

// ── DashScope API 通用调用 ───────────────────────────────────────────────────

interface DashScopeMessage {
  role: string
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
}

async function callDashScope(model: string, messages: DashScopeMessage[], maxTokens = 4000, retries = 3): Promise<string> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(`${DASHSCOPE_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${DASHSCOPE_API_KEY}`,
        },
        body: JSON.stringify({ model, messages, stream: false, max_tokens: maxTokens }),
        signal: AbortSignal.timeout(180_000),
      })

      if (response.status === 500 || response.status === 503 || response.status === 429) {
        const wait = attempt * 10000
        log('warn', `${model} API 返回 ${response.status}，${wait / 1000}s 后重试（${attempt}/${retries}）`)
        await new Promise(r => setTimeout(r, wait))
        continue
      }

      if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText)
        throw new Error(`${model} API 失败 (${response.status}): ${errText}`)
      }

      const data = await response.json() as { choices: Array<{ message: { content: string } }> }
      return data.choices[0]?.message?.content ?? ''
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const cause = (err as Record<string, unknown> & { cause?: { code?: string } }).cause
      const isNetworkRetryable = msg.includes('timed out') || msg.includes('fetch failed')
        || cause?.code === 'ETIMEDOUT' || cause?.code === 'ECONNRESET' || cause?.code === 'ECONNREFUSED'
      if (attempt < retries && isNetworkRetryable) {
        const wait = attempt * 15000
        log('warn', `${model} 网络超时/中断（${msg}），${wait / 1000}s 后重试（${attempt}/${retries}）`)
        await new Promise(r => setTimeout(r, wait))
        continue
      }
      throw err
    }
  }
  throw new Error(`${model} 重试 ${retries} 次后仍失败`)
}

// ── Embedding API ────────────────────────────────────────────────────────────

/**
 * 调用 DashScope text-embedding-v3 批量生成向量
 *
 * @param texts - 待编码的文本数组（单次最多 10 条）
 * @returns 对应的向量数组
 * @author zhi.qu
 * @date 2026-04-03
 */
async function callEmbedding(texts: string[], retries = 3): Promise<number[][]> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(`${DASHSCOPE_BASE_URL}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${DASHSCOPE_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'text-embedding-v3',
          input: texts,
          dimension: 512,
        }),
        signal: AbortSignal.timeout(180_000),
      })

      if (response.status === 500 || response.status === 503 || response.status === 429) {
        const wait = attempt * 5000
        log('warn', `Embedding API 返回 ${response.status}，${wait / 1000}s 后重试（${attempt}/${retries}）`)
        await new Promise(r => setTimeout(r, wait))
        continue
      }

      if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText)
        throw new Error(`Embedding API 失败 (${response.status}): ${errText}`)
      }

      const data = await response.json() as {
        data: Array<{ embedding: number[] }>
      }
      return data.data.map(d => d.embedding)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (attempt < retries && (msg.includes('timed out') || msg.includes('fetch failed'))) {
        const wait = attempt * 10000
        log('warn', `Embedding 网络超时（${msg}），${wait / 1000}s 后重试（${attempt}/${retries}）`)
        await new Promise(r => setTimeout(r, wait))
        continue
      }
      throw err
    }
  }
  throw new Error(`Embedding 重试 ${retries} 次后仍失败`)
}

// ── 文档解析 ─────────────────────────────────────────────────────────────────

const IMAGE_PAGE_TEXT_THRESHOLD = 300

interface ParsedResult {
  text: string
  images: string[]
  imagePageNumbers: number[]
  perPageChars: Array<{ num: number; chars: number }>
}

async function parsePdfFull(filePath: string): Promise<ParsedResult> {
  const { PDFParse } = require2('pdf-parse')
  const buffer = fs.readFileSync(filePath)
  const parser = new PDFParse({ data: new Uint8Array(buffer) })

  const textResult = await parser.getText({ parsePageInfo: true })
  const fullText: string = textResult.text || ''

  const perPageChars: Array<{ num: number; chars: number }> = []
  const imageDensePages: number[] = []

  if (Array.isArray(textResult.pages)) {
    textResult.pages.forEach((page: { num: number; text: string }) => {
      const chars = (page.text || '').replace(/\s+/g, '').length
      perPageChars.push({ num: page.num, chars })
      if (chars < IMAGE_PAGE_TEXT_THRESHOLD) {
        imageDensePages.push(page.num)
      }
    })
  }

  const images: string[] = []
  const imagePageNumbers: number[] = []
  if (imageDensePages.length > 0) {
    const imageDenseSet = new Set(imageDensePages)
    const screenshotResult = await parser.getScreenshot({ scale: 2 })
    for (const screenshot of screenshotResult.pages) {
      if (imageDenseSet.has(screenshot.pageNumber) && screenshot.dataUrl) {
        images.push(screenshot.dataUrl)
        imagePageNumbers.push(screenshot.pageNumber)
      }
    }
  }

  return { text: fullText, images, imagePageNumbers, perPageChars }
}

async function parseDocx(filePath: string): Promise<string> {
  const mammoth = require2('mammoth')
  const result = await mammoth.extractRawText({ path: filePath })
  return result.value as string
}

// ── Vision Model 图纸解读 ───────────────────────────────────────────────────

const VISION_PROMPT = `请仔细分析这张技术文档页面图片，提取所有有价值的结构化信息：

1. **尺寸图/工程图**：提取所有尺寸标注数值（单位mm），整理为参数表格
2. **设备布局图**：描述各组件的空间位置关系（上下左右），整理为布局表格
3. **原理图/流程图**：描述流向、各部件名称和功能
4. **数据表格**：以 Markdown 表格格式输出
5. **接线图**：描述端子排列、线缆规格
6. **安装空间图**：提取预留距离、间距等数值

输出要求：
- 使用 Markdown 格式，直接输出内容，不要用 \`\`\`markdown 包裹
- 只输出图片中实际可见的数据，不要编造或推断图片中不存在的数值
- 所有数值必须保留原始精度（如 989mm 而非 约1m）
- 表格必须使用标准 Markdown 表格语法
- 如果图片中有多种信息，全部提取
- 不要描述"图片中有..."，直接输出结构化数据
- 禁止使用任何 emoji 图标（如 ⚠️ ✅ ℹ️ 等）
- 不要在末尾附加总结、说明或自评`

async function visionAnalyze(base64DataUrl: string, pageNum: number): Promise<string> {
  const result = await callDashScope(VISION_MODEL, [
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: base64DataUrl } },
        { type: 'text', text: VISION_PROMPT },
      ],
    },
  ], 4096)

  return cleanOcrHtml(result)
}

// ── agent-template.md 加载 ──────────────────────────────────────────────────

/**
 * 读取 agent-template.md 并填充占位符，生成 System Prompt
 *
 * @author zhi.qu
 * @date 2026-04-02
 */
function buildSystemPrompt(avatarName: string, avatarId: string, roleDescription: string): string {
  const templatePath = path.join(TEMPLATES_PATH, 'agent-template.md')
  let template = fs.readFileSync(templatePath, 'utf-8')

  template = template.replace(/\{\{AGENT_NAME\}\}/g, avatarName)
  template = template.replace(/\{\{AVATAR_ID\}\}/g, avatarId)
  template = template.replace(/\{\{ROLE_DESCRIPTION\}\}/g, roleDescription)
  template = template.replace(/\{\{AGENT_DESCRIPTION_CN\}\}/g, '工商业储能方案设计与收益测算专家')
  template = template.replace(/\{\{AGENT_DESCRIPTION_EN\}\}/g, 'C&I energy storage solution design expert')
  template = template.replace(/\{\{DOMAIN\}\}/g, '工商业储能')
  template = template.replace(/\{\{KNOWLEDGE_DIR\}\}/g, `avatars/${avatarId}/knowledge/`)

  return template
}

// ── LLM 文档格式化（委托 @soul/core document-formatter）─────────────────────

/**
 * 将 callDashScope 适配为 LLMCallFn 签名，供 formatDocument 使用。
 */
const dashScopeLLM: LLMCallFn = async (systemPrompt, userPrompt, maxTokens = 8192) => {
  return callDashScope(RESTRUCTURE_MODEL, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ], maxTokens)
}

/**
 * 包装 formatDocument，增加日志输出。
 */
async function restructureDocument(
  rawText: string,
  title: string,
  source: string,
): Promise<string> {
  log('info', `文档拆分中...（${rawText.length} 字符）`)
  return formatDocument(rawText, title, source, dashScopeLLM, (progress) => {
    log('info', `格式化章节 ${progress.current}/${progress.total}：${progress.chapterTitle}`)
  })
}

/**
 * 生成多文档参数对比速查表。
 *
 * 接收任意数量的文档（不硬编码产品型号），
 * 文档数 < 2 时直接返回 null 跳过 LLM 调用。
 *
 * @author zhi.qu
 * @date 2026-04-03
 */
async function generateComparisonTable(
  documents: Array<{ title: string; content: string }>
): Promise<string | null> {
  if (documents.length < 2) {
    log('info', '仅一份文档，跳过对比表生成')
    return null
  }

  // 只取每份文档前 4000 字符（参数层），避免操作步骤干扰对比
  const excerpts = documents
    .map((d, i) => `【文档${i + 1}】${d.title}\n\n${d.content.slice(0, 4000)}`)
    .join('\n\n---\n\n')

  const prompt = `以下是多份文档的核心内容摘要：

${excerpts}

---

请生成这些文档/产品的参数对比速查表（Markdown 表格）。
列出各文档之间有差异的关键参数，相同参数可省略或合并为一行注明"相同"。
只对比原文中明确出现的数值，不推断或估算缺失数据。`

  log('info', `生成 ${documents.length} 份文档的对比速查表...`)
  const raw = await callDashScope(RESTRUCTURE_MODEL, [
    { role: 'system', content: FORMAT_SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ], 8192)

  return cleanLlmOutput(raw)
}

// ── 知识检索问答 ──────────────────────────────────────────────────────────────

/**
 * 使用 @soul/core rag-answerer 的 retrieveAndBuildPrompt 构建增强 user 消息，
 * 再调用 LLM 生成最终回答。与桌面端走同一代码路径。
 *
 * @author zhi.qu
 * @date 2026-04-03
 */
async function answerQuestion(
  retriever: KnowledgeRetriever,
  question: string,
  sysPrompt: string,
  embeddingMap: Map<string, number[]>,
): Promise<string> {
  const ragConfig = {
    callLLM: dashScopeLLM,
    callEmbedding,
  }

  const enhancedMessage = await retrieveAndBuildPrompt(
    retriever, question, ragConfig, embeddingMap,
  )

  const answer = await callDashScope(
    RESTRUCTURE_MODEL,
    [
      { role: 'system', content: sysPrompt },
      { role: 'user', content: enhancedMessage },
    ],
    4000,
  )

  return `### LLM 回答\n\n${answer}`
}

// ── 主流程 ────────────────────────────────────────────────────────────────────

async function main() {
  if (fs.existsSync(OUTPUT_DIR)) fs.rmSync(OUTPUT_DIR, { recursive: true, force: true })
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  reportLines.push('# 小堵·工商储专家 模拟测试报告 v11（LLM 格式化 · 零信息丢失）')
  reportLines.push(`\n> 日期：2026-04-03`)
  reportLines.push(`> 核心改进：从 LLM 提炼改为 LLM 格式化（程序切章 + 逐章排版 + 多文档对比表）`)
  reportLines.push(`> 输出：${OUTPUT_DIR}`)

  // 构建 System Prompt（基于 agent-template.md 填充占位符）
  const roleDescription = `我叫小堵，专注工商业储能方案设计与收益测算。每一个数字都必须能追溯到具体的产品手册或政策文件。

## 身份定位

> **角色**：工商业储能方案设计专家
> **领域**：储能系统选型、技术参数解读、占地评估、设备布局规划

## 核心风格

- 结论先行，先给结论再给依据
- 技术参数引用必须标注来源文件和章节
- 知识库没有的数据直接说没有`

  const systemPrompt = buildSystemPrompt('小堵', AVATAR_ID, roleDescription)
  log('ok', `分身对话 System Prompt 已构建（${systemPrompt.length} 字符），基于 agent-template.md`)

  // ══════════════════════════════════════════════════════════════════════════
  // Step 1：文档解析
  // ══════════════════════════════════════════════════════════════════════════
  section('Step 1 / 文档解析（含 PDF 图表页截图）')

  log('step', `解析 PDF：${path.basename(PDF_PATH)}`)
  const pdfResult = await parsePdfFull(PDF_PATH)
  log('ok', `文字提取：${pdfResult.text.length} 字符，共 ${pdfResult.perPageChars.length} 页`)
  log('ok', `图表页截图：${pdfResult.images.length} 张（页码：${pdfResult.imagePageNumbers.join(', ')}）`)

  log('step', `解析 DOCX：${path.basename(DOCX_PATH)}`)
  const docxText = await parseDocx(DOCX_PATH)
  log('ok', `文字提取：${docxText.length} 字符`)

  // ══════════════════════════════════════════════════════════════════════════
  // Step 2：保存图表页截图
  // ══════════════════════════════════════════════════════════════════════════
  section('Step 2 / 保存图表页截图')

  const imgDir = path.join(OUTPUT_DIR, 'pdf-screenshots')
  fs.mkdirSync(imgDir, { recursive: true })
  for (let i = 0; i < pdfResult.images.length; i++) {
    const pageNum = pdfResult.imagePageNumbers[i]
    const imgPath = path.join(imgDir, `page-${String(pageNum).padStart(2, '0')}.png`)
    const base64Data = pdfResult.images[i].replace(/^data:image\/png;base64,/, '')
    fs.writeFileSync(imgPath, Buffer.from(base64Data, 'base64'))
    log('ok', `page-${String(pageNum).padStart(2, '0')}.png → ${(fs.statSync(imgPath).size / 1024).toFixed(0)} KB`)
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Step 3：Vision Model 图纸解读
  // ══════════════════════════════════════════════════════════════════════════
  section('Step 3 / Vision Model 图纸解读（qwen-vl-max）')

  const visionResults: Array<{ pageNum: number; content: string }> = []
  for (let i = 0; i < pdfResult.images.length; i++) {
    const pageNum = pdfResult.imagePageNumbers[i]
    log('step', `分析图片 ${i + 1} / ${pdfResult.images.length}（第 ${pageNum} 页）...`)
    try {
      const result = await visionAnalyze(pdfResult.images[i], pageNum)
      visionResults.push({ pageNum, content: result })
      const preview = result.split('\n').slice(0, 3).join(' ').slice(0, 80)
      log('ok', `第 ${pageNum} 页：${result.length} 字符 → ${preview}...`)
    } catch (err) {
      log('error', `第 ${pageNum} 页分析失败：${err instanceof Error ? err.message : String(err)}`)
      visionResults.push({ pageNum, content: '' })
    }
  }

  // 保存 Vision 分析原始结果供检查
  const visionPath = path.join(OUTPUT_DIR, 'vision-results.md')
  const visionMd = visionResults
    .map(v => `## 第 ${v.pageNum} 页\n\n${v.content || '（无内容）'}\n`)
    .join('\n---\n\n')
  fs.writeFileSync(visionPath, `# Vision Model 分析结果\n\n${visionMd}`, 'utf-8')
  log('ok', `Vision 结果已保存：${visionPath}`)

  // ══════════════════════════════════════════════════════════════════════════
  // Step 4：LLM 结构化重整
  // ══════════════════════════════════════════════════════════════════════════
  section('Step 4 / 预处理 + LLM 格式化')

  // ENS-L262: PDF 噪音清洗 + Vision 数据融入原文
  log('step', 'PDF 全文噪音清洗...')
  const cleanedPdfText = cleanPdfFullText(pdfResult.text)
  log('ok', `清洗前 ${pdfResult.text.length} → 清洗后 ${cleanedPdfText.length} 字符`)

  log('step', 'Vision 数据按页码融入 PDF 原文...')
  const mergedPdfText = mergeVisionIntoText(cleanedPdfText, visionResults, pdfResult.perPageChars)
  log('ok', `融入前 ${cleanedPdfText.length} → 融入后 ${mergedPdfText.length} 字符（+${mergedPdfText.length - cleanedPdfText.length} Vision 数据）`)

  log('step', 'LLM 格式化 ENS-L262（程序切章 + 逐章排版）...')
  const restructured262 = await restructureDocument(
    mergedPdfText,
    '远景能源 ENS-L262 工商业储能一体机用户手册',
    'ENS-L262-01用户手册 -V1.pdf',
  )
  log('ok', `格式化完成：${restructured262.length} 字符`)

  // 数值校验 ENS-L262（含 Vision 原始数据作为合法来源）
  const visionAllText = visionResults.map(v => v.content).join('\n')
  const fabricated262 = detectFabricatedNumbers(restructured262, pdfResult.text + '\n' + visionAllText)
  if (fabricated262.length > 0) {
    log('warn', `ENS-L262 疑似编造数值 ${fabricated262.length} 个：${fabricated262.join(', ')}`)
  } else {
    log('ok', 'ENS-L262 数值校验通过，未发现疑似编造')
  }

  // ENS-L419: DOCX 噪音清洗 + 目录清洗
  log('step', 'DOCX 文本噪音清洗...')
  const cleanedDocxText = cleanPdfFullText(docxText)
  log('ok', `噪音清洗前 ${docxText.length} → 清洗后 ${cleanedDocxText.length} 字符`)

  log('step', 'DOCX 目录段落清洗...')
  const tocCleanedDocx = stripDocxToc(cleanedDocxText)
  log('ok', `目录清洗前 ${cleanedDocxText.length} → 清洗后 ${tocCleanedDocx.length} 字符（去除 ${cleanedDocxText.length - tocCleanedDocx.length} 字符目录）`)

  log('step', 'LLM 格式化 ENS-L419（程序切章 + 逐章排版）...')
  const restructured419 = await restructureDocument(
    tocCleanedDocx,
    '远景能源 ENS-L419 工商业储能一体机用户手册',
    '远景能源ENS-L419工商业储能一体机用户手册.docx',
  )
  log('ok', `格式化完成：${restructured419.length} 字符`)

  // 数值校验 ENS-L419
  const fabricated419 = detectFabricatedNumbers(restructured419, docxText)
  if (fabricated419.length > 0) {
    log('warn', `ENS-L419 疑似编造数值 ${fabricated419.length} 个：${fabricated419.join(', ')}`)
  } else {
    log('ok', 'ENS-L419 数值校验通过，未发现疑似编造')
  }

  // 多文档对比速查表
  log('step', '生成多文档参数对比速查表...')
  const comparisonTable = await generateComparisonTable([
    { title: '远景能源 ENS-L262 工商业储能一体机用户手册', content: restructured262 },
    { title: '远景能源 ENS-L419 工商业储能一体机用户手册', content: restructured419 },
  ])

  // ══════════════════════════════════════════════════════════════════════════
  // Step 5：创建分身 + 写入知识文档
  // ══════════════════════════════════════════════════════════════════════════
  section('Step 5 / 创建分身 + 写入知识文档')

  const soulContent = `# 小堵·工商储专家

我叫小堵，专注工商业储能方案设计与收益测算。每一个数字都必须能追溯到具体的产品手册或政策文件。

## 身份定位

> **角色**：工商业储能方案设计专家
> **领域**：储能系统选型、技术参数解读、占地评估、设备布局规划

## 核心风格

- 结论先行，先给结论再给依据
- 技术参数引用必须标注来源文件和章节
- 知识库没有的数据直接说没有

## 口头禅

- "这个数据在手册第几页？"
- "面积不够就换方案，不要硬塞"

## 好的回答示例

### 场景 1：知识库有完整参数

**用户**：ENS-L262 的外形尺寸是多少？

**小堵**：根据知识库手册数据，ENS-L262 外形尺寸为 989mm(W)×1465.5mm(D)×2470.5mm(H)，
占地面积约 1.45 m²，需预留操作通道。
[来源: knowledge/ens-l262-manual.md]

### 场景 2：知识库无数据

**用户**：ENS-L262 的制冷量是多少？

**小堵**：当前知识库的手册中没有制冷量的具体数据，建议联系远景能源技术支持确认。

## 数据溯源红线

| 数据类型 | 必须来源 | 禁止行为 |
|---------|---------|---------|
| 外形尺寸 | 产品手册具体章节 | 凭经验估算 |
| 技术参数 | 规格表 | 引用过期版本 |
| 布局要求 | 安装说明 | 模糊表述 |

## 原则

1. 数据可溯源：所有参数指向知识库具体文件
2. 有一说一：没有数据就明确说
3. 结论先行：先结论后依据
`

  const avatarManager = new AvatarManager(OUTPUT_DIR, TEMPLATES_PATH)
  avatarManager.createAvatar(AVATAR_ID, soulContent, [], [])
  log('ok', `分身目录：${path.join(OUTPUT_DIR, AVATAR_ID)}`)

  const avatarPath = path.join(OUTPUT_DIR, AVATAR_ID)
  const knowledgePath = path.join(avatarPath, 'knowledge')
  const km = new KnowledgeManager(knowledgePath)

  km.writeFile('ens-l262-manual.md', restructured262)
  log('ok', `写入：ens-l262-manual.md（${restructured262.length} 字符）`)

  km.writeFile('ens-l419-manual.md', restructured419)
  log('ok', `写入：ens-l419-manual.md（${restructured419.length} 字符）`)

  if (comparisonTable) {
    km.writeFile('comparison.md', `# 产品参数对比速查表\n\n${comparisonTable}`)
    log('ok', `写入：comparison.md（${comparisonTable.length} 字符）`)
  }

  // 保存 Vision 截图到知识库 images/ 目录
  const knowledgeImgDir = path.join(knowledgePath, 'images')
  fs.mkdirSync(knowledgeImgDir, { recursive: true })
  for (let i = 0; i < pdfResult.images.length; i++) {
    const pageNum = pdfResult.imagePageNumbers[i]
    const imgName = `page-${String(pageNum).padStart(2, '0')}.png`
    const base64Data = pdfResult.images[i].replace(/^data:image\/png;base64,/, '')
    fs.writeFileSync(path.join(knowledgeImgDir, imgName), Buffer.from(base64Data, 'base64'))
  }
  log('ok', `截图复制到知识库：${pdfResult.images.length} 张 → knowledge/images/`)

  // 回填 README.md（知识文件索引 + 图片映射）
  const imageInfos = visionResults
    .filter(v => v.content.trim().length > 10)
    .map(v => {
      const lines = v.content.split('\n').map(l => l.trim())
      // 优先取文字描述行
      let desc = lines.find(l => l.length > 5 && !l.startsWith('|') && !l.startsWith('---') && !l.startsWith('#'))?.slice(0, 60)
      if (!desc) {
        // 回退：从表格首行提取列名作为描述
        const headerLine = lines.find(l => l.startsWith('|') && !l.includes('---'))
        if (headerLine) {
          const cols = headerLine.split('|').map(c => c.trim()).filter(Boolean).slice(0, 3)
          desc = `数据表（${cols.join('、')}）`
        } else {
          desc = `第${v.pageNum}页技术图纸`
        }
      }
      return {
        filename: `images/page-${String(v.pageNum).padStart(2, '0')}.png`,
        description: desc,
        targetSection: `ens-l262-manual.md（第${v.pageNum}页图片分析）`,
      }
    })

  km.updateReadme('小堵·工商储专家', [
    {
      filename: 'ens-l262-manual.md',
      description: '远景能源 ENS-L262 工商业储能一体机用户手册（150kW/313.5kWh），含图片分析数据',
      source: 'ENS-L262-01用户手册 -V1.pdf',
    },
    {
      filename: 'ens-l419-manual.md',
      description: '远景能源 ENS-L419 工商业储能一体机用户手册（215kW/419kWh）',
      source: '远景能源ENS-L419工商业储能一体机用户手册.docx',
    },
  ], imageInfos)
  log('ok', 'README.md 已回填（知识文件索引 + 图片映射）')

  // ══════════════════════════════════════════════════════════════════════════
  // Step 6：加载分身
  // ══════════════════════════════════════════════════════════════════════════
  section('Step 6 / 加载分身（组装 systemPrompt）')

  const soulLoader = new SoulLoader(OUTPUT_DIR)
  const config = soulLoader.loadAvatar(AVATAR_ID)
  log('ok', `分身名称：${config.name}`)
  log('ok', `systemPrompt 长度：${config.systemPrompt.length} 字符`)

  const promptPath = path.join(avatarPath, '_system-prompt.md')
  fs.writeFileSync(promptPath, config.systemPrompt, 'utf-8')

  // ══════════════════════════════════════════════════════════════════════════
  // Step 7：索引构建（委托 @soul/core knowledge-indexer）
  // ══════════════════════════════════════════════════════════════════════════
  section('Step 7 / 知识库索引构建（BM25 + 上下文补充 + Embedding）')

  const retriever = new KnowledgeRetriever(knowledgePath)
  log('ok', `知识库切分完成：${retriever.getChunkKeys().length} 个 chunk`)

  const indexerLLM: LLMCallFn = async (sys, user, maxTokens = 100) => {
    return callDashScope('qwen-turbo', [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ], maxTokens)
  }

  log('step', '构建检索索引（上下文摘要 + 向量嵌入）...')
  const { contexts: contextMap, embeddings: embeddingMap } = await buildKnowledgeIndex(
    retriever,
    { callLLM: indexerLLM, callEmbedding },
    (progress) => {
      if (progress.phase === 'context') {
        log('info', `上下文 ${progress.current}/${progress.total}：${progress.detail || ''}`)
      } else {
        log('info', `Embedding ${progress.current}/${progress.total}`)
      }
    },
  )
  log('ok', `索引构建完成：${contextMap.size} 上下文，${embeddingMap.size} 向量`)

  saveIndex(knowledgePath, contextMap, embeddingMap)
  log('ok', `索引已持久化到 ${knowledgePath}/_index/`)

  // 保存上下文索引供人工检查
  const contextLines = [...contextMap.entries()]
    .map(([key, ctx]) => `${key}\n  → ${ctx}`)
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'chunk-contexts.txt'),
    contextLines.join('\n\n'),
    'utf-8',
  )

  // ══════════════════════════════════════════════════════════════════════════
  // Step 8：问答测试
  // ══════════════════════════════════════════════════════════════════════════
  section('Step 8 / 问答测试（BM25 + Embedding RRF 融合）')

  const questions = [
    'ENS-L262工商储的占地面积和体积',
    'ENS-L262工商储内部设备布局',
  ]

  const qaLines: string[] = [
    '# 小堵·工商储专家 问答记录',
    '',
    '> 分身：小堵·工商储专家',
    '> 知识库：ENS-L262 用户手册 + ENS-L419 用户手册',
    '> 测试日期：2026-04-03',
    '> 检索引擎：segmentit 分词 + BM25 + 上下文补充 + Embedding RRF 融合',
    '',
  ]

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]
    log('step', `Q${i + 1}：${q}`)

    const answer = await answerQuestion(retriever, q, systemPrompt, embeddingMap)
    const preview = answer.split('\n').slice(0, 8).join('\n')
    log('ok', `A${i + 1}：\n${preview}\n...（完整内容见问答记录文件）`)

    qaLines.push(`## Q${i + 1}：${q}`)
    qaLines.push('')
    qaLines.push(answer)
    qaLines.push('')
  }

  const qaPath = path.join(OUTPUT_DIR, '问答记录.md')
  fs.writeFileSync(qaPath, qaLines.join('\n'), 'utf-8')
  log('ok', `问答记录已保存：${qaPath}`)

  // ══════════════════════════════════════════════════════════════════════════
  // 汇总
  // ══════════════════════════════════════════════════════════════════════════
  section('生成内容路径汇总')

  const outputFiles: Array<[string, string]> = [
    ['knowledge/ens-l262-manual.md', path.join(knowledgePath, 'ens-l262-manual.md')],
    ['knowledge/ens-l419-manual.md', path.join(knowledgePath, 'ens-l419-manual.md')],
    ['knowledge/comparison.md', path.join(knowledgePath, 'comparison.md')],
    ['vision-results.md', visionPath],
    ['问答记录.md', qaPath],
    ['pdf-screenshots/', imgDir],
  ]

  for (const [label, p] of outputFiles) {
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      log('info', `${label.padEnd(36)} ${fs.statSync(p).size.toLocaleString()} bytes`)
    } else if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      log('info', `${label.padEnd(36)} ${fs.readdirSync(p).length} 个文件`)
    }
    log('info', `  → ${p}`)
  }

  const reportPath = path.join(OUTPUT_DIR, '模拟测试报告.md')
  fs.writeFileSync(reportPath, reportLines.join('\n') + '\n\n' + qaLines.join('\n'), 'utf-8')

  const projectOutputDir = path.join(SOUL_ROOT, 'test-output', 'xiaodu-sim-v11')
  if (fs.existsSync(projectOutputDir)) fs.rmSync(projectOutputDir, { recursive: true, force: true })
  fs.cpSync(OUTPUT_DIR, projectOutputDir, { recursive: true })

  console.log('\n' + '═'.repeat(60))
  console.log('  模拟测试完成（v11 LLM 格式化 · 零信息丢失）')
  console.log('═'.repeat(60))
  console.log(`\n项目目录：${projectOutputDir}`)
  console.log(`知识文档：${path.join(projectOutputDir, AVATAR_ID, 'knowledge')}`)
  console.log(`Vision 结果：${path.join(projectOutputDir, 'vision-results.md')}`)
}

main().catch(err => {
  console.error('❌ 模拟测试异常终止:', err)
  process.exit(1)
})
