/**
 * 文档格式化模块：程序化章节切分 + 逐章 LLM 格式化。
 *
 * v11 核心理念：放弃 LLM "提炼"（必然丢信息），改为 LLM "格式化"（保留全文，只做排版）。
 * 桌面端和模拟测试共用此模块，确保知识处理结果一致。
 *
 * @author zhi.qu
 * @date 2026-04-03
 */

import { cleanLlmOutput } from './utils/ocr-html-cleaner'

export interface Chapter {
  title: string
  content: string
  index: number
}

export interface FormatProgress {
  current: number
  total: number
  chapterTitle: string
}

/**
 * LLM 调用函数签名。
 * 调用方注入具体实现（桌面端用 LLMService.complete，测试用 callDashScope）。
 */
export type LLMCallFn = (
  systemPrompt: string,
  userPrompt: string,
  maxTokens?: number,
) => Promise<string>

/**
 * 图表页文字阈值（同 document-parser.ts）：
 * 少于此字符数的页面以图表为主，需要 OCR。
 */
const MAX_CHAPTER_CHARS = 6000

/**
 * 文档格式化专用 System Prompt。
 *
 * 角色为「排版员」：保留全部内容，只做 Markdown 格式转换，严禁删减/改写/概括。
 */
export const FORMAT_SYSTEM_PROMPT = `你是一个文档格式化助手。你的任务是将原始文本转换为结构化的 Markdown 格式。

## 第一性原理思维（必须贯穿始终）

1. **追问本质**：面对任何文本，先理解其本质含义和结构关系，再决定格式
2. **拆解到基本事实**：识别文本中的基本事实单元（参数键值对、操作步骤、规则条目）
3. **质疑隐含假设**：不假设固定文档结构，根据实际内容判断最适合的格式
4. **从因到果推导**：每个格式化决策必须有清晰依据（为什么用表格？为什么用有序列表？）
5. **拒绝表面类比**：不套用固定模板，根据内容本身选择最佳表达形式

## 核心约束（不可违反）

1. **严禁删减内容**：原文的每一句话、每一个数值都必须出现在输出中
2. **严禁改写内容**：不得修改原文的措辞、数值、单位、符号
3. **严禁概括总结**：不得用自己的话替代原文表述，不得省略"次要"内容
4. **允许的格式操作**：
   - 识别并标记标题层级（## / ###）
   - 将散落的参数键值对整理为 Markdown 表格（| 参数 | 值 | 单位 |）
   - 将连续描述的操作步骤整理为有序列表（1. 2. 3.）
   - 修正明显的 OCR 错误（乱码字符、多余空格）
   - 规范化列表格式（统一 bullet 样式）
   - 保留原文的章节编号

## 输出格式

- 使用标准 Markdown 语法
- 参数数据优先使用三列表格（参数 | 数值 | 来源/备注）
- 操作步骤使用有序列表
- 不要在末尾附加总结、建议或自评
- 不要使用任何 emoji 图标`

/**
 * 程序化识别章节边界，将清洗后的全文拆成章节数组。
 *
 * 识别以下常见中文技术文档章节标题模式：
 *   - 「第X章」 / 「第一章」（汉字序数）
 *   - 「X. 标题」 / 「X.X 标题」 / 「X.X.X 标题」（数字编号）
 *   - 「一、标题」 / 「二、标题」（中文序号 + 顿号）
 *
 * 若某章节文本超过 MAX_CHAPTER_CHARS，按段落二次切分。
 */
export function splitIntoChapters(text: string): Chapter[] {
  const headingPattern = /^(?:第[一二三四五六七八九十百\d]+章\s+.+|[一二三四五六七八九十]+、.+|\d+(?:\.\d+)*\s+\S.{1,30})$/m

  const lines = text.split('\n')
  const chapterBreaks: Array<{ lineIndex: number; title: string }> = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line && headingPattern.test(line)) {
      chapterBreaks.push({ lineIndex: i, title: line })
    }
  }

  if (chapterBreaks.length === 0) {
    return [{ title: '全文', content: text, index: 0 }]
  }

  const rawChapters: Chapter[] = []
  for (let i = 0; i < chapterBreaks.length; i++) {
    const start = chapterBreaks[i].lineIndex
    const end = i + 1 < chapterBreaks.length ? chapterBreaks[i + 1].lineIndex : lines.length
    const content = lines.slice(start, end).join('\n').trim()
    rawChapters.push({ title: chapterBreaks[i].title, content, index: i })
  }

  const firstBreakLine = chapterBreaks[0].lineIndex
  if (firstBreakLine > 0) {
    const preamble = lines.slice(0, firstBreakLine).join('\n').trim()
    if (preamble.length > 50) {
      rawChapters.unshift({ title: '前言/目录', content: preamble, index: -1 })
    }
  }

  const result: Chapter[] = []
  let globalIndex = 0
  for (const chapter of rawChapters) {
    if (chapter.content.length <= MAX_CHAPTER_CHARS) {
      result.push({ ...chapter, index: globalIndex++ })
      continue
    }

    const paragraphs = chapter.content.split(/\n{2,}/)
    let currentContent = ''
    let partNum = 1

    for (const para of paragraphs) {
      if ((currentContent + '\n\n' + para).length > MAX_CHAPTER_CHARS && currentContent.length > 0) {
        result.push({
          title: `${chapter.title}（第${partNum}部分）`,
          content: currentContent.trim(),
          index: globalIndex++,
        })
        currentContent = para
        partNum++
      } else {
        currentContent = currentContent ? `${currentContent}\n\n${para}` : para
      }
    }

    if (currentContent.trim()) {
      result.push({
        title: partNum > 1 ? `${chapter.title}（第${partNum}部分）` : chapter.title,
        content: currentContent.trim(),
        index: globalIndex++,
      })
    }
  }

  return result
}

/**
 * 将单个章节送入 LLM 进行 Markdown 格式化。
 * LLM 角色为「排版员」：保留全部内容，只做格式转换。
 */
export async function formatChapter(
  chapter: Chapter,
  callLLM: LLMCallFn,
): Promise<string> {
  const userPrompt = `请将以下文档章节格式化为结构化 Markdown。
保留全部原文内容，不删减任何文字或数值。

章节标题：${chapter.title}

---

${chapter.content}`

  const raw = await callLLM(FORMAT_SYSTEM_PROMPT, userPrompt, 8192)
  return cleanLlmOutput(raw)
}

/**
 * 将文档全文拆成章节后逐章 LLM 格式化，最终拼接成完整知识文档。
 *
 * 流程：程序化章节切分 → 逐章格式化 → 拼接全文
 * LLM 只做排版，严禁删减内容，实现零信息丢失。
 *
 * @param rawText     清洗后的文档全文
 * @param title       文档标题（用于输出头部）
 * @param source      文件来源名（如 xxx.pdf）
 * @param callLLM     LLM 调用函数（由调用方注入）
 * @param onProgress  可选的进度回调
 */
export async function formatDocument(
  rawText: string,
  title: string,
  source: string,
  callLLM: LLMCallFn,
  onProgress?: (progress: FormatProgress) => void,
): Promise<string> {
  const chapters = splitIntoChapters(rawText)

  const formatted: string[] = []
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i]
    if (onProgress) {
      onProgress({ current: i + 1, total: chapters.length, chapterTitle: ch.title })
    }
    const result = await formatChapter(ch, callLLM)
    formatted.push(result)
  }

  const header = `# ${title}\n\n**来源文档**：\`${source}\`\n\n---\n\n`
  return header + formatted.join('\n\n---\n\n')
}
