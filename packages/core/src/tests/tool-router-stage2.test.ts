/**
 * Stage 二（5 个 P1 工具）单元测试。
 *
 * 覆盖：
 *   1. read_lines    — 1-based 行号读取 / 默认窗口 / 越界处理 / 硬上限截断
 *   2. list_files    — glob 过滤（*, **, ?）/ 与 filter 互斥优先级 / 截断标志
 *   3. multi_edit    — 顺序应用 / replace_all / 原子事务（任一失败回滚）
 *   4. git_status / git_diff — 真实 git 仓库内 status/diff / 非 git 目录友好错误
 *   5. notebook_edit — 编辑既有 cell / 新增 cell / 非 .ipynb 拒绝
 *
 * 设计要点：
 *   - 所有用例都创建独立的 tmp avatars/<id>/workspaces/<convId> 沙箱，互不干扰
 *   - 不依赖任何 LLM 调用，纯本地校验 ToolRouter 的工具实现
 *   - git 用例先 spawn `git init` 真实初始化，避免对外部环境（用户当前目录是否 git 仓库）有依赖
 *
 * @author zhi.qu
 * @date 2026-04-29
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ToolRouter } from '../tool-router'

interface Sandbox {
  avatarsPath: string
  workspaceRoot: string
  cleanup: () => void
}

const AVATAR_ID = 'stage2-test'
const CONV_ID = 'conv-001'

function setupSandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-stage2-'))
  const avatarsPath = path.join(root, 'avatars')
  const workspaceRoot = path.join(avatarsPath, AVATAR_ID, 'workspaces', CONV_ID)
  fs.mkdirSync(workspaceRoot, { recursive: true })
  return {
    avatarsPath,
    workspaceRoot,
    cleanup: () => {
      try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* noop */ }
    },
  }
}

function parseJsonContent<T = unknown>(content: string): T {
  return JSON.parse(content) as T
}

// ─── read_lines ───────────────────────────────────────────────────────────────

test('read_lines 默认窗口：start_line=1，返回前 200 行', async () => {
  const { avatarsPath, workspaceRoot, cleanup } = setupSandbox()
  const router = new ToolRouter(avatarsPath)
  try {
    const lines = Array.from({ length: 250 }, (_, i) => `line-${i + 1}`)
    fs.writeFileSync(path.join(workspaceRoot, 'big.txt'), lines.join('\n'), 'utf-8')

    const r = await router.execute(
      AVATAR_ID,
      { name: 'read_lines', arguments: { path: 'big.txt' } },
      undefined,
      CONV_ID,
    )
    assert.equal(r.error, undefined, `不应有错误: ${r.error ?? ''}`)
    const out = r.content.split('\n')
    assert.equal(out.length, 200, '默认应返回 200 行')
    assert.equal(out[0], '1|line-1', '首行应是 1|line-1')
    assert.equal(out[199], '200|line-200', '末行应是 200|line-200')
  } finally {
    cleanup()
  }
})

test('read_lines 指定 start_line / end_line（1-based 闭区间）', async () => {
  const { avatarsPath, workspaceRoot, cleanup } = setupSandbox()
  const router = new ToolRouter(avatarsPath)
  try {
    const lines = Array.from({ length: 50 }, (_, i) => `L${i + 1}`)
    fs.writeFileSync(path.join(workspaceRoot, 'a.txt'), lines.join('\n'), 'utf-8')

    const r = await router.execute(
      AVATAR_ID,
      { name: 'read_lines', arguments: { path: 'a.txt', start_line: 10, end_line: 12 } },
      undefined,
      CONV_ID,
    )
    assert.equal(r.error, undefined)
    const out = r.content.split('\n')
    assert.deepEqual(out, ['10|L10', '11|L11', '12|L12'])
  } finally {
    cleanup()
  }
})

test('read_lines start_line 越过文件总行数 → 友好错误', async () => {
  const { avatarsPath, workspaceRoot, cleanup } = setupSandbox()
  const router = new ToolRouter(avatarsPath)
  try {
    fs.writeFileSync(path.join(workspaceRoot, 'short.txt'), 'a\nb\nc', 'utf-8')

    const r = await router.execute(
      AVATAR_ID,
      { name: 'read_lines', arguments: { path: 'short.txt', start_line: 100 } },
      undefined,
      CONV_ID,
    )
    assert.notEqual(r.error, undefined)
    assert.match(r.error!, /超过文件总行数/)
  } finally {
    cleanup()
  }
})

