/**
 * Session Search（A4 · Hermes 借鉴）：会话历史的情节记忆泄压阀。
 *
 * 复用 v3 起就有的 messages_fts（FTS5 external-content 表 + 触发器增量同步），
 * **不做任何批量建索引**——工程铁律：FTS 建索引不在 IPC 关键路径上同步执行；
 * 这里只有带 LIMIT 的只读查询，better-sqlite3 同步调用毫秒级返回。
 *
 * 三模式（细节照抄 Hermes memory_tool 的 session recall 设计）：
 *   - search：关键词 FTS 检索 → 按会话去重（每会话取最优命中）→
 *     命中点 ±window 条消息窗口 + 会话首尾 bookends；
 *     定时任务会话降权但不排除（cron 产生的会话噪音多，但可能有关键结论）
 *   - view：按 conversation_id 翻页阅读单个历史会话
 *   - browse：浏览最近会话列表（含定时任务标记）
 *
 * 零 LLM 成本。有了它，复盘 prompt 才能理直气壮说
 * "过程性内容不进记忆，用会话搜索找"。
 *
 * @author zhi.qu
 * @date 2026-07-05
 */

import type Database from 'better-sqlite3'

/** search 模式默认返回的去重会话数 */
const DEFAULT_MAX_SESSIONS = 3
/** 命中点上下文窗口（±N 条消息） */
const DEFAULT_WINDOW = 2
/** browse / view 默认分页 */
const DEFAULT_BROWSE_LIMIT = 10
const DEFAULT_VIEW_LIMIT = 20
/** 单条消息在结果里的截断长度 */
const MSG_TRUNCATE = 300
/** FTS 原始命中候选上限（去重前） */
const RAW_HIT_LIMIT = 60
/** 定时任务会话的降权系数（bm25 rank 为负值，乘 <1 系数使其变"差"但不出局） */
const SCHEDULED_RANK_DAMPING = 0.5

interface RawHit {
  messageId: string
  mrowid: number
  conversationId: string
  title: string
  role: string
  createdAt: number
  snip: string
  rank: number
}

interface MessageRow {
  id: string
  role: string
  content: string
  created_at: number
}

function truncate(text: string, max = MSG_TRUNCATE): string {
  const oneLine = (text ?? '').replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine
}

