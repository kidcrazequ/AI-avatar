/**
 * Deliberation 抽取器单测（v17，Phase 1）。
 *
 * 覆盖：
 *   1. 单 marker：抽出 + 从 cleanText 移除
 *   2. 多 marker：全抽出按出现顺序
 *   3. 跨行 marker（[\s\S]*? 必须）
 *   4. 空 marker（[UNCERTAIN][/UNCERTAIN]）被忽略，不进数组
 *   5. 过长内容截断到 MARKER_CHAR_LIMIT + …
 *   6. 两类 marker 互不串扰（同文本里都用）
 *   7. 无 marker 文本：cleanText 原样返回，markers 空数组
 *
 * @author zhi.qu
 * @date 2026-05-17
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { extractUncertain, extractReconsider, MARKER_CHAR_LIMIT } from './deliberation-extractors'

describe('deliberation-extractors', () => {
  test('extractUncertain：单 marker 抽出 + cleanText 移除', () => {
    const r = extractUncertain('结论是 X。[UNCERTAIN]来源数据有疑问[/UNCERTAIN]')
    assert.deepEqual(r.markers, ['来源数据有疑问'])
    assert.equal(r.cleanText, '结论是 X。')
  })

  test('extractReconsider：单 marker 抽出 + cleanText 移除', () => {
    const r = extractReconsider('现在认为 Y。[RECONSIDER]之前以为 X，看到新数据后改成 Y[/RECONSIDER]')
    assert.deepEqual(r.markers, ['之前以为 X，看到新数据后改成 Y'])
    assert.equal(r.cleanText, '现在认为 Y。')
  })

  test('多 marker：按出现顺序全抽出', () => {
    const r = extractUncertain('A [UNCERTAIN]点 1[/UNCERTAIN] B [UNCERTAIN]点 2[/UNCERTAIN] C')
    assert.deepEqual(r.markers, ['点 1', '点 2'])
    assert.equal(r.cleanText, 'A  B  C')
  })

  test('跨行 marker：正则用 [\\s\\S]*? 而不是 .*?，应支持多行', () => {
    const r = extractUncertain('结论。[UNCERTAIN]第一行原因\n第二行原因[/UNCERTAIN]')
    assert.equal(r.markers.length, 1)
    assert.match(r.markers[0], /第一行原因[\s\S]*第二行原因/)
  })

  test('空 marker：被忽略，不进数组', () => {
    const r = extractUncertain('正文[UNCERTAIN][/UNCERTAIN]结尾')
    assert.deepEqual(r.markers, [])
    assert.equal(r.cleanText, '正文结尾')
  })

  test('过长内容：截断到 MARKER_CHAR_LIMIT 并加 …', () => {
    const long = 'x'.repeat(MARKER_CHAR_LIMIT + 50)
    const r = extractUncertain(`[UNCERTAIN]${long}[/UNCERTAIN]`)
    assert.equal(r.markers.length, 1)
    assert.equal(r.markers[0].length, MARKER_CHAR_LIMIT + 1) // +1 是 … 单字符
    assert.equal(r.markers[0].endsWith('…'), true)
  })

  test('两类 marker 互不串扰：同文本里都用', () => {
    const text = '结论 Z [UNCERTAIN]数据来源不明[/UNCERTAIN] [RECONSIDER]之前说 W，现在说 Z[/RECONSIDER]。'
    const u = extractUncertain(text)
    const r = extractReconsider(u.cleanText)
    assert.deepEqual(u.markers, ['数据来源不明'])
    assert.deepEqual(r.markers, ['之前说 W，现在说 Z'])
    // 两遍 trim 之后 RECONSIDER 抽走，剩下 "结论 Z  。"
    assert.match(r.cleanText, /^结论 Z\s+。$/)
  })

  test('无 marker：cleanText 原样、markers 空', () => {
    const r = extractUncertain('一段普通文本，没有任何 marker。')
    assert.deepEqual(r.markers, [])
    assert.equal(r.cleanText, '一段普通文本，没有任何 marker。')
  })
})
