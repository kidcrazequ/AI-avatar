/**
 * sop-schema / sop-runner 单元测试（W5.6）
 *
 * 测试意图（WHY）：SOP 状态机存在的唯一理由是"不信任 LLM 的自报"。
 * 因此本文件的重心不是"函数返回值对不对"，而是把每一条纪律钉死：
 *   - 解析期：图画错了必须在进入运行期之前报错（悬空边 / 重复 id / 无终点 / 死节点）
 *   - 运行期：LLM 想跳步、想走图外的边、想在非终点宣告完成，全部要被拒绝并留下 warning
 *   - 持久化：状态 JSON round-trip 后行为必须完全一致（W5.4 会话恢复依赖此性质）
 * 一旦这些断言能在业务逻辑改动后仍然通过，说明纪律被绕过了，测试就该失败。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { parseSopCard, type SopCard } from '../sop-schema'
import {
  SopRunner,
  SOP_REPORT_OPEN,
  SOP_REPORT_CLOSE,
  type SopState,
} from '../sop-runner'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const PILOT_SOP_PATH = path.join(
  REPO_ROOT,
  'expert-packs/小堵-工商储专家/skills/roi-consult.sop.yaml',
)

/** 测试夹具：两步流程 a → b（b 为终点），a 需要收集槽位「容量」 */
const FIXTURE_YAML = `
sop_version: 1
skill: demo
goal: 演示两步流程
start: a
terminal:
  - b
interruption: pause
nodes:
  - id: a
    name: 收集
    instruction: 收集容量
    expects:
      - 容量
    tools:
      - search_knowledge
    next:
      - to: b
        when: 容量收集齐
  - id: b
    name: 输出
    instruction: 输出结论
`

function loadFixture(): SopCard {
  const r = parseSopCard(FIXTURE_YAML)
  assert.equal(r.ok, true, '夹具 yaml 必须能通过校验')
  return (r as { ok: true; card: SopCard }).card
}

/** 断言错误清单中存在包含指定子串的一条（错误信息是给人读的，逐条断言防止校验被悄悄摘掉） */
function assertHasError(errors: string[], fragment: string): void {
  assert.ok(
    errors.some((e) => e.includes(fragment)),
    `期望错误清单包含「${fragment}」，实际: ${JSON.stringify(errors)}`,
  )
}

describe('sop-schema / parseSopCard 反例', () => {
  it('重复 node id：转移目标会二义，必须在解析期拦下', () => {
    const r = parseSopCard(`
sop_version: 1
skill: demo
goal: g
start: a
terminal: [b]
interruption: pause
nodes:
  - id: a
    name: A
    instruction: i
    next: [{ to: b }]
  - id: a
    name: A2
    instruction: i2
  - id: b
    name: B
    instruction: i3
`)
    assert.equal(r.ok, false)
    assertHasError((r as { ok: false; errors: string[] }).errors, '节点 id 重复: a')
  })

  it('悬空 next.to：运行期会转移到不存在的节点，必须解析期报错', () => {
    const r = parseSopCard(`
sop_version: 1
skill: demo
goal: g
start: a
terminal: [a]
interruption: pause
nodes:
  - id: a
    name: A
    instruction: i
    next: [{ to: ghost }]
`)
    assert.equal(r.ok, false)
    assertHasError((r as { ok: false; errors: string[] }).errors, '节点 a 的 next.to 指向不存在的节点: ghost')
  })

  it('terminal 为空：流程永远无法完成，属于图画错', () => {
    const r = parseSopCard(`
sop_version: 1
skill: demo
goal: g
start: a
terminal: []
interruption: pause
nodes:
  - id: a
    name: A
    instruction: i
`)
    assert.equal(r.ok, false)
    assertHasError((r as { ok: false; errors: string[] }).errors, 'terminal 必须是非空数组')
  })

  it('存在从起点不可达的节点：写了却永远走不到，是作者的笔误', () => {
    const r = parseSopCard(`
sop_version: 1
skill: demo
goal: g
start: a
terminal: [b]
interruption: pause
nodes:
  - id: a
    name: A
    instruction: i
    next: [{ to: b }]
  - id: b
    name: B
    instruction: i
  - id: orphan
    name: 孤儿
    instruction: i
`)
    assert.equal(r.ok, false)
    assertHasError((r as { ok: false; errors: string[] }).errors, '节点 orphan 从起点不可达')
  })

  it('sop_version 非 1 / start 悬空 / interruption 非法：一次性收齐全部错误，不早退', () => {
    const r = parseSopCard(`
sop_version: 2
skill: demo
goal: g
start: nowhere
terminal: [a]
interruption: 随便
nodes:
  - id: a
    name: A
    instruction: i
`)
    assert.equal(r.ok, false)
    const errors = (r as { ok: false; errors: string[] }).errors
    assertHasError(errors, 'sop_version 必须为 1')
    assertHasError(errors, 'start 指向不存在的节点: nowhere')
    assertHasError(errors, 'interruption 必须是')
    assert.ok(errors.length >= 3, '三类错误必须同时报出，而不是报第一条就返回')
  })
})

