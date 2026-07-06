/**
 * skill-router.ts — AI 分身 Skill 路由系统
 *
 * 三层架构：
 *   Layer 1: 索引层（skill-index.yaml）— name / keywords / when / priority
 *   Layer 2: 路由层（本文件）— 意图提取 → grep 召回 → 冲突裁决 → fallback
 *   Layer 3: 执行层 — 加载选中 skill 的完整 SKILL.md → 注入对话
 *
 * 核心设计原则：
 *   - 不依赖全量注入上下文（不把所有 skill 塞 system prompt）
 *   - 不依赖 LLM 单独做路由判断（主干是确定性 grep）
 *   - LLM 只在必要时介入：意图提取 / 冲突裁决 / fallback
 *   - 本地闭环，无需服务端
 *
 * @author claude + zhi.qu
 * @date 2026-04-16
 */

import fs from 'fs'
import path from 'path'
import { tokenize } from './knowledge-retriever'
import { normalizeIntentLocal, sanitizeForRouteLog, type IntentFrame } from './intent-normalizer'

// ─── Types ──────────────────────────────────────────────────────

export interface SkillIndexEntry {
  name: string
  path: string
  domain: string
  keywords: string[]
  aliases: string[]
  handles_intents: string[]
  provides: string[]
  consumes: string[]
  can_compose_with: string[]
  when: string
  priority: number
  /** 技能来源：local=分身专属，shared=公共，community=社区（默认 local） */
  source?: 'local' | 'shared' | 'community'
  /** 社区技能来源 URL（source='community' 时有值） */
  origin?: string
}

export interface SkillIndex {
  version: string
  skills: SkillIndexEntry[]
}

export interface RouteResult {
  /** 选中的 skill name（null = 没有匹配的 skill，走普通对话） */
  selectedSkill: string | null
  /** 多技能/虚拟能力的规划结果；selectedSkill 保留给旧调用方兼容 */
  selectedSkills: string[]
  /** 完整 SKILL.md 内容（选中时有值） */
  skillContent: string | null
  /** 已选中 skill 的内容映射；旧路径仍只消费 skillContent */
  skillContents: Record<string, string>
  /** 本地意图归一化结果，不调用云端模型 */
  intentFrame: IntentFrame
  /** 能力规划结果 */
  routePlan: RoutePlan
  /** 路由层本地拒答，如实现隐私守卫命中 */
  guardrailResponse?: string
  /** 路由层本地澄清响应，如模糊意图且不应进入 LLM */
  clarificationResponse?: string
  /** 可注入到后续回答的路由提示 */
  promptHint?: string
  /** 路由决策过程日志 */
  log: RouteLog
}

export interface RouteStep {
  id: string
  kind: 'skill' | 'capability' | 'guardrail' | 'clarify'
  skillName?: string
  capability?: string
  purpose: string
  dependsOn?: string[]
}

export interface RoutePlan {
  mode: 'none' | 'single_skill' | 'composite' | 'guardrail' | 'clarify'
  steps: RouteStep[]
  reason: string
  confidence: number
}

export interface RouteLog {
  timestamp: string
  input: string
  keywordsExtracted: string[]
  intentFrame: Pick<IntentFrame, 'entity' | 'intents' | 'artifact' | 'format' | 'metrics' | 'aliases' | 'confidence' | 'needsClarification'>
  matchedSkills: Array<{ name: string; hitCount: number; priority: number; capabilityScore: number }>
  fallbackTriggered: boolean
  selectedSkill: string | null
  selectedSkills: string[]
  durationMs: number
}

type CapabilityFields = Pick<
  SkillIndexEntry,
  'aliases' | 'handles_intents' | 'provides' | 'consumes' | 'can_compose_with'
>

