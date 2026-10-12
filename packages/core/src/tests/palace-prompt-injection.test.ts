/**
 * Palace 确定性注入测试。
 *
 * 为什么这些行为重要：
 * - 零注入必须是严格空串——空 palace 分身不为此付出任何 token / cache 失效成本。
 * - 摘要截断上限守护 system prompt 预算，防止用户长画像挤占上下文。
 * - 承诺提醒 ≤3 条 + 溢出提示，保证提醒确定生效但不淹没 soul 人格。
 * - 日期比较基于本地日期字符串（localDateString），杜绝 UTC 漂移误报逾期。
 */

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  PALACE_DUE_REMINDER_MAX_ITEMS,
  PALACE_PROFILE_SUMMARY_MAX_CHARS,
  PALACE_SCHEMA_VERSION,
  buildDefaultPalaceProfile,
  buildPalacePromptInjection,
  getPalaceCommitmentsPath,
  hasSubstantivePalaceProfile,
  loadPalacePromptInjection,
  localDateString,
  writePalaceCommitments,
  writePalaceProfile,
  type PalaceCommitment,
} from '../index'

const AVATAR_ID = 'test-avatar'
const TODAY = '2026-07-06'
const YESTERDAY = '2026-07-05'
const TOMORROW = '2026-07-07'

function commitment(input: Partial<PalaceCommitment> & { id: string }): PalaceCommitment {
  return {
    direction: 'i_owe_them',
    title: `承诺-${input.id}`,
    counterparty: '张三',
    promise: '交付材料',
    status: 'open',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...input,
  }
}

describe('palace-prompt-injection: 纯函数', () => {
  it('空 profile + 无承诺 → 严格零注入（空串，不占 token）', () => {
    assert.equal(buildPalacePromptInjection({ profile: '', commitments: [], today: TODAY }), '')
  })

  it('空模板骨架不算实质内容 → 零注入', () => {
    const skeleton = buildDefaultPalaceProfile()
    assert.equal(hasSubstantivePalaceProfile(skeleton), false)
    // 追加空行/空白也不改变判定
    assert.equal(hasSubstantivePalaceProfile(`${skeleton}\n\n   \n`), false)
    assert.equal(buildPalacePromptInjection({ profile: skeleton, commitments: [], today: TODAY }), '')
  })

  it('骨架下填了真实内容 → 算实质内容并注入画像段', () => {
    const profile = `${buildDefaultPalaceProfile()}\n资深储能产品经理，负责工商储方案。`
    assert.equal(hasSubstantivePalaceProfile(profile), true)
    const out = buildPalacePromptInjection({ profile, commitments: [], today: TODAY })
    assert.ok(out.startsWith('## 职场画像（摘要）'))
    assert.ok(out.includes('资深储能产品经理'))
    assert.ok(!out.includes('已截断'), '未超限不得出现截断标注')
    assert.ok(!out.includes('今日承诺提醒'), '无到期承诺时不得出现提醒段')
  })

  it('画像超过上限 → 截断到 N 字符并标注', () => {
    const long = 'A'.repeat(PALACE_PROFILE_SUMMARY_MAX_CHARS + 100)
    const out = buildPalacePromptInjection({ profile: long, commitments: [], today: TODAY })
    assert.ok(out.includes('A'.repeat(PALACE_PROFILE_SUMMARY_MAX_CHARS)))
    assert.ok(!out.includes('A'.repeat(PALACE_PROFILE_SUMMARY_MAX_CHARS + 1)), '正文不得超过截断上限')
    assert.ok(out.includes('（画像已截断，完整内容见「职场」面板档案页）'))
  })

  it('逾期判定：昨天→已逾期、今天→今日到期、明天→不注入', () => {
    const out = buildPalacePromptInjection({
      profile: '',
      commitments: [
        commitment({ id: 'c-yesterday', title: '昨天的债', dueAt: YESTERDAY }),
        commitment({ id: 'c-today', title: '今天的账', dueAt: TODAY }),
        commitment({ id: 'c-tomorrow', title: '明天的事', dueAt: TOMORROW }),
      ],
      today: TODAY,
    })
    assert.ok(out.startsWith('## 今日承诺提醒'))
    assert.ok(out.includes(`【已逾期（原到期 ${YESTERDAY}）】昨天的债`))
    assert.ok(out.includes('【今日到期】今天的账'))
    assert.ok(!out.includes('明天的事'), '未到期承诺不得提前打扰')
  })

  it('非 open 状态（proposed/blocked/done/dropped）与无 dueAt 的不进提醒', () => {
    const out = buildPalacePromptInjection({
      profile: '',
      commitments: [
        commitment({ id: 'c-proposed', status: 'proposed', dueAt: YESTERDAY }),
        commitment({ id: 'c-blocked', status: 'blocked', dueAt: YESTERDAY }),
        commitment({ id: 'c-done', status: 'done', dueAt: YESTERDAY }),
        commitment({ id: 'c-dropped', status: 'dropped', dueAt: YESTERDAY }),
        commitment({ id: 'c-nodue', status: 'open' }),
      ],
      today: TODAY,
    })
    assert.equal(out, '', '两段皆不满足时必须回到严格零注入')
  })

  it('到期承诺最多 3 条（最早到期在前）+ 溢出提示', () => {
    const out = buildPalacePromptInjection({
      profile: '',
      commitments: [
        commitment({ id: 'c1', title: '第一件', dueAt: '2026-07-01' }),
        commitment({ id: 'c2', title: '第二件', dueAt: '2026-07-02' }),
        commitment({ id: 'c3', title: '第三件', dueAt: '2026-07-03' }),
        commitment({ id: 'c4', title: '第四件', dueAt: '2026-07-04' }),
        commitment({ id: 'c5', title: '第五件', dueAt: TODAY }),
      ],
      today: TODAY,
    })
    const itemLines = out.split('\n').filter(line => line.startsWith('- 【'))
    assert.equal(itemLines.length, PALACE_DUE_REMINDER_MAX_ITEMS)
    assert.ok(out.includes('第一件') && out.includes('第二件') && out.includes('第三件'))
    assert.ok(!out.includes('第四件') && !out.includes('第五件'))
    assert.ok(out.includes('另有 2 条逾期/今日到期承诺，见「职场」面板'))
  })
})