describe('sop-runner / parseReport', () => {
  it('取最后一个 sop_state 块：LLM 可能在思考里先写一个草稿，最终以末尾那个为准', () => {
    const runner = new SopRunner(loadFixture())
    const text = [
      `草稿 ${SOP_REPORT_OPEN}{"next":"wrong"}${SOP_REPORT_CLOSE}`,
      `正文 ${SOP_REPORT_OPEN}{"filled":{"容量":"200kWh"},"next":"b","done":false}${SOP_REPORT_CLOSE}`,
    ].join('\n')
    const report = runner.parseReport(text)
    assert.deepEqual(report, { filled: { 容量: '200kWh' }, next: 'b', done: false })
  })

  it('无标记 / JSON 损坏一律 null：绝不猜测 LLM 想说什么', () => {
    const runner = new SopRunner(loadFixture())
    assert.equal(runner.parseReport('普通回复，没有汇报'), null)
    assert.equal(runner.parseReport(`${SOP_REPORT_OPEN}{坏JSON${SOP_REPORT_CLOSE}`), null)
    assert.equal(runner.parseReport(`${SOP_REPORT_OPEN}{"next":"b"}`), null, '标记未闭合不算汇报')
  })

  it('数值槽位转字符串收下：LLM 常把容量报成 number，丢弃会造成真实信息损失', () => {
    const runner = new SopRunner(loadFixture())
    const report = runner.parseReport(`${SOP_REPORT_OPEN}{"filled":{"容量":200}}${SOP_REPORT_CLOSE}`)
    assert.deepEqual(report?.filled, { 容量: '200' })
  })
})

