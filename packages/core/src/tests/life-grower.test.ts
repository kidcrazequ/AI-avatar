/**
 * `life/grower` 单元测试。
 *
 * 覆盖：
 *   - 时间换算 computeAvatarDeltaMonths（1× / 12× / 52× / 0× / 时钟回拨）
 *   - 事件密度抽样 samplePendingMonths（确定性 random + 边界）
 *   - reconsolidate 阈值 shouldReconsolidate（+5 episodes / +30 天 / 都不满足）
 *   - 边界跳过（timeScale=0 / growthEnabled=false / generationStatus='generating' /
 *     sub-month-delta / 内存锁）
 *   - LLM 失败：重试 1 次仍失败 → progress.failedEpisodes，timeline 无孤儿
 *   - reconsolidate 实际触发：写 consolidated.md + 更新 manifest
 *   - 多分身遍历：单分身错误不影响其他
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  advanceLife,
  advanceAllAvatars,
  computeAvatarDeltaMonths,
  samplePendingMonths,
  shouldReconsolidate,
  __clearGrowthLocksForTesting,
} from '../life/grower'
import { DEFAULT_DENSITY_WEIGHTS } from '../life/density'
import {
  ensureLifeDir,
  readLifeConsolidated,
  readLifeManifest,
  readLifeProgress,
  readLifeTimeline,
  writeLifeManifest,
  writeLifeProgress,
  writeLifeTimeline,
  writeLifeConsolidated,
} from '../life/store'
import type { LifeManifest, LifeProgress, LifeTimelineEntry } from '../life/types'

// ─── 时间换算 ───────────────────────────────────────────────────────────────

describe('computeAvatarDeltaMonths', () => {
  // 真实时间锚点：2026-01-01 00:00:00Z
  const ANCHOR = '2026-01-01T00:00:00.000Z'
  const ANCHOR_DATE = new Date(ANCHOR)

  it('timeScale=1：真实 1 个月 → 分身 1 个月', () => {
    const now = new Date(ANCHOR_DATE.getTime() + 30.5 * 24 * 60 * 60 * 1000)
    const delta = computeAvatarDeltaMonths(now, ANCHOR, 1)
    assert.ok(delta >= 1 && delta <= 1, `1× 30 天 → 1 月, 实际 ${delta}`)
  })

  it('timeScale=12：真实 1 个月 → 分身 12 个月', () => {
    const now = new Date(ANCHOR_DATE.getTime() + 30.5 * 24 * 60 * 60 * 1000)
    const delta = computeAvatarDeltaMonths(now, ANCHOR, 12)
    assert.ok(delta >= 11 && delta <= 13, `12× 30 天 → 12 月, 实际 ${delta}`)
  })

  it('timeScale=52：真实 1 周 → 分身 12 个月', () => {
    const now = new Date(ANCHOR_DATE.getTime() + 7 * 24 * 60 * 60 * 1000)
    const delta = computeAvatarDeltaMonths(now, ANCHOR, 52)
    assert.ok(delta >= 11 && delta <= 13, `52× 7 天 → 12 月, 实际 ${delta}`)
  })

  it('timeScale=0：始终返回 0（冻结）', () => {
    const now = new Date(ANCHOR_DATE.getTime() + 365 * 24 * 60 * 60 * 1000)
    assert.equal(computeAvatarDeltaMonths(now, ANCHOR, 0), 0)
  })

  it('系统时钟回拨（now < lastAdvancedAt）→ 返回 0', () => {
    const now = new Date(ANCHOR_DATE.getTime() - 24 * 60 * 60 * 1000)
    assert.equal(computeAvatarDeltaMonths(now, ANCHOR, 1), 0)
  })

  it('lastAdvancedAt 解析失败 → 返回 0（避免阻塞）', () => {
    assert.equal(computeAvatarDeltaMonths(ANCHOR_DATE, 'not-a-date', 1), 0)
  })

  it('不到 1 个月（亚月）→ 返回 0', () => {
    const now = new Date(ANCHOR_DATE.getTime() + 10 * 24 * 60 * 60 * 1000)
    assert.equal(computeAvatarDeltaMonths(now, ANCHOR, 1), 0)
  })

  it('负 timeScale 当作 0 处理', () => {
    const now = new Date(ANCHOR_DATE.getTime() + 365 * 24 * 60 * 60 * 1000)
    assert.equal(computeAvatarDeltaMonths(now, ANCHOR, -1), 0)
  })
})

// ─── samplePendingMonths ────────────────────────────────────────────────────

describe('samplePendingMonths', () => {
  it('确定性 random=0：所有月份都触发（< 任何概率）', () => {
    const months = samplePendingMonths(0, 12, () => 0)
    assert.equal(months.length, 12)
    assert.deepEqual(months.slice(0, 3), [0, 1, 2])
  })

  it('确定性 random=0.99：没有月份触发（> 0.30）', () => {
    const months = samplePendingMonths(0, 12, () => 0.99)
    assert.equal(months.length, 0)
  })

  it('random=0.20：年轻段（0.30）触发，中年段（0.15）不触发', () => {
    // 跨度 24 月年轻段 vs 12 月中年段（避开 MAX_NEW_EPISODES_PER_ADVANCE=60 上限）
    const youngOnly = samplePendingMonths(0, 24, () => 0.20)
    assert.equal(youngOnly.length, 24, '年轻段（24 月）全部触发')
    const middleOnly = samplePendingMonths(300, 312, () => 0.20)
    assert.equal(middleOnly.length, 0, '中年段不触发（0.20 > 0.15）')
  })

  it('终止月 <= 起始月 → 返回空数组', () => {
    assert.equal(samplePendingMonths(120, 120, () => 0).length, 0)
    assert.equal(samplePendingMonths(120, 100, () => 0).length, 0)
  })

  it('上限保护：单次最多生成 60 个事件', () => {
    // 跨度 120 月 + random=0 全部触发，但被 MAX_NEW_EPISODES_PER_ADVANCE=60 截断
    const months = samplePendingMonths(0, 120, () => 0)
    assert.equal(months.length, 60)
  })

  it('自定义密度权重生效', () => {
    // 把所有概率都设为 0 → 0.20 random 时全部不触发
    const months = samplePendingMonths(0, 12, () => 0.20, {
      ...DEFAULT_DENSITY_WEIGHTS,
      youngProbability: 0.0,
    })
    assert.equal(months.length, 0)
  })
})

// ─── shouldReconsolidate ────────────────────────────────────────────────────

describe('shouldReconsolidate', () => {
  const NOW = new Date('2026-05-09T00:00:00.000Z')

  it('新增 5 个 episodes → 触发', () => {
    assert.equal(
      shouldReconsolidate(85, 80, NOW.toISOString(), NOW),
      true,
    )
  })

  it('新增 4 个 episodes 且未到 30 天 → 不触发', () => {
    const lastConsolidatedAt = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString()
    assert.equal(
      shouldReconsolidate(84, 80, lastConsolidatedAt, NOW),
      false,
    )
  })

  it('新增 0 个 episodes 但距上次 reconsolidate >= 30 天 → 触发', () => {
    const lastConsolidatedAt = new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1000).toISOString()
    assert.equal(
      shouldReconsolidate(80, 80, lastConsolidatedAt, NOW),
      true,
    )
  })

  it('lastConsolidatedAt 解析失败 → 触发（保守，确保有 consolidated.md）', () => {
    assert.equal(
      shouldReconsolidate(80, 80, '', NOW),
      true,
    )
  })

  it('自定义阈值（episodeThreshold=10）', () => {
    assert.equal(
      shouldReconsolidate(85, 80, NOW.toISOString(), NOW, {
        episodeThreshold: 10,
        daysThreshold: 365,
      }),
      false,
    )
    assert.equal(
      shouldReconsolidate(91, 80, NOW.toISOString(), NOW, {
        episodeThreshold: 10,
        daysThreshold: 365,
      }),
      true,
    )
  })
})

// ─── advanceLife（集成测试，落盘） ──────────────────────────────────────────

describe('advanceLife - 集成', () => {
  let tmpRoot: string
  const AVATAR = 'test-avatar'
  const FIXED_NOW = new Date('2026-06-09T03:00:00Z')

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-life-grower-test-'))
  })

  after(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  beforeEach(async () => {
    __clearGrowthLocksForTesting()
    const caseDir = fs.mkdtempSync(path.join(tmpRoot, 'case-'))
    fs.mkdirSync(path.join(caseDir, AVATAR), { recursive: true })
    tmpRoot = caseDir
    await ensureLifeDir(tmpRoot, AVATAR)
  })

  function makeManifest(overrides: Partial<LifeManifest> = {}): LifeManifest {
    return {
      schemaVersion: 1,
      personaName: '陈默',
      birthYear: 1991,
      birthMonth: 8,
      birthDay: 15,
      initialAge: 35,
      initialAgeBornAt: '2026-05-09T00:00:00.000Z',
      timeScale: 1,
      lastAdvancedAt: '2026-05-09T00:00:00.000Z',
      currentAgeMonths: 420, // 35 岁
      growthEnabled: true,
      gender: '男',
      birthplace: '湖北十堰',
      familyBackground: '父亲是机械厂工程师，母亲是中学教师。家里堆满旧报纸和拆开一半的收音机。',
      personalityArc: [{ age: 7, shift: '从胆小转向好奇' }],
      professionalSpine: [{ age: 12, milestone: '第一次拆收音机' }],
      majorRelationships: [
        { role: '祖父', name: '陈守诚', description: '退休铁路工人' },
      ],
      createdAt: '2026-05-09',
      totalEpisodes: 80,
      totalChars: 240000,
      generationStatus: 'complete',
      lastConsolidatedAt: '2026-05-09T00:00:00.000Z',
      consolidationCounter: 1,
      ...overrides,
    }
  }

  function makeProgress(overrides: Partial<LifeProgress> = {}): LifeProgress {
    return {
      stage: 'complete',
      completedEpisodes: 80,
      totalEpisodes: 80,
      usedFallback: false,
      lastError: '',
      updatedAt: '2026-05-09T00:00:00.000Z',
      failedEpisodes: [],
      consolidationLastTotalEpisodes: 80,
      ...overrides,
    }
  }

  function makeTimelineEntry(seq: number, age: number): LifeTimelineEntry {
    return {
      id: `ep-${seq.toString().padStart(4, '0')}-existing${seq}`,
      age,
      year: 1991 + age,
      month: 6,
      title: `已有事件${seq}`,
      summary: '一句话',
      category: 'daily',
      themes: ['日常'],
      importance: 5,
      emotion: 5,
      emotionType: 'wonder',
      wordCount: 3000,
      consolidationStatus: 'remembered',
      consolidationNote: '',
    }
  }

  /** mock LLM：返回合法的 outline 数组 + episode 正文 + consolidated 正文 */
  function makeMockLLMs(opts: { failOutline?: boolean; failEpisode?: boolean } = {}) {
    let outlineCalls = 0
    let episodeCalls = 0
    let consolidateCalls = 0

    const callLLM = async (system: string, _user: string, _max?: number): Promise<string> => {
      if (system.includes('人生编剧')) {
        outlineCalls += 1
        if (opts.failOutline) throw new Error('mock outline 故意失败')
        return JSON.stringify([
          {
            age: 35,
            year: 2026,
            month: 6,
            title: '夏夜的设计稿',
            summary: '深夜独自完成第一稿设计',
            category: 'professional',
            themes: ['专业', '夜晚'],
            importance: 7,
            emotion: 6,
            emotionType: 'wonder',
          },
        ])
      }
      if (system.includes('传记作者')) {
        episodeCalls += 1
        if (opts.failEpisode) throw new Error('mock episode 故意失败')
        return '那是夏夜，台灯昏黄。我盯着设计稿。'.repeat(40)
      }
      if (system.includes('深夜独白')) {
        consolidateCalls += 1
        return '## 主题一\n回忆。\n\n## 主题二\n更多回忆。'
      }
      throw new Error(`mock LLM 未识别 prompt: ${system.slice(0, 40)}`)
    }
    return {
      llms: { creationLLM: callLLM, chatLLM: callLLM, creationConfigured: true },
      counters: () => ({ outlineCalls, episodeCalls, consolidateCalls }),
    }
  }

  // ─── 跳过分支（边界处理，全部必测） ────────────────────────────────────

  it('manifest 不存在 → skipReason=no-manifest', async () => {
    const { llms } = makeMockLLMs()
    const r = await advanceLife({
      avatarsRoot: tmpRoot,
      avatarId: AVATAR,
      llms,
      now: () => FIXED_NOW,
      random: () => 0.99,
    })
    assert.equal(r.advanced, false)
    assert.equal(r.skipReason, 'no-manifest')
  })

  it('growthEnabled=false → skipReason=growth-disabled', async () => {
    await writeLifeManifest(tmpRoot, AVATAR, makeManifest({ growthEnabled: false }))
    const { llms, counters } = makeMockLLMs()
    const r = await advanceLife({
      avatarsRoot: tmpRoot,
      avatarId: AVATAR,
      llms,
      now: () => FIXED_NOW,
      random: () => 0,
    })
    assert.equal(r.advanced, false)
    assert.equal(r.skipReason, 'growth-disabled')
    assert.equal(counters().outlineCalls, 0, '应当不调 LLM')
  })

  it('timeScale=0 → skipReason=time-frozen', async () => {
    await writeLifeManifest(tmpRoot, AVATAR, makeManifest({ timeScale: 0 }))
    const { llms } = makeMockLLMs()
    const r = await advanceLife({
      avatarsRoot: tmpRoot,
      avatarId: AVATAR,
      llms,
      now: () => FIXED_NOW,
      random: () => 0,
    })
    assert.equal(r.advanced, false)
    assert.equal(r.skipReason, 'time-frozen')
  })

  it('generationStatus=generating → skipReason=generation-in-progress', async () => {
    await writeLifeManifest(
      tmpRoot,
      AVATAR,
      makeManifest({ generationStatus: 'generating' }),
    )
    const { llms } = makeMockLLMs()
    const r = await advanceLife({
      avatarsRoot: tmpRoot,
      avatarId: AVATAR,
      llms,
      now: () => FIXED_NOW,
      random: () => 0,
    })
    assert.equal(r.advanced, false)
    assert.equal(r.skipReason, 'generation-in-progress')
  })

  it('avatarDeltaMonths < 1（亚月）→ skipReason=sub-month-delta', async () => {
    // lastAdvancedAt 是 5 天前，timeScale=1 → 0 个月
    const recent = new Date(FIXED_NOW.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString()
    await writeLifeManifest(tmpRoot, AVATAR, makeManifest({ lastAdvancedAt: recent }))
    const { llms } = makeMockLLMs()
    const r = await advanceLife({
      avatarsRoot: tmpRoot,
      avatarId: AVATAR,
      llms,
      now: () => FIXED_NOW,
      random: () => 0,
    })
    assert.equal(r.advanced, false)
    assert.equal(r.skipReason, 'sub-month-delta')
  })

  // ─── 正常推进 ───────────────────────────────────────────────────────────

  it('正常推进：1 个月 + random=0 → 触发 1 个事件', async () => {
    // 31 天前推进
    const oneMonthAgo = new Date(FIXED_NOW.getTime() - 31 * 24 * 60 * 60 * 1000).toISOString()
    await writeLifeManifest(
      tmpRoot,
      AVATAR,
      makeManifest({ lastAdvancedAt: oneMonthAgo, currentAgeMonths: 240 }), // 20 岁，年轻段
    )
    await writeLifeTimeline(tmpRoot, AVATAR, [makeTimelineEntry(1, 19)])
    await writeLifeProgress(tmpRoot, AVATAR, makeProgress({
      consolidationLastTotalEpisodes: 1,
      totalEpisodes: 1,
      completedEpisodes: 1,
    }))
    const { llms, counters } = makeMockLLMs()
    const r = await advanceLife({
      avatarsRoot: tmpRoot,
      avatarId: AVATAR,
      llms,
      now: () => FIXED_NOW,
      random: () => 0,
    })
    assert.equal(r.advanced, true)
    assert.equal(r.avatarDeltaMonths, 1)
    assert.equal(r.newEpisodes, 1)
    assert.equal(r.failedEpisodes, 0)
    const c = counters()
    assert.equal(c.outlineCalls, 1)
    assert.equal(c.episodeCalls, 1)

    // 落盘验证
    const tl = await readLifeTimeline(tmpRoot, AVATAR)
    assert.equal(tl.length, 2, 'timeline 应有 1 个原 entry + 1 个新 entry')
    assert.ok(tl.some(e => e.title === '夏夜的设计稿'))

    const updated = await readLifeManifest(tmpRoot, AVATAR)
    assert.ok(updated)
    assert.equal(updated.currentAgeMonths, 241)
    assert.equal(updated.totalEpisodes, 81)
    assert.equal(updated.generationStatus, 'growing')
    assert.equal(updated.lastAdvancedAt, FIXED_NOW.toISOString())
  })

  // ─── LLM 失败 ──────────────────────────────────────────────────────────

  it('outline LLM 失败：重试 1 次仍失败 → 计入 failedEpisodes，timeline 无孤儿', async () => {
    const oneMonthAgo = new Date(FIXED_NOW.getTime() - 31 * 24 * 60 * 60 * 1000).toISOString()
    await writeLifeManifest(
      tmpRoot,
      AVATAR,
      makeManifest({ lastAdvancedAt: oneMonthAgo, currentAgeMonths: 240, totalEpisodes: 0 }),
    )
    await writeLifeTimeline(tmpRoot, AVATAR, [])
    await writeLifeProgress(tmpRoot, AVATAR, makeProgress({
      totalEpisodes: 0, completedEpisodes: 0, consolidationLastTotalEpisodes: 0,
    }))

    const { llms } = makeMockLLMs({ failOutline: true })
    const r = await advanceLife({
      avatarsRoot: tmpRoot,
      avatarId: AVATAR,
      llms,
      now: () => FIXED_NOW,
      random: () => 0,
    })
    assert.equal(r.advanced, true, 'manifest 仍然要更新（推进时间）')
    assert.equal(r.newEpisodes, 0)
    assert.equal(r.failedEpisodes, 1)

    const progress = await readLifeProgress(tmpRoot, AVATAR)
    assert.ok(progress)
    assert.equal(progress.failedEpisodes.length, 1)
    assert.ok(progress.lastError.includes('outline'), `lastError 应含 outline 错误：${progress.lastError}`)

    const tl = await readLifeTimeline(tmpRoot, AVATAR)
    assert.equal(tl.length, 0, 'outline 失败时不应在 timeline 留孤儿')
  })

  it('episode 写盘 LLM 失败：回滚 timeline 条目（不留孤儿）', async () => {
    const oneMonthAgo = new Date(FIXED_NOW.getTime() - 31 * 24 * 60 * 60 * 1000).toISOString()
    await writeLifeManifest(
      tmpRoot,
      AVATAR,
      makeManifest({ lastAdvancedAt: oneMonthAgo, currentAgeMonths: 240, totalEpisodes: 0 }),
    )
    await writeLifeTimeline(tmpRoot, AVATAR, [])

    const { llms } = makeMockLLMs({ failEpisode: true })
    const r = await advanceLife({
      avatarsRoot: tmpRoot,
      avatarId: AVATAR,
      llms,
      now: () => FIXED_NOW,
      random: () => 0,
    })
    assert.equal(r.failedEpisodes, 1)
    const tl = await readLifeTimeline(tmpRoot, AVATAR)
    assert.equal(tl.length, 0, 'episode 失败时 timeline 应回滚（无孤儿）')
  })

  // ─── reconsolidate 实际触发 ────────────────────────────────────────────

  it('新增 episodes 达阈值 → 触发 reconsolidate（写 consolidated.md + 更新 manifest）', async () => {
    // currentAgeMonths=24 (2 岁，年轻段) + lastAdvancedAt 6 个月前 → delta=6
    // random=0 → 6 个事件全部触发，达 episodeThreshold=5
    const sixMonthsAgo = new Date(FIXED_NOW.getTime() - 6 * 31 * 24 * 60 * 60 * 1000).toISOString()
    await writeLifeManifest(
      tmpRoot,
      AVATAR,
      makeManifest({
        lastAdvancedAt: sixMonthsAgo,
        currentAgeMonths: 24,
        totalEpisodes: 0,
        lastConsolidatedAt: FIXED_NOW.toISOString(), // 距今 0 天，避免按天数触发
      }),
    )
    await writeLifeTimeline(tmpRoot, AVATAR, [])
    await writeLifeProgress(tmpRoot, AVATAR, makeProgress({
      totalEpisodes: 0, completedEpisodes: 0, consolidationLastTotalEpisodes: 0,
    }))
    await writeLifeConsolidated(tmpRoot, AVATAR, '# 旧的 consolidated\n旧内容')

    const { llms, counters } = makeMockLLMs()
    const r = await advanceLife({
      avatarsRoot: tmpRoot,
      avatarId: AVATAR,
      llms,
      now: () => FIXED_NOW,
      random: () => 0, // 全部触发
    })
    assert.equal(r.advanced, true)
    assert.ok(r.newEpisodes >= 5, `应至少 5 个新事件，实际 ${r.newEpisodes}`)
    assert.equal(r.reconsolidated, true)

    const c = counters()
    assert.equal(c.consolidateCalls, 1, '应该调用 1 次 consolidate LLM')

    const consolidated = await readLifeConsolidated(tmpRoot, AVATAR)
    assert.ok(consolidated.includes('## 主题一'), `新 consolidated 应有内容：${consolidated.slice(0, 100)}`)
    assert.ok(!consolidated.includes('旧内容'), '旧 consolidated 应被覆盖')

    const updated = await readLifeManifest(tmpRoot, AVATAR)
    assert.ok(updated)
    assert.equal(updated.consolidationCounter, 2, 'consolidationCounter 应 +1')
    assert.equal(updated.lastConsolidatedAt, FIXED_NOW.toISOString())
  })

  it('新增 episodes 未达阈值 → 不触发 reconsolidate', async () => {
    // 1 个月 + 年轻段 → 1 个事件，不到 5
    const oneMonthAgo = new Date(FIXED_NOW.getTime() - 31 * 24 * 60 * 60 * 1000).toISOString()
    await writeLifeManifest(
      tmpRoot,
      AVATAR,
      makeManifest({
        lastAdvancedAt: oneMonthAgo,
        currentAgeMonths: 240,
        totalEpisodes: 80,
        lastConsolidatedAt: FIXED_NOW.toISOString(),
      }),
    )
    await writeLifeTimeline(tmpRoot, AVATAR, [makeTimelineEntry(1, 19)])
    await writeLifeProgress(tmpRoot, AVATAR, makeProgress({
      totalEpisodes: 80, completedEpisodes: 80, consolidationLastTotalEpisodes: 80,
    }))

    const { llms, counters } = makeMockLLMs()
    const r = await advanceLife({
      avatarsRoot: tmpRoot,
      avatarId: AVATAR,
      llms,
      now: () => FIXED_NOW,
      random: () => 0,
    })
    assert.equal(r.advanced, true)
    assert.equal(r.reconsolidated, false)
    assert.equal(counters().consolidateCalls, 0)
  })

  // ─── advanceAllAvatars 多分身 ─────────────────────────────────────────

  it('advanceAllAvatars 单分身错误不影响其他分身', async () => {
    const A = 'avatar-a'
    const B = 'avatar-b' // 故意不创建 manifest，模拟 no-manifest
    fs.mkdirSync(path.join(tmpRoot, A), { recursive: true })
    fs.mkdirSync(path.join(tmpRoot, B), { recursive: true })
    await ensureLifeDir(tmpRoot, A)
    await ensureLifeDir(tmpRoot, B)
    const oneMonthAgo = new Date(FIXED_NOW.getTime() - 31 * 24 * 60 * 60 * 1000).toISOString()
    await writeLifeManifest(
      tmpRoot,
      A,
      makeManifest({ lastAdvancedAt: oneMonthAgo, currentAgeMonths: 240, totalEpisodes: 0 }),
    )
    await writeLifeTimeline(tmpRoot, A, [])

    const { llms } = makeMockLLMs()
    const summary = await advanceAllAvatars({
      avatarsRoot: tmpRoot,
      avatarIds: [A, B],
      llms,
      now: () => FIXED_NOW,
      random: () => 0,
    })
    assert.equal(summary.total, 2)
    assert.equal(summary.advanced, 1)
    assert.equal(summary.skipped, 1)
    assert.equal(summary.failed, 0)
    const detailB = summary.details.find(d => d.avatarId === B)
    assert.ok(detailB)
    assert.equal(detailB.result?.skipReason, 'no-manifest')
  })

  // ─── 内存锁 ────────────────────────────────────────────────────────────

  it('并发调用 advanceLife 时第二个返回 skipReason=locked', async () => {
    // 先用 1 个月数据写 manifest
    const oneMonthAgo = new Date(FIXED_NOW.getTime() - 31 * 24 * 60 * 60 * 1000).toISOString()
    await writeLifeManifest(
      tmpRoot,
      AVATAR,
      makeManifest({ lastAdvancedAt: oneMonthAgo, currentAgeMonths: 240, totalEpisodes: 0 }),
    )
    await writeLifeTimeline(tmpRoot, AVATAR, [])

    // 让 LLM 等一拍才返回（模拟长时间 LLM call）
    let resolveOutline: (v: string) => void = () => {}
    const slowOutlinePromise = new Promise<string>((res) => { resolveOutline = res })
    const callLLM = async (system: string): Promise<string> => {
      if (system.includes('人生编剧')) return slowOutlinePromise
      if (system.includes('传记作者')) return '正文。'.repeat(50)
      if (system.includes('深夜独白')) return '## 主题\n内容。'
      throw new Error('未识别 prompt')
    }
    const llms = { creationLLM: callLLM, chatLLM: callLLM, creationConfigured: true }

    const first = advanceLife({
      avatarsRoot: tmpRoot,
      avatarId: AVATAR,
      llms,
      now: () => FIXED_NOW,
      random: () => 0,
    })
    // 等一个 microtask，确保 first 已 acquireGrowthLock
    await Promise.resolve()
    await Promise.resolve()

    const second = await advanceLife({
      avatarsRoot: tmpRoot,
      avatarId: AVATAR,
      llms,
      now: () => FIXED_NOW,
      random: () => 0,
    })
    assert.equal(second.advanced, false)
    assert.equal(second.skipReason, 'locked')

    // 解开 first，让它收尾，避免悬挂
    resolveOutline(JSON.stringify([
      {
        age: 20, year: 2011, month: 6, title: 'X', summary: 'Y',
        category: 'daily', themes: [], importance: 5, emotion: 5, emotionType: 'wonder',
      },
    ]))
    await first
  })
})
