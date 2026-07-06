/**
 * Local intent normalizer for SkillRouter.
 *
 * This layer deliberately uses deterministic rules only. It must not call
 * LLMService or any provider API; cloud-backed intent classification can be
 * added later only behind an explicit opt-in switch.
 */

export interface IntentOverlay {
  type: 'metric'
  name: string
  target?: string
}

export interface IntentGuardrail {
  type: 'implementation_privacy' | 'retrieval_boundary' | 'knowledge_pipeline_boundary'
  response: string
}

export interface IntentFrame {
  entity?: string
  intents: string[]
  artifact?: string
  format?: string
  metrics: string[]
  overlays: IntentOverlay[]
  aliases: string[]
  confidence: number
  needsClarification: boolean
  clarificationOptions: string[]
  guardrail?: IntentGuardrail
}

export const IMPLEMENTATION_PRIVACY_RESPONSE =
  '我不能披露当前系统使用的具体模型、供应商 SDK、接入方式、数据流向或内部架构细节。你可以告诉我想完成什么任务，我会直接按能力范围帮你处理。'

export const RETRIEVAL_BOUNDARY_RESPONSE =
  '我只能说明本轮检索没有命中相关信息，不能据此证明知识库中不存在。需要的话，我可以继续按文件名、参数名、同义词或指定范围重新检索。'

export const KNOWLEDGE_PIPELINE_BOUNDARY_RESPONSE =
  '我不能仅凭当前分身对话确认知识导入、清洗或转写流程。普通使用场景下，我只说明本轮回答实际引用了哪些来源；完整实现以平台文档、管理员说明或代码为准。'

const METRIC_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'failure_rate', re: /(故障率|失效率|失效|故障|异常率|问题率)/i },
  { name: 'efficiency', re: /(效率|能效|设备侧效率|转换效率|rte)/i },
  { name: 'cost', re: /(成本|价格|报价|费用|单价|capex|opex)/i },
  { name: 'delivery', re: /(交付|周期|延期|进度|排期|里程碑)/i },
  { name: 'quality', re: /(质量|良率|缺陷|投诉|copq|返修)/i },
  { name: 'performance', re: /(表现|性能|效果|运行情况|健康度|体检)/i },
]

export function normalizeIntentLocal(userMessage: string): IntentFrame {
  const text = userMessage.trim()
  const lower = text.toLowerCase()
  const intents = new Set<string>()
  const aliases = new Set<string>()
  const metrics = new Set<string>()
  const overlays: IntentOverlay[] = []
  let artifact: string | undefined
  let format: string | undefined
  let confidence = 0.35

  const guardrail = detectBoundaryGuardrail(text)
  if (guardrail) {
    return {
      intents: [guardrail.type],
      artifact: 'refusal',
      metrics: [],
      overlays: [],
      aliases: [],
      confidence: 0.99,
      needsClarification: false,
      clarificationOptions: [],
      guardrail,
    }
  }

  const entity = extractEntity(text)

  if (/(为什么|为啥|当时|怎么定|谁拍板|没用|没采用|没选|取消|决策|评审|取舍)/.test(text)) {
    intents.add('trace_decision')
    confidence += 0.25
  }

  if (/(x\s*光|x光|透视|扒开|拆开看|内部结构|结构展开|拓扑|部件关系)/i.test(text)) {
    intents.add('expose_internal_relation')
    artifact = 'structure_diagram'
    format = 'mermaid.flowchart'
    aliases.add('xray_view')
    confidence += 0.35
  }

  if (/(架构图|结构图|拓扑图|系统图|流程图|全景图|关系图|模块关系|调用链|时序图|甘特图|状态机|er\s*图|类图|脑图|思维导图)/i.test(text)) {
    intents.add('expose_internal_relation')
    artifact = 'structure_diagram'
    format = inferStructureFormat(text)
    confidence += 0.3
  }

  if (/(画图|画个图|图表|可视化|趋势图|走势图|折线|柱状|饼图|散点|雷达|热力|占比|分布|同比|环比)/i.test(text)) {
    intents.add('visualize_data')
    if (!artifact || artifact !== 'structure_diagram') {
      artifact = 'data_chart'
      format = inferChartFormat(text)
    }
    confidence += 0.25
  }

  for (const metric of METRIC_PATTERNS) {
    if (metric.re.test(text)) metrics.add(metric.name)
  }

  const hasBroadReviewCue = /(表现|性能|效果|运行情况|健康度|体检|看下|看看|分析一下|盘点一下|怎么样|靠不靠谱)/.test(text)
  if (hasBroadReviewCue && entity && !artifact) {
    intents.add('evaluate_performance')
    confidence += 0.2
  }

  const hasOverlayCue = /(标注|标出|标每个|带上|叠加|附上|顺便|同时|overlay)/i.test(text)
  if ((artifact === 'structure_diagram' || intents.has('expose_internal_relation')) && hasOverlayCue && metrics.size > 0) {
    intents.add('annotate_with_metrics')
    for (const metric of metrics) {
      overlays.push({
        type: 'metric',
        name: metric,
        target: /(部件|组件|模块|节点|设备)/.test(text) ? 'components' : undefined,
      })
    }
    confidence += 0.2
  }

  if (intents.size === 0 && metrics.size > 0) {
    intents.add('evaluate_performance')
    confidence += 0.15
  }

  const needsClarification = shouldClarify({
    entity,
    intents,
    artifact,
    metrics,
    confidence,
  })

  return {
    entity,
    intents: [...intents],
    artifact,
    format,
    metrics: [...metrics],
    overlays,
    aliases: [...aliases],
    confidence: Math.min(confidence, 0.99),
    needsClarification,
    clarificationOptions: needsClarification
      ? ['质量表现', '结构拆解', '故障率/异常率', '选型或决策历史']
      : [],
  }
}

