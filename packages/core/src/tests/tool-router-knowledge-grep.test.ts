/**
 * tool-router knowledge_grep / knowledge_glob 单测
 *
 * 验证红线 + 核心场景：
 *   - knowledge_grep 命中分身 knowledge/ 下的 .md 文件
 *   - 仅扫文本类文件（.md/.txt/.json/.yaml），跳过 .png / .pdf 等二进制
 *   - scope 路径穿越攻击（../ / 绝对路径）拒绝
 *   - 硬上限（max_per_file / max_total）生效
 *   - knowledge_glob 支持 ** / *
 *   - 知识库目录不存在时优雅返回（空 matches/files，不抛）
 *
 * @author zhi.qu
 * @date 2026-05-18
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { ToolRouter } from '../tool-router'

const AVATAR_ID = 'kgrep-test'

function setupSandbox(): { avatarsPath: string; knowledgePath: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-kgrep-'))
  const avatarsPath = path.join(root, 'avatars')
  const knowledgePath = path.join(avatarsPath, AVATAR_ID, 'knowledge')
  fs.mkdirSync(knowledgePath, { recursive: true })
  return {
    avatarsPath,
    knowledgePath,
    cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* noop */ } },
  }
}

function parseJsonContent<T = unknown>(content: string): T {
  return JSON.parse(content) as T
}

// ─── knowledge_grep ────────────────────────────────────────────────────────

test('knowledge_grep 命中分身 knowledge/ 下 .md 文件', async () => {
  const { avatarsPath, knowledgePath, cleanup } = setupSandbox()
  const router = new ToolRouter(avatarsPath)
  try {
    fs.writeFileSync(path.join(knowledgePath, 'a.md'), '上海电价峰谷价差 0.83 元/kWh\n另一行', 'utf-8')
    fs.writeFileSync(path.join(knowledgePath, 'b.md'), '广州电价峰平段 0.55 元/kWh', 'utf-8')

    const r = await router.execute(AVATAR_ID, { name: 'knowledge_grep', arguments: { pattern: '峰谷' } })
    assert.equal(r.error, undefined, `不应有错误: ${r.error ?? ''}`)
    const out = parseJsonContent<{ count: number; matches: Array<{ file: string; line: number; text: string }> }>(r.content)
    assert.equal(out.count, 1)
    assert.equal(out.matches[0].file, 'knowledge/a.md')
    assert.equal(out.matches[0].line, 1)
    assert.match(out.matches[0].text, /峰谷/)
  } finally {
    cleanup()
  }
})

// A1 溯源闭集：grep 命中必须携带行级来源锚点，否则 grep 检索到的内容
// 无法进入"本轮已下发 anchor 集合"，回答引用它会被 verifier 误报集合外违规。
test('knowledge_grep 命中条目携带行级 [来源: ...] 锚点（A1 溯源闭集）', async () => {
  const { avatarsPath, knowledgePath, cleanup } = setupSandbox()
  const router = new ToolRouter(avatarsPath)
  try {
    fs.writeFileSync(path.join(knowledgePath, 'a.md'), '第一行\n上海电价峰谷价差 0.83 元/kWh', 'utf-8')

    const r = await router.execute(AVATAR_ID, { name: 'knowledge_grep', arguments: { pattern: '峰谷' } })
    assert.equal(r.error, undefined, `不应有错误: ${r.error ?? ''}`)
    const out = parseJsonContent<{ matches: Array<{ file: string; line: number; anchor?: string }> }>(r.content)
    assert.equal(out.matches.length, 1)
    assert.equal(out.matches[0].anchor, '[来源: knowledge/a.md#L2]')
  } finally {
    cleanup()
  }
})

test('knowledge_grep 跳过二进制文件（仅扫 .md/.txt/.json/.yaml）', async () => {
  const { avatarsPath, knowledgePath, cleanup } = setupSandbox()
  const router = new ToolRouter(avatarsPath)
  try {
    fs.writeFileSync(path.join(knowledgePath, 'text.md'), 'pattern-target', 'utf-8')
    // 假装的 PDF / PNG 文件，含 pattern 但应被跳过
    fs.writeFileSync(path.join(knowledgePath, 'doc.pdf'), 'pattern-target', 'utf-8')
    fs.writeFileSync(path.join(knowledgePath, 'image.png'), 'pattern-target', 'utf-8')

    const r = await router.execute(AVATAR_ID, { name: 'knowledge_grep', arguments: { pattern: 'pattern-target' } })
    const out = parseJsonContent<{ count: number; matches: Array<{ file: string }> }>(r.content)
    assert.equal(out.count, 1, '应只命中 .md 一个')
    assert.equal(out.matches[0].file, 'knowledge/text.md')
  } finally {
    cleanup()
  }
})

