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

// ─── Types ──────────────────────────────────────────────────────

export interface SkillIndexEntry {
  name: string
  path: string
  domain: string
  keywords: string[]
  when: string
  priority: number
}

export interface SkillIndex {
  version: string
  skills: SkillIndexEntry[]
}

export interface RouteResult {
  /** 选中的 skill name（null = 没有匹配的 skill，走普通对话） */
  selectedSkill: string | null
  /** 完整 SKILL.md 内容（选中时有值） */
  skillContent: string | null
  /** 路由决策过程日志 */
  log: RouteLog
}

export interface RouteLog {
  timestamp: string
  input: string
  keywordsExtracted: string[]
  matchedSkills: Array<{ name: string; hitCount: number; priority: number }>
  fallbackTriggered: boolean
  selectedSkill: string | null
  durationMs: number
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
   * Step 1: 意图提取 — 从用户消息中提取关键词（用 segmentit 分词，不调 LLM）
   * Step 2: grep 召回 — 在 keywordMap 中匹配，输出候选 skill 列表
   * Step 3: 冲突裁决 — 多命中时按 priority + hitCount 排序（不调 LLM）
   * fallback: 0 命中时返回 null（不调 LLM，让普通对话流程处理）
   *
   * 极简版：纯本地 grep，不调 LLM。速度 < 1ms。
   * 后续可在 Step 1 和 Step 3 增加轻量 LLM 调用提升准确率。
   */
  route(avatarId: string, userMessage: string): RouteResult {
    const t0 = Date.now()
    const log: RouteLog = {
      timestamp: new Date().toISOString(),
      input: userMessage.slice(0, 200),
      keywordsExtracted: [],
      matchedSkills: [],
      fallbackTriggered: false,
      selectedSkill: null,
      durationMs: 0,
    }

    if (this.index.skills.length === 0) {
      log.durationMs = Date.now() - t0
      return { selectedSkill: null, skillContent: null, log }
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

    // 构建候选列表并排序：先按 hitCount 降序，再按 priority 升序
    const candidates: Array<{ name: string; hitCount: number; priority: number }> = []
    for (const [name, hitCount] of hitMap) {
      const entry = this.index.skills.find(s => s.name === name)
      if (entry) {
        candidates.push({ name, hitCount, priority: entry.priority })
      }
    }
    candidates.sort((a, b) => {
      if (b.hitCount !== a.hitCount) return b.hitCount - a.hitCount
      return a.priority - b.priority
    })
    log.matchedSkills = candidates.slice(0, 5)

    // Step 3: 决策
    if (candidates.length === 0) {
      // 0 命中：不触发任何 skill，走普通对话
      log.fallbackTriggered = true
      log.durationMs = Date.now() - t0
      console.log(`[SkillRouter] 0 命中，fallback（${log.durationMs}ms）`)
      return { selectedSkill: null, skillContent: null, log }
    }

    // 命中 ≥ 1：默认选 top-1，图表类按通用规则做二次裁决
    let selected = candidates[0]
    const candidateNames = new Set(candidates.map(c => c.name))
    if (candidateNames.has('chart-from-knowledge') && candidateNames.has('draw-chart')) {
      const preferChartFromKnowledge = this.shouldPreferChartFromKnowledge(userMessage)
      if (preferChartFromKnowledge) {
        const chartFromKnowledgeCandidate = candidates.find(c => c.name === 'chart-from-knowledge')
        if (chartFromKnowledgeCandidate) selected = chartFromKnowledgeCandidate
      } else {
        const drawChartCandidate = candidates.find(c => c.name === 'draw-chart')
        if (drawChartCandidate) selected = drawChartCandidate
      }
    }
    log.selectedSkill = selected.name
    log.durationMs = Date.now() - t0

    // Layer 3: 加载完整 SKILL.md
    const skillEntry = this.index.skills.find(s => s.name === selected.name)!
    const skillContent = this.loadSkillContent(avatarId, skillEntry)

    console.log(`[SkillRouter] → ${selected.name} (hits=${selected.hitCount.toFixed(1)}, priority=${selected.priority}, ${log.durationMs}ms)`)
    return { selectedSkill: selected.name, skillContent, log }
  }

  /**
   * 获取所有 skill 的 name + when 列表（用于 fallback 场景注入 LLM）。
   */
  getSkillSummaries(): Array<{ name: string; when: string }> {
    return this.index.skills.map(s => ({ name: s.name, when: s.when }))
  }

  // ─── 内部方法 ──────────────────────────────────────────────────

  private loadSkillContent(avatarId: string, entry: SkillIndexEntry): string | null {
    const skillPath = path.join(this.avatarsPath, avatarId, entry.path)
    if (!fs.existsSync(skillPath)) {
      console.warn(`[SkillRouter] SKILL.md 不存在: ${skillPath}`)
      return null
    }
    try {
      return fs.readFileSync(skillPath, 'utf-8')
    } catch (err) {
      console.warn(`[SkillRouter] 读取 SKILL.md 失败: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
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
      for (const kw of skill.keywords) {
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
    let inKeywords = false

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
        currentSkill = { name: trimmed.trim().replace('- name:', '').trim(), keywords: [] }
        inKeywords = false
        continue
      }

      if (!currentSkill) continue

      const kv = trimmed.trim()

      // keywords 列表
      if (kv.startsWith('keywords:')) {
        inKeywords = true
        // 检查是否内联数组 [a, b, c]
        const inline = kv.replace('keywords:', '').trim()
        if (inline.startsWith('[')) {
          currentSkill.keywords = inline.replace(/\[|\]/g, '').split(',').map(s => s.trim())
          inKeywords = false
        }
        continue
      }

      if (inKeywords && kv.startsWith('-')) {
        currentSkill.keywords!.push(kv.replace(/^-\s*/, '').trim())
        continue
      }

      // 非 keywords 的 - 开头行（新 skill）→ 结束 keywords
      if (kv.startsWith('-') && !inKeywords) continue
      inKeywords = false

      // 其他字段
      if (kv.startsWith('path:')) currentSkill.path = kv.replace('path:', '').trim()
      else if (kv.startsWith('domain:')) currentSkill.domain = kv.replace('domain:', '').trim()
      else if (kv.startsWith('when:')) currentSkill.when = kv.replace('when:', '').trim()
      else if (kv.startsWith('priority:')) currentSkill.priority = parseInt(kv.replace('priority:', '').trim(), 10) || 1
    }

    // 最后一个 skill
    if (currentSkill?.name) {
      result.skills.push(this.finalizeSkillEntry(currentSkill))
    }

    return result
  }

  private finalizeSkillEntry(partial: Partial<SkillIndexEntry>): SkillIndexEntry {
    return {
      name: partial.name || '',
      path: partial.path || `skills/${partial.name}.md`,
      domain: partial.domain || '',
      keywords: partial.keywords || [],
      when: partial.when || '',
      priority: partial.priority ?? 1,
    }
  }
}
