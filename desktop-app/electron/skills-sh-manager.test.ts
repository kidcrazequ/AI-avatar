/**
 * skills-sh-manager.test.ts — SkillsShManager 安全边界单元测试
 *
 * 只测不依赖网络/git 的纯逻辑（通过 `as any` 触达私有方法）：
 * - copyDir 必须跳过 symlink（否则恶意技能仓库可借 symlink 逃逸出安装目录读宿主文件）
 * - copyDir 必须跳过 .git，且照常复制普通嵌套文件
 * - parseSource 必须挡住 `-`/`.` 开头、`..`、多段路径等非法来源
 * - sanitizeSkillId 必须把穿越/斜杠收敛成安全片段或抛错
 *
 * WHY：安装来自第三方公开仓库，copyDir/parseSource 是把不可信内容落到 avatars/ 的最后一道闸。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SkillsShManager } from './skills-sh-manager'
import { safeSkillId } from '@soul/core'

const stubLogger = { activity() { /* noop */ }, error() { /* noop */ }, warn() { /* noop */ } } as never
function makeMgr() {
  const avatarsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-sst-avatars-'))
  return { mgr: new SkillsShManager(avatarsPath, stubLogger), avatarsPath }
}

test('copyDir skips symlinks but copies real files and skips .git', () => {
  const { mgr } = makeMgr()
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-sst-src-'))
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'soul-sst-dest-')), 'out')

  // 真实文件 + 嵌套目录
  fs.writeFileSync(path.join(src, 'SKILL.md'), '---\nname: x\n---\nbody')
  fs.mkdirSync(path.join(src, 'rules'))
  fs.writeFileSync(path.join(src, 'rules', 'a.md'), 'rule a')
  // 应被跳过：.git 目录
  fs.mkdirSync(path.join(src, '.git'))
  fs.writeFileSync(path.join(src, '.git', 'config'), 'secret')
  // 攻击向量：指向宿主任意文件的 symlink
  fs.symlinkSync('/etc/passwd', path.join(src, 'evil'))
  // 攻击向量：指向宿主目录的 symlink
  fs.symlinkSync('/etc', path.join(src, 'evildir'))

  ;(mgr as unknown as { copyDir(s: string, d: string): void }).copyDir(src, dest)

  assert.ok(fs.existsSync(path.join(dest, 'SKILL.md')), 'SKILL.md 应被复制')
  assert.ok(fs.existsSync(path.join(dest, 'rules', 'a.md')), '嵌套文件应被复制')
  assert.ok(!fs.existsSync(path.join(dest, '.git')), '.git 应被跳过')
  // 核心断言：symlink 一律不进安装目录（lstat 确认连 symlink 本身都没有）
  assert.ok(!fs.lstatSync(path.join(dest, 'evil'), { throwIfNoEntry: false }), 'symlink(文件) 必须被跳过')
  assert.ok(!fs.lstatSync(path.join(dest, 'evildir'), { throwIfNoEntry: false }), 'symlink(目录) 必须被跳过')
})

test('parseSource rejects malicious sources and accepts owner/repo', () => {
  const { mgr } = makeMgr()
  const parse = (s: string) => (mgr as unknown as { parseSource(s: string): { owner: string; repo: string } }).parseSource(s)

  for (const bad of ['', 'foo', 'a/b/c', '../etc/x', '-opt/repo', 'owner/-opt', '.hidden/repo', 'owner/..']) {
    assert.throws(() => parse(bad), new RegExp('非法|不能为空'), `应拒绝: ${bad}`)
  }
  assert.deepEqual(parse('vercel-labs/agent-skills'), { owner: 'vercel-labs', repo: 'agent-skills' })
  assert.deepEqual(parse('owner/repo.git'), { owner: 'owner', repo: 'repo' })
})

test('assertUrlSkillId accepts safe ids and rejects path/traversal chars', () => {
  const { mgr } = makeMgr()
  const f = (s: string) => (mgr as unknown as { assertUrlSkillId(s: string): string }).assertUrlSkillId(s)
  assert.equal(f('vercel-react-best-practices'), 'vercel-react-best-practices')
  assert.equal(f('git-commit'), 'git-commit')
  for (const bad of ['a/b', '..', 'a..b', 'a b', '']) {
    assert.throws(() => f(bad), /非法的 skillId/, `应拒绝: ${JSON.stringify(bad)}`)
  }
})

test('pageUrl builds a validated skills.sh URL and rejects bad input', () => {
  const { mgr } = makeMgr()
  const f = (s: string, k: string) => (mgr as unknown as { pageUrl(s: string, k: string): string }).pageUrl(s, k)
  assert.equal(
    f('vercel-labs/agent-skills', 'vercel-react-best-practices'),
    'https://skills.sh/skills/vercel-labs/agent-skills/vercel-react-best-practices',
  )
  assert.throws(() => f('../evil', 'x'), /非法的技能来源|非法的来源片段/)
  assert.throws(() => f('owner/repo', 'a/b'), /非法的 skillId/)
})

test('safeSkillId (shared core) collapses to a safe segment, no traversal/slash', () => {
  assert.equal(safeSkillId('vercel-react-best-practices'), 'vercel-react-best-practices')
  assert.equal(safeSkillId('a/b'), 'a-b')
  assert.equal(safeSkillId('../x'), 'x')
  assert.equal(safeSkillId('  '), '')
})

test('sanitizeSkillId collapses unsafe chars and never yields a traversal', () => {
  const { mgr } = makeMgr()
  const san = (s: string) => (mgr as unknown as { sanitizeSkillId(s: string): string }).sanitizeSkillId(s)

  assert.equal(san('vercel-react-best-practices'), 'vercel-react-best-practices')
  assert.equal(san('a/b'), 'a-b')
  assert.equal(san('../x'), 'x') // 穿越被折叠，绝不残留 .. 或 /
  assert.match(san('foo.bar baz'), /^[A-Za-z0-9_-]+$/)
  assert.throws(() => san(''), /不能为空/)
  assert.throws(() => san('///'), /无法.*生成/)
})
