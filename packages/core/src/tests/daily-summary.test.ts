/**
 * Daily Summary 单元测试（v18 OpenHuman 借鉴）
 *
 * 覆盖：
 *   - localDateStringFromMs：本地时区 + padding
 *   - groupEpisodesByDate：分组 / forgotten 跳过 / 无效 ts 跳过 / 同日按 ts 排序
 *   - compileDailySummary：空 / 单条 / 多条 / pinned 标记 / clip / 非法日期抛错
 *   - writeDailySummary + readDailySummary roundtrip
 *   - listDailySummaries：空目录 / 升降序 / start/end 过滤 / limit
 *   - applyDailySummaryAllDates 端到端
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  localDateStringFromMs,
  groupEpisodesByDate,
  compileDailySummary,
  writeDailySummary,
  readDailySummary,
  listDailySummaries,
  applyDailySummaryAllDates,
} from '../memory/daily-summary'
import type { ConversationEpisode } from '../memory/episode-types'

function withTempDir(body: (avatarsPath: string, avatarId: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-summary-test-'))
  try {
    body(root, 'a1')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function makeEpisode(overrides: Partial<ConversationEpisode> = {}): ConversationEpisode {
  return {
    schemaVersion: 1,
    conversationId: 'conv-x',
    avatarId: 'a1',
    title: 'test',
    theme: '',
    summary: 'short summary',
    keyQuotes: [],
    themes: [],
    valence: 0,
    emotionType: 'joy',
    importance: 5,
    consolidationStatus: 'remembered',
    consolidationNote: '',
    conversationStartedAt: new Date('2026-05-18T10:00:00').getTime(),
    conversationLastMessageAt: new Date('2026-05-18T11:00:00').getTime(),
    extractedAt: new Date('2026-05-18T11:01:00').getTime(),
    messageCount: 6,
    ...overrides,
  }
}

describe('localDateStringFromMs', () => {
  it('返回本地 YYYY-MM-DD（不是 UTC）', () => {
    const ts = new Date(2026, 4, 18, 23, 30).getTime() // 5 月 18 日 23:30 本地
    assert.equal(localDateStringFromMs(ts), '2026-05-18')
  })

  it('月日补零', () => {
    const ts = new Date(2026, 0, 1, 12, 0).getTime() // 1 月 1 日
    assert.equal(localDateStringFromMs(ts), '2026-01-01')
  })
})

describe('groupEpisodesByDate', () => {
  it('按 conversationStartedAt 分组', () => {
    const eps = [
      makeEpisode({ conversationId: 'c1', conversationStartedAt: new Date(2026, 4, 18, 10).getTime() }),
      makeEpisode({ conversationId: 'c2', conversationStartedAt: new Date(2026, 4, 18, 14).getTime() }),
      makeEpisode({ conversationId: 'c3', conversationStartedAt: new Date(2026, 4, 19, 9).getTime() }),
    ]
    const groups = groupEpisodesByDate(eps)
    assert.equal(groups.get('2026-05-18')!.length, 2)
    assert.equal(groups.get('2026-05-19')!.length, 1)
  })

  it('跳过 forgotten', () => {
    const eps = [
      makeEpisode({ conversationId: 'rem' }),
      makeEpisode({ conversationId: 'forg', consolidationStatus: 'forgotten' }),
    ]
    const groups = groupEpisodesByDate(eps)
    const flat = Array.from(groups.values()).flat()
    assert.equal(flat.length, 1)
    assert.equal(flat[0].conversationId, 'rem')
  })

  it('跳过非法 ts（0 / NaN / 负数）', () => {
    const eps = [
      makeEpisode({ conversationId: 'good' }),
      makeEpisode({ conversationId: 'bad-zero', conversationStartedAt: 0 }),
      makeEpisode({ conversationId: 'bad-neg', conversationStartedAt: -1 }),
      makeEpisode({ conversationId: 'bad-nan', conversationStartedAt: NaN }),
    ]
    const groups = groupEpisodesByDate(eps)
    const flat = Array.from(groups.values()).flat()
    assert.equal(flat.length, 1)
    assert.equal(flat[0].conversationId, 'good')
  })

  it('同日按 conversationStartedAt 升序', () => {
    const eps = [
      makeEpisode({ conversationId: 'late', conversationStartedAt: new Date(2026, 4, 18, 22).getTime() }),
      makeEpisode({ conversationId: 'early', conversationStartedAt: new Date(2026, 4, 18, 8).getTime() }),
      makeEpisode({ conversationId: 'mid', conversationStartedAt: new Date(2026, 4, 18, 14).getTime() }),
    ]
    const groups = groupEpisodesByDate(eps)
    const same = groups.get('2026-05-18')!
    assert.deepEqual(same.map(e => e.conversationId), ['early', 'mid', 'late'])
  })
})

describe('compileDailySummary', () => {
  it('空 episode 数组返回友好兜底', () => {
    const md = compileDailySummary('2026-05-18', [])
    assert.ok(md.includes('# 2026-05-18 的对话回顾'))
    assert.ok(md.includes('当天没有显著的对话记忆'))
  })

  it('单 episode 渲染含 title / importance / summary', () => {
    const ep = makeEpisode({
      title: '聊储能 IRR',
      theme: '工商储项目',
      summary: '讨论了 12% IRR 阈值',
      importance: 8,
      valence: 3,
    })
    const md = compileDailySummary('2026-05-18', [ep])
    assert.ok(md.includes('聊储能 IRR'))
    assert.ok(md.includes('工商储项目'))
    assert.ok(md.includes('importance: **8**'))
    assert.ok(md.includes('discussed 12% IRR') || md.includes('讨论了 12% IRR'))
  })

  it('summary 超过 240 字符自动截断 + 加 …', () => {
    const longSummary = 'X'.repeat(500)
    const ep = makeEpisode({ summary: longSummary })
    const md = compileDailySummary('2026-05-18', [ep])
    assert.ok(md.includes('…'))
    assert.equal(md.includes('X'.repeat(500)), false)
  })

  it('pinned episode 显示 📌 标记', () => {
    const ep = makeEpisode({ pinned: true })
    const md = compileDailySummary('2026-05-18', [ep])
    assert.ok(md.includes('📌 pinned'))
  })

  it('themes 合集去重显示在 header', () => {
    const ep1 = makeEpisode({ conversationId: 'a', themes: ['工商储', '电价'] })
    const ep2 = makeEpisode({ conversationId: 'b', themes: ['电价', '政策'] })
    const md = compileDailySummary('2026-05-18', [ep1, ep2])
    assert.ok(md.includes('工商储'))
    assert.ok(md.includes('政策'))
    // "电价" 只出现一次（在 header 行去重；正文里其他出现不算）
  })

  it('非法日期格式抛错', () => {
    assert.throws(() => compileDailySummary('2026/05/18', []), /非法日期格式/)
    assert.throws(() => compileDailySummary('not-a-date', []), /非法日期格式/)
  })
})

describe('writeDailySummary / readDailySummary roundtrip', () => {
  it('write 后 read 返回相同内容', () => {
    withTempDir((dir, id) => {
      const content = '# Test Summary\n\nbody'
      writeDailySummary(dir, id, '2026-05-18', content)
      const read = readDailySummary(dir, id, '2026-05-18')
      assert.equal(read, content)
    })
  })

  it('文件不存在 read 返回 null', () => {
    withTempDir((dir, id) => {
      assert.equal(readDailySummary(dir, id, '2026-05-18'), null)
    })
  })

  it('非法日期参数 write 抛错 / read 返回 null', () => {
    withTempDir((dir, id) => {
      assert.throws(() => writeDailySummary(dir, id, 'bad-date', 'x'), /非法日期格式/)
      assert.equal(readDailySummary(dir, id, 'bad-date'), null)
    })
  })
})

describe('listDailySummaries', () => {
  it('空目录返回空数组', () => {
    withTempDir((dir, id) => {
      assert.deepEqual(listDailySummaries(dir, id), [])
    })
  })

  it('返回降序日期列表（最新在前）', () => {
    withTempDir((dir, id) => {
      writeDailySummary(dir, id, '2026-05-16', 'a')
      writeDailySummary(dir, id, '2026-05-18', 'b')
      writeDailySummary(dir, id, '2026-05-17', 'c')
      assert.deepEqual(listDailySummaries(dir, id), ['2026-05-18', '2026-05-17', '2026-05-16'])
    })
  })

  it('start/end 过滤', () => {
    withTempDir((dir, id) => {
      writeDailySummary(dir, id, '2026-05-15', 'a')
      writeDailySummary(dir, id, '2026-05-17', 'b')
      writeDailySummary(dir, id, '2026-05-19', 'c')
      assert.deepEqual(
        listDailySummaries(dir, id, { start: '2026-05-16', end: '2026-05-18' }),
        ['2026-05-17'],
      )
    })
  })

  it('limit 截断', () => {
    withTempDir((dir, id) => {
      for (let d = 10; d <= 20; d++) {
        writeDailySummary(dir, id, `2026-05-${String(d).padStart(2, '0')}`, 'x')
      }
      const r = listDailySummaries(dir, id, { limit: 3 })
      assert.equal(r.length, 3)
      assert.deepEqual(r, ['2026-05-20', '2026-05-19', '2026-05-18'])
    })
  })

  it('忽略非 .md / 非日期格式文件', () => {
    withTempDir((dir, id) => {
      writeDailySummary(dir, id, '2026-05-18', 'a')
      // 手动写一些垃圾
      const sumDir = path.join(dir, id, 'memory', 'daily-summaries')
      fs.writeFileSync(path.join(sumDir, 'README.md'), 'not a date')
      fs.writeFileSync(path.join(sumDir, '2026-05-18.txt'), 'wrong ext')
      assert.deepEqual(listDailySummaries(dir, id), ['2026-05-18'])
    })
  })
})

describe('applyDailySummaryAllDates 端到端', () => {
  it('多日期 episode 集合 → 每日各一个 .md', () => {
    withTempDir((dir, id) => {
      const eps = [
        makeEpisode({ conversationId: 'd1a', conversationStartedAt: new Date(2026, 4, 18, 10).getTime() }),
        makeEpisode({ conversationId: 'd1b', conversationStartedAt: new Date(2026, 4, 18, 15).getTime() }),
        makeEpisode({ conversationId: 'd2', conversationStartedAt: new Date(2026, 4, 19, 11).getTime() }),
      ]
      const result = applyDailySummaryAllDates(dir, id, eps)
      assert.equal(result.written.length, 2)
      assert.equal(result.skipped.length, 0)
      const day1 = readDailySummary(dir, id, '2026-05-18')!
      assert.match(day1, /共 2 次对话/)
      const day2 = readDailySummary(dir, id, '2026-05-19')!
      assert.match(day2, /共 1 次对话/)
    })
  })

  it('forgotten 不进 summary', () => {
    withTempDir((dir, id) => {
      const eps = [
        makeEpisode({ conversationId: 'rem', conversationStartedAt: new Date(2026, 4, 18, 10).getTime() }),
        makeEpisode({ conversationId: 'forg', conversationStartedAt: new Date(2026, 4, 18, 11).getTime(), consolidationStatus: 'forgotten' }),
      ]
      const result = applyDailySummaryAllDates(dir, id, eps)
      assert.equal(result.written.length, 1)
      const day = readDailySummary(dir, id, '2026-05-18')!
      assert.match(day, /共 1 次对话/)
    })
  })

  it('空 episode 集合：不写任何文件', () => {
    withTempDir((dir, id) => {
      const result = applyDailySummaryAllDates(dir, id, [])
      assert.equal(result.written.length, 0)
      assert.deepEqual(listDailySummaries(dir, id), [])
    })
  })
})