describe('sop-runner / applyTurn 纪律', () => {
  it('未上报 sop_state：状态原地不动 + warning（没有汇报就没有推进）', () => {
    const runner = new SopRunner(loadFixture())
    const s0 = runner.initialState(1000)
    const r = runner.applyTurn(s0, null, 2000)
    assert.equal(r.state.nodeId, 'a')
    assert.equal(r.transitioned, false)
    assert.equal(r.finished, false)
    assert.deepEqual(r.warnings, ['本轮未上报 sop_state'])
    assert.deepEqual(r.state.history, [])
  })

  it('槽位不齐请求转移：拒转 + warning（防跳步是状态机的核心价值）', () => {
    const runner = new SopRunner(loadFixture())
    const s0 = runner.initialState(1000)
    const r = runner.applyTurn(s0, { next: 'b' }, 2000)
    assert.equal(r.state.nodeId, 'a', '槽位没齐就必须留在原节点')
    assert.equal(r.transitioned, false)
    assertHasError(r.warnings, '仍有未收集槽位（容量）')
  })

  it('空白字符串不算已收集：空槽位混进 filled 不能骗过防跳步校验', () => {
    const runner = new SopRunner(loadFixture())
    const s0 = runner.initialState(1000)
    const r = runner.applyTurn(s0, { filled: { 容量: '   ' }, next: 'b' }, 2000)
    assert.equal(r.transitioned, false)
    assertHasError(r.warnings, '仍有未收集槽位')
  })

  it('槽位齐后沿合法边转移：成功 + history 追加轨迹（W5.3 要拿它喂 Traces）', () => {
    const runner = new SopRunner(loadFixture())
    const s0 = runner.initialState(1000)
    const r = runner.applyTurn(s0, { filled: { 容量: '200kWh' }, next: 'b' }, 2000)
    assert.equal(r.state.nodeId, 'b')
    assert.equal(r.transitioned, true)
    assert.deepEqual(r.state.history, ['a -> b'])
    assert.deepEqual(r.warnings, [])
    assert.deepEqual(r.state.filled, { 容量: '200kWh' })
  })

  it('filled 新值覆盖旧值：用户中途修正参数是常态', () => {
    const runner = new SopRunner(loadFixture())
    const s0 = runner.initialState(1000)
    const s1 = runner.applyTurn(s0, { filled: { 容量: '200kWh' } }, 2000).state
    const s2 = runner.applyTurn(s1, { filled: { 容量: '500kWh' } }, 3000).state
    assert.deepEqual(s2.filled, { 容量: '500kWh' })
  })

  it('请求图外的目标：拒转 + warning（只能沿图上的边走）', () => {
    const runner = new SopRunner(loadFixture())
    const s0 = runner.initialState(1000)
    const r = runner.applyTurn(s0, { filled: { 容量: '200kWh' }, next: 'ghost' }, 2000)
    assert.equal(r.state.nodeId, 'a')
    assert.equal(r.transitioned, false)
    assertHasError(r.warnings, '不在当前节点 a 的可转移列表中')
  })

  it('非终点节点上报 done：不认，warning「未到终点节点不可完成」（防提前收尾）', () => {
    const runner = new SopRunner(loadFixture())
    const s0 = runner.initialState(1000)
    const r = runner.applyTurn(s0, { done: true }, 2000)
    assert.equal(r.finished, false)
    assertHasError(r.warnings, '未到终点节点不可完成')
  })

  it('转入终点节点同一轮 done=true：finished（最后一轮转移+交付是常见形态）', () => {
    const runner = new SopRunner(loadFixture())
    const s0 = runner.initialState(1000)
    const r = runner.applyTurn(s0, { filled: { 容量: '200kWh' }, next: 'b', done: true }, 2000)
    assert.equal(r.state.nodeId, 'b')
    assert.equal(r.transitioned, true)
    assert.equal(r.finished, true)
    assert.deepEqual(r.warnings, [])
  })

  it('applyTurn 不修改传入 state：调用方可安全保留上一轮快照做回滚', () => {
    const runner = new SopRunner(loadFixture())
    const s0 = runner.initialState(1000)
    runner.applyTurn(s0, { filled: { 容量: '200kWh' }, next: 'b' }, 2000)
    assert.equal(s0.nodeId, 'a')
    assert.deepEqual(s0.filled, {})
    assert.deepEqual(s0.history, [])
  })

  it('state JSON round-trip 后行为一致：W5.4 会话持久化恢复的正确性依赖此性质', () => {
    const runner = new SopRunner(loadFixture())
    const s0 = runner.initialState(1000)
    const s1 = runner.applyTurn(s0, { filled: { 容量: '200kWh' } }, 2000).state

    const revived = JSON.parse(JSON.stringify(s1)) as SopState
    assert.deepEqual(revived, s1, '序列化后字段不能丢失')

    const direct = runner.applyTurn(s1, { next: 'b', done: true }, 3000)
    const afterRevive = runner.applyTurn(revived, { next: 'b', done: true }, 3000)
    assert.deepEqual(afterRevive.state, direct.state)
    assert.equal(afterRevive.transitioned, direct.transitioned)
    assert.equal(afterRevive.finished, direct.finished)
    assert.deepEqual(afterRevive.warnings, direct.warnings)
  })
})

