/**
 * 一键运行技能模板单测。
 *
 * 为什么这些测试存在（Rule 9）：模板是「运行」按钮与分身之间的产品契约——
 * 必须包含技能名、"先加载技能/列输入清单/缺失先确认/逐步执行"四个流程约束；
 * 少任何一段，分身就可能跳过流程直接编造执行结果。
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildSkillRunPrompt } from './skill-run-prompt'

describe('buildSkillRunPrompt', () => {
  test('模板包含技能名（书名号包裹，供分身精确定位技能）', () => {
    const prompt = buildSkillRunPrompt('draw-mermaid')
    assert.ok(prompt.includes('「draw-mermaid」'))
  })

  test('模板包含四个流程约束：加载技能 / 输入清单 / 缺失先确认 / 逐步执行', () => {
    const prompt = buildSkillRunPrompt('any-skill')
    assert.ok(prompt.includes('先加载该技能'), '必须要求先加载技能读取完整流程')
    assert.ok(prompt.includes('输入清单'), '必须要求列出执行所需的输入清单')
    assert.ok(prompt.includes('缺失的信息先向我确认'), '必须要求缺失信息先确认，防止编造')
    assert.ok(prompt.includes('逐步执行并在每步说明产出'), '必须要求逐步执行并说明产出')
  })

  test('中文技能名原样嵌入，不做转义或截断', () => {
    const prompt = buildSkillRunPrompt('周报-汇总流程')
    assert.ok(prompt.includes('「周报-汇总流程」'))
  })
})
