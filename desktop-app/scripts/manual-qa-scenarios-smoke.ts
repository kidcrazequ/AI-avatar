import assert from 'node:assert/strict'
import { runManualQaScenarioSuite } from '../src/services/manual-qa-scenarios'

async function main(): Promise<void> {
  const result = await runManualQaScenarioSuite()

  assert.equal(result.scenarios.length, 4)

  const knowledge = result.scenarios.find((item) => item.id === 'knowledge-fact')
  assert.ok(knowledge, 'missing knowledge-fact scenario')
  assert.equal(knowledge.routing?.contextStrategy, 'light-rag')
  assert.equal(knowledge.workflow?.assistantSummaries[0]?.referenceCount, 1)

  const excel = result.scenarios.find((item) => item.id === 'excel-numeric')
  assert.ok(excel, 'missing excel-numeric scenario')
  assert.equal(excel.routing?.contextStrategy, 'excel-first')
  assert.equal(excel.workflow?.openedPreviewKinds[0], 'excel')

  const followUp = result.scenarios.find((item) => item.id === 'follow-up')
  assert.ok(followUp, 'missing follow-up scenario')
  assert.equal(followUp.workflow?.assistantSummaries.length, 2)
  assert.equal(followUp.workflow?.assistantSummaries[1]?.currentContextReferenceCount, 1)

  const antiFake = result.scenarios.find((item) => item.id === 'anti-fake-citation')
  assert.ok(antiFake, 'missing anti-fake-citation scenario')
  assert.equal(antiFake.validation?.removedUnsupportedCount, 1)
  assert.equal(antiFake.workflow?.assistantSummaries[0]?.referenceCount, 1)

  console.log('[manual-qa-scenarios-smoke] PASS')
  console.log(JSON.stringify(result, null, 2))
}

void main().catch((error) => {
  console.error('[manual-qa-scenarios-smoke] FAIL')
  console.error(error)
  process.exitCode = 1
})