test('knowledge_grep 缺 pattern 报错', async () => {
  const { avatarsPath, cleanup } = setupSandbox()
  const router = new ToolRouter(avatarsPath)
  try {
    const r = await router.execute(AVATAR_ID, { name: 'knowledge_grep', arguments: {} })
    assert.ok(r.error, '应返回错误')
    assert.match(r.error!, /pattern/)
  } finally {
    cleanup()
  }
})

test('knowledge_grep 非法正则降级为错误（不抛）', async () => {
  const { avatarsPath, cleanup } = setupSandbox()
  const router = new ToolRouter(avatarsPath)
  try {
    const r = await router.execute(AVATAR_ID, { name: 'knowledge_grep', arguments: { pattern: '[unclosed' } })
    assert.ok(r.error, '非法正则应返回错误')
    assert.match(r.error!, /非法正则/)
  } finally {
    cleanup()
  }
})

test('knowledge_grep scope 路径穿越拒绝', async () => {
  const { avatarsPath, knowledgePath, cleanup } = setupSandbox()
  const router = new ToolRouter(avatarsPath)
  try {
    fs.writeFileSync(path.join(knowledgePath, 'a.md'), 'data', 'utf-8')
    // 尝试用 ../ 跳出 knowledge/
    const r = await router.execute(AVATAR_ID, {
      name: 'knowledge_grep',
      arguments: { pattern: 'data', scope: '../../etc' },
    })
    assert.ok(r.error, '路径穿越应被拒绝')
  } finally {
    cleanup()
  }
})

test('knowledge_grep max_per_file 硬上限生效', async () => {
  const { avatarsPath, knowledgePath, cleanup } = setupSandbox()
  const router = new ToolRouter(avatarsPath)
  try {
    // 写一个含 300 行同 pattern 的大文件
    const lines = Array.from({ length: 300 }, () => 'pattern-line-xxx')
    fs.writeFileSync(path.join(knowledgePath, 'big.md'), lines.join('\n'), 'utf-8')

    const r = await router.execute(AVATAR_ID, {
      name: 'knowledge_grep',
      arguments: { pattern: 'pattern-line', max_per_file: 10 },
    })
    const out = parseJsonContent<{ count: number; matches: unknown[] }>(r.content)
    assert.equal(out.count, 10, 'max_per_file=10 时应只返回 10 条')
  } finally {
    cleanup()
  }
})

test('knowledge_grep max_total 硬上限触发 truncated', async () => {
  const { avatarsPath, knowledgePath, cleanup } = setupSandbox()
  const router = new ToolRouter(avatarsPath)
  try {
    // 多个文件每文件多行
    for (let i = 0; i < 10; i++) {
      const lines = Array.from({ length: 50 }, () => 'pattern-X')
      fs.writeFileSync(path.join(knowledgePath, `f${i}.md`), lines.join('\n'), 'utf-8')
    }
    const r = await router.execute(AVATAR_ID, {
      name: 'knowledge_grep',
      arguments: { pattern: 'pattern-X', max_per_file: 50, max_total: 100 },
    })
    const out = parseJsonContent<{ count: number; truncated: boolean }>(r.content)
    assert.equal(out.count, 100)
    assert.equal(out.truncated, true)
  } finally {
    cleanup()
  }
})

test('knowledge_grep 知识库目录不存在 → 优雅返回 count=0', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-kgrep-empty-'))
  const avatarsPath = path.join(root, 'avatars')
  // 不创建 knowledge/
  fs.mkdirSync(path.join(avatarsPath, AVATAR_ID), { recursive: true })
  const router = new ToolRouter(avatarsPath)
  try {
    const r = await router.execute(AVATAR_ID, { name: 'knowledge_grep', arguments: { pattern: 'x' } })
    const out = parseJsonContent<{ count: number; matches: unknown[] }>(r.content)
    assert.equal(out.count, 0, '空 knowledge 应返回 count=0')
    assert.equal(out.matches.length, 0)
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* noop */ }
  }
})

