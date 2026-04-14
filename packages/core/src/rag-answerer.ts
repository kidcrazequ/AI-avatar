/**
 * RAG 问答模块：程序化多跳检索 + 5 规则 prompt 构造。
 *
 * 封装从"用户问题"到"增强 user 消息"的完整流程：
 *   1. 分词提取关键词
 *   2. 生成查询 embedding（注入 __query__）
 *   3. BM25 + 向量 RRF 融合检索（第一跳）
 *   4. LLM 实体提取
 *   5. multiHopSearch 二次检索
 *   6. 构造包含检索结果 + 5 规则的 user 消息
 *
 * 桌面端和模拟测试共用此模块，确保回答质量一致。
 *
 * @author zhi.qu
 * @date 2026-04-03
 */

import type { KnowledgeRetriever } from './knowledge-retriever'
import { tokenize } from './knowledge-retriever'
import type { LLMCallFn } from './document-formatter'
import type { EmbeddingCallFn } from './knowledge-indexer'

export interface RAGConfig {
  callLLM: LLMCallFn
  callEmbedding: EmbeddingCallFn
}

/**
 * per-retriever 串行锁：防止并发 RAG 调用交替修改同一 retriever 的 embeddings 导致竞态。
 * 每次 retrieveAndBuildPrompt 会临时注入 __query__ 向量，完成后恢复；
 * 并发调用同一 retriever 时必须串行执行以保持内部状态一致。
 *
 * 使用 WeakMap 保证不同 retriever 实例相互独立，不跨分身串行化。
 */
const retrieverLocks = new WeakMap<object, Promise<unknown>>()

/**
 * 实体提取 Prompt：从检索结果中提取设备/组件/系统名。
 */
export const ENTITY_EXTRACT_PROMPT = `从以下文档片段中提取所有设备名称、组件名称和技术系统名称。
要求：
- 只输出名称，每行一个
- 不加编号、不加解释
- 只提取具体的设备/组件/系统名，不提取通用词汇
- 最多输出 10 个`

/**
 * 答题 5 规则模板。
 * 确保 LLM 充分利用 system prompt 中的完整知识库，而非仅依赖检索结果。
 */
const ANSWER_RULES = `规则：
1. 知识库中有的数据，直接引用并标注来源章节，不要说"未提供"
2. 涉及设备/组件时，主动搜索知识库中该组件出现的所有章节，将分散在不同位置的信息合并后再判断是否缺失
3. 只有知识库中确实不存在的数据，才标注为缺失
4. 涉及面积/体积时，同时计算含安装预留空间的总占地面积
5. 涉及空间布局、位置关系的问题，在文字描述之外，额外用 ASCII 图直观展示组件的相对位置`

/**
 * 对用户问题执行程序化 RAG，返回增强后的 user 消息。
 *
 * 增强后的消息包含：
 *   - 用户原始问题
 *   - 多跳检索结果（带来源标注）
 *   - 可选的百科参考（来自 wiki/concepts/）
 *   - 5 条答题规则
 *
 * @param retriever    已注入 contexts + embeddings 的 KnowledgeRetriever
 * @param question     用户原始问题
 * @param config       LLM 和 Embedding 调用函数
 * @param embeddingMap 当前的 embedding Map（用于注入 __query__）
 * @param wikiChunks   可选的百科概念页检索结果（不参与多跳，仅作为补充参考）
 * @returns 增强后的 user 消息文本
 *
 * @author zhi.qu
 * @date 2026-04-09
 */