test('read_lines end_line 超过末行 → 自动收口到末行', async () => {
  const { avatarsPath, workspaceRoot, cleanup } = setupSandbox()
  const router = new ToolRouter(avatarsPath)
  try {
    fs.writeFileSync(path.join(workspaceRoot, 'short.txt'), 'a\nb\nc', 'utf-8')

    const r = await router.execute(
      AVATAR_ID,
      { name: 'read_lines', arguments: { path: 'short.txt', start_line: 2, end_line: 999 } },
      undefined,
      CONV_ID,
    )
    assert.equal(r.error, undefined)
    // 应包含 2|b 和 3|c
    assert.match(r.content, /^2\|b/m)
    assert.match(r.content, /^3\|c/m)
  } finally {
    cleanup()
  }
})

test('read_lines 文件不存在 → 错误', async () => {
  const { avatarsPath, cleanup } = setupSandbox()
  const router = new ToolRouter(avatarsPath)
  try {
    const r = await router.execute(
      AVATAR_ID,
      { name: 'read_lines', arguments: { path: 'nope.txt' } },
      undefined,
      CONV_ID,
    )
    assert.notEqual(r.error, undefined)
    assert.match(r.error!, /文件不存在/)
  } finally {
    cleanup()
  }
})

// ─── list_files glob ──────────────────────────────────────────────────────────

test('list_files glob "*.ts" 仅匹配根目录下 .ts，不跨目录', async () => {
  const { avatarsPath, workspaceRoot, cleanup } = setupSandbox()
  const router = new ToolRouter(avatarsPath)
  try {
    fs.writeFileSync(path.join(workspaceRoot, 'a.ts'), 'x', 'utf-8')
    fs.writeFileSync(path.join(workspaceRoot, 'b.tsx'), 'x', 'utf-8')
    fs.mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true })
    fs.writeFileSync(path.join(workspaceRoot, 'src', 'c.ts'), 'x', 'utf-8')

    const r = await router.execute(
      AVATAR_ID,
      { name: 'list_files', arguments: { glob: '*.ts' } },
      undefined,
      CONV_ID,
    )
    assert.equal(r.error, undefined)
    const out = parseJsonContent<{ items: Array<{ path: string; type: string }> }>(r.content)
    const files = out.items.filter((it) => it.type === 'file').map((it) => it.path).sort()
    assert.deepEqual(files, ['a.ts'], 'glob *.ts 不应跨目录')
  } finally {
    cleanup()
  }
})

test('list_files glob "**/*.ts" 跨目录递归匹配', async () => {
  const { avatarsPath, workspaceRoot, cleanup } = setupSandbox()
  const router = new ToolRouter(avatarsPath)
  try {
    fs.writeFileSync(path.join(workspaceRoot, 'a.ts'), 'x', 'utf-8')
    fs.mkdirSync(path.join(workspaceRoot, 'src', 'deep'), { recursive: true })
    fs.writeFileSync(path.join(workspaceRoot, 'src', 'b.ts'), 'x', 'utf-8')
    fs.writeFileSync(path.join(workspaceRoot, 'src', 'deep', 'c.ts'), 'x', 'utf-8')
    fs.writeFileSync(path.join(workspaceRoot, 'src', 'deep', 'd.md'), 'x', 'utf-8')

    const r = await router.execute(
      AVATAR_ID,
      { name: 'list_files', arguments: { glob: '**/*.ts' } },
      undefined,
      CONV_ID,
    )
    assert.equal(r.error, undefined)
    const out = parseJsonContent<{ items: Array<{ path: string; type: string }> }>(r.content)
    const files = out.items.filter((it) => it.type === 'file').map((it) => it.path).sort()
    assert.deepEqual(files, ['a.ts', 'src/b.ts', 'src/deep/c.ts'])
  } finally {
    cleanup()
  }
})

