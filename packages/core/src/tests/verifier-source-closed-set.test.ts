/**
 * A1 溯源闭集校验单测（verifier 后置断言）
 *
 * 业务动机（WHY）：2026-05-22「来源错位」事故——分身把二手 markdown 总结冒充
 * "原始 sheet"当来源。闭集规则把"只准引用本轮工具真实下发过的锚点"从 prompt
 * 恳求变成机器断言。本文件验证：
 *   - 集合内引用通过（不误伤合法引用）
 *   - 集合外文件路径必报违规（编造来源必须被看见）
 *   - 无来源标注的回答不误报（闭集规则只审"写了引用的"）
 *   - 前缀/变体规范化匹配（模型写 `knowledge/x.md 第3节`、`xxx.xlsx#sheet=总表`
 *     等宽容形态时不误报；但换成集合外 sheet/路径仍违规）
 *   - advisory 定位：违规只报 warn，ok 保持 true，不阻断回复
 *
 * @date 2026-07-05
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  auditAnswerSourceCitations,
  verifyAgentAnswer,
} from '../agent-runtime/verifier'

const CLOSED_SET_ISSUE = 'source_anchor_out_of_set'

/** 便捷断言：verifyAgentAnswer 结果里是否含闭集违规 issue */
function closedSetIssueOf(result: ReturnType<typeof verifyAgentAnswer>) {
  return result.issues.find((issue) => issue.id === CLOSED_SET_ISSUE)
}

describe('A1 溯源闭集：集合内引用通过', () => {
  it('回答复用工具下发的锚点原文 → 无闭集违规', () => {
    const result = verifyAgentAnswer({
      userText: '262 柜体过去 6 个月不良率是多少？',
      answerText: '不良率 1.2% [来源: knowledge/_excel/262项目CoPQ.json#sheet=总表&rows=12-18]，背景见 [来源: knowledge/262-copq-summary.md#L10-L40]。',
      availableSourceAnchors: [
        '[来源: knowledge/_excel/262项目CoPQ.json#sheet=总表&rows=12-18]',
        '[来源: knowledge/262-copq-summary.md#L10-L40]',
      ],
    })
    assert.equal(closedSetIssueOf(result), undefined)
  })

  it('行号细化（引用是下发区间的子集/单行）→ 通过', () => {
    const audit = auditAnswerSourceCitations(
      '峰谷价差 0.83 元/kWh [来源: knowledge/pricing/上海.md#L5]',
      ['[来源: knowledge/pricing/上海.md#L1-L40]'],
    )
    assert.equal(audit.violations.length, 0)
    assert.equal(audit.checkedCount, 1)
  })
})

describe('A1 溯源闭集：集合外路径违规', () => {
  it('引用了本轮从未下发的 knowledge 文件 → warn 且不阻断（advisory）', () => {
    const result = verifyAgentAnswer({
      userText: '262 柜体测试通过率？',
      answerText: '通过率 98.7% [来源: knowledge/262-测试报告总结.md]',
      availableSourceAnchors: ['[来源: knowledge/_excel/262项目CoPQ.json#sheet=总表&rows=1-20]'],
    })
    const issue = closedSetIssueOf(result)
    assert.ok(issue, '集合外路径必须报违规')
    assert.equal(issue.severity, 'warn')
    assert.match(issue.evidence ?? '', /262-测试报告总结\.md/)
    // advisory：不 block、不翻转 ok —— 与 verifier 既有定位一致
    assert.equal(result.ok, true)
  })

  it('本轮闭集为空（[]）时，knowledge 域引用一律视为集合外', () => {
    const audit = auditAnswerSourceCitations(
      '详见 [来源: knowledge/some/file.md]',
      [],
    )
    assert.equal(audit.violations.length, 1)
  })

  it('Excel 引用了未下发的 sheet（同文件不同表）→ 违规（sheet 是最小粒度）', () => {
    const audit = auditAnswerSourceCitations(
      '出货量 262 台 [来源: knowledge/_excel/262项目CoPQ.json#sheet=出货明细&rows=3-9]',
      ['[来源: knowledge/_excel/262项目CoPQ.json#sheet=总表&rows=12-18]'],
    )
    assert.equal(audit.violations.length, 1)
  })
})

