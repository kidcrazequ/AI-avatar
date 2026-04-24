import { resolvePolicy, type ConsistencyPolicy } from './consistency-policy'

export type ConversationMode = 'normal' | 'chart'
export type ContextStrategy = 'no-rag' | 'light-rag' | 'full-rag' | 'excel-first' | 'cache-only'
export type ToolProfile = 'minimal' | 'standard' | 'chart'

export interface RouteConversationOptions<TModel> {
  content: string
  hasImages: boolean
  chatModel: TModel
  visionModel?: TModel
  minRagQueryLength?: number
}

export interface RoutingDecision<TModel> {
  model: TModel
  modelKind: 'chat' | 'vision'
  mode: ConversationMode
  contextStrategy: ContextStrategy
  toolProfile: ToolProfile
  policy: ConsistencyPolicy
  shouldCheckChartCache: boolean
  reason: string
}

const ACK_REGEX = /^(好|好的|行|可以|收到|明白|嗯|哦|谢谢|感谢|ok|okay|yes|no|继续|开始吧|收到啦|知道了|了解了|好嘞|行吧)[！!。.,，\s]*$/i
const SMALL_TALK_REGEX = /(你是谁|你还记得|你记得我|你怎么看|聊聊|在吗|你好|嗨|hello|hi|你叫什么|你是做什么的|介绍一下你自己)/i
const EXCEL_HINT_REGEX = /(excel|表格|工作表|sheet|列|字段|统计周期|月份|机型|效率|出货量|销售额|同比|环比|KPI|趋势|台数|单价|毛利|功率|容量)/i
const CROSS_FILE_REGEX = /(对比|比较|汇总|总结|综合|结合|分别|以及|同时|多个|跨文件|多份|关联|从.*到.*|差异|优缺点|共同点)/i
const FOLLOW_UP_EDIT_REGEX = /^(那|那就|那你|这个|这个呢|继续|接着|改成|换成|重新|再来|补充|展开|详细一点|简单一点|总结一下|润色一下|压缩一下)/i
const CHART_FOLLOW_UP_REGEX = /(上面的图|前面的图|这张图|那个图|改成图表|换成柱状图|换成折线图|继续画图)/i
const STRICT_NUMERIC_REGEX = /(请给出|请列出|精确|具体数值|分别是多少|按月|按季度|按机型|按地区|排行|top\s*\d+)/i

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

  if (hasImages && visionModel) {
    return {
      model: visionModel,
      modelKind: 'vision',
      mode: policy.mode,
      contextStrategy: 'no-rag',
      toolProfile: 'minimal',
      policy,
      shouldCheckChartCache: false,
      reason: 'images',
    }
  }

  let contextStrategy: ContextStrategy = 'light-rag'
  let toolProfile: ToolProfile = 'standard'
  let reason = 'default-light-rag'

  if (trimmed.length === 0 || trimmed.length < minRagQueryLength || ACK_REGEX.test(trimmed)) {
    contextStrategy = 'no-rag'
    toolProfile = 'minimal'
    reason = 'short-or-ack'
  } else if (policy.mode === 'chart') {
    contextStrategy = 'excel-first'
    toolProfile = 'chart'
    reason = 'chart-consistency'
  } else if (CHART_FOLLOW_UP_REGEX.test(trimmed)) {
    contextStrategy = 'cache-only'
    toolProfile = 'chart'
    reason = 'chart-follow-up'
  } else if (EXCEL_HINT_REGEX.test(trimmed) && STRICT_NUMERIC_REGEX.test(trimmed)) {
    contextStrategy = 'excel-first'
    toolProfile = 'chart'
    reason = 'excel-structured-data'
  } else if (CROSS_FILE_REGEX.test(trimmed)) {
    contextStrategy = 'full-rag'
    toolProfile = 'standard'
    reason = 'cross-file-question'
  } else if (EXCEL_HINT_REGEX.test(trimmed)) {
    contextStrategy = 'light-rag'
    toolProfile = 'standard'
    reason = 'excel-related-fact'
  } else if (trimmed.length >= 60) {
    contextStrategy = 'full-rag'
    toolProfile = 'standard'
    reason = 'long-query'
  } else if (SMALL_TALK_REGEX.test(trimmed) || FOLLOW_UP_EDIT_REGEX.test(trimmed)) {
    contextStrategy = 'no-rag'
    toolProfile = 'minimal'
    reason = SMALL_TALK_REGEX.test(trimmed) ? 'small-talk-or-persona' : 'follow-up-edit'
  }

  return {
    model: chatModel,
    modelKind: 'chat',
    mode: policy.mode,
    contextStrategy,
    toolProfile,
    policy,
    shouldCheckChartCache: policy.mode === 'chart' || contextStrategy === 'cache-only',
    reason,
  }
}
