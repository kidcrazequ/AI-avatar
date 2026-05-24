/**
 * 对话路由器：仅做"低风险、确定性"的安全护栏，其余决策交给 LLM。
 *
 * 设计原则（PR1·P0-1 重构后）：
 *   - 不替 LLM 判断"用什么工具""要不要检索""走哪个工作流"
 *   - 只处理两类 router 真的能判断对的事：
 *       1) 模型选择（图片必须走 vision）
 *       2) 极简输入跳过 RAG（"好的"/"嗯" 之类的纯确认句，避免空检索浪费 token）
 *   - 其余一切通过 contextStrategy='auto' 透传，由 LLM 看完整问题 + 工具描述自主决定
 *
 * 旧的 chart/excel/cross-file/long-query 等 7 条业务正则已全部删除。
 * 这些场景应由 LLM 自己根据用户意图选择对应工具（query_excel / search_knowledge / load_skill 等）。
 *
 * @author zhi.qu
 * @date 2026-05-01
 */

import { resolvePolicy, type ConsistencyPolicy } from './consistency-policy'

/**
 * 上下文策略——只剩两个值。
 *   - 'no-rag' : router 已确定无需 RAG（图片 / 纯确认 / 空输入）
 *   - 'auto'   : 默认；让 LLM 通过工具调用自主决定是否检索
 */
export type ContextStrategy = 'no-rag' | 'auto'

export interface RouteConversationOptions<TModel> {
  content: string
  hasImages: boolean
  chatModel: TModel
  visionModel?: TModel
  /** 短输入跳过 RAG 的阈值（字符数），默认 4 */
  minRagQueryLength?: number
}

export interface RoutingDecision<TModel> {
  model: TModel
  modelKind: 'chat' | 'vision'
  contextStrategy: ContextStrategy
  /** 一致性策略（temperature/seed/chart hint），与 agent 决策正交 */
  policy: ConsistencyPolicy
  /** 路由理由，仅用于日志与回归分析 */
  reason: string
  /**
   * 建议主分身这轮 fan-out 一个 verifier 子代理复核（2026-05-22 Mavis 借鉴）。
   * null = 不建议。调用方可把这个信号转成一条 system prompt 提示注入到当前轮的 LLM 调用。
   */
  fanOut: FanOutSignal | null
}

/**
 * 纯确认句检测：用户只是在回应/确认（"好的"/"嗯"/"收到"），无实质提问内容。
 * 命中后跳过 RAG，避免空检索浪费 token。这是少数 router 能判断对的低风险场景。
 */
const ACK_REGEX = /^(好|好的|行|可以|收到|明白|嗯|哦|谢谢|感谢|ok|okay|yes|no|继续|开始吧|收到啦|知道了|了解了|好嘞|行吧)[！!。.,，\s]*$/i

/**
 * 高风险数据类问题特征：用户要具体数字 / 来源 / 出货量 / 通过率 / 跨源对比。
 * 命中时建议主分身在产出后 fan-out 一个 verifier 子代理复核（2026-05-22 Mavis 借鉴）。
 *
 * 故意保守：宁可少建议也不要每条都触发；门槛是"含至少一个高风险关键词 + 内容长度 ≥ 12"。
 * 单纯打招呼或简短确认不触发。
 */
const HIGH_STAKES_DATA_REGEX = /(多少|几个|哪几|占比|通过率|不良率|出货量|具体数字|具体多少|准确数据|项目数据|历史数据|来源|出处|引用|标到|标注来源|对比|比较|区别|vs )/i

/** verifier fan-out 建议信号——纯函数；调用方决定要不要拼到系统提示。 */
export interface FanOutSignal {
  kind: 'verifier'
  /** 命中的关键词（人读用，便于回归调试） */
  reason: string
}

export function detectFanOutSignal(content: string): FanOutSignal | null {
  const trimmed = content.trim()
  if (trimmed.length < 12) return null
  const m = trimmed.match(HIGH_STAKES_DATA_REGEX)
  if (!m) return null
  return { kind: 'verifier', reason: `high-stakes-keyword:${m[1] ?? m[0]}` }
}

export function routeConversation<TModel>(options: RouteConversationOptions<TModel>): RoutingDecision<TModel> {
  const {
    content,
    hasImages,
    chatModel,
    visionModel,
    minRagQueryLength = 4,
  } = options

  const trimmed = content.trim()
  const policy = resolvePolicy({ content, hasImages })

  // 护栏 1：图片必须走 vision 模型；vision 模型一般不擅长长 RAG 上下文，强制 no-rag
  if (hasImages && visionModel) {
    return {
      model: visionModel,
      modelKind: 'vision',
      contextStrategy: 'no-rag',
      policy,
      reason: 'images',
      fanOut: null,
    }
  }

  // 护栏 2：极短输入或纯确认句，跳过 RAG（拿来检索也没意义）
  if (trimmed.length === 0 || trimmed.length < minRagQueryLength || ACK_REGEX.test(trimmed)) {
    return {
      model: chatModel,
      modelKind: 'chat',
      contextStrategy: 'no-rag',
      policy,
      reason: trimmed.length === 0 ? 'empty' : (ACK_REGEX.test(trimmed) ? 'ack' : 'too-short'),
      fanOut: null,
    }
  }

  // 默认：透传给 LLM 自主决策；额外附带 fan-out 信号供 caller 决定是否注入 verifier 提示
  return {
    model: chatModel,
    modelKind: 'chat',
    contextStrategy: 'auto',
    policy,
    reason: 'auto',
    fanOut: detectFanOutSignal(content),
  }
}