export function sanitizeForRouteLog(input: string): string {
  const compact = input.replace(/\s+/g, ' ').trim()
  if (compact.length <= 80) return compact
  return `${compact.slice(0, 77)}...`
}

function detectBoundaryGuardrail(text: string): IntentGuardrail | undefined {
  return detectImplementationPrivacy(text) ?? detectRetrievalBoundary(text) ?? detectKnowledgePipelineBoundary(text)
}

function detectImplementationPrivacy(text: string): IntentGuardrail | undefined {
  const lower = text.toLowerCase()
  const asksModel =
    /(什么|哪个|哪种|使用|用了|基于).{0,8}(模型|model)/i.test(text) ||
    /(模型|model).{0,8}(版本|型号|是哪|多少|什么|哪个|哪种)/i.test(text) ||
    /(gpt|claude|openai|anthropic|gemini|deepseek|qwen|通义|豆包).{0,12}(模型|版本|sdk|开发|接入|供应商|api)/i.test(lower) ||
    /(用的|使用的|基于).{0,8}(gpt|claude|openai|anthropic|gemini|deepseek|qwen|通义|豆包)/i.test(lower) ||
    /(gpt|claude|openai|anthropic|gemini|deepseek|qwen|通义|豆包).{0,12}(还是|or|和|与|vs)/i.test(lower)
  const asksSdkOrArchitecture =
    /(claude\s*sdk|openai\s*sdk|anthropic\s*sdk|sdk.{0,8}开发|基于.{0,16}sdk)/i.test(lower) ||
    /(后端|服务端|内部|底层).{0,12}(架构|实现|接入|接的|怎么接|调用|路由|provider|供应商)/i.test(text)
  const asksPromptOrSecrets =
    /(system\s*prompt|系统提示词|prompt.{0,8}(给我|泄露|看看|怎么写)|提示词.{0,8}(给我|泄露|看看|怎么写)|api\s*key|密钥|内部配置)/i.test(lower)
  const asksDataFlowOrDeployment =
    /(数据|知识库|文件|附件|消息|聊天|对话|内容).{0,24}(上传|发到|传到|上云|出网|留存|训练).{0,36}(大语言模型|云服务器|模型服务器|第三方|llm|api|openai|claude|anthropic)/i.test(lower) ||
    /(你|你们|当前系统|这个系统|soul|ai分身|分身|平台|我的数据|用户数据|知识库|上传的文件|附件|消息|聊天记录).{0,36}(数据流向|隐私|加密|本地处理|本地运行|端侧运行|离线运行|远程\s*api|调用.{0,8}api|是否上云|会不会上云|会不会出网|云服务器)/i.test(lower)

  if (!asksModel && !asksSdkOrArchitecture && !asksPromptOrSecrets && !asksDataFlowOrDeployment) return undefined
  return {
    type: 'implementation_privacy',
    response: IMPLEMENTATION_PRIVACY_RESPONSE,
  }
}

