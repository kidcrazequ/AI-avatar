/**
 * Palace 路线卡匹配。
 */

import type { PalaceRoom } from './types'

export interface PalaceRoomMatch {
  room: PalaceRoom
  score: number
  reasons: string[]
}

export interface PalaceMatchOptions {
  limit?: number
  includeDisabled?: boolean
}

export function matchPalaceRooms(
  rooms: PalaceRoom[],
  task: string,
  options: PalaceMatchOptions = {},
): PalaceRoomMatch[] {
  const limit = Math.max(1, Math.min(20, Math.floor(options.limit ?? 5)))
  const query = normalize(task)
  if (!query) return []
  const terms = extractMatchTerms(query)
  const matches: PalaceRoomMatch[] = []

  for (const room of rooms) {
    if (!room.enabled && !options.includeDisabled) continue
    const reasons: string[] = []
    let score = 0

    for (const trigger of room.triggers) {
      const t = normalize(trigger)
      if (!t) continue
      if (query === t) {
        score += 120
        reasons.push(`触发词完全匹配: ${trigger}`)
      } else if (query.includes(t) || t.includes(query)) {
        score += 80
        reasons.push(`触发词命中: ${trigger}`)
      }
    }

    const name = normalize(room.name)
    if (name && (query.includes(name) || name.includes(query))) {
      score += 60
      reasons.push(`路线名匹配: ${room.name}`)
    }

    const description = normalize(room.description)
    const body = normalize(room.body)
    const supporting = normalize([
      room.requiredFiles.join(' '),
      room.readOrder.join(' '),
      room.conditionalReads.join(' '),
      room.pitfalls.join(' '),
      room.outputLocation,
      room.toneGuidance,
      room.sedimentTargets.join(' '),
    ].join(' '))

    let termHits = 0
    for (const term of terms) {
      if (name.includes(term)) {
        score += 12
        termHits += 1
      }
      if (description.includes(term)) {
        score += 8
        termHits += 1
      }
      if (supporting.includes(term)) {
        score += 5
        termHits += 1
      }
      if (body.includes(term)) {
        score += 3
        termHits += 1
      }
    }
    if (termHits > 0) reasons.push(`关键词命中 ${termHits} 次`)

    if (score > 0) {
      score += Math.max(0, room.priority) / 10
      matches.push({ room, score, reasons })
    }
  }

  matches.sort((a, b) => b.score - a.score || b.room.priority - a.room.priority || a.room.id.localeCompare(b.room.id))
  return matches.slice(0, limit)
}

export function extractMatchTerms(query: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const push = (term: string) => {
    const t = normalize(term)
    if (t.length < 2 || seen.has(t)) return
    seen.add(t)
    out.push(t)
  }

  for (const m of query.matchAll(/[a-z0-9_-]{2,}|[\u4e00-\u9fa5]{2,}/gi)) {
    push(m[0])
    if (/^[\u4e00-\u9fa5]+$/.test(m[0])) {
      for (let n = 2; n <= 3; n++) {
        for (let i = 0; i + n <= m[0].length; i++) push(m[0].slice(i, i + n))
      }
    }
  }
  return out
}

function normalize(value: string): string {
  return value.trim().toLowerCase()
}
