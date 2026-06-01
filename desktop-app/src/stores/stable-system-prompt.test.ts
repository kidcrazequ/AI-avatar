/**
 * stable system-prompt 前缀的回归测试（借鉴 Pi Coding Agent 的 prompt-cache 纪律）。
 *
 * 为什么这些测试存在（Rule 9：测意图，不只是测行为）：
 *   stable 段被标 cacheable，命中 prompt cache 的前提是它的字节在多轮之间完全不变。
 *   只要有人往拼接逻辑里塞了随时间/每轮变化的 token（new Date()、计数器、检索片段），
 *   缓存就会静默失效、成本翻倍而没有任何报错。这里用两道防线把这种回归挡在测试里：
 *     1. byte-identity：同一入参连续两次构建必须逐字节相同（抓住任何非确定性）。
 *     2. volatile-scan：HARD_RULES / DELIBERATION_GUIDE 与拼接结果不得含易变 token。
 *   最后还反向验证扫描器本身确实能命中易变 token —— 否则"全绿"只是假绿。
 *
 * @author zhi.qu
 * @date 2026-06-01
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  HARD_RULES,
  DELIBERATION_GUIDE,
  buildStableSystemText,
  scanForVolatileTokens,
} from './stable-system-prompt'

describe('stable-system-prompt', () => {
  const SAMPLE_PROMPT = '你是「电图」，资深电气工程师分身，基于知识库可追溯地回答。'

  test('byte-identity：同一入参连续两次构建逐字节一致（prompt cache 命中前提）', () => {
    assert.equal(buildStableSystemText(SAMPLE_PROMPT), buildStableSystemText(SAMPLE_PROMPT))
  })

  test('拼接顺序固定：HARD_RULES → DELIBERATION_GUIDE → systemPrompt', () => {
    const out = buildStableSystemText(SAMPLE_PROMPT)
    assert.equal(out.indexOf(HARD_RULES), 0)
    assert.ok(
      out.indexOf(HARD_RULES) < out.indexOf(DELIBERATION_GUIDE) &&
        out.indexOf(DELIBERATION_GUIDE) < out.indexOf(SAMPLE_PROMPT),
      '三段顺序错位',
    )
  })

  test('stable 段（含两条常量）不含任何易变 token', () => {
    const found = scanForVolatileTokens(buildStableSystemText(SAMPLE_PROMPT))
    assert.deepEqual(found, [], `stable 段混入易变 token：${found.join(', ')}`)
  })

  test('HARD_RULES 常量本身不含易变 token', () => {
    assert.deepEqual(scanForVolatileTokens(HARD_RULES), [])
  })

  test('DELIBERATION_GUIDE 常量本身不含易变 token', () => {
    assert.deepEqual(scanForVolatileTokens(DELIBERATION_GUIDE), [])
  })

  // 反向验证：扫描器必须真能抓到易变 token，否则上面的"全绿"毫无意义（防假绿）。
  test('扫描器能抓到注入的 ISO 时间戳 / 时钟 / Date 调用', () => {
    assert.deepEqual(scanForVolatileTokens('生成于 2026-06-01T12:30 的回答'), ['2026-06-01T12:30'])
    assert.deepEqual(scanForVolatileTokens('当前 13:05:09'), ['13:05:09'])
    assert.ok(scanForVolatileTokens('foo Date.now() bar').includes('Date.now()'))
    assert.ok(scanForVolatileTokens('x.toISOString().slice(0,10)').length > 0)
  })

  test('一旦把易变 systemPrompt 塞进 stable 段，扫描会立即报警', () => {
    const out = buildStableSystemText('知识库快照时间 2026-06-01T09:00，下同。')
    assert.ok(scanForVolatileTokens(out).length > 0, '易变 systemPrompt 应被 stable 段扫描抓出')
  })
})