function detectRetrievalBoundary(text: string): IntentGuardrail | undefined {
  const lower = text.toLowerCase()
  const asksSearchTrace =
    /(真的|到底|实际|刚才|本轮).{0,10}(查|搜|检索).{0,12}(了吗|过吗|哪些|范围|来源|路径)/i.test(text) ||
    /(怎么|如何).{0,10}(相信|证明|保证).{0,24}(查|搜|检索|不是.{0,8}没找|知识库.{0,8}(没有|不存在))/i.test(text) ||
    /(没查到|未命中|找不到|没找到).{0,20}(不等于|等于|代表|说明|证明).{0,12}(没有|不存在)/i.test(text) ||
    /知识库.{0,20}(没有|不存在).{0,20}(怎么证明|凭什么|真的吗|确定吗)/i.test(text) ||
    /(明明有|应该有).{0,24}(没找到|没搜到|没查到|未命中)/i.test(text) ||
    /retrieval.{0,16}(trace|log|path|miss)/i.test(lower)

  if (!asksSearchTrace) return undefined
  return {
    type: 'retrieval_boundary',
    response: RETRIEVAL_BOUNDARY_RESPONSE,
  }
}

function detectKnowledgePipelineBoundary(text: string): IntentGuardrail | undefined {
  const lower = text.toLowerCase()
  const asksKnowledgePipeline =
    /(知识库|知识|文档|文件).{0,28}(原始格式|原文|原始文件|导入流程|导入机制|清洗|转写|改写|提炼|增强|格式化|pipeline|markdown|\.md|md\s*文件)/i.test(lower) ||
    /(知识库|知识|文档|文件|资料|语料).{0,20}(来源|从哪|哪里来|哪来的|来自哪里|谁提供|谁导入|谁整理|谁上传|怎么来的|如何来的)/i.test(lower) ||
    /(来源|出处).{0,16}(知识库|知识|文档|文件|资料|语料)/i.test(lower) ||
    /(llm|大模型|语言模型).{0,12}(提炼|改写|总结|转写|清洗).{0,18}(知识库|知识|文档|文件)/i.test(lower)

  if (!asksKnowledgePipeline) return undefined
  return {
    type: 'knowledge_pipeline_boundary',
    response: KNOWLEDGE_PIPELINE_BOUNDARY_RESPONSE,
  }
}

function extractEntity(text: string): string | undefined {
  const quoted = text.match(/[「『"']([^「」『』"']{1,40})[」』"']/)
  if (quoted?.[1]) return quoted[1].trim()

  const productCode = text.match(/(?:^|[^\dA-Za-z])(\d{2,4}\s*(?:kwh|kw|ah|mwh)?)(?=$|[^\dA-Za-z])/i)
  if (productCode?.[1]) return productCode[1].replace(/\s+/g, '')

  const named = text.match(/(?:看下|看看|分析|盘点|画|做个|关于|给我)([\u4e00-\u9fa5A-Za-z0-9_-]{2,24})(?:的|表现|架构|结构|拓扑|体检|$)/)
  if (named?.[1]) return named[1].trim()

  return undefined
}

function inferStructureFormat(text: string): string {
  if (/甘特|排期|时间表|里程碑/.test(text)) return 'mermaid.gantt'
  if (/时序|调用链|交互/.test(text)) return 'mermaid.sequence'
  if (/状态机|状态流转/.test(text)) return 'mermaid.state'
  if (/er\s*图|实体关系|数据模型/i.test(text)) return 'mermaid.er'
  if (/类图|oop/i.test(text)) return 'mermaid.class'
  if (/脑图|思维导图|知识图谱/.test(text)) return 'mermaid.mindmap'
  return 'mermaid.flowchart'
}

function inferChartFormat(text: string): string {
  if (/折线|趋势|走势|同比|环比/.test(text)) return 'echarts.line'
  if (/饼|占比|环形/.test(text)) return 'echarts.pie'
  if (/散点|分布/.test(text)) return 'echarts.scatter'
  if (/雷达/.test(text)) return 'echarts.radar'
  if (/热力/.test(text)) return 'echarts.heatmap'
  return 'echarts.bar'
}

function shouldClarify(input: {
  entity?: string
  intents: Set<string>
  artifact?: string
  metrics: Set<string>
  confidence: number
}): boolean {
  if (!input.entity) return false
  if (!input.intents.has('evaluate_performance')) return false
  if (input.artifact) return false
  const concreteMetrics = [...input.metrics].filter(metric => metric !== 'performance')
  if (concreteMetrics.length > 0) return false
  return input.confidence < 0.75
}
