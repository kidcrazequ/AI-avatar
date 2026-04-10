/**
 * 问答测试脚本：使用已生成的知识库 + 上下文 + Embedding，
 * 将检索结果送入 LLM 以分身身份生成完整回答。
 *
 * 用法：npx ts-node src/tests/qa-test.ts
 *   或：node dist/tests/qa-test.js
 *
 * @author zhi.qu
 * @date 2026-04-03
 */

import fs from 'fs'
import path from 'path'
import { KnowledgeRetriever, tokenize } from '../knowledge-retriever'

const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || ''
const DASHSCOPE_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'

const OUTPUT_DIR = path.resolve(__dirname, '../../../../test-output/xiaodu-sim-v11')
const AVATAR_ID = 'xiaodu-ci-storage'
const KNOWLEDGE_PATH = path.join(OUTPUT_DIR, AVATAR_ID, 'knowledge')
const CONTEXT_FILE = path.join(OUTPUT_DIR, 'chunk-contexts.txt')
const SYSTEM_PROMPT_FILE = path.join(OUTPUT_DIR, AVATAR_ID, '_system-prompt.md')

interface DashScopeMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * 调用 DashScope LLM 生成回答
 */
async function callLLM(
  messages: DashScopeMessage[],
  maxTokens = 4000,
  retries = 3,
): Promise<string> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(`${DASHSCOPE_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${DASHSCOPE_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'qwen-plus',
          messages,
          stream: false,
          max_tokens: maxTokens,
        }),
        signal: AbortSignal.timeout(180_000),
      })

      if (response.status === 429 || response.status >= 500) {
        const wait = attempt * 5000
        console.log(`  ⚠️ API ${response.status}，${wait / 1000}s 后重试 (${attempt}/${retries})`)
        await new Promise(r => setTimeout(r, wait))
        continue
      }

      if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText)
        throw new Error(`LLM API 失败 (${response.status}): ${errText}`)
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>
      }
      return data.choices?.[0]?.message?.content?.trim() || ''
    } catch (err) {
      if (attempt === retries) throw err
      await new Promise(r => setTimeout(r, attempt * 5000))
    }
  }
  return ''
}

/**
 * 调用 DashScope Embedding
 */
async function callEmbedding(texts: string[], retries = 3): Promise<number[][]> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(`${DASHSCOPE_BASE_URL}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${DASHSCOPE_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'text-embedding-v3',
          input: texts,
          dimensions: 512,
        }),
        signal: AbortSignal.timeout(180_000),
      })
      if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText)
        throw new Error(`Embedding API 失败 (${response.status}): ${errText}`)
      }
      const data = (await response.json()) as {
        data?: Array<{ embedding: number[] }>
      }
      return data.data?.map(d => d.embedding) || []
    } catch (err) {
      if (attempt === retries) throw err
      await new Promise(r => setTimeout(r, attempt * 3000))
    }
  }
  return []
}

