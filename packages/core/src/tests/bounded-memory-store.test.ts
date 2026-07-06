/**
 * Bounded Memory Store（A4 · Hermes 借鉴）单元测试。
 *
 * 测试意图（Rule 9：编码 WHY）：
 *   - 原子操作正确性：add/replace/remove 是记忆演化的唯一路径，任何一处坏掉
 *     都会让"预算即遗忘"的结构性约束失效
 *   - 预算强制：预算满时 add/replace 必须被拒绝——这是 Hermes 设计的核心
 *     （价值排序由结构强制而非 prompt 恳求），拒绝失败 = 记忆无界膨胀
 *   - 遗忘留痕：remove/replace 必须返回被删原文——静默遗忘撞 Soul 溯源红线
 *   - 遗留格式容忍：现存分身的自由格式 MEMORY.md 绝不能被破坏性重写，
 *     legacy 块必须原样保留且结构上不可被 op 编辑
 *
 * @author zhi.qu
 * @date 2026-07-05
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseBoundedMemoryMarkdown,
  serializeBoundedMemoryDoc,
  applyBoundedMemoryOp,
  boundedMemoryChars,
  formatMemoryUsageHeader,
  readBoundedMemoryFile,
  writeBoundedMemoryFileAtomic,
  resolveMemoryCharBudget,
  DEFAULT_MEMORY_CHAR_BUDGET,
  MIN_MEMORY_CHAR_BUDGET,
  MAX_MEMORY_CHAR_BUDGET,
  MAX_BOUNDED_ENTRY_CHARS,
  type BoundedMemoryDoc,
} from '../memory/bounded-store'
import {
  parseMemoryReviewResponse,
  buildMemoryReviewUserPrompt,
  MEMORY_REVIEW_MAX_OPS,
} from '../memory/memory-review'

const LEGACY_TEXT = `# 长期记忆

<!-- 2026-05-01 -->
用户偏好简洁中文回答。

<!-- 2026-05-10 -->
项目决策：优先做工商储。`

describe('bounded-store 解析与序列化', () => {
  it('无 mem 标记的自由格式文件整体进 legacyPreamble（遗留格式容忍）', () => {
    const doc = parseBoundedMemoryMarkdown(LEGACY_TEXT)
    assert.equal(doc.entries.length, 0)
    // 旧式 <!-- 日期 --> 注释不是 mem 标记，必须原样保留在 legacy 块
    assert.ok(doc.legacyPreamble.includes('<!-- 2026-05-01 -->'))
    assert.ok(doc.legacyPreamble.includes('优先做工商储'))
  })

  it('legacy + 条目混合文件：legacy 原样保留，条目逐条解析', () => {
    const text = `${LEGACY_TEXT}\n\n<!-- mem:m-20260705-ab12 2026-07-05 -->\n用户在上海，电价问题默认按上海口径。\n\n<!-- mem:m-20260706-cd34 2026-07-06 -->\n汇报格式：先结论后论据。\n`
    const doc = parseBoundedMemoryMarkdown(text)
    assert.ok(doc.legacyPreamble.includes('优先做工商储'))
    assert.equal(doc.entries.length, 2)
    assert.equal(doc.entries[0].id, 'm-20260705-ab12')
    assert.equal(doc.entries[0].date, '2026-07-05')
    assert.equal(doc.entries[1].content, '汇报格式：先结论后论据。')
  })

  it('round-trip 稳定：parse(serialize(doc)) 结构等价（懒迁移不破坏文件）', () => {
    const text = `${LEGACY_TEXT}\n\n<!-- mem:m-1 2026-07-01 -->\n条目一\n\n<!-- mem:m-2 2026-07-02 -->\n条目二（多行\n第二行）\n`
    const doc = parseBoundedMemoryMarkdown(text)
    const doc2 = parseBoundedMemoryMarkdown(serializeBoundedMemoryDoc(doc))
    assert.equal(doc2.legacyPreamble, doc.legacyPreamble)
    assert.deepEqual(doc2.entries, doc.entries)
  })

  it('空文件 → 空文档，序列化为空串', () => {
    const doc = parseBoundedMemoryMarkdown('')
    assert.equal(doc.legacyPreamble, '')
    assert.equal(doc.entries.length, 0)
    assert.equal(serializeBoundedMemoryDoc(doc), '')
  })
})

describe('bounded-store 原子操作与预算强制', () => {
  const empty: BoundedMemoryDoc = { legacyPreamble: '', entries: [] }

  it('add 生成条目并返回 id', () => {
    const res = applyBoundedMemoryOp(empty, { type: 'add', content: '用户偏好中文' }, 500)
    assert.ok(res.ok)
    if (res.ok) {
      assert.equal(res.doc.entries.length, 1)
      assert.match(res.entryId, /^m-\d{8}-[a-z0-9]{4}$/)
      assert.equal(res.doc.entries[0].content, '用户偏好中文')
    }
  })

  it('预算满时 add 被拒绝（预算即遗忘：结构强制，不是 prompt 恳求）', () => {
    const base = applyBoundedMemoryOp(empty, { type: 'add', content: 'x'.repeat(400) }, 500)
    assert.ok(base.ok)
    if (!base.ok) return
    const res = applyBoundedMemoryOp(base.doc, { type: 'add', content: 'y'.repeat(200) }, 500)
    assert.equal(res.ok, false)
    if (!res.ok) {
      // 错误信息必须包含现有条目清单，让 LLM 能选择删除对象
      assert.ok(res.error.includes('预算已满'))
      assert.ok(res.error.includes(base.doc.entries[0].id))
    }
  })

  it('remove 永远允许且返回被删原文（遗忘留痕）', () => {
    const base = applyBoundedMemoryOp(empty, { type: 'add', content: '要被遗忘的内容' }, 500)
    assert.ok(base.ok)
    if (!base.ok) return
    const res = applyBoundedMemoryOp(base.doc, { type: 'remove', id: base.entryId }, 500)
    assert.ok(res.ok)
    if (res.ok) {
      assert.equal(res.doc.entries.length, 0)
      assert.equal(res.forgotten, '要被遗忘的内容')
    }
  })

  it('replace 更新内容 + 返回被覆盖原文；超预算的 replace 被拒绝', () => {
    const base = applyBoundedMemoryOp(empty, { type: 'add', content: '旧内容' }, 500)
    assert.ok(base.ok)
    if (!base.ok) return
    const ok = applyBoundedMemoryOp(base.doc, { type: 'replace', id: base.entryId, content: '新内容' }, 500)
    assert.ok(ok.ok)
    if (ok.ok) {
      assert.equal(ok.doc.entries[0].content, '新内容')
      assert.equal(ok.forgotten, '旧内容')
    }
    const tooBig = applyBoundedMemoryOp(base.doc, { type: 'replace', id: base.entryId, content: 'z'.repeat(600) }, 500)
    assert.equal(tooBig.ok, false)
  })

  it('replace/remove 不存在的 id 报错并回显现有条目', () => {
    const base = applyBoundedMemoryOp(empty, { type: 'add', content: '内容' }, 500)
    assert.ok(base.ok)
    if (!base.ok) return
    const res = applyBoundedMemoryOp(base.doc, { type: 'remove', id: 'm-nonexistent' }, 500)
    assert.equal(res.ok, false)
    if (!res.ok) assert.ok(res.error.includes(base.entryId))
  })

  it('单条超过 MAX_BOUNDED_ENTRY_CHARS 被拒绝（防单条吃掉整个预算）', () => {
    const res = applyBoundedMemoryOp(
      empty,
      { type: 'add', content: 'x'.repeat(MAX_BOUNDED_ENTRY_CHARS + 1) },
      MAX_MEMORY_CHAR_BUDGET,
    )
    assert.equal(res.ok, false)
  })

  it('legacy 块计入预算但结构上不可被 op 编辑（绝不破坏用户既有记忆）', () => {
    const doc = parseBoundedMemoryMarkdown(LEGACY_TEXT)
    const legacyChars = boundedMemoryChars(doc)
    assert.ok(legacyChars > 0)
    // 预算刚好只够 legacy：add 被拒，但 legacy 原文毫发无损
    const res = applyBoundedMemoryOp(doc, { type: 'add', content: '新条目' }, legacyChars + 2)
    assert.equal(res.ok, false)
    assert.ok(doc.legacyPreamble.includes('优先做工商储'))
    // remove 无法指到 legacy（没有 id），只会报"不存在"
    const rm = applyBoundedMemoryOp(doc, { type: 'remove', id: 'any' }, 5000)
    assert.equal(rm.ok, false)
  })
})

describe('bounded-store 用量表头与文件 IO', () => {
  it('formatMemoryUsageHeader 输出规格形态 [82% — 1,804/2,200 chars]', () => {
    assert.equal(formatMemoryUsageHeader(1804, 2200), '[82% — 1,804/2,200 chars]')
    assert.equal(formatMemoryUsageHeader(0, 5000), '[0% — 0/5,000 chars]')
  })

  it('readBoundedMemoryFile 不存在 → 空文档；writeBoundedMemoryFileAtomic 可回读', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-bounded-mem-'))
    const file = path.join(dir, 'memory', 'MEMORY.md')
    assert.deepEqual(readBoundedMemoryFile(file), { legacyPreamble: '', entries: [] })
    const doc: BoundedMemoryDoc = {
      legacyPreamble: '# 旧内容',
      entries: [{ id: 'm-1', date: '2026-07-05', content: '条目' }],
    }
    writeBoundedMemoryFileAtomic(file, doc)
    const back = readBoundedMemoryFile(file)
    assert.equal(back.legacyPreamble, '# 旧内容')
    assert.deepEqual(back.entries, doc.entries)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('resolveMemoryCharBudget：缺配置用默认值，配置越界 clamp', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-budget-'))
    fs.mkdirSync(path.join(root, 'a1'), { recursive: true })
    assert.equal(resolveMemoryCharBudget(root, 'a1'), DEFAULT_MEMORY_CHAR_BUDGET)
    fs.writeFileSync(path.join(root, 'a1', 'avatar.config.json'), JSON.stringify({ memoryCharBudget: 6000 }))
    assert.equal(resolveMemoryCharBudget(root, 'a1'), 6000)
    fs.writeFileSync(path.join(root, 'a1', 'avatar.config.json'), JSON.stringify({ memoryCharBudget: 10 }))
    assert.equal(resolveMemoryCharBudget(root, 'a1'), MIN_MEMORY_CHAR_BUDGET)
    fs.rmSync(root, { recursive: true, force: true })
  })
})

describe('memory-review 响应解析（后台复盘的零 LLM 侧）', () => {
  it('合法 JSON ops 全部解析', () => {
    const r = parseMemoryReviewResponse(
      '{"ops":[{"store":"memory","op":"add","content":"A"},{"store":"user","op":"replace","id":"m-1","content":"B"},{"store":"memory","op":"remove","id":"m-2"}]}',
    )
    assert.equal(r.nothingToSave, false)
    assert.equal(r.ops.length, 3)
    assert.deepEqual(r.ops[2], { store: 'memory', op: { type: 'remove', id: 'm-2' } })
  })

  it('```json 围栏与前后杂文字被容忍（弱模型输出常态）', () => {
    const r = parseMemoryReviewResponse('好的，以下是结果：\n```json\n{"ops":[{"store":"user","op":"add","content":"偏好简洁"}]}\n```\n以上。')
    assert.equal(r.ops.length, 1)
    assert.equal(r.ops[0].store, 'user')
  })

  it('"Nothing to save" 合法：空 ops / 非 JSON 文本都归为 nothingToSave 而非报错', () => {
    assert.equal(parseMemoryReviewResponse('{"ops":[]}').nothingToSave, true)
    assert.equal(parseMemoryReviewResponse('Nothing to save').nothingToSave, true)
    assert.equal(parseMemoryReviewResponse('').nothingToSave, true)
  })

  it('非法 op 逐条丢弃且 ops 总数被 cap（防 LLM 倾倒）', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ store: 'memory', op: 'add', content: `c${i}` }))
    const withBad = [{ store: 'evil', op: 'add', content: 'x' }, { store: 'memory', op: 'add' }, ...many]
    const r = parseMemoryReviewResponse(JSON.stringify({ ops: withBad }))
    assert.equal(r.ops.length, MEMORY_REVIEW_MAX_OPS)
    assert.ok(r.ops.every(o => o.store === 'memory'))
  })

  it('buildMemoryReviewUserPrompt 带用量表头 + 条目 id（LLM 能选 remove 对象）', () => {
    const memoryDoc = parseBoundedMemoryMarkdown('<!-- mem:m-abc 2026-07-01 -->\n用户在上海\n')
    const prompt = buildMemoryReviewUserPrompt({
      memoryDoc,
      userDoc: { legacyPreamble: '', entries: [] },
      memoryBudget: 5000,
      userBudget: 5000,
      transcript: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好，我是分身' },
      ],
    })
    assert.ok(prompt.includes('id=m-abc'))
    assert.ok(prompt.includes('chars]'))
    assert.ok(prompt.includes('用户: 你好'))
  })
})