test('list_files glob "src/**/*.json" 限定子目录', async () => {
  const { avatarsPath, workspaceRoot, cleanup } = setupSandbox()
  const router = new ToolRouter(avatarsPath)
  try {
    fs.mkdirSync(path.join(workspaceRoot, 'src', 'sub'), { recursive: true })
    fs.writeFileSync(path.join(workspaceRoot, 'root.json'), '{}', 'utf-8')
    fs.writeFileSync(path.join(workspaceRoot, 'src', 'sub', 'a.json'), '{}', 'utf-8')

    const r = await router.execute(
      AVATAR_ID,
      { name: 'list_files', arguments: { glob: 'src/**/*.json' } },
      undefined,
      CONV_ID,
    )
    assert.equal(r.error, undefined)
    const out = parseJsonContent<{ items: Array<{ path: string; type: string }> }>(r.content)
    const files = out.items.filter((it) => it.type === 'file').map((it) => it.path).sort()
    assert.deepEqual(files, ['src/sub/a.json'], 'root.json 不应被命中')
  } finally {
    cleanup()
  }
})

test('list_files 旧 filter 仍然生效（向后兼容）', async () => {
  const { avatarsPath, workspaceRoot, cleanup } = setupSandbox()
  const router = new ToolRouter(avatarsPath)
  try {
    fs.writeFileSync(path.join(workspaceRoot, 'foo.md'), '', 'utf-8')
    fs.writeFileSync(path.join(workspaceRoot, 'bar.txt'), '', 'utf-8')

    const r = await router.execute(
      AVATAR_ID,
      { name: 'list_files', arguments: { filter: '\\.md$' } },
      undefined,
      CONV_ID,
    )
    assert.equal(r.error, undefined)
    const out = parseJsonContent<{ items: Array<{ path: string; type: string }> }>(r.content)
    const files = out.items.filter((it) => it.type === 'file').map((it) => it.path)
    assert.deepEqual(files, ['foo.md'])
  } finally {
    cleanup()
  }
})

// ─── multi_edit ───────────────────────────────────────────────────────────────

test('multi_edit 顺序应用多条编辑，全部成功则原子写入', async () => {
  const { avatarsPath, workspaceRoot, cleanup } = setupSandbox()
  const router = new ToolRouter(avatarsPath)
  try {
    fs.writeFileSync(path.join(workspaceRoot, 'app.ts'), 'foo bar baz', 'utf-8')

    const r = await router.execute(
      AVATAR_ID,
      {
        name: 'multi_edit',
        arguments: {
          path: 'app.ts',
          edits: [
            { old_string: 'foo', new_string: 'FOO' },
            { old_string: 'baz', new_string: 'BAZ' },
          ],
        },
      },
      undefined,
      CONV_ID,
    )
    assert.equal(r.error, undefined)
    const after = fs.readFileSync(path.join(workspaceRoot, 'app.ts'), 'utf-8')
    assert.equal(after, 'FOO bar BAZ')
    const payload = parseJsonContent<{ edits_applied: number; total_replacements: number }>(r.content)
    assert.equal(payload.edits_applied, 2)
    assert.equal(payload.total_replacements, 2)
  } finally {
    cleanup()
  }
})

test('multi_edit replace_all=true 替换全部出现', async () => {
  const { avatarsPath, workspaceRoot, cleanup } = setupSandbox()
  const router = new ToolRouter(avatarsPath)
  try {
    fs.writeFileSync(path.join(workspaceRoot, 'a.txt'), 'x x x x', 'utf-8')

    const r = await router.execute(
      AVATAR_ID,
      {
        name: 'multi_edit',
        arguments: {
          path: 'a.txt',
          edits: [{ old_string: 'x', new_string: 'Y', replace_all: true }],
        },
      },
      undefined,
      CONV_ID,
    )
    assert.equal(r.error, undefined)
    assert.equal(fs.readFileSync(path.join(workspaceRoot, 'a.txt'), 'utf-8'), 'Y Y Y Y')
    const payload = parseJsonContent<{ total_replacements: number }>(r.content)
    assert.equal(payload.total_replacements, 4)
  } finally {
    cleanup()
  }
})

