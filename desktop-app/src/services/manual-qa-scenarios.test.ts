import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runManualQaScenarioSuite, type ManualQaScenarioResult } from './manual-qa-scenarios'

function requireScenario(
  scenarios: ManualQaScenarioResult[],
  id: ManualQaScenarioResult['id'],
): ManualQaScenarioResult {
  const scenario = scenarios.find((item) => item.id === id)
  assert.ok(scenario)
  return scenario
}

describe('manual-qa-scenarios', () => {
  it('应覆盖知识库事实问答、Excel 数值问答、连续追问和乱引用拦截四个场景', async () => {
    const result = await runManualQaScenarioSuite()

    assert.equal(result.scenarios.length, 4)

    const knowledge = requireScenario(result.scenarios, 'knowledge-fact')
    assert.equal(knowledge.routing?.contextStrategy, 'knowledge-tools')
    assert.equal(knowledge.routing?.toolProfile, 'standard')
    assert.equal(knowledge.workflow?.assistantSummaries[0]?.referenceCount, 1)
    assert.equal(knowledge.workflow?.assistantSummaries[0]?.summaryStatus, 'all-current-context')
    assert.equal(knowledge.workflow?.openedPreviewKinds[0], 'knowledge')
    assert.match(knowledge.workflow?.assistantSummaries[0]?.cards[0]?.subtitle ?? '', /policy\.md/)

    const excel = requireScenario(result.scenarios, 'excel-numeric')
    assert.equal(excel.routing?.contextStrategy, 'excel-first')
    assert.equal(excel.routing?.toolProfile, 'chart')
    assert.equal(excel.workflow?.assistantSummaries[0]?.referenceCount, 1)
    assert.equal(excel.workflow?.assistantSummaries[0]?.currentContextReferenceCount, 1)
    assert.equal(excel.workflow?.openedPreviewKinds[0], 'excel')
    assert.match(excel.workflow?.assistantSummaries[0]?.cards[0]?.subtitle ?? '', /sheet 总表/)
    assert.match(excel.workflow?.assistantSummaries[0]?.cards[0]?.subtitle ?? '', /rows 3-5/)

    const followUp = requireScenario(result.scenarios, 'follow-up')
    assert.equal(followUp.workflow?.assistantSummaries.length, 2)
    assert.equal(followUp.workflow?.assistantSummaries[0]?.summaryStatus, 'all-current-context')
    assert.equal(followUp.workflow?.assistantSummaries[1]?.summaryStatus, 'all-current-context')
    assert.match(followUp.workflow?.assistantSummaries[1]?.cards[0]?.subtitle ?? '', /row 4|rows 4-4/)

    const antiFake = requireScenario(result.scenarios, 'anti-fake-citation')
    assert.equal(antiFake.validation?.removedUnsupportedCount, 1)
    assert.equal(antiFake.validation?.validAnchors.length, 1)
    assert.equal(antiFake.workflow?.assistantSummaries[0]?.referenceCount, 1)
    assert.doesNotMatch(antiFake.validation?.text ?? '', /manual\.md/)
    assert.deepEqual(antiFake.validation?.unsupportedAnchors, ['[来源: knowledge/manual.md#L20-L26]'])
  })
})