test('knowledge_grep ripgrep 与 node 回退命中集合一致（parity）', async () => {
  const { avatarsPath, knowledgePath, cleanup } = setupSandbox()
  const router = new ToolRouter(avatarsPath)
  const pathBak = process.env.PATH
  try {
    fs.mkdirSync(path.join(knowledgePath, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(knowledgePath, 'a.md'), '峰时 1.156\n谷时 0.286\n峰时 0.99', 'utf-8')
    fs.writeFileSync(path.join(knowledgePath, 'sub', 'b.md'), 'IEC62619 峰时\n无关行', 'utf-8')

    const key = (m: { file: string; line: number }) => `${m.file}:${m.line}`
    type Out = { engine: string; matches: Array<{ file: string; line: number }> }

    // 默认引擎（CI 有 rg 则 ripgrep，无则 node）
    const normal = parseJsonContent<Out>(
      (await router.execute(AVATAR_ID, { name: 'knowledge_grep', arguments: { pattern: '峰时' } })).content)

    // 抹掉 PATH → execFileSync('rg') ENOENT → 强制 node 回退
    process.env.PATH = path.join(avatarsPath, 'no-such-bin')
    const fallback = parseJsonContent<Out>(
      (await router.execute(AVATAR_ID, { name: 'knowledge_grep', arguments: { pattern: '峰时' } })).content)

    assert.equal(fallback.engine, 'node', 'PATH 抹掉后必须回退 node 引擎')
    // 两条后端路径的命中集合必须逐条一致——这是 ripgrep 升级不得改变行为的硬不变量
    assert.deepEqual(
      normal.matches.map(key).sort(),
      fallback.matches.map(key).sort(),
      'ripgrep 与 node 回退的命中集合必须完全一致',
    )
    assert.equal(fallback.matches.length, 3, '峰时 应命中 a.md 两行 + b.md 一行')
  } finally {
    process.env.PATH = pathBak
    cleanup()
  }
})

test('knowledge_grep JS-only 正则（lookahead）回退 node 仍正确', async () => {
  const { avatarsPath, knowledgePath, cleanup } = setupSandbox()
  const router = new ToolRouter(avatarsPath)
  try {
    fs.writeFileSync(path.join(knowledgePath, 'a.md'), '峰时电价 1.156\n峰时段说明\n谷时电价', 'utf-8')
    // 前瞻断言：rg 的 Rust 引擎不支持 lookahead（exit 2）→ 必须回退到支持它的 node 正则
    const r = await router.execute(AVATAR_ID, { name: 'knowledge_grep', arguments: { pattern: '峰时(?=电价)' } })
    const out = parseJsonContent<{ engine: string; count: number; matches: Array<{ line: number }> }>(r.content)
    assert.equal(out.engine, 'node', 'lookahead 必须回退 node 引擎')
    assert.equal(out.count, 1, '只命中"峰时电价"，不命中"峰时段"')
    assert.equal(out.matches[0].line, 1)
  } finally {
    cleanup()
  }
})

// ─── knowledge_glob ────────────────────────────────────────────────────────

test('knowledge_glob 命中 ** 跨目录模式', async () => {
  const { avatarsPath, knowledgePath, cleanup } = setupSandbox()
  const router = new ToolRouter(avatarsPath)
  try {
    fs.writeFileSync(path.join(knowledgePath, '上海电价.md'), 'x', 'utf-8')
    fs.mkdirSync(path.join(knowledgePath, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(knowledgePath, 'sub', '电价对比.md'), 'x', 'utf-8')
    fs.writeFileSync(path.join(knowledgePath, '其他.md'), 'x', 'utf-8')

    const r = await router.execute(AVATAR_ID, {
      name: 'knowledge_glob',
      arguments: { pattern: '**/*电价*.md' },
    })
    const out = parseJsonContent<{ count: number; files: string[] }>(r.content)
    assert.equal(out.count, 2, '应命中 2 个名字含电价的文件')
    assert.ok(out.files.includes('knowledge/上海电价.md'))
    assert.ok(out.files.includes('knowledge/sub/电价对比.md'))
  } finally {
    cleanup()
  }
})

test('knowledge_glob 缺 pattern 报错', async () => {
  const { avatarsPath, cleanup } = setupSandbox()
  const router = new ToolRouter(avatarsPath)
  try {
    const r = await router.execute(AVATAR_ID, { name: 'knowledge_glob', arguments: {} })
    assert.ok(r.error)
    assert.match(r.error!, /pattern/)
  } finally {
    cleanup()
  }
})

test('knowledge_glob 文件名匹配（不带 **，*.md 直接命中根级）', async () => {
  const { avatarsPath, knowledgePath, cleanup } = setupSandbox()
  const router = new ToolRouter(avatarsPath)
  try {
    fs.writeFileSync(path.join(knowledgePath, 'a.md'), 'x', 'utf-8')
    fs.writeFileSync(path.join(knowledgePath, 'b.txt'), 'x', 'utf-8')

    const r = await router.execute(AVATAR_ID, { name: 'knowledge_glob', arguments: { pattern: '*.md' } })
    const out = parseJsonContent<{ count: number; files: string[] }>(r.content)
    assert.ok(out.count >= 1, '*.md 应命中根级 a.md')
    assert.ok(out.files.includes('knowledge/a.md'))
  } finally {
    cleanup()
  }
})