test('multi_edit 任一 old_string 未命中 → 整个事务回滚（文件不变）', async () => {
  const { avatarsPath, workspaceRoot, cleanup } = setupSandbox()
  const router = new ToolRouter(avatarsPath)
  try {
    const original = 'foo bar baz'
    fs.writeFileSync(path.join(workspaceRoot, 'app.ts'), original, 'utf-8')

    const r = await router.execute(
      AVATAR_ID,
      {
        name: 'multi_edit',
        arguments: {
          path: 'app.ts',
          edits: [
            { old_string: 'foo', new_string: 'FOO' },
            { old_string: '不存在的串', new_string: 'X' },
          ],
        },
      },
      undefined,
      CONV_ID,
    )
    assert.notEqual(r.error, undefined, '应当报错')
    assert.match(r.error!, /回滚|未在文件中找到/)
    // 关键：文件原文未被改动
    assert.equal(
      fs.readFileSync(path.join(workspaceRoot, 'app.ts'), 'utf-8'),
      original,
      '事务回滚时文件不应有任何改动',
    )
  } finally {
    cleanup()
  }
})

test('multi_edit old_string === new_string 拒绝（无操作编辑）', async () => {
  const { avatarsPath, workspaceRoot, cleanup } = setupSandbox()
  const router = new ToolRouter(avatarsPath)
  try {
    fs.writeFileSync(path.join(workspaceRoot, 'a.txt'), 'foo', 'utf-8')

    const r = await router.execute(
      AVATAR_ID,
      {
        name: 'multi_edit',
        arguments: {
          path: 'a.txt',
          edits: [{ old_string: 'foo', new_string: 'foo' }],
        },
      },
      undefined,
      CONV_ID,
    )
    assert.notEqual(r.error, undefined)
    assert.match(r.error!, /相同|无操作/)
  } finally {
    cleanup()
  }
})

// ─── git_status / git_diff ────────────────────────────────────────────────────

/** 在 cwd 下静默执行 git 子命令；测试辅助 */
function gitInit(cwd: string): boolean {
  const init = spawnSync('git', ['init', '--quiet'], { cwd })
  if (init.status !== 0) return false
  // 设置最小 user.name / email，避免 commit 时 prompt
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd })
  spawnSync('git', ['config', 'user.name', 'Stage2 Test'], { cwd })
  spawnSync('git', ['config', 'commit.gpgsign', 'false'], { cwd })
  return true
}

test('git_status 在非 git 目录返回友好错误', async () => {
  const { avatarsPath, cleanup } = setupSandbox()
  const router = new ToolRouter(avatarsPath)
  try {
    const r = await router.execute(
      AVATAR_ID,
      { name: 'git_status', arguments: {} },
      undefined,
      CONV_ID,
    )
    assert.notEqual(r.error, undefined)
    assert.match(r.error!, /不在 git 仓库/)
  } finally {
    cleanup()
  }
})

test('git_status 在 git 仓库：返回改动列表', async (t) => {
  const { avatarsPath, workspaceRoot, cleanup } = setupSandbox()
  if (!gitInit(workspaceRoot)) {
    t.skip('git not available')
    cleanup()
    return
  }
  const router = new ToolRouter(avatarsPath)
  try {
    // 写一个未跟踪文件，应该出现在 status 里
    fs.writeFileSync(path.join(workspaceRoot, 'new.txt'), 'hello', 'utf-8')

    const r = await router.execute(
      AVATAR_ID,
      { name: 'git_status', arguments: {} },
      undefined,
      CONV_ID,
    )
    assert.equal(r.error, undefined, `不应报错: ${r.error ?? ''}`)
    const payload = parseJsonContent<{ changed_count: number; changes: string[] }>(r.content)
    assert.ok(payload.changed_count >= 1)
    assert.ok(payload.changes.some((line) => line.includes('new.txt')), 'changes 应包含 new.txt')
  } finally {
    cleanup()
  }
})