describe('palace-prompt-injection: 同步装载（soul-loader 链路）', () => {
  let suiteRoot = ''
  let avatarsRoot = ''

  before(() => {
    suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-palace-inject-test-'))
  })

  after(() => {
    fs.rmSync(suiteRoot, { recursive: true, force: true })
  })

  beforeEach(() => {
    avatarsRoot = fs.mkdtempSync(path.join(suiteRoot, 'case-'))
    fs.mkdirSync(path.join(avatarsRoot, AVATAR_ID), { recursive: true })
  })

  it('palace 目录不存在 → 零注入', () => {
    assert.equal(loadPalacePromptInjection(avatarsRoot, AVATAR_ID), '')
  })

  it('只有 profile 实质内容 → 只注入画像段', async () => {
    await writePalaceProfile(avatarsRoot, AVATAR_ID, '# Profile\n\n负责华东区工商储售前方案。')
    const out = loadPalacePromptInjection(avatarsRoot, AVATAR_ID)
    assert.ok(out.startsWith('## 职场画像（摘要）'))
    assert.ok(out.includes('负责华东区工商储售前方案'))
    assert.ok(!out.includes('今日承诺提醒'))
  })

  it('逾期承诺（真实本地日期）→ 注入提醒段；日期判定走 localDateString', async () => {
    const yesterday = localDateString(new Date(Date.now() - 24 * 60 * 60 * 1000))
    await writePalaceCommitments(avatarsRoot, AVATAR_ID, {
      schemaVersion: PALACE_SCHEMA_VERSION,
      commitments: [commitment({ id: 'c-real', title: '给李四回评审意见', dueAt: yesterday })],
    })
    const out = loadPalacePromptInjection(avatarsRoot, AVATAR_ID)
    assert.ok(out.includes('## 今日承诺提醒'))
    assert.ok(out.includes(`【已逾期（原到期 ${yesterday}）】给李四回评审意见`))
    // ensurePalaceWorkspace 落的默认 profile 是空模板骨架，不得混入画像段
    assert.ok(!out.includes('职场画像'))
  })

  it('commitments.json 损坏 → 承诺段降级为零注入，不阻断装配', async () => {
    await writePalaceProfile(avatarsRoot, AVATAR_ID, '# Profile\n\n有实质内容。')
    fs.writeFileSync(getPalaceCommitmentsPath(avatarsRoot, AVATAR_ID), '{oops', 'utf-8')
    const out = loadPalacePromptInjection(avatarsRoot, AVATAR_ID)
    assert.ok(out.includes('职场画像'))
    assert.ok(!out.includes('今日承诺提醒'))
  })
})
