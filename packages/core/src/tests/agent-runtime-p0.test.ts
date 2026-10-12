import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  buildAgentCapabilityLayout,
  buildAgentCapabilityPromptHint,
  buildBehaviorModePromptBlock,
  buildSkillDraftFromConversation,
  conversationModeToBehaviorModeIds,
  detectBehaviorModes,
  ensureTaskWorkspace,
  resolveTaskWorkspacePath,
  buildTaskWorkspacePromptHint,
  RunTraceRecorder,
  verifyAgentAnswer,
} from '../agent-runtime'

describe('P0 behavior modes', () => {
  it('detects keyword modes and builds a compact prompt block', () => {
    const modes = detectBehaviorModes('这次请严谨溯源，少写点，不要编。')
    assert.deepEqual(modes.map((m) => m.mode.id), ['strict_traceability', 'minimal_delivery'])
    const block = buildBehaviorModePromptBlock(modes)
    assert.match(block, /strict_traceability/)
    assert.match(block, /关键事实/)
    assert.match(block, /minimal_delivery/)
  })

  it('deduplicates explicit and keyword modes and applies intensity', () => {
    const modes = detectBehaviorModes('请 code review，默认只读。', ['code-review'], 'strict')
    assert.equal(modes.length, 1)
    assert.equal(modes[0].mode.id, 'code_review')
    assert.equal(modes[0].intensity, 'strict')
    assert.equal(modes[0].explicit, true)
  })

  it('maps conversation modes into behavior modes without changing tool mode', () => {
    assert.deepEqual(conversationModeToBehaviorModeIds('agent'), [])
    assert.deepEqual(conversationModeToBehaviorModeIds('plan'), ['plan_first'])
    assert.deepEqual(conversationModeToBehaviorModeIds('ask'), ['ask_only'])

    const modes = detectBehaviorModes('这轮请排查报错。', conversationModeToBehaviorModeIds('plan'))
    assert.deepEqual(modes.map((m) => m.mode.id), ['plan_first', 'debug_trace'])
  })
})

describe('P0 task workspace protocol', () => {
  it('creates reserved directories and blocks traversal', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-task-ws-'))
    const layout = ensureTaskWorkspace(root, { createReadme: true })
    assert.ok(fs.existsSync(layout.dirs.workspace))
    assert.ok(fs.existsSync(layout.dirs.uploads))
    assert.ok(fs.existsSync(layout.dirs.outputs))
    assert.ok(fs.existsSync(layout.dirs.artifacts))
    assert.ok(fs.existsSync(layout.dirs.traces))
    assert.ok(fs.existsSync(path.join(layout.root, 'WORKSPACE.md')))
    assert.throws(() => resolveTaskWorkspacePath(layout, 'outputs', '../escape.txt'), /路径穿越|路径越界|outside/i)
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('renders prompt hints with stable virtual paths', () => {
    const layout = ensureTaskWorkspace(fs.mkdtempSync(path.join(os.tmpdir(), 'soul-task-hint-')))
    const hint = buildTaskWorkspacePromptHint(layout)
    assert.match(hint, /\/mnt\/user-data\/workspace/)
    assert.match(hint, /Final deliverables/)
    fs.rmSync(layout.root, { recursive: true, force: true })
  })
})

describe('P0 avatar capability directory protocol', () => {
  it('describes existing avatar directories without creating new files', () => {
    const root = path.join(os.tmpdir(), 'soul-avatar-capability')
    const layout = buildAgentCapabilityLayout(root)
    assert.equal(layout.protocolVersion, '2026-06-p0-capabilities')
    assert.equal(layout.dirs.skills, path.join(root, 'skills'))
    assert.equal(layout.virtualDirs.workspaces, '/mnt/avatar/workspaces')
    assert.ok(layout.descriptors.some((d) => d.kind === 'knowledge' && d.required))
    assert.match(buildAgentCapabilityPromptHint(layout), /Avatar Capability Directories/)
  })
})

describe('P0 answer verifier', () => {
  it('reports source risk without rewriting the answer', () => {
    const result = verifyAgentAnswer({
      userText: '四川发电侧和售电侧全国排名是多少？',
      answerText: '四川发电侧第 6，售电侧第 3。',
      behaviorModeIds: ['strict_traceability'],
    })
    assert.equal(result.ok, true)
    assert.ok(result.issues.some((issue) => issue.id === 'number_without_source_signal'))
  })
})

describe('P1 skill draft protocol', () => {
  it('creates a pending draft that does not look like an enabled skill', () => {
    const draft = buildSkillDraftFromConversation({
      avatarId: 'avatar-1',
      conversationId: 'conv-1',
      userText: '以后回答政策问题先列来源。',
      assistantText: '可以沉淀为技能：先检索 knowledge，再列出处。',
      now: new Date(Date.UTC(2026, 5, 25, 3, 0, 0)),
    })
    assert.equal(draft.protocolVersion, '2026-06-p1-draft')
    assert.match(draft.filename, /^20260625030000-/)
    assert.match(draft.content, /status: draft/)
    assert.match(draft.content, /人工确认清单/)
  })
})

describe('P0 run trace recorder', () => {
  it('writes JSONL events and a summary', async () => {
    const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-run-trace-'))
    let tick = 0
    const recorder = new RunTraceRecorder({
      traceDir,
      runId: 'run-1',
      conversationId: 'conv-1',
      avatarId: 'avatar-1',
      now: () => new Date(Date.UTC(2026, 5, 25, 1, 0, tick++)),
    })
    recorder.start({ behaviorModes: ['strict_traceability'] })
    recorder.record('model_call', {
      model: 'test-model',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 },
    })
    recorder.record('tool_call', { tool: 'read_knowledge_file' })
    recorder.record('artifact', { path: 'outputs/report.md' })
    recorder.record('source_hit', { source: 'knowledge/a.md' })
    recorder.finish('done')
    await recorder.flush()

    const jsonl = fs.readFileSync(path.join(traceDir, 'run-1.jsonl'), 'utf-8').trim().split(/\r?\n/)
    assert.equal(jsonl.length, 6)
    const summary = JSON.parse(fs.readFileSync(path.join(traceDir, 'run-1.summary.json'), 'utf-8')) as {
      status: string
      modelCallCount: number
      toolCallCount: number
      artifacts: string[]
      sources: string[]
      usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number }
    }
    assert.equal(summary.status, 'done')
    assert.equal(summary.modelCallCount, 1)
    assert.equal(summary.toolCallCount, 1)
    assert.deepEqual(summary.artifacts, ['outputs/report.md'])
    assert.deepEqual(summary.sources, ['knowledge/a.md'])
    assert.equal(summary.usage.inputTokens, 10)
    assert.equal(summary.usage.outputTokens, 5)
    assert.equal(summary.usage.cacheReadTokens, 2)
    fs.rmSync(traceDir, { recursive: true, force: true })
  })
})