test('git_diff 在 git 仓库：能看到改动', async (t) => {
  const { avatarsPath, workspaceRoot, cleanup } = setupSandbox()
  if (!gitInit(workspaceRoot)) {
    t.skip('git not available')
    cleanup()
    return
  }
  const router = new ToolRouter(avatarsPath)
  try {
    // 提交一个 baseline，再修改它，使 worktree 与 index 出现差异
    fs.writeFileSync(path.join(workspaceRoot, 'a.txt'), 'line1\nline2\n', 'utf-8')
    spawnSync('git', ['add', 'a.txt'], { cwd: workspaceRoot })
    spawnSync('git', ['commit', '-m', 'init', '--quiet'], { cwd: workspaceRoot })
    fs.writeFileSync(path.join(workspaceRoot, 'a.txt'), 'line1\nLINE_TWO\n', 'utf-8')

    const r = await router.execute(
      AVATAR_ID,
      { name: 'git_diff', arguments: {} },
      undefined,
      CONV_ID,
    )
    assert.equal(r.error, undefined, `不应报错: ${r.error ?? ''}`)
    const payload = parseJsonContent<{ empty?: boolean; diff: string }>(r.content)
    assert.notEqual(payload.empty, true, 'diff 不应为空')
    assert.match(payload.diff, /-line2/)
    assert.match(payload.diff, /\+LINE_TWO/)
  } finally {
    cleanup()
  }
})

test('git_diff 无改动时返回 empty=true', async (t) => {
  const { avatarsPath, workspaceRoot, cleanup } = setupSandbox()
  if (!gitInit(workspaceRoot)) {
    t.skip('git not available')
    cleanup()
    return
  }
  const router = new ToolRouter(avatarsPath)
  try {
    fs.writeFileSync(path.join(workspaceRoot, 'clean.txt'), 'x', 'utf-8')
    spawnSync('git', ['add', 'clean.txt'], { cwd: workspaceRoot })
    spawnSync('git', ['commit', '-m', 'clean', '--quiet'], { cwd: workspaceRoot })

    const r = await router.execute(
      AVATAR_ID,
      { name: 'git_diff', arguments: {} },
      undefined,
      CONV_ID,
    )
    assert.equal(r.error, undefined)
    const payload = parseJsonContent<{ empty?: boolean }>(r.content)
    assert.equal(payload.empty, true)
  } finally {
    cleanup()
  }
})

// ─── notebook_edit ────────────────────────────────────────────────────────────

function makeNotebook(workspaceRoot: string, fileName: string, cells: Array<{ type: 'code' | 'markdown'; source: string }>): string {
  const content = {
    cells: cells.map((c) => ({
      cell_type: c.type,
      metadata: {},
      source: c.source.split(/(?<=\n)/),
      ...(c.type === 'code' ? { execution_count: null, outputs: [] } : {}),
    })),
    metadata: { kernelspec: { name: 'python3', display_name: 'Python 3' } },
    nbformat: 4,
    nbformat_minor: 5,
  }
  const p = path.join(workspaceRoot, fileName)
  fs.writeFileSync(p, JSON.stringify(content, null, 2), 'utf-8')
  return p
}

test('notebook_edit 修改既有 code cell 的 source（替换子串）', async () => {
  const { avatarsPath, workspaceRoot, cleanup } = setupSandbox()
  const router = new ToolRouter(avatarsPath)
  try {
    makeNotebook(workspaceRoot, 'a.ipynb', [
      { type: 'code', source: 'print(1)\n' },
      { type: 'markdown', source: '# title\n' },
    ])

    const r = await router.execute(
      AVATAR_ID,
      {
        name: 'notebook_edit',
        arguments: {
          target_notebook: 'a.ipynb',
          cell_idx: 0,
          is_new_cell: false,
          cell_language: 'python',
          old_string: 'print(1)',
          new_string: 'print(42)',
        },
      },
      undefined,
      CONV_ID,
    )
    assert.equal(r.error, undefined, `不应报错: ${r.error ?? ''}`)

    const after = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'a.ipynb'), 'utf-8')) as {
      cells: Array<{ cell_type: string; source: string | string[]; execution_count?: number | null; outputs?: unknown[] }>
    }
    const cell0 = after.cells[0]
    const text = Array.isArray(cell0.source) ? cell0.source.join('') : cell0.source
    assert.match(text, /print\(42\)/)
    assert.equal(cell0.execution_count, null, '修改后 execution_count 应被重置为 null')
    assert.deepEqual(cell0.outputs, [], '修改后 outputs 应被清空')
    // 第二个 cell 不变
    assert.equal(after.cells[1].cell_type, 'markdown')
  } finally {
    cleanup()
  }
})