describe('sop-runner / buildTurnPrompt', () => {
  it('text 通道（默认）：给出 sop_state 标记格式，并明确列出仍缺槽位', () => {
    const runner = new SopRunner(loadFixture())
    const prompt = runner.buildTurnPrompt(runner.initialState(1000))
    assert.ok(prompt.includes('收集'), '含当前节点 name')
    assert.ok(prompt.includes('收集容量'), '含当前节点 instruction')
    assert.ok(prompt.includes('本节点仍缺槽位: 容量'), '缺失槽位必须显式列出，否则 LLM 不知道要问什么')
    assert.ok(prompt.includes('- b（条件: 容量收集齐）'), '转移选项须带 when 条件')
    assert.ok(prompt.includes('search_knowledge'), '含建议工具')
    assert.ok(prompt.includes(SOP_REPORT_OPEN) && prompt.includes(SOP_REPORT_CLOSE), 'text 通道须给出标记格式')
    assert.ok(!prompt.includes('sop_report'), 'text 通道不应提工具通道')
  })

  it('tool 通道：改为要求调用 sop_report 工具，且不出现 <sop_state> 标记（防双通道串味）', () => {
    const runner = new SopRunner(loadFixture())
    const prompt = runner.buildTurnPrompt(runner.initialState(1000), { reportChannel: 'tool' })
    assert.ok(prompt.includes('sop_report'), 'tool 通道须指名工具')
    assert.ok(!prompt.includes(SOP_REPORT_OPEN), 'tool 通道不得出现 <sop_state> 标记')
    assert.ok(prompt.includes('本节点仍缺槽位: 容量'), '两通道的槽位进度信息应一致')
  })

  it('已收集槽位回显：LLM 才不会重复追问用户已经答过的参数', () => {
    const runner = new SopRunner(loadFixture())
    const s = runner.applyTurn(runner.initialState(1000), { filled: { 容量: '200kWh' } }, 2000).state
    const prompt = runner.buildTurnPrompt(s)
    assert.ok(prompt.includes('- 容量: 200kWh'))
    assert.ok(prompt.includes('本节点仍缺槽位: （已收集齐）'))
  })

  it('状态损坏（nodeId 不在卡内）：不抛错，提示如实告知用户', () => {
    const runner = new SopRunner(loadFixture())
    const broken: SopState = { skill: 'demo', nodeId: 'gone', filled: {}, startedAtMs: 1, history: [] }
    const prompt = runner.buildTurnPrompt(broken)
    assert.ok(prompt.includes('SOP 状态异常'))
    const r = runner.applyTurn(broken, { next: 'b', done: true }, 2)
    assert.equal(r.transitioned, false)
    assert.equal(r.finished, false)
    assertHasError(r.warnings, '不在 SOP 卡中')
  })
})

describe('试点技能 roi-consult.sop.yaml 走查', () => {
  it('通过 schema 校验（试点卡本身必须是合法图）', () => {
    const raw = fs.readFileSync(PILOT_SOP_PATH, 'utf-8')
    const r = parseSopCard(raw)
    assert.equal(r.ok, true, `试点卡校验失败: ${r.ok ? '' : JSON.stringify(r.errors)}`)
    const card = (r as { ok: true; card: SopCard }).card
    assert.equal(card.skill, 'roi-consult')
    assert.ok(card.nodes.length >= 4, '试点流程至少 4 个节点')
    assert.ok(
      card.nodes.some((n) => n.tools.includes('search_knowledge')),
      '查电价与政策节点须建议 search_knowledge（溯源纪律的落点）',
    )
    assert.ok(card.nodes.some((n) => n.tools.includes('calculate_roi')), '测算节点须建议 calculate_roi')
  })

  it('从 start 逐轮模拟走到 terminal：全流程可达，且中途跳步会被拒', () => {
    const raw = fs.readFileSync(PILOT_SOP_PATH, 'utf-8')
    const parsed = parseSopCard(raw)
    assert.equal(parsed.ok, true)
    const card = (parsed as { ok: true; card: SopCard }).card
    const runner = new SopRunner(card)

    let state = runner.initialState(0)
    // 第一轮就想直奔终点：必须被拒（起点槽位还一个没收集）
    const cheat = runner.applyTurn(state, { next: card.terminalIds[0], done: true }, 1)
    assert.equal(cheat.finished, false, '不许一步跳到终点')
    assert.ok(cheat.warnings.length > 0)

    // 老实走：每轮填满当前节点 expects，再沿第一条边转移
    let finished = false
    for (let turn = 0; turn < 20 && !finished; turn++) {
      const node = card.nodes.find((n) => n.id === state.nodeId)
      assert.ok(node, `节点 ${state.nodeId} 应存在于卡中`)
      const filled: Record<string, string> = {}
      for (const slot of node!.expects) filled[slot] = `模拟值-${slot}`

      const isTerminal = card.terminalIds.includes(node!.id)
      const next = isTerminal ? null : node!.next[0]?.to ?? null
      const result = runner.applyTurn(state, { filled, next, done: isTerminal }, turn + 2)
      assert.deepEqual(result.warnings, [], `第 ${turn + 1} 轮不应有 warning: ${result.warnings.join(' / ')}`)
      state = result.state
      finished = result.finished
    }

    assert.equal(finished, true, '按图逐节点推进必须能走到终点')
    assert.ok(card.terminalIds.includes(state.nodeId))
    assert.ok(state.history.length >= 3, `轨迹应记录每一次转移，实际: ${JSON.stringify(state.history)}`)
  })
})