export async function retrieveAndBuildPrompt(
  retriever: KnowledgeRetriever,
  question: string,
  config: RAGConfig,
  embeddingMap?: Map<string, number[]>,
  wikiChunks?: Array<{ file: string; heading: string; content: string; score: number }>,
): Promise<string> {
  // 串行执行：等待同一 retriever 前一个 RAG 调用完成，防止并发修改 embeddings 竞态
  // 使用 WeakMap per-retriever 锁，不同分身之间互不阻塞
  const prev = retrieverLocks.get(retriever) ?? Promise.resolve()
  let releaseLock!: () => void
  retrieverLocks.set(retriever, new Promise<void>(r => { releaseLock = r }))
  await prev

  const keywords = tokenize(question)
  const query = keywords.join(' ')

  // 注入查询向量（用于 RRF 融合）
  // 在 per-retriever 串行锁保护下，直接操作内部 embeddingMap（零拷贝），完成后清除恢复
  let injectedQueryVector = false
  if (embeddingMap || retriever.hasEmbeddings()) {
    try {
      const [queryEmb] = await config.callEmbedding([question])
      retriever.injectQueryVector(queryEmb)
      injectedQueryVector = true
    } catch (err) {
      console.warn('[RAG] 查询 embedding 失败，退回纯 BM25:', err instanceof Error ? err.message : String(err))
    }
  }

  try {
    // 第一跳检索
    const hop1Chunks = retriever.searchChunks(query, 8)
    if (hop1Chunks.length === 0) {
      return `${question}\n\n[系统提示] 知识库检索无结果。知识库可能为空或不包含相关内容。请直接告知用户"当前知识库中没有相关数据，请先导入知识文件"，不要反复调用 search_knowledge / query_excel 等工具尝试搜索。`
    }

    // 按第一跳 top-1 分数决定是否需要多跳：
    // 高分（≥ 阈值）说明查询关键词精准命中，直接用第一跳结果，省一次 LLM 调用（3-5 秒）。
    // 低分说明查询模糊（如"这个柜子散热方案有什么问题"），需要 LLM 提取实体做二次检索。
    const HOP1_SCORE_THRESHOLD = 8
    const top1Score = hop1Chunks[0]?.score ?? 0
    let entities: string[] = []

    if (top1Score < HOP1_SCORE_THRESHOLD) {
      // 实体提取：从第一跳结果中提取组件/设备名
      const hop1Text = hop1Chunks
        .slice(0, 5)
        .map(c => `【${c.heading}】\n${c.content.trim().slice(0, 500)}`)
        .join('\n\n')

      try {
        const entityResponse = await config.callLLM(ENTITY_EXTRACT_PROMPT, hop1Text, 200)
        entities = entityResponse
          .split('\n')
          .map(line => line.replace(/^[-•*\d.]+\s*/, '').trim())
          .filter(e => e.length >= 2 && e.length <= 20)
      } catch (err) {
        console.warn('[RAG] 实体提取失败，跳过多跳检索:', err instanceof Error ? err.message : String(err))
      }
    }

    // 多跳检索
    const allChunks = entities.length > 0
      ? retriever.multiHopSearch(query, entities, 15)
      : hop1Chunks.map(c => ({ ...c, hop: 1 }))

    // 构建参考资料
    const refText = allChunks
      .slice(0, 12)
      .map(
        (c, idx) =>
          `【参考${idx + 1}·${c.hop === 1 ? '直接匹配' : '关联参数'}】来源：${c.file} > ${c.heading}\n${c.content.trim().slice(0, 2000)}`,
      )
      .join('\n\n---\n\n')

    // 百科参考：来自 wiki/concepts/ 的补充性概念聚合页（可选）
    let wikiRefText = ''
    if (wikiChunks && wikiChunks.length > 0) {
      wikiRefText = '\n\n---\n\n百科参考（概念聚合页，仅供补充，以知识库原文为准）：\n' +
        wikiChunks
          .slice(0, 3)
          .map((c, idx) =>
            `【百科${idx + 1}】来源：${c.file} > ${c.heading}\n${c.content.trim().slice(0, 1500)}`,
          )
          .join('\n\n---\n\n')
    }

    return `用户问题：${question}

以下检索结果是回答的起点，但不是你的全部知识。你的完整知识库在 system prompt 中，请同时使用检索结果和 system prompt 中的所有相关章节来回答。

${ANSWER_RULES}

检索起点：
${refText}${wikiRefText}`
  } finally {
    if (injectedQueryVector) {
      retriever.clearQueryVector()
    }
    releaseLock!()
  }
}
