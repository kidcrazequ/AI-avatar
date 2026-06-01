/**
 * 分身自述单测（借鉴 Pi self-documenting）。
 *
 * 为什么这些测试存在（Rule 9：测意图）：
 *   detectSelfDescriptionIntent 决定一条消息是否被"无 LLM 短路"接管。误判（把领域问题
 *   当成自述）会直接劫持用户的真实提问，所以**负样本**比正样本更重要——领域问题、
 *   带尾巴的句子、超长句都必须放行给 LLM。buildSelfDescriptionAnswer 必须确定性地
 *   列出技能与红线（这正是借鉴点的价值：一致、免费、红线必现）。
 *
 * @author zhi.qu
 * @date 2026-06-01
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectSelfDescriptionIntent,
  buildSelfDescriptionAnswer,
} from '../avatar-self-description'

describe('detectSelfDescriptionIntent — 正样本', () => {
  for (const q of [
    '你能做什么',
    '你能做什么？',
    '你会做什么',
    '你有哪些技能',
    '你装了哪些技能',
    '你都会什么本事',
    '你受哪些红线',
    '你有什么限制',
    '介绍一下你自己',
    '说说你是谁',
    '你是谁？',
    '技能列表',
    '你的能力有哪些',
    '你能帮我做什么',
  ]) {
    test(`命中：「${q}」`, () => {
      assert.equal(detectSelfDescriptionIntent(q), true)
    })
  }
})

describe('detectSelfDescriptionIntent — 负样本（必须放行给 LLM）', () => {
  for (const q of [
    '你能做一个储能方案对比吗', // 领域问题，带尾巴
    '你能帮我查一下 262 柜体的出货量吗',
    '介绍一下 280Ah 和 315Ah 的能量密度差异',
    '你能做什么样的收益测算', // "你能做什么" 是前缀但后接领域内容
    '帮我把这个技能列表导出成表格', // 含"技能列表"但是动作请求
    '我是谁', // 问的是用户自己
    '', // 空
    '   ', // 纯空白
    '你能不能详细讲讲这个项目当年为什么没用 315Ah 电芯以及谁拍的板最后怎么定的', // 超长决策回溯
  ]) {
    test(`放行：「${q || '(空)'}」`, () => {
      assert.equal(detectSelfDescriptionIntent(q), false)
    })
  }
})

describe('buildSelfDescriptionAnswer', () => {
  const SKILLS = [
    { name: 'decision-trace', description: '决策回溯：还原料号/人名/阶段' },
    { name: 'chart-from-knowledge', description: '基于知识库数据画图' },
  ]
  const RED_LINES = ['不编造友商/海外数据', '数据必须可溯源到原始 sheet/条款']

  test('含身份、技能、红线三段，且技能与红线全部出现', () => {
    const out = buildSelfDescriptionAnswer({
      roleLine: '资深电气工程师分身「电图」',
      skills: SKILLS,
      redLines: RED_LINES,
    })
    assert.match(out, /电图/)
    assert.match(out, /decision-trace/)
    assert.match(out, /chart-from-knowledge/)
    assert.match(out, /可溯源到原始 sheet/)
    assert.match(out, /🔒/)
  })

  test('无技能时给出占位说明而非空段', () => {
    const out = buildSelfDescriptionAnswer({ skills: [], redLines: RED_LINES })
    assert.match(out, /未启用专属技能/)
  })

  test('确定性：相同输入逐字节一致', () => {
    const input = { roleLine: 'X', skills: SKILLS, redLines: RED_LINES }
    assert.equal(buildSelfDescriptionAnswer(input), buildSelfDescriptionAnswer(input))
  })

  test('空 redLines 不渲染红线段', () => {
    const out = buildSelfDescriptionAnswer({ skills: SKILLS, redLines: [] })
    assert.doesNotMatch(out, /🔒/)
  })
})
