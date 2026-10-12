/**
 * sop-schema.ts — SOP 状态机技能卡（SopCard）schema 与解析校验（W5.1）
 *
 * 痛点：流程型技能写成散文后，LLM 执行多步骤 SOP 时会跳步、漏收集参数、提前收尾。
 * 本模块把 SOP 定义为可校验的状态机图（节点 + 边 + 起点/终点），在解析期把
 * 图结构错误（悬空边、重复 id、不可达节点、无终点）全部拦下，运行期交给 SopRunner。
 *
 * 文件位置约定：`skills/<name>.sop.yaml`（与技能 md 同目录、同名）。
 * YAML 面向人手写，顶层键用 snake_case：
 *   sop_version: 1
 *   skill: roi-consult
 *   goal: ...
 *   start: collect-basics
 *   terminal: [report]
 *   interruption: pause          # pause=保留状态待续 / exit=终止
 *   nodes:
 *     - id: collect-basics
 *       name: 收集基础参数
 *       instruction: ...
 *       expects: [装机容量]      # 本节点需收集齐的槽位
 *       tools: [search_knowledge] # 建议工具（提示性，不强制）
 *       next:
 *         - to: fetch-tariff
 *           when: 基础参数收集齐
 *
 * TS 接口面向代码，用 camelCase（sopVersion/startId/terminalIds）。
 * 校验手写（本包无 zod），所有违规逐条收集为中文 error，不早退。
 */

import { parse as parseYaml } from 'yaml'

export interface SopNode {
  id: string
  name: string
  instruction: string
  expects: string[]                      // 本节点需收集齐的槽位（中文名）
  tools: string[]                        // 本节点建议可用工具名（提示性，不强制）
  next: Array<{ to: string; when?: string }>
}

export interface SopCard {
  sopVersion: 1
  skill: string
  goal: string
  startId: string
  terminalIds: string[]
  interruption: 'pause' | 'exit'         // 用户中途岔开话题：pause=保留状态待续，exit=终止
  nodes: SopNode[]
}

/** 读取对象上的非空字符串字段；不合法时记 error 并返回空串 */
function readNonEmptyString(obj: Record<string, unknown>, key: string, errors: string[]): string {
  const v = obj[key]
  if (typeof v === 'string' && v.trim().length > 0) return v.trim()
  errors.push(`${key} 必须是非空字符串`)
  return ''
}

/** 读取节点上的字符串数组字段；缺省视为 []（终点节点常无 expects/tools），类型不对记 error */
function readStringArray(node: Record<string, unknown>, nodeId: string, key: string, errors: string[]): string[] {
  const v = node[key]
  if (v === undefined || v === null) return []
  if (!Array.isArray(v) || v.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
    errors.push(`节点 ${nodeId} 的 ${key} 必须是字符串数组`)
    return []
  }
  return (v as string[]).map((s) => s.trim())
}

/** 解析单个节点的 next 边列表；缺省视为 []（终点节点无出边） */
function readNextEdges(node: Record<string, unknown>, nodeId: string, errors: string[]): Array<{ to: string; when?: string }> {
  const v = node.next
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) {
    errors.push(`节点 ${nodeId} 的 next 必须是数组`)
    return []
  }
  const edges: Array<{ to: string; when?: string }> = []
  v.forEach((item, j) => {
    if (typeof item !== 'object' || item === null) {
      errors.push(`节点 ${nodeId} 的第 ${j + 1} 条 next 必须是对象`)
      return
    }
    const edge = item as Record<string, unknown>
    const to = typeof edge.to === 'string' && edge.to.trim().length > 0 ? edge.to.trim() : ''
    if (!to) {
      errors.push(`节点 ${nodeId} 的第 ${j + 1} 条 next 缺少非空字符串 to`)
      return
    }
    if (edge.when !== undefined && typeof edge.when !== 'string') {
      errors.push(`节点 ${nodeId} 的第 ${j + 1} 条 next 的 when 必须是字符串`)
      edges.push({ to })
      return
    }
    edges.push(typeof edge.when === 'string' ? { to, when: edge.when } : { to })
  })
  return edges
}

/**
 * 解析并校验一张 SOP 卡（yaml 原文 → SopCard）。
 *
 * 校验规则（每条违规一行中文 error，全部收集不早退）：
 * - sop_version 必须为 1
 * - node id 唯一
 * - start / terminal / 所有 next.to 必须引用存在的节点（无悬空边）
 * - terminal 非空
 * - 从 start 出发不可达的节点报 error（图画错了：死节点）
 */
