/**
 * Behavior modes are compact, reusable work-style rules.
 *
 * They are intentionally smaller than skills: a mode changes how the agent
 * approaches a task, while a skill defines a task workflow.
 */

export type BehaviorModeId =
  | 'strict_traceability'
  | 'minimal_delivery'
  | 'grill_requirements'
  | 'code_review'
  | 'plan_first'
  | 'ask_only'
  | 'debug_trace'

export type BehaviorModeIntensity = 'lite' | 'full' | 'strict'
export type ConversationModeLike = 'agent' | 'plan' | 'ask' | string

export interface BehaviorModeDefinition {
  id: BehaviorModeId
  label: string
  description: string
  triggerKeywords: string[]
  promptRules: string[]
  boundaries: string[]
  defaultIntensity: BehaviorModeIntensity
  persistentByDefault: boolean
}

export interface BehaviorModeActivation {
  mode: BehaviorModeDefinition
  intensity: BehaviorModeIntensity
  explicit: boolean
  matchedKeyword?: string
}

export const DEFAULT_BEHAVIOR_MODES: readonly BehaviorModeDefinition[] = Object.freeze([
  Object.freeze({
    id: 'strict_traceability',
    label: '严谨溯源',
    description: '关键事实先找来源，缺数据时明确说缺口。',
    triggerKeywords: ['严谨溯源', '溯源', '来源', '不要编', '证据', '可追溯'],
    promptRules: [
      '关键事实、数字、参数、政策、工程判断必须标注来源或说明缺口。',
      '先归并已确认事实、判断、不确定项，再输出结论。',
      '不得用模型常识冒充 knowledge/ 或文件证据。',
    ],
    boundaries: [
      '寒暄、格式确认、简单承接不强制检索。',
      '没有来源时输出缺口和下一步补证路径。',
    ],
    defaultIntensity: 'full',
    persistentByDefault: false,
  }),
  Object.freeze({
    id: 'minimal_delivery',
    label: '极简交付',
    description: '用最短路径交付可用结果，避免过度设计。',
    triggerKeywords: ['极简', '最小', '少写点', '一句话', '不要复杂', '短平快'],
    promptRules: [
      '先判断是否已有现成路径可复用。',
      '交付用户明确需要的内容，跳过 speculative 结构。',
      '非必要不新增依赖、不新增抽象、不写长解释。',
    ],
    boundaries: [
      '安全、数据溯源、可恢复性、用户明确要求不得被省略。',
      '复杂任务可以给短计划，但不把计划当交付。',
    ],
    defaultIntensity: 'full',
    persistentByDefault: false,
  }),
  Object.freeze({
    id: 'grill_requirements',
    label: '拷打需求',
    description: '先挑战模糊、冲突或缺证据的需求。',
    triggerKeywords: ['拷打', '挑战需求', '质疑', '需求评审', 'grill'],
    promptRules: [
      '先指出需求里的目标、约束、输入、验收缺口。',
      '能直接执行的小问题直接做；会导致返工的大缺口先钉住。',
      '输出问题清单时按阻塞程度排序。',
    ],
    boundaries: [
      '不要为了显得严格而阻塞已足够明确的小任务。',
      '质疑后要给可执行的补充路径。',
    ],
    defaultIntensity: 'full',
    persistentByDefault: false,
  }),
  Object.freeze({
    id: 'code_review',
    label: '代码审查',
    description: '默认只读，优先发现行为回归、运行时风险和缺失测试。',
    triggerKeywords: ['code review', '代码审查', '审查', 'review', '找 bug'],
    promptRules: [
      '默认只读不改代码，除非用户明确要求修复。',
      '发现项优先，按严重程度排序，带文件和行号。',
      '重点看行为回归、类型/运行时风险、数据损坏、安全和缺失测试。',
    ],
    boundaries: [
      '不要把风格偏好伪装成 bug。',
      '没有发现问题时明确说未发现，并说明剩余风险。',
    ],
    defaultIntensity: 'full',
    persistentByDefault: false,
  }),
  Object.freeze({
    id: 'plan_first',
    label: '先规划',
    description: '先收敛方案、边界和验收，再进入执行。',
    triggerKeywords: ['先规划', '先计划', '先给方案', '方案先行', '不要动文件', '先别改'],
    promptRules: [
      '先说明目标、约束、执行顺序和风险点。',
      '需要改代码时先确认范围，避免把调研和执行混在一起。',
      '能直接回答的咨询类问题不要输出冗长计划。',
    ],
    boundaries: [
      '用户明确要求立即执行时，不把计划当作最终交付。',
      '计划模式不等于拒绝推进；确认后按最小范围执行。',
    ],
    defaultIntensity: 'full',
    persistentByDefault: false,
  }),
  Object.freeze({
    id: 'ask_only',
    label: '纯问答',
    description: '回答问题、澄清判断，不主动调用工具或修改文件。',
    triggerKeywords: ['只问', '只回答', '纯问答', '不要调用工具', '别动文件', '解释一下'],
    promptRules: [
      '优先直接回答用户问题。',
      '不主动创建、修改、删除文件。',
      '信息不足时用一句话说明缺口，必要时给可验证路径。',
    ],
    boundaries: [
      '用户明确要求执行或运行命令时，该模式不应阻塞。',
      '高风险事实仍要说明不确定性。',
    ],
    defaultIntensity: 'full',
    persistentByDefault: false,
  }),
  Object.freeze({
    id: 'debug_trace',
    label: '调试追踪',
    description: '按复现、定位、修复、验证的顺序排查问题。',
    triggerKeywords: ['debug', '调试', '排查', '定位问题', '报错', '复现', 'trace'],
    promptRules: [
      '先复述可观察现象和可疑改动点。',
      '优先找最小可复现路径，再做局部修复。',
      '修复后给出验证命令和结果。',
    ],
    boundaries: [
      '不要顺手重构无关模块。',
      '没有证据时标注为推测，并继续找证据。',
    ],
    defaultIntensity: 'full',
    persistentByDefault: false,
  }),
])