describe('A1 溯源闭集：无来源标注不误报', () => {
  it('回答没有任何 [来源: ...] 引用 → 闭集规则零违规（缺来源交给既有 missing_source_signal 规则）', () => {
    const result = verifyAgentAnswer({
      userText: '262 柜体不良率多少？',
      answerText: '当前知识库缺少来源，无法确认该数字。',
      availableSourceAnchors: ['[来源: knowledge/262-copq-summary.md#L10-L40]'],
    })
    assert.equal(closedSetIssueOf(result), undefined)
  })

  it('availableSourceAnchors 未传（undefined）→ 规则不激活，不误报旧调用方', () => {
    const result = verifyAgentAnswer({
      userText: '不良率？',
      answerText: '1.2% [来源: knowledge/凭空编造.md]',
    })
    assert.equal(closedSetIssueOf(result), undefined)
  })

  it('域外引用（URL / life / 模糊标签）不进入闭集断言', () => {
    const audit = auditAnswerSourceCitations(
      '行业均值见 [来源: https://example.com/report]，往事见 [来源: life/episodes/2026-01.md]，另参考 [来源: CoPQ 台账]',
      ['[来源: knowledge/a.md#L1-L3]'],
    )
    assert.equal(audit.violations.length, 0)
    assert.equal(audit.checkedCount, 0)
    assert.equal(audit.skippedCount, 3)
  })
})

describe('A1 溯源闭集：前缀/变体规范化匹配', () => {
  it('模型写 `knowledge/x.md 第3节` 章节变体 → 文件级命中即通过', () => {
    const audit = auditAnswerSourceCitations(
      '详见 [来源: knowledge/pricing/上海.md 第3节]',
      ['[来源: knowledge/pricing/上海.md#L1-L40]'],
    )
    assert.equal(audit.violations.length, 0)
    assert.equal(audit.checkedCount, 1)
  })

  it('模型只引到文件级（无行号）→ 通过（行号缺失不算违规）', () => {
    const audit = auditAnswerSourceCitations(
      '详见 [来源: knowledge/pricing/上海.md]',
      ['[来源: knowledge/pricing/上海.md#L5-L7]'],
    )
    assert.equal(audit.violations.length, 0)
  })

  it('Excel 原始文件名变体 `xxx.xlsx#sheet=总表` → 按 basename+sheet 命中 json 视图锚点', () => {
    const audit = auditAnswerSourceCitations(
      '不良率 1.2% [来源: 262项目CoPQ.xlsx#sheet=总表]',
      ['[来源: knowledge/_excel/262项目CoPQ.json#sheet=总表&rows=12-18]'],
    )
    assert.equal(audit.violations.length, 0)
    assert.equal(audit.checkedCount, 1)
  })

  it('前缀匹配必须落在路径边界：`knowledge/abc` 不得误配 `knowledge/abc-full.md`', () => {
    const audit = auditAnswerSourceCitations(
      '详见 [来源: knowledge/abc]',
      ['[来源: knowledge/abc-full.md#L1-L9]'],
    )
    assert.equal(audit.violations.length, 1)
  })

  it('shared/knowledge/ 前缀不被误认为分身 knowledge/ 域（负向后行）', () => {
    const audit = auditAnswerSourceCitations(
      '详见 [来源: shared/knowledge/common.md]',
      ['[来源: knowledge/common.md#L1-L5]'],
    )
    // shared/ 域不进闭集断言：不通过也不违规
    assert.equal(audit.checkedCount, 0)
    assert.equal(audit.skippedCount, 1)
  })
})