export function parseSopCard(raw: string): { ok: true; card: SopCard } | { ok: false; errors: string[] } {
  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch (err) {
    return { ok: false, errors: [`YAML 解析失败: ${err instanceof Error ? err.message : String(err)}`] }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, errors: ['SOP 卡顶层必须是 YAML 对象'] }
  }

  const errors: string[] = []
  const obj = parsed as Record<string, unknown>

  // ── 顶层标量字段 ──
  if (obj.sop_version !== 1) {
    errors.push(`sop_version 必须为 1（当前: ${JSON.stringify(obj.sop_version)}）`)
  }
  const skill = readNonEmptyString(obj, 'skill', errors)
  const goal = readNonEmptyString(obj, 'goal', errors)
  let interruption: 'pause' | 'exit' = 'pause'
  if (obj.interruption === 'pause' || obj.interruption === 'exit') {
    interruption = obj.interruption
  } else {
    errors.push(`interruption 必须是 'pause' 或 'exit'（当前: ${JSON.stringify(obj.interruption)}）`)
  }

  // ── 节点列表 ──
  const nodes: SopNode[] = []
  const nodeIds = new Set<string>()
  if (!Array.isArray(obj.nodes) || obj.nodes.length === 0) {
    errors.push('nodes 必须是非空数组')
  } else {
    obj.nodes.forEach((item, i) => {
      if (typeof item !== 'object' || item === null) {
        errors.push(`第 ${i + 1} 个节点必须是对象`)
        return
      }
      const n = item as Record<string, unknown>
      const id = typeof n.id === 'string' && n.id.trim().length > 0 ? n.id.trim() : ''
      if (!id) {
        // 没有 id 就无法参与引用检查，跳过该节点其余校验
        errors.push(`第 ${i + 1} 个节点缺少非空字符串 id`)
        return
      }
      if (nodeIds.has(id)) {
        // 重复 id 会让转移目标二义，保留首个定义，仅记错
        errors.push(`节点 id 重复: ${id}`)
        return
      }
      nodeIds.add(id)

      const nodeErrors: string[] = []
      const name = typeof n.name === 'string' && n.name.trim().length > 0 ? n.name.trim() : ''
      if (!name) nodeErrors.push(`节点 ${id} 缺少非空字符串 name`)
      const instruction = typeof n.instruction === 'string' && n.instruction.trim().length > 0 ? n.instruction.trim() : ''
      if (!instruction) nodeErrors.push(`节点 ${id} 缺少非空字符串 instruction`)
      const expects = readStringArray(n, id, 'expects', nodeErrors)
      const tools = readStringArray(n, id, 'tools', nodeErrors)
      const next = readNextEdges(n, id, nodeErrors)
      errors.push(...nodeErrors)
      nodes.push({ id, name, instruction, expects, tools, next })
    })
  }

  // ── 引用完整性：start / terminal / next.to 必须指向存在的节点 ──
  const start = readNonEmptyString(obj, 'start', errors)
  if (start && nodeIds.size > 0 && !nodeIds.has(start)) {
    errors.push(`start 指向不存在的节点: ${start}`)
  }

  const terminalIds: string[] = []
  if (!Array.isArray(obj.terminal) || obj.terminal.length === 0) {
    errors.push('terminal 必须是非空数组')
  } else {
    obj.terminal.forEach((t, i) => {
      if (typeof t !== 'string' || t.trim().length === 0) {
        errors.push(`terminal 的第 ${i + 1} 项必须是非空字符串`)
        return
      }
      const tid = t.trim()
      if (nodeIds.size > 0 && !nodeIds.has(tid)) {
        errors.push(`terminal 指向不存在的节点: ${tid}`)
      }
      terminalIds.push(tid)
    })
  }

  for (const node of nodes) {
    for (const edge of node.next) {
      if (!nodeIds.has(edge.to)) {
        errors.push(`节点 ${node.id} 的 next.to 指向不存在的节点: ${edge.to}`)
      }
    }
  }

  // ── 可达性：从 start BFS，扫出画错的死节点（起点无效时跳过，避免连带误报） ──
  if (start && nodeIds.has(start)) {
    const adjacency = new Map<string, string[]>(nodes.map((n) => [n.id, n.next.map((e) => e.to)]))
    const visited = new Set<string>([start])
    const queue = [start]
    while (queue.length > 0) {
      const current = queue.shift() as string
      for (const to of adjacency.get(current) ?? []) {
        if (nodeIds.has(to) && !visited.has(to)) {
          visited.add(to)
          queue.push(to)
        }
      }
    }
    for (const node of nodes) {
      if (!visited.has(node.id)) errors.push(`节点 ${node.id} 从起点不可达`)
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    card: { sopVersion: 1, skill, goal, startId: start, terminalIds, interruption, nodes },
  }
}
