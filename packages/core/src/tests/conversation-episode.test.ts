/**
 * 对话情景记忆 v17 Phase 2a 单测。
 *
 * 覆盖：
 *   - store: write/read roundtrip、list、delete、shouldExtractEpisode 判定
 *   - extractor: mock LLM 输出严格 JSON 走通；缺字段被拒；越界数值被 clamp
 *   - extractor: 损坏 JSON 报 errorReason 不抛
 *   - extractor: 空 transcript 直接拒
 *
 * @author zhi.qu
 * @date 2026-05-17
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'

import {
  writeConversationEpisode,
  readConversationEpisode,
  listConversationEpisodes,
  deleteConversationEpisode,
  shouldExtractEpisode,
} from '../memory/episode-store'
import { extractConversationEpisode } from '../memory/episode-extractor'
import {
  CONVERSATION_EPISODE_SCHEMA_VERSION,
  type ConversationEpisode,
  type ExtractEpisodeInput,
} from '../memory/episode-types'

const tmpDirs: string[] = []
function makeAvatarsRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-episode-test-'))
  tmpDirs.push(dir)
  // 创建一个 avatar 目录，便于 store API 拼路径
  fs.mkdirSync(path.join(dir, 'a1'), { recursive: true })
  return dir
}

after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* noop */ }
  }
})

function makeEpisode(overrides: Partial<ConversationEpisode> = {}): ConversationEpisode {
  return {
    schemaVersion: CONVERSATION_EPISODE_SCHEMA_VERSION,
    conversationId: 'conv-1',
    avatarId: 'a1',
    title: '关于 X 的讨论',
    theme: '用户问 X，我给出了 Y 方案',
    summary: '我和用户聊了 X，发现 Y 是合适的方案，确认了几个边界条件。',
    keyQuotes: ['用户说：X 要满足 A', '我回：那就用 Y'],
    themes: ['技术决策', '边界条件'],
    valence: 3,
    emotionType: 'wonder',
    importance: 6,
    consolidationStatus: 'remembered',
    consolidationNote: '',
    conversationStartedAt: 1000,
    conversationLastMessageAt: 2000,
    extractedAt: 2500,
    messageCount: 8,
    ...overrides,
  }
}

describe('episode-store', () => {
  test('write/read roundtrip：原样还原', async () => {
    const root = makeAvatarsRoot()
    const ep = makeEpisode()
    await writeConversationEpisode(root, ep)
    const got = await readConversationEpisode(root, 'a1', 'conv-1')
    assert.deepEqual(got, ep)
  })

  test('read 不存在的 episode：返回 null', async () => {
    const root = makeAvatarsRoot()
    const got = await readConversationEpisode(root, 'a1', 'never-existed')
    assert.equal(got, null)
  })

  test('list：多 episode 全部返回；损坏 json 跳过', async () => {
    const root = makeAvatarsRoot()
    const ep1 = makeEpisode({ conversationId: 'conv-1', title: 'A', importance: 5 })
    const ep2 = makeEpisode({ conversationId: 'conv-2', title: 'B', importance: 8 })
    await writeConversationEpisode(root, ep1)
    await writeConversationEpisode(root, ep2)
    // 注入一个损坏的 JSON 文件
    const dir = path.join(root, 'a1', 'memory', 'episodes')
    fs.writeFileSync(path.join(dir, 'corrupt.json'), '{this is not json', 'utf-8')

    const list = await listConversationEpisodes(root, 'a1')
    const titles = list.map(e => e.title).sort()
    assert.deepEqual(titles, ['A', 'B'], '只返回合法 episode，损坏文件被跳过')
  })

  test('list：episodes 目录不存在 → 空数组（新分身常态）', async () => {
    const root = makeAvatarsRoot()
    const list = await listConversationEpisodes(root, 'a1')
    assert.deepEqual(list, [])
  })

  test('delete：删除后 read 返回 null；幂等不抛', async () => {
    const root = makeAvatarsRoot()
    await writeConversationEpisode(root, makeEpisode())
    await deleteConversationEpisode(root, 'a1', 'conv-1')
    const got = await readConversationEpisode(root, 'a1', 'conv-1')
    assert.equal(got, null)
    // 第二次 delete 不应抛
    await deleteConversationEpisode(root, 'a1', 'conv-1')
  })

  test('shouldExtractEpisode：无 episode 总是要抽；消息数变多要重抽；不变跳过', () => {
    assert.equal(shouldExtractEpisode(null, 5), true)
    assert.equal(shouldExtractEpisode(makeEpisode({ messageCount: 5 }), 5), false)
    assert.equal(shouldExtractEpisode(makeEpisode({ messageCount: 5 }), 8), true)
  })

  test('路径安全：avatarId 含 ../ 抛错', async () => {
    const root = makeAvatarsRoot()
    await assert.rejects(() => readConversationEpisode(root, '../etc', 'conv-1'))
  })
})