const MODE_BY_ID = new Map<BehaviorModeId, BehaviorModeDefinition>(
  DEFAULT_BEHAVIOR_MODES.map((mode) => [mode.id, mode])
)

const INTENSITIES: readonly BehaviorModeIntensity[] = ['lite', 'full', 'strict']

export function normalizeBehaviorModeId(value: string): BehaviorModeId | null {
  const normalized = value.trim().toLowerCase().replace(/[-\s]+/g, '_')
  if (MODE_BY_ID.has(normalized as BehaviorModeId)) return normalized as BehaviorModeId
  return null
}

export function normalizeBehaviorModeIntensity(value: string | undefined): BehaviorModeIntensity | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  return INTENSITIES.includes(normalized as BehaviorModeIntensity)
    ? normalized as BehaviorModeIntensity
    : null
}

export function getBehaviorMode(id: BehaviorModeId): BehaviorModeDefinition {
  const mode = MODE_BY_ID.get(id)
  if (!mode) throw new Error(`unknown behavior mode: ${id}`)
  return mode
}

export function detectBehaviorModes(
  text: string,
  explicitModeIds: readonly string[] = [],
  intensity?: string,
): BehaviorModeActivation[] {
  const activations = new Map<BehaviorModeId, BehaviorModeActivation>()
  const selectedIntensity = normalizeBehaviorModeIntensity(intensity)

  for (const rawId of explicitModeIds) {
    const id = normalizeBehaviorModeId(rawId)
    if (!id) continue
    const mode = getBehaviorMode(id)
    activations.set(id, {
      mode,
      intensity: selectedIntensity ?? mode.defaultIntensity,
      explicit: true,
    })
  }

  const haystack = text.toLowerCase()
  for (const mode of DEFAULT_BEHAVIOR_MODES) {
    if (activations.has(mode.id)) continue
    const matched = mode.triggerKeywords.find((keyword) => haystack.includes(keyword.toLowerCase()))
    if (!matched) continue
    activations.set(mode.id, {
      mode,
      intensity: selectedIntensity ?? mode.defaultIntensity,
      explicit: false,
      matchedKeyword: matched,
    })
  }

  return [...activations.values()]
}

export function conversationModeToBehaviorModeIds(mode: ConversationModeLike): BehaviorModeId[] {
  if (mode === 'plan') return ['plan_first']
  if (mode === 'ask') return ['ask_only']
  return []
}

export function buildBehaviorModePromptBlock(activations: readonly BehaviorModeActivation[]): string {
  if (activations.length === 0) return ''
  const lines: string[] = ['## Behavior Modes']
  for (const activation of activations) {
    const { mode, intensity } = activation
    lines.push('', `### ${mode.label} (${mode.id}, ${intensity})`)
    lines.push(mode.description)
    lines.push('Rules:')
    for (const rule of mode.promptRules) lines.push(`- ${rule}`)
    lines.push('Boundaries:')
    for (const boundary of mode.boundaries) lines.push(`- ${boundary}`)
    if (intensity === 'lite') {
      lines.push('- Lite intensity: name the stricter option briefly, but do not block execution.')
    } else if (intensity === 'strict') {
      lines.push('- Strict intensity: stop when a missing source, missing requirement, or unsafe action would make the result misleading.')
    }
  }
  return lines.join('\n')
}

export function summarizeBehaviorModeActivations(activations: readonly BehaviorModeActivation[]): string[] {
  return activations.map((activation) => {
    const source = activation.explicit
      ? 'explicit'
      : `keyword:${activation.matchedKeyword ?? ''}`
    return `${activation.mode.id}:${activation.intensity}:${source}`
  })
}