const DEFAULT_SKILL_CAPABILITIES: Record<string, Partial<CapabilityFields>> = {
  'draw-mermaid': {
    aliases: ['X 光透视', 'X光透视', '透视', '扒开看', '拆开看', '内部结构', '结构展开', '拓扑', '部件关系'],
    handles_intents: ['expose_internal_relation', 'draw_structure', 'map_process', 'plan_timeline', 'annotate_with_metrics'],
    provides: ['structure_diagram', 'mermaid.flowchart', 'mermaid.sequence', 'mermaid.gantt', 'mermaid.state', 'mermaid.er', 'mermaid.class', 'mermaid.mindmap'],
    consumes: ['entities', 'relationships', 'timeline', 'states', 'metrics'],
    can_compose_with: ['metric_lookup', 'draw-chart', 'chart-from-knowledge'],
  },
  'draw-chart': {
    aliases: ['画图', '可视化', '走势图', '数据展示'],
    handles_intents: ['visualize_data', 'compare_metrics', 'evaluate_performance'],
    provides: ['data_chart', 'echarts.line', 'echarts.bar', 'echarts.pie', 'echarts.scatter', 'echarts.radar', 'echarts.heatmap'],
    consumes: ['inline_data', 'metrics', 'categories'],
    can_compose_with: ['chart-from-knowledge'],
  },
  'chart-from-knowledge': {
    aliases: ['知识库画图', '从表格画', '基于数据画'],
    handles_intents: ['visualize_data', 'compare_metrics'],
    provides: ['data_chart', 'echarts.line', 'echarts.bar', 'echarts.pie'],
    consumes: ['knowledge_data', 'metrics', 'categories'],
    can_compose_with: ['draw-chart'],
  },
  'decision-trace': {
    aliases: ['为什么没做', '当时怎么定', '谁拍板', '决策历史'],
    handles_intents: ['trace_decision'],
    provides: ['decision_trace'],
    consumes: ['knowledge_data', 'decision_records'],
    can_compose_with: ['chart-from-knowledge', 'draw-mermaid'],
  },
}

// ─── SkillRouter ────────────────────────────────────────────────

export class SkillRouter {
  private index: SkillIndex
  private avatarsPath: string
  /** 预计算：所有 keywords 展平为 keyword → skill name 的反向索引 */
  private keywordMap: Map<string, string[]>

  constructor(avatarsPath: string) {
    this.avatarsPath = avatarsPath
    this.index = { version: '1.0', skills: [] }
    this.keywordMap = new Map()
  }