async function main() {
  if (!DASHSCOPE_API_KEY) {
    console.error('❌ 请设置 DASHSCOPE_API_KEY 环境变量')
    process.exit(1)
  }

  // 验证文件存在
  for (const f of [KNOWLEDGE_PATH, CONTEXT_FILE, SYSTEM_PROMPT_FILE]) {
    if (!fs.existsSync(f)) {
      console.error(`❌ 文件不存在：${f}\n请先运行完整模拟测试`)
      process.exit(1)
    }
  }

  console.log('═══════════════════════════════════════════════')
  console.log('  问答测试（检索 + LLM 回答）')
  console.log('═══════════════════════════════════════════════\n')

  // 1. 加载知识库
  const retriever = new KnowledgeRetriever(KNOWLEDGE_PATH)
  console.log(`✓ 知识库加载完成`)

  // 2. 加载上下文（按空行分隔的块解析，兼容 simulate-xiaodu 的 \n\n 分隔格式）
  const contextMap = new Map<string, string>()
  const blocks = fs.readFileSync(CONTEXT_FILE, 'utf-8').split('\n\n')
  for (const block of blocks) {
    const [keyLine, ctxLine] = block.split('\n')
    if (!keyLine || !ctxLine) continue
    const key = keyLine.trim()
    const ctx = ctxLine.replace(/^\s*→\s*/, '').trim()
    if (key && ctx) contextMap.set(key, ctx)
  }
  retriever.setContexts(contextMap)
  console.log(`✓ 上下文加载完成（${contextMap.size} 条）`)

  // 3. 加载 System Prompt
  const systemPrompt = fs.readFileSync(SYSTEM_PROMPT_FILE, 'utf-8')
  console.log(`✓ System Prompt 加载完成（${systemPrompt.length} 字符）`)

  // 4. 为 chunk 生成 embedding
  console.log(`\n▶ 生成 chunk embedding...`)
  const chunkKeys = retriever.getChunkKeys()
  const embeddingMap = new Map<string, number[]>()
  const batchSize = 20
  for (let i = 0; i < chunkKeys.length; i += batchSize) {
    const batch = chunkKeys.slice(i, i + batchSize)
    const texts = batch.map(ck => {
      const ctx = contextMap.get(ck.key) || ''
      return `${ctx} ${ck.heading} ${ck.contentPreview}`.slice(0, 500)
    })
    try {
      const embeddings = await callEmbedding(texts)
      embeddings.forEach((emb, idx) => embeddingMap.set(batch[idx].key, emb))
    } catch (err) {
      console.log(`  ⚠️ Embedding 批次失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  retriever.setEmbeddings(embeddingMap)
  console.log(`✓ Embedding 完成（${embeddingMap.size}/${chunkKeys.length}）\n`)

  // 5. 问答测试（多跳检索）
  const questions = [
    'ENS-L262工商储的占地面积和体积',
    'ENS-L262工商储内部设备布局',
  ]

  const ENTITY_EXTRACT_PROMPT = `从以下文档片段中提取所有设备名称、组件名称和技术系统名称。
要求：
- 只输出名称，每行一个
- 不加编号、不加解释
- 只提取具体的设备/组件/系统名（如"电池"、"PCS一体机"、"液冷机组"），不提取通用词汇
- 最多输出 10 个`

  const qaLines: string[] = [
    '# 小堵·工商储专家 问答测试（多跳检索）',
    '',
    '> 测试日期：2026-04-03',
    '> 检索引擎：segmentit 分词 + BM25 + 上下文补充 + Embedding RRF 融合 + **多跳检索**',
    '> 回答模型：qwen-plus',
    '',
  ]

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]
    console.log(`${'─'.repeat(50)}`)
    console.log(`Q${i + 1}：${q}`)
    console.log(`${'─'.repeat(50)}`)

    // 生成查询 embedding
    try {
      const [queryEmb] = await callEmbedding([q])
      embeddingMap.set('__query__', queryEmb)
      retriever.setEmbeddings(embeddingMap)
    } catch (err) {
      console.log(`  ⚠️ 查询 embedding 失败，退回纯 BM25`)
    }

    // ── 第一跳：原始查询检索 ──
    const keywords = tokenize(q)
    const query = keywords.join(' ')
    const hop1Chunks = retriever.searchChunks(query, 8)
    console.log(`  第一跳检索：${hop1Chunks.length} 个片段`)
    hop1Chunks.slice(0, 5).forEach((c, idx) => {
      console.log(`    [${idx + 1}] ${c.score.toFixed(3)} | [${c.file}] ${c.heading} (${c.content.length}字)`)
    })

    // ── 实体提取：从第一跳结果中提取组件/设备名 ──
    const hop1Text = hop1Chunks
      .slice(0, 5)
      .map(c => `【${c.heading}】\n${c.content.trim().slice(0, 500)}`)
      .join('\n\n')

    console.log(`\n  ▶ 提取实体...`)
    const entityResponse = await callLLM(
      [
        { role: 'system', content: ENTITY_EXTRACT_PROMPT },
        { role: 'user', content: hop1Text },
      ],
      200,
    )
    const entities = entityResponse
      .split('\n')
      .map(line => line.replace(/^[-•*\d.]+\s*/, '').trim())
      .filter(e => e.length >= 2 && e.length <= 20)
    console.log(`  提取到 ${entities.length} 个实体：${entities.join('、')}`)

    // ── 第二跳：按实体检索关联参数 ──
    console.log(`\n  ▶ 第二跳检索（按实体追踪参数）...`)
    const allChunks = retriever.multiHopSearch(query, entities, 15)
    const hop2Only = allChunks.filter(c => c.hop === 2)
    console.log(`  第二跳新增：${hop2Only.length} 个片段`)
    hop2Only.forEach((c, idx) => {
      console.log(`    [+${idx + 1}] ${c.score.toFixed(3)} | [${c.file}] ${c.heading} (${c.content.length}字)`)
    })
    console.log(`  合并后总片段：${allChunks.length} 个`)

    // ── 构建参考资料 ──
    const refText = allChunks
      .slice(0, 12)
      .map(
        (c, idx) =>
          `【参考${idx + 1}·${c.hop === 1 ? '直接匹配' : '关联参数'}】来源：${c.file} > ${c.heading}\n${c.content.trim().slice(0, 2000)}`,
      )
      .join('\n\n---\n\n')

    // ── 调用 LLM 生成回答 ──
    console.log(`\n  ▶ 调用 LLM 生成回答...`)
    const userMessage = `用户问题：${q}

以下检索结果是回答的起点，但不是你的全部知识。你的完整知识库在 system prompt 中，请同时使用检索结果和 system prompt 中的所有相关章节来回答。

规则：
1. 知识库中有的数据，直接引用并标注来源章节，不要说"未提供"
2. 涉及设备/组件时，主动搜索知识库中该组件出现的所有章节，将分散在不同位置的信息合并后再判断是否缺失
3. 只有知识库中确实不存在的数据，才标注为缺失
4. 涉及面积/体积时，同时计算含安装预留空间的总占地面积
5. 涉及空间布局、位置关系的问题，在文字描述之外，额外用 ASCII 图直观展示组件的相对位置

检索起点：
${refText}`

    const answer = await callLLM(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      4000,
    )

    console.log(`\n  ✓ A${i + 1}：`)
    console.log(answer)
    console.log()

    // ── 记录到文件 ──
    qaLines.push(`## Q${i + 1}：${q}`)
    qaLines.push('')
    qaLines.push(`**检索关键词**：${keywords.join(' | ')}`)
    qaLines.push(`**提取实体**：${entities.join('、')}`)
    qaLines.push(`**第一跳片段**：${hop1Chunks.length} 个 → **第二跳新增**：${hop2Only.length} 个 → **合并**：${allChunks.length} 个`)
    qaLines.push('')
    qaLines.push('### 检索到的参考片段')
    qaLines.push('')
    allChunks.forEach((c, idx) => {
      const hopLabel = c.hop === 1 ? '直接' : '关联'
      qaLines.push(`${idx + 1}. [${hopLabel}] **[${c.file}] ${c.heading}**（${c.content.length}字，score=${c.score.toFixed(3)}）`)
    })
    qaLines.push('')
    qaLines.push('### LLM 回答')
    qaLines.push('')
    qaLines.push(answer)
    qaLines.push('')
    qaLines.push('---')
    qaLines.push('')
  }

  const qaPath = path.join(OUTPUT_DIR, '问答测试.md')
  fs.writeFileSync(qaPath, qaLines.join('\n'), 'utf-8')
  console.log(`\n✓ 问答结果已保存：${qaPath}`)
}

main().catch(err => {
  console.error('❌ 测试失败：', err)
  process.exit(1)
})