function fmtTs(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** FTS5 转义：按空白切词，每个 token 双引号包裹（内部双引号翻倍），空白连接=AND */
function toFtsQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(t => '"' + t.replace(/"/g, '""') + '"')
    .join(' ')
}

export class SessionSearchStore {
  constructor(private readonly db: Database.Database) {}

  /** 定时任务产生/写入过的会话 id 集合（schedules 固定会话 ∪ schedule_runs 历史） */
  private scheduledConversationIds(): Set<string> {
    try {
      const rows = this.db
        .prepare(`
          SELECT conversation_id AS cid FROM schedules WHERE conversation_id IS NOT NULL
          UNION
          SELECT conversation_id AS cid FROM schedule_runs WHERE conversation_id IS NOT NULL
        `)
        .all() as Array<{ cid: string }>
      return new Set(rows.map(r => r.cid))
    } catch {
      // schedules 表异常时不影响搜索主功能
      return new Set()
    }
  }

  /**
   * LIKE 子串兜底检索（中文场景）：转义 % _ \ 后子串匹配，按时间倒序取最近命中。
   * rank 统一给 -1（无 bm25 值），后续定时任务降权逻辑照常适用。
   */
  private likeFallbackHits(query: string, avatarId: string): RawHit[] {
    const escaped = query.replace(/[\\%_]/g, ch => '\\' + ch)
    const rows = this.db
      .prepare(`
        SELECT m.id AS messageId,
               m.rowid AS mrowid,
               m.conversation_id AS conversationId,
               c.title AS title,
               m.role AS role,
               m.created_at AS createdAt,
               m.content AS content
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE c.avatar_id = ?
          AND m.role IN ('user', 'assistant')
          AND m.content LIKE ? ESCAPE '\\'
        ORDER BY m.created_at DESC
        LIMIT ?
      `)
      .all(avatarId, `%${escaped}%`, RAW_HIT_LIMIT) as Array<Omit<RawHit, 'snip' | 'rank'> & { content: string }>
    return rows.map(r => {
      const idx = r.content.indexOf(query)
      const start = Math.max(0, idx - 40)
      const snip = (start > 0 ? '…' : '') + r.content.slice(start, Math.max(0, idx) + query.length + 60)
      return {
        messageId: r.messageId,
        mrowid: r.mrowid,
        conversationId: r.conversationId,
        title: r.title,
        role: r.role,
        createdAt: r.createdAt,
        snip,
        rank: -1,
      }
    })
  }

  /**
   * 命中点上下文：±window 条消息 + 首尾 bookends + 位置计数，全部窗口化查询。
   * 不整会话拉取——数千条消息的长会话在同步 API 上整读会阻塞 IPC 关键路径。
   */
  private hitContext(
    conversationId: string,
    hit: { messageId: string; createdAt: number; mrowid: number },
    window: number,
  ): {
    total: number
    /** 窗口首条消息在整个会话（user/assistant）里的 0-based 位置 */
    windowStart: number
    windowMsgs: MessageRow[]
    hitFound: boolean
    first: MessageRow | null
    last: MessageRow | null
  } {
    const base = `FROM messages WHERE conversation_id = ? AND role IN ('user', 'assistant')`
    const beforeCond = `AND (created_at < ? OR (created_at = ? AND rowid < ?))`
    const afterCond = `AND (created_at > ? OR (created_at = ? AND rowid > ?))`
    const total = (this.db.prepare(`SELECT COUNT(*) AS n ${base}`).get(conversationId) as { n: number }).n
    const hitRow = this.db
      .prepare(`SELECT id, role, content, created_at ${base} AND rowid = ?`)
      .get(conversationId, hit.mrowid) as MessageRow | undefined
    if (!hitRow) {
      return { total, windowStart: -1, windowMsgs: [], hitFound: false, first: null, last: null }
    }
    const hitPos = (this.db
      .prepare(`SELECT COUNT(*) AS n ${base} ${beforeCond}`)
      .get(conversationId, hit.createdAt, hit.createdAt, hit.mrowid) as { n: number }).n
    const before = (this.db
      .prepare(`SELECT id, role, content, created_at ${base} ${beforeCond} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(conversationId, hit.createdAt, hit.createdAt, hit.mrowid, window) as MessageRow[]).reverse()
    const after = this.db
      .prepare(`SELECT id, role, content, created_at ${base} ${afterCond} ORDER BY created_at ASC, rowid ASC LIMIT ?`)
      .all(conversationId, hit.createdAt, hit.createdAt, hit.mrowid, window) as MessageRow[]
    const first = this.db
      .prepare(`SELECT id, role, content, created_at ${base} ORDER BY created_at ASC, rowid ASC LIMIT 1`)
      .get(conversationId) as MessageRow | undefined
    const last = this.db
      .prepare(`SELECT id, role, content, created_at ${base} ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(conversationId) as MessageRow | undefined
    return {
      total,
      windowStart: hitPos - before.length,
      windowMsgs: [...before, hitRow, ...after],
      hitFound: true,
      first: first ?? null,
      last: last ?? null,
    }
  }

  search(params: {
    avatarId: string
    query: string
    maxSessions?: number
    window?: number
    excludeConversationId?: string
  }): string {
    const query = (params.query ?? '').trim()
    if (!query) return '[session_search] query 不能为空'
    const maxSessions = Math.max(1, Math.min(8, params.maxSessions ?? DEFAULT_MAX_SESSIONS))
    const window = Math.max(0, Math.min(6, params.window ?? DEFAULT_WINDOW))
    const ftsQuery = toFtsQuery(query)

    let hits: RawHit[]
    try {
      hits = this.db
        .prepare(`
          SELECT m.id AS messageId,
                 m.rowid AS mrowid,
                 m.conversation_id AS conversationId,
                 c.title AS title,
                 m.role AS role,
                 m.created_at AS createdAt,
                 snippet(messages_fts, 0, '[', ']', '…', 16) AS snip,
                 rank
          FROM messages_fts
          JOIN messages m ON m.rowid = messages_fts.rowid
          JOIN conversations c ON c.id = m.conversation_id
          WHERE messages_fts MATCH ?
            AND c.avatar_id = ?
            AND m.role IN ('user', 'assistant')
          ORDER BY rank
          LIMIT ?
        `)
        .all(ftsQuery, params.avatarId, RAW_HIT_LIMIT) as RawHit[]
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('fts5') || msg.includes('MATCH') || msg.includes('syntax')) {
        hits = []
      } else {
        throw err
      }
    }

    // 中文兜底：messages_fts 用默认 unicode61 tokenizer，连续 CJK 是单 token，
    // "电价" 匹配不到 "江苏的电价政策……"。FTS 零命中时退回 LIKE 子串扫描
    // （带 LIMIT；本地库万级消息量毫秒~几十毫秒级，且只在 FTS 零命中时走）。
    if (hits.length === 0) {
      hits = this.likeFallbackHits(query, params.avatarId)
      if (hits.length === 0) {
        return `[session_search] 关键词 "${query}" 在历史会话里没有命中。可换关键词重试，或用 mode="browse" 浏览会话列表。`
      }
    }

    const scheduled = this.scheduledConversationIds()
    // 定时任务会话降权不排除：rank 为负（越小越好），乘 <1 系数使其排位后移
    const adjusted = hits
      .filter(h => h.conversationId !== params.excludeConversationId)
      .map(h => ({
        ...h,
        isScheduled: scheduled.has(h.conversationId),
        score: scheduled.has(h.conversationId) ? h.rank * SCHEDULED_RANK_DAMPING : h.rank,
      }))
      .sort((a, b) => a.score - b.score)

    // 按会话去重：每会话保留最优命中
    const bestPerConv = new Map<string, (typeof adjusted)[number]>()
    for (const h of adjusted) {
      if (!bestPerConv.has(h.conversationId)) bestPerConv.set(h.conversationId, h)
    }
    const selected = Array.from(bestPerConv.values()).slice(0, maxSessions)
    if (selected.length === 0) {
      return `[session_search] 关键词 "${query}" 在历史会话里没有命中。可换关键词重试，或用 mode="browse" 浏览会话列表。`
    }

    const blocks: string[] = [
      `[session_search] 关键词 "${query}" 命中 ${bestPerConv.size} 个会话，展示前 ${selected.length} 个（每会话取最优命中 ±${window} 条上下文 + 首尾锚点）：`,
    ]
    for (const hit of selected) {
      const ctx = this.hitContext(hit.conversationId, hit, window)
      const lines: string[] = []
      const schedMark = hit.isScheduled ? '（定时任务会话，已降权）' : ''
      lines.push(`── 会话 ${hit.conversationId}「${hit.title}」${schedMark} · ${fmtTs(hit.createdAt)} · 共 ${ctx.total} 条消息`)
      if (!ctx.hitFound) {
        lines.push(`  命中片段: ${truncate(hit.snip)}`)
      } else {
        const start = ctx.windowStart
        const end = start + ctx.windowMsgs.length - 1
        // 会话首 bookend（不与窗口重叠时才补）
        if (start > 0 && ctx.first) {
          lines.push(`  [开头] ${ctx.first.role}: ${truncate(ctx.first.content, 120)}`)
          if (start > 1) lines.push(`  …（略 ${start - 1} 条）`)
        }
        for (const m of ctx.windowMsgs) {
          const marker = m.id === hit.messageId ? '»' : ' '
          lines.push(`  ${marker} ${m.role}: ${truncate(m.content)}`)
        }
        // 会话尾 bookend
        if (end < ctx.total - 1 && ctx.last) {
          if (end < ctx.total - 2) lines.push(`  …（略 ${ctx.total - 2 - end} 条）`)
          lines.push(`  [结尾] ${ctx.last.role}: ${truncate(ctx.last.content, 120)}`)
        }
      }
      lines.push(`  （需要读全文：session_search mode="view" conversation_id="${hit.conversationId}"）`)
      blocks.push(lines.join('\n'))
    }
    return blocks.join('\n\n')
  }

  view(params: { avatarId: string; conversationId: string; offset?: number; limit?: number }): string {
    const conv = this.db
      .prepare(`SELECT id, title, avatar_id FROM conversations WHERE id = ?`)
      .get(params.conversationId) as { id: string; title: string; avatar_id: string } | undefined
    if (!conv || conv.avatar_id !== params.avatarId) {
      return `[session_search] 会话 ${params.conversationId} 不存在或不属于当前分身。用 mode="browse" 查看可用会话。`
    }
    const offset = Math.max(0, Math.floor(params.offset ?? 0))
    const limit = Math.max(1, Math.min(50, Math.floor(params.limit ?? DEFAULT_VIEW_LIMIT)))
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND role IN ('user', 'assistant')`)
        .get(params.conversationId) as { n: number }
    ).n
    const rows = this.db
      .prepare(`
        SELECT role, content, created_at FROM messages
        WHERE conversation_id = ? AND role IN ('user', 'assistant')
        ORDER BY created_at ASC, rowid ASC
        LIMIT ? OFFSET ?
      `)
      .all(params.conversationId, limit, offset) as Array<Omit<MessageRow, 'id'>>
    if (rows.length === 0) {
      return `[session_search] 会话「${conv.title}」共 ${total} 条消息，offset=${offset} 超出范围。`
    }
    const lines = [
      `[session_search] 会话 ${conv.id}「${conv.title}」消息 ${offset + 1}-${offset + rows.length} / 共 ${total} 条：`,
      ...rows.map(r => `  ${r.role} (${fmtTs(r.created_at)}): ${truncate(r.content, 500)}`),
    ]
    if (offset + rows.length < total) {
      lines.push(`  （继续翻页：offset=${offset + rows.length}）`)
    }
    return lines.join('\n')
  }

  browse(params: { avatarId: string; offset?: number; limit?: number }): string {
    const offset = Math.max(0, Math.floor(params.offset ?? 0))
    const limit = Math.max(1, Math.min(30, Math.floor(params.limit ?? DEFAULT_BROWSE_LIMIT)))
    const scheduled = this.scheduledConversationIds()
    const rows = this.db
      .prepare(`
        SELECT c.id, c.title, c.updated_at,
               (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.role IN ('user', 'assistant')) AS msg_count
        FROM conversations c
        WHERE c.avatar_id = ?
        ORDER BY c.updated_at DESC
        LIMIT ? OFFSET ?
      `)
      .all(params.avatarId, limit, offset) as Array<{ id: string; title: string; updated_at: number; msg_count: number }>
    if (rows.length === 0) {
      return offset === 0
        ? '[session_search] 当前分身还没有历史会话。'
        : `[session_search] offset=${offset} 超出会话列表范围。`
    }
    const lines = [
      `[session_search] 会话列表（第 ${offset + 1}-${offset + rows.length} 个，按最近更新排序）：`,
      ...rows.map(r => {
        const mark = scheduled.has(r.id) ? ' [定时任务]' : ''
        return `  - ${r.id}「${r.title}」${mark} · ${r.msg_count} 条消息 · ${fmtTs(r.updated_at)}`
      }),
      `  （读某个会话全文：mode="view" conversation_id="..."；继续翻页：offset=${offset + rows.length}）`,
    ]
    return lines.join('\n')
  }
}

/**
 * session_search 工具入口（main.ts execute-tool-call 直接调用）。
 * 参数宽容解析——弱模型经常传错类型，这里逐字段兜底而不是整体报错。
 */
export function runSessionSearchTool(
  store: SessionSearchStore,
  avatarId: string,
  currentConversationId: string | undefined,
  args: Record<string, unknown>,
): string {
  const mode = args.mode === 'view' || args.mode === 'browse' ? args.mode : 'search'
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined
  if (mode === 'view') {
    const conversationId = typeof args.conversation_id === 'string' ? args.conversation_id.trim() : ''
    if (!conversationId) return '[session_search] mode="view" 需要 conversation_id'
    return store.view({ avatarId, conversationId, offset: num(args.offset), limit: num(args.limit) })
  }
  if (mode === 'browse') {
    return store.browse({ avatarId, offset: num(args.offset), limit: num(args.limit) })
  }
  const query = typeof args.query === 'string' ? args.query : ''
  return store.search({
    avatarId,
    query,
    maxSessions: num(args.limit),
    window: num(args.window),
    excludeConversationId: currentConversationId,
  })
}