  /**
   * 加载指定分身的 skill-index.yaml。
   * 如果文件不存在，返回空索引（路由器降级为"无 skill"模式）。
   */
  loadIndex(avatarId: string): void {
    const indexPath = path.join(this.avatarsPath, avatarId, 'skills', 'skill-index.yaml')
    if (!fs.existsSync(indexPath)) {
      // 没有索引文件 → 尝试从 templates 复制
      const templateIndex = path.join(this.avatarsPath, '..', 'templates', 'skill-index.yaml')
      if (fs.existsSync(templateIndex)) {
        const destDir = path.join(this.avatarsPath, avatarId, 'skills')
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true })
        fs.copyFileSync(templateIndex, indexPath)
      } else {
        this.index = { version: '1.0', skills: [] }
        this.keywordMap = new Map()
        return
      }
    }

    try {
      const raw = fs.readFileSync(indexPath, 'utf-8')
      this.index = this.parseYaml(raw)
      this.buildKeywordMap()
    } catch (err) {
      console.warn(`[SkillRouter] 加载 skill-index.yaml 失败:`, err instanceof Error ? err.message : String(err))
      this.index = { version: '1.0', skills: [] }
      this.keywordMap = new Map()
    }
  }

  /**
   * 主路由入口：从用户输入路由到最合适的 skill。
   *
   * Step 1: 本地意图归一化 — 输出 IntentFrame，不调 LLM
   * Step 2: grep + capability 召回 — keyword/aliases + handles/provides
   * Step 3: 确定性规划 — 单 skill / 组合 routePlan / 澄清 / 守卫
   */
  route(avatarId: string, userMessage: string): RouteResult {
    const t0 = Date.now()
    const intentFrame = normalizeIntentLocal(userMessage)
    const log: RouteLog = {
      timestamp: new Date().toISOString(),
      input: sanitizeForRouteLog(userMessage),
      keywordsExtracted: [],
      intentFrame: {
        entity: intentFrame.entity,
        intents: intentFrame.intents,
        artifact: intentFrame.artifact,
        format: intentFrame.format,
        metrics: intentFrame.metrics,
        aliases: intentFrame.aliases,
        confidence: intentFrame.confidence,
        needsClarification: intentFrame.needsClarification,
      },
      matchedSkills: [],
      fallbackTriggered: false,
      selectedSkill: null,
      selectedSkills: [],
      durationMs: 0,
    }

    if (intentFrame.guardrail) {
      const routePlan: RoutePlan = {
        mode: 'guardrail',
        steps: [{
          id: `guardrail-${intentFrame.guardrail.type.replace(/_/g, '-')}`,
          kind: 'guardrail',
          purpose: this.describeGuardrailPurpose(intentFrame.guardrail.type),
        }],
        reason: `命中 ${intentFrame.guardrail.type} 守卫，路由层本地返回固定边界响应，不进入工具循环/LLM provider`,
        confidence: intentFrame.confidence,
      }
      log.selectedSkills = []
      log.durationMs = Date.now() - t0
      return {
        selectedSkill: null,
        selectedSkills: [],
        skillContent: null,
        skillContents: {},
        intentFrame,
        routePlan,
        guardrailResponse: intentFrame.guardrail.response,
        log,
      }
    }

    if (this.index.skills.length === 0) {
      const routePlan = this.buildNoSkillPlan(intentFrame, '当前分身没有可用 skill-index')
      log.durationMs = Date.now() - t0
      return {
        selectedSkill: null,
        selectedSkills: [],
        skillContent: null,
        skillContents: {},
        intentFrame,
        routePlan,
        promptHint: this.buildPromptHint(intentFrame, routePlan),
        log,
      }
    }

    // Step 1: 意图提取 — segmentit 分词（复用 knowledge-retriever 的 tokenize）
    const queryLower = userMessage.toLowerCase()
    const tokens = tokenize(queryLower)
    // 同时保留原文中的关键短语（2-4 字的中文连续片段）
    const bigrams = this.extractBigrams(queryLower)
    const allKeywords = [...new Set([...tokens, ...bigrams])]
    log.keywordsExtracted = allKeywords.slice(0, 20)

    // Step 2: grep 召回 — 在 keywordMap 中匹配
    const hitMap = new Map<string, number>() // skill name → hit count
    for (const kw of allKeywords) {
      // 精确匹配
      const exactHits = this.keywordMap.get(kw)
      if (exactHits) {
        for (const skillName of exactHits) {
          hitMap.set(skillName, (hitMap.get(skillName) || 0) + 1)
        }
      }
      // 子串匹配（keyword 包含 kw 或 kw 包含 keyword）
      for (const [keyword, skillNames] of this.keywordMap) {
        if (keyword !== kw && (keyword.includes(kw) || kw.includes(keyword))) {
          for (const sn of skillNames) {
            hitMap.set(sn, (hitMap.get(sn) || 0) + 0.5) // 子串匹配权重低于精确
          }
        }
      }
    }

    // 构建候选列表并排序：先按 capabilityScore + hitCount 降序，再按 priority 升序
    const allNames = new Set<string>([...hitMap.keys()])
    for (const skill of this.index.skills) {
      const score = this.scoreCapability(skill, intentFrame)
      if (score > 0) allNames.add(skill.name)
    }

    const candidates: Array<{ name: string; hitCount: number; priority: number; capabilityScore: number }> = []
    for (const name of allNames) {
      const entry = this.index.skills.find(s => s.name === name)
      if (entry) {
        candidates.push({
          name,
          hitCount: hitMap.get(name) || 0,
          priority: entry.priority,
          capabilityScore: this.scoreCapability(entry, intentFrame),
        })
      }
    }
    candidates.sort((a, b) => {
      const aTotal = a.hitCount + a.capabilityScore
      const bTotal = b.hitCount + b.capabilityScore
      if (bTotal !== aTotal) return bTotal - aTotal
      return a.priority - b.priority
    })
    log.matchedSkills = candidates.slice(0, 5)

    if (intentFrame.needsClarification) {
      const clarificationResponse = this.buildClarificationResponse(intentFrame)
      const routePlan: RoutePlan = {
        mode: 'clarify',
        steps: [{
          id: 'clarify-intent',
          kind: 'clarify',
          purpose: '模糊表现评估意图需要先缩小交付物或指标范围',
        }],
        reason: '用户给出实体但未给出具体交付物/指标，先本地澄清，避免误加载技能',
        confidence: intentFrame.confidence,
      }
      log.durationMs = Date.now() - t0
      return {
        selectedSkill: null,
        selectedSkills: [],
        skillContent: null,
        skillContents: {},
        intentFrame,
        routePlan,
        clarificationResponse,
        log,
      }
    }

    // Step 3: 决策
    if (candidates.length === 0) {
      // 0 命中：不触发任何 skill，走普通对话
      const routePlan = this.buildNoSkillPlan(intentFrame, '没有技能关键词或能力声明命中')
      log.fallbackTriggered = true
      log.durationMs = Date.now() - t0
      console.log(`[SkillRouter] 0 命中，fallback（${log.durationMs}ms）`)
      return {
        selectedSkill: null,
        selectedSkills: [],
        skillContent: null,
        skillContents: {},
        intentFrame,
        routePlan,
        promptHint: this.buildPromptHint(intentFrame, routePlan),
        log,
      }
    }

    let routePlan = this.planRoute(intentFrame, candidates)
    let plannedSkillNames = routePlan.steps
      .filter((step): step is RouteStep & { skillName: string } => step.kind === 'skill' && typeof step.skillName === 'string')
      .map(step => step.skillName)

    // 命中 ≥ 1：默认选规划里的第一个 skill，图表类按通用规则做二次裁决
    let selected = candidates.find(c => c.name === plannedSkillNames[0]) || candidates[0]
    const candidateNames = new Set(candidates.map(c => c.name))
    if (routePlan.mode !== 'composite' && candidateNames.has('chart-from-knowledge') && candidateNames.has('draw-chart')) {
      const preferChartFromKnowledge = this.shouldPreferChartFromKnowledge(userMessage)
      if (preferChartFromKnowledge) {
        const chartFromKnowledgeCandidate = candidates.find(c => c.name === 'chart-from-knowledge')
        if (chartFromKnowledgeCandidate) selected = chartFromKnowledgeCandidate
      } else {
        const drawChartCandidate = candidates.find(c => c.name === 'draw-chart')
        if (drawChartCandidate) selected = drawChartCandidate
      }
      routePlan = {
        ...routePlan,
        steps: [{
          id: 'draw-data-chart',
          kind: 'skill',
          skillName: selected.name,
          purpose: selected.name === 'chart-from-knowledge' ? '先检索知识库数据再输出 ECharts 图表' : '基于已知数据输出 ECharts 图表',
        }],
        reason: `图表二次裁决选择 ${selected.name}`,
      }
      plannedSkillNames = routePlan.steps
        .filter((step): step is RouteStep & { skillName: string } => step.kind === 'skill' && typeof step.skillName === 'string')
        .map(step => step.skillName)
    }

    const selectedSkills = plannedSkillNames.length > 0 ? plannedSkillNames : [selected.name]
    log.selectedSkill = selected.name
    log.selectedSkills = selectedSkills
    log.durationMs = Date.now() - t0

    // Layer 3: 加载完整 SKILL.md
    const skillContents: Record<string, string> = {}
    for (const skillName of selectedSkills) {
      const skillEntry = this.index.skills.find(s => s.name === skillName)
      if (!skillEntry) continue
      const content = this.loadSkillContent(avatarId, skillEntry)
      if (content) skillContents[skillName] = content
    }
    const skillContent = skillContents[selected.name] || null

    console.log(`[SkillRouter] → ${selected.name} (hits=${selected.hitCount.toFixed(1)}, priority=${selected.priority}, ${log.durationMs}ms)`)
    return {
      selectedSkill: selected.name,
      selectedSkills,
      skillContent,
      skillContents,
      intentFrame,
      routePlan,
      promptHint: this.buildPromptHint(intentFrame, routePlan),
      log,
    }
  }

  /**
   * 获取所有 skill 的 name + when 列表（用于 fallback 场景注入 LLM）。
   */
  getSkillSummaries(): Array<{ name: string; when: string }> {
    return this.index.skills.map(s => ({ name: s.name, when: s.when }))
  }

  // ─── 内部方法 ──────────────────────────────────────────────────

  private scoreCapability(skill: SkillIndexEntry, frame: IntentFrame): number {
    let score = 0
    for (const intent of frame.intents) {
      if (skill.handles_intents.includes(intent)) score += 2
    }
    if (frame.artifact && skill.provides.includes(frame.artifact)) score += 2
    if (frame.format && skill.provides.includes(frame.format)) score += 1.5
    for (const alias of frame.aliases) {
      if (skill.aliases.some(a => a.toLowerCase() === alias.toLowerCase())) score += 1
    }

    if (frame.overlays.length > 0 && skill.handles_intents.includes('annotate_with_metrics')) score += 1
    if (frame.metrics.length > 0 && skill.consumes.includes('metrics')) score += 0.5

    // Name-based defaults protect older skill-index.yaml files that have not
    // been migrated to the capability schema yet.
    if (frame.artifact === 'structure_diagram' && skill.name === 'draw-mermaid') score += 2
    if (frame.artifact === 'data_chart' && (skill.name === 'draw-chart' || skill.name === 'chart-from-knowledge')) score += 1.5
    if (frame.intents.includes('trace_decision') && skill.name === 'decision-trace') score += 2

    return score
  }

  private describeGuardrailPurpose(type: NonNullable<IntentFrame['guardrail']>['type']): string {
    switch (type) {
      case 'implementation_privacy':
        return '拒答模型、SDK、系统提示词、数据流向、内部架构等实现边界问题'
      case 'retrieval_boundary':
        return '说明检索未命中边界，避免把本轮未命中说成知识库不存在'
      case 'knowledge_pipeline_boundary':
        return '拒绝在普通分身对话中推测知识导入、清洗、转写流程'
    }
  }

  private planRoute(
    frame: IntentFrame,
    candidates: Array<{ name: string; hitCount: number; priority: number; capabilityScore: number }>
  ): RoutePlan {
    const candidateNames = new Set(candidates.map(c => c.name))

    if (frame.artifact === 'structure_diagram' && frame.overlays.length > 0 && candidateNames.has('draw-mermaid')) {
      return {
        mode: 'composite',
        steps: [
          {
            id: 'metric-lookup',
            kind: 'capability',
            capability: 'metric_lookup',
            purpose: `从知识库检索 ${frame.entity ?? '目标对象'} 的 ${frame.metrics.join(', ') || '指标'}，只做取数/溯源，不输出 chart`,
          },
          {
            id: 'draw-structure-overlay',
            kind: 'skill',
            skillName: 'draw-mermaid',
            purpose: '绘制结构/拓扑图，并把已取证指标标注到对应节点 label',
            dependsOn: ['metric-lookup'],
          },
        ],
        reason: '结构图请求叠加指标标注，不能把 chart-from-knowledge 当作指标查询复用',
        confidence: Math.max(frame.confidence, 0.86),
      }
    }

    if (frame.artifact === 'structure_diagram' && candidateNames.has('draw-mermaid')) {
      return {
        mode: 'single_skill',
        steps: [{
          id: 'draw-structure',
          kind: 'skill',
          skillName: 'draw-mermaid',
          purpose: '输出 Mermaid 结构图',
        }],
        reason: '归一化后产物为 structure_diagram',
        confidence: Math.max(frame.confidence, 0.8),
      }
    }

    if (frame.intents.includes('trace_decision') && candidateNames.has('decision-trace')) {
      return {
        mode: 'single_skill',
        steps: [{
          id: 'trace-decision',
          kind: 'skill',
          skillName: 'decision-trace',
          purpose: '按决策回溯流程检索证据链',
        }],
        reason: '归一化后意图为 trace_decision',
        confidence: Math.max(frame.confidence, 0.8),
      }
    }

    if (frame.artifact === 'data_chart') {
      const chartSkill = candidateNames.has('chart-from-knowledge') ? 'chart-from-knowledge' : 'draw-chart'
      if (candidateNames.has(chartSkill)) {
        return {
          mode: 'single_skill',
          steps: [{
            id: 'draw-data-chart',
            kind: 'skill',
            skillName: chartSkill,
            purpose: chartSkill === 'chart-from-knowledge' ? '先检索知识库数据再输出 ECharts 图表' : '基于已知数据输出 ECharts 图表',
          }],
          reason: '归一化后产物为 data_chart',
          confidence: Math.max(frame.confidence, 0.78),
        }
      }
    }

    const top = candidates[0]
    return {
      mode: 'single_skill',
      steps: [{
        id: `load-${top.name}`,
        kind: 'skill',
        skillName: top.name,
        purpose: '关键词/能力召回的最高分技能',
      }],
      reason: '按关键词命中与能力分选择最高分技能',
      confidence: Math.max(frame.confidence, Math.min(0.75, top.hitCount + top.capabilityScore > 0 ? 0.7 : 0.4)),
    }
  }

  private buildNoSkillPlan(frame: IntentFrame, reason: string): RoutePlan {
    return {
      mode: 'none',
      steps: [],
      reason,
      confidence: frame.confidence,
    }
  }

  private buildPromptHint(frame: IntentFrame, routePlan: RoutePlan): string | undefined {
    if (routePlan.mode === 'none' && frame.intents.length === 0) return undefined
    if (routePlan.mode === 'guardrail' || routePlan.mode === 'clarify') return undefined

    const parts = [
      '路由层本地意图归一化结果：',
      `- intents: ${frame.intents.length ? frame.intents.join(', ') : '未明确'}`,
      frame.entity ? `- entity: ${frame.entity}` : undefined,
      frame.artifact ? `- artifact: ${frame.artifact}${frame.format ? ` (${frame.format})` : ''}` : undefined,
      frame.metrics.length ? `- metrics: ${frame.metrics.join(', ')}` : undefined,
      routePlan.mode === 'composite'
        ? '- routePlan: 先做知识库指标取数/溯源，再把指标标注到结构图节点；不要为了指标标注加载或输出 ECharts chart。'
        : `- routePlan: ${routePlan.reason}`,
    ].filter(Boolean)

    return parts.join('\n')
  }

  private buildClarificationResponse(frame: IntentFrame): string {
    const entity = frame.entity ? `「${frame.entity}」` : '这个对象'
    return `你想看 ${entity} 的哪一类表现？可以选：${frame.clarificationOptions.join(' / ')}。`
  }

  private loadSkillContent(avatarId: string, entry: SkillIndexEntry): string | null {
    // source 分流：之前一律 path.join(avatarsPath, avatarId, entry.path)，
    // shared/community 索引的 path 是 repo-root 相对（shared/skills/xxx.md），
    // 拼出来变成 avatars/<id>/shared/skills/xxx.md，命中后 skillContent=null。
    //   - local: path 约定相对【分身根目录】（skills/xxx.md，见 skill-index.yaml 头注 +
    //     finalizeSkillEntry 默认值）。所以优先 avatarRoot + entry.path；之前用
    //     yamlDir(=avatarRoot/skills) + entry.path 会拼成 skills/skills/xxx.md → 命中但
    //     skillContent=null（前端显示“加载技能”却不注入正文）。保留 yamlDir + entry.path
    //     作为兼容 fallback（兼容只写裸文件名 xxx.md 的旧索引）。
    //   - shared/community: 优先按 repo-root 相对解析（canonical）；
    //     失败时退回按 skill-index.yaml 所在目录解析（兼容 community-skill-manager
    //     早期写的 ../../../shared/... 形式）
    const repoRoot = path.resolve(this.avatarsPath, '..')
    const avatarRoot = path.join(this.avatarsPath, avatarId)
    const yamlDir = path.join(avatarRoot, 'skills')
    const source = entry.source ?? 'local'
    // 越界根按 source 收紧：local 必须落在【分身目录】内，shared/community 才放宽到 repo root。
    // 否则 local 索引写 ../../desktop-app/.env 这类路径仍会落在 repoRoot 下、绕过校验读任意仓库文件。
    const containmentRoot = source === 'local' ? avatarRoot : repoRoot
    const candidates: string[] = source === 'local'
      ? [path.join(avatarRoot, entry.path), path.join(yamlDir, entry.path)]
      : [path.resolve(repoRoot, entry.path), path.resolve(yamlDir, entry.path)]

    for (const skillPath of candidates) {
      // 越界校验：必须落在 containmentRoot 下，防 yaml 里的 ../ 跑出边界
      const rel = path.relative(containmentRoot, skillPath)
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        console.warn(`[SkillRouter] skill 路径越界（不在 ${source === 'local' ? 'avatar 目录' : 'repo root'} 下）：${skillPath}`)
        continue
      }
      if (!fs.existsSync(skillPath)) continue
      try {
        return fs.readFileSync(skillPath, 'utf-8')
      } catch (err) {
        console.warn(`[SkillRouter] 读取 SKILL.md 失败 ${skillPath}: ${err instanceof Error ? err.message : String(err)}`)
        return null
      }
    }
    console.warn(`[SkillRouter] SKILL.md 不存在（已试候选 ${candidates.length} 个）：name=${entry.name} path=${entry.path} source=${source}`)
    return null
  }

  /** 从文本中提取 2-4 字符的连续中文片段作为 bigram 候选 */
  private extractBigrams(text: string): string[] {
    const cjkChunks = text.match(/[\u4e00-\u9fa5]{2,}/g) || []
    const bigrams: string[] = []
    for (const chunk of cjkChunks) {
      // 2-gram 和 3-gram
      for (let i = 0; i <= chunk.length - 2; i++) {
        bigrams.push(chunk.slice(i, i + 2))
        if (i <= chunk.length - 3) bigrams.push(chunk.slice(i, i + 3))
      }
    }
    return bigrams
  }

  /** 构建 keyword → skill names 的反向索引 */
  private buildKeywordMap(): void {
    this.keywordMap = new Map()
    for (const skill of this.index.skills) {
      for (const kw of [...skill.keywords, ...skill.aliases]) {
        const lower = kw.toLowerCase()
        const existing = this.keywordMap.get(lower) || []
        if (!existing.includes(skill.name)) {
          existing.push(skill.name)
        }
        this.keywordMap.set(lower, existing)
      }
    }
  }

  /**
   * 图表路由通用判定：
   * - 数据查询型意图（时间范围/指标查询/筛选）优先 chart-from-knowledge
   * - 用户已在消息中直接给出结构化数值时优先 draw-chart
   */
  private shouldPreferChartFromKnowledge(userMessage: string): boolean {
    const msg = userMessage.toLowerCase()
    const hasDataQueryIntent = /(查询|筛选|统计|趋势|同比|环比|指标|数据源|excel|csv|sheet|月份|按月|按周|按年|区间|范围|机型|项目)/.test(msg)
    const hasTimeRangeIntent = /(20\d{2}\s*年|[0-9]{1,2}\s*月).*(到|至|~|～|-|—)|(到|至|~|～|-|—).*(20\d{2}\s*年|[0-9]{1,2}\s*月)/.test(msg)
    const hasInlineStructuredData = this.hasInlineStructuredData(msg)
    if (hasInlineStructuredData) return false
    return hasDataQueryIntent || hasTimeRangeIntent
  }

  /** 粗粒度识别“用户已贴数据”的场景：表格/列表数值/键值对 */
  private hasInlineStructuredData(msg: string): boolean {
    if (msg.includes('|') && msg.includes('\n')) return true // markdown 表格
    if (/[:：]\s*[-+]?\d+(\.\d+)?(%|万|元|kwh|kw|mw|mwh)?/i.test(msg)) return true // 键值数值
    if (/(\d+(\.\d+)?%[\s,，;；、]*){3,}/.test(msg)) return true // 连续百分比
    if (/([a-z\u4e00-\u9fa5]{1,8}\s*[=:：]\s*[-+]?\d+(\.\d+)?[\s,，;；、]*){3,}/i.test(msg)) return true // 键值列表
    if (/(已给你数据|如下数据|根据以下数据|按这组数据)/.test(msg)) return true
    return false
  }

  /**
   * 极简 YAML 解析器（只支持 skill-index.yaml 的固定结构）。
   * 不引入 js-yaml 依赖，手动解析 key: value 和 - item 列表。
   */
  private parseYaml(raw: string): SkillIndex {
    const result: SkillIndex = { version: '1.0', skills: [] }
    const lines = raw.split('\n')
    let currentSkill: Partial<SkillIndexEntry> | null = null
    let activeListField: keyof CapabilityFields | 'keywords' | null = null
    const listFields = new Set<string>(['keywords', 'aliases', 'handles_intents', 'provides', 'consumes', 'can_compose_with'])

    for (const line of lines) {
      const trimmed = line.replace(/#.*$/, '').trimEnd() // 去注释
      if (!trimmed.trim()) continue

      const indent = line.length - line.trimStart().length

      // 顶层
      if (indent === 0) {
        if (trimmed.startsWith('version:')) {
          result.version = trimmed.split(':').slice(1).join(':').trim().replace(/["']/g, '')
        }
        continue
      }

      // skills 列表项开头
      if (indent >= 2 && trimmed.trim().startsWith('- name:')) {
        if (currentSkill?.name) {
          result.skills.push(this.finalizeSkillEntry(currentSkill))
        }
        currentSkill = { name: this.cleanScalar(trimmed.trim().replace('- name:', '').trim()), keywords: [] }
        activeListField = null
        continue
      }

      if (!currentSkill) continue

      const kv = trimmed.trim()

      const listField = this.getListField(kv, listFields)
      if (listField) {
        activeListField = listField
        const inline = kv.replace(`${listField}:`, '').trim()
        if (inline.startsWith('[')) {
          currentSkill[listField] = this.parseInlineList(inline) as never
          activeListField = null
        } else {
          currentSkill[listField] = (currentSkill[listField] || []) as never
        }
        continue
      }

      if (activeListField && kv.startsWith('-')) {
        const list = (currentSkill[activeListField] || []) as string[]
        list.push(this.cleanScalar(kv.replace(/^-\s*/, '').trim()))
        currentSkill[activeListField] = list as never
        continue
      }

      // 非已识别列表的 - 开头行 → 忽略，避免误读未知嵌套结构
      if (kv.startsWith('-') && !activeListField) continue
      activeListField = null

      // 其他字段
      if (kv.startsWith('path:')) currentSkill.path = this.cleanScalar(kv.replace('path:', '').trim())
      else if (kv.startsWith('domain:')) currentSkill.domain = this.cleanScalar(kv.replace('domain:', '').trim())
      else if (kv.startsWith('when:')) currentSkill.when = this.cleanScalar(kv.replace('when:', '').trim())
      else if (kv.startsWith('priority:')) currentSkill.priority = parseInt(kv.replace('priority:', '').trim(), 10) || 1
      else if (kv.startsWith('source:')) currentSkill.source = this.cleanScalar(kv.replace('source:', '').trim()) as SkillIndexEntry['source']
      else if (kv.startsWith('origin:')) currentSkill.origin = this.cleanScalar(kv.replace('origin:', '').trim())
    }

    // 最后一个 skill
    if (currentSkill?.name) {
      result.skills.push(this.finalizeSkillEntry(currentSkill))
    }

    return result
  }

  private finalizeSkillEntry(partial: Partial<SkillIndexEntry>): SkillIndexEntry {
    const defaults = DEFAULT_SKILL_CAPABILITIES[partial.name || ''] || {}
    return {
      name: partial.name || '',
      path: partial.path || `skills/${partial.name}.md`,
      domain: partial.domain || '',
      keywords: partial.keywords || [],
      aliases: this.mergeList(defaults.aliases, partial.aliases),
      handles_intents: this.mergeList(defaults.handles_intents, partial.handles_intents),
      provides: this.mergeList(defaults.provides, partial.provides),
      consumes: this.mergeList(defaults.consumes, partial.consumes),
      can_compose_with: this.mergeList(defaults.can_compose_with, partial.can_compose_with),
      when: partial.when || '',
      priority: partial.priority ?? 1,
      source: partial.source,
      origin: partial.origin,
    }
  }

  private getListField(kv: string, listFields: Set<string>): keyof CapabilityFields | 'keywords' | null {
    const field = kv.split(':', 1)[0]
    if (!listFields.has(field)) return null
    return field as keyof CapabilityFields | 'keywords'
  }

  private parseInlineList(inline: string): string[] {
    return inline
      .replace(/^\[/, '')
      .replace(/\]$/, '')
      .split(',')
      .map(s => this.cleanScalar(s.trim()))
      .filter(Boolean)
  }

  private cleanScalar(value: string): string {
    return value.replace(/^['"]|['"]$/g, '').trim()
  }

  private mergeList(a?: string[], b?: string[]): string[] {
    return [...new Set([...(a || []), ...(b || [])].filter(Boolean))]
  }
}