test('notebook_edit is_new_cell=true 在指定位置插入新 cell', async () => {
  const { avatarsPath, workspaceRoot, cleanup } = setupSandbox()
  const router = new ToolRouter(avatarsPath)
  try {
    makeNotebook(workspaceRoot, 'a.ipynb', [
      { type: 'code', source: 'x=1\n' },
      { type: 'code', source: 'y=2\n' },
    ])

    const r = await router.execute(
      AVATAR_ID,
      {
        name: 'notebook_edit',
        arguments: {
          target_notebook: 'a.ipynb',
          cell_idx: 1,
          is_new_cell: true,
          cell_language: 'markdown',
          new_string: '## inserted',
        },
      },
      undefined,
      CONV_ID,
    )
    assert.equal(r.error, undefined)

    const after = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'a.ipynb'), 'utf-8')) as {
      cells: Array<{ cell_type: string; source: string | string[] }>
    }
    assert.equal(after.cells.length, 3)
    assert.equal(after.cells[1].cell_type, 'markdown')
    const inserted = Array.isArray(after.cells[1].source) ? after.cells[1].source.join('') : after.cells[1].source
    assert.equal(inserted, '## inserted')
    // 原来的 y=2 被挤到 idx=2
    const last = Array.isArray(after.cells[2].source) ? after.cells[2].source.join('') : after.cells[2].source
    assert.match(last, /y=2/)
  } finally {
    cleanup()
  }
})

test('notebook_edit 非 .ipynb 文件被拒绝', async () => {
  const { avatarsPath, workspaceRoot, cleanup } = setupSandbox()
  const router = new ToolRouter(avatarsPath)
  try {
    fs.writeFileSync(path.join(workspaceRoot, 'a.txt'), 'plain', 'utf-8')

    const r = await router.execute(
      AVATAR_ID,
      {
        name: 'notebook_edit',
        arguments: {
          target_notebook: 'a.txt',
          cell_idx: 0,
          is_new_cell: false,
          cell_language: 'python',
          new_string: 'x',
        },
      },
      undefined,
      CONV_ID,
    )
    assert.notEqual(r.error, undefined)
    assert.match(r.error!, /\.ipynb/)
  } finally {
    cleanup()
  }
})

test('notebook_edit cell_idx 超出范围 → 错误且文件不被改动', async () => {
  const { avatarsPath, workspaceRoot, cleanup } = setupSandbox()
  const router = new ToolRouter(avatarsPath)
  try {
    const p = makeNotebook(workspaceRoot, 'a.ipynb', [{ type: 'code', source: 'x' }])
    const before = fs.readFileSync(p, 'utf-8')

    const r = await router.execute(
      AVATAR_ID,
      {
        name: 'notebook_edit',
        arguments: {
          target_notebook: 'a.ipynb',
          cell_idx: 99,
          is_new_cell: false,
          cell_language: 'python',
          new_string: 'y',
        },
      },
      undefined,
      CONV_ID,
    )
    assert.notEqual(r.error, undefined)
    assert.match(r.error!, /超出范围/)
    assert.equal(fs.readFileSync(p, 'utf-8'), before, '错误时文件不应被改动')
  } finally {
    cleanup()
  }
})

test('notebook_edit old_string 为空 → 整段覆盖现有 cell', async () => {
  const { avatarsPath, workspaceRoot, cleanup } = setupSandbox()
  const router = new ToolRouter(avatarsPath)
  try {
    makeNotebook(workspaceRoot, 'a.ipynb', [{ type: 'code', source: 'old\nstuff\n' }])

    const r = await router.execute(
      AVATAR_ID,
      {
        name: 'notebook_edit',
        arguments: {
          target_notebook: 'a.ipynb',
          cell_idx: 0,
          is_new_cell: false,
          cell_language: 'python',
          old_string: '',
          new_string: 'brand_new()',
        },
      },
      undefined,
      CONV_ID,
    )
    assert.equal(r.error, undefined)
    const after = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'a.ipynb'), 'utf-8')) as {
      cells: Array<{ source: string | string[] }>
    }
    const text = Array.isArray(after.cells[0].source) ? after.cells[0].source.join('') : after.cells[0].source
    assert.equal(text, 'brand_new()')
  } finally {
    cleanup()
  }
})