describe('episode-extractor', () => {
  function makeInput(transcript: ExtractEpisodeInput['transcript'] = [
    { role: 'user', content: '你怎么看 X 方案', ts: 1 },
    { role: 'assistant', content: '我倾向 Y，因为 ...', ts: 2 },
  ]): ExtractEpisodeInput {
    return {
      conversationId: 'conv-1',
      avatarId: 'a1',
      conversationTitle: '方案讨论',
      transcript,
    }
  }

  test('LLM 输出合法 JSON：抽出 episode，schemaVersion 已填', async () => {
    const mockLLM = async () => JSON.stringify({
      title: '关于 X 的讨论',
      theme: '用户问方案选择，我给出 Y',
      summary: '我和用户聊了 X，分析了 Y 方案的合理性。',
      keyQuotes: ['Y 因为 ...'],
      themes: ['方案'],
      valence: 2,
      emotionType: 'wonder',
      importance: 5,
    })
    const r = await extractConversationEpisode(makeInput(), mockLLM)
    assert.equal(r.ok, true)
    if (r.ok) {
      assert.equal(r.episode.title, '关于 X 的讨论')
      assert.equal(r.episode.importance, 5)
      assert.equal(r.episode.schemaVersion, CONVERSATION_EPISODE_SCHEMA_VERSION)
      assert.equal(r.episode.consolidationStatus, 'remembered')
    }
  })

  test('LLM 输出含代码块包装：剥掉后照常解析', async () => {
    const mockLLM = async () => '```json\n' + JSON.stringify({
      title: 'X', theme: 't', summary: 's', keyQuotes: [], themes: [],
      valence: 0, emotionType: 'joy', importance: 3,
    }) + '\n```'
    const r = await extractConversationEpisode(makeInput(), mockLLM)
    assert.equal(r.ok, true)
  })

  test('数值越界：valence > 10 / importance < 0 被 clamp', async () => {
    const mockLLM = async () => JSON.stringify({
      title: 'X', theme: 't', summary: 's', keyQuotes: [], themes: [],
      valence: 99, emotionType: 'joy', importance: -5,
    })
    const r = await extractConversationEpisode(makeInput(), mockLLM)
    assert.equal(r.ok, true)
    if (r.ok) {
      assert.equal(r.episode.valence, 10, 'valence > 10 应 clamp 到 10')
      assert.equal(r.episode.importance, 0, 'importance < 0 应 clamp 到 0')
    }
  })

  test('非法 emotionType 退化到 wonder', async () => {
    const mockLLM = async () => JSON.stringify({
      title: 'X', theme: 't', summary: 's', keyQuotes: [], themes: [],
      valence: 0, emotionType: 'unknown_emotion', importance: 3,
    })
    const r = await extractConversationEpisode(makeInput(), mockLLM)
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.episode.emotionType, 'wonder')
  })

  test('缺 title：拒绝抽取', async () => {
    const mockLLM = async () => JSON.stringify({
      summary: 's', valence: 0, emotionType: 'joy', importance: 3,
    })
    const r = await extractConversationEpisode(makeInput(), mockLLM)
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.errorReason, /title 或 summary 缺失/)
  })

  test('LLM 返回非法 JSON：errorReason 含 JSON 解析失败', async () => {
    const mockLLM = async () => '不是 json 的乱码 {{{{'
    const r = await extractConversationEpisode(makeInput(), mockLLM)
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.errorReason, /JSON 解析失败/)
  })

  test('空 transcript：拒绝抽取', async () => {
    const mockLLM = async () => 'never called'
    const r = await extractConversationEpisode(makeInput([]), mockLLM)
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.errorReason, /transcript 为空/)
  })

  test('LLM 抛错：errorReason 含 LLM 调用失败', async () => {
    const mockLLM = async () => { throw new Error('网络炸了') }
    const r = await extractConversationEpisode(makeInput(), mockLLM)
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.match(r.errorReason, /LLM 调用失败/)
      assert.match(r.errorReason, /网络炸了/)
    }
  })
})
