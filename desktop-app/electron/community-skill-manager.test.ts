/**
 * community-skill-manager.test.ts — copySkillFiles 目录型技能（B1）单元测试
 *
 * 只测不依赖网络/git 的纯 fs 逻辑（通过 as unknown as 触达私有方法）：
 * - 含 SKILL.md 的子目录按一个技能列出：name=目录名、file=<目录>/SKILL.md、
 *   frontmatter 从 SKILL.md 读；references/ 等整目录零转换拷入
 * - 不含 SKILL.md 的子目录不算技能、不落盘
 * - source.skills 白名单对目录型技能同样生效
 * - 第三方仓库不可信：目录内 symlink / .git 不落盘
 *
 * WHY：B1 之后 soul-sync 会把目录型技能零转换装进 shared/skills/community/，
 * 若 UI 侧 sync/列举只认 *.md 单文件，这些技能既不出现在列表里，
 * 还会在下次 UI 同步重建 destDir 时被整个抹掉。
 *
 * 运行：
 *   NODE_PATH=./test-support/node_modules npx tsx --test electron/community-skill-manager.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CommunitySkillManager } from './community-skill-manager'
import type { CommunitySkillInfo, CommunitySkillSource } from '@soul/core'

const stubLogger = { activity() { /* noop */ }, error() { /* noop */ }, warn() { /* noop */ } } as never

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-csm-'))
  const avatarsPath = path.join(root, 'avatars')
  fs.mkdirSync(avatarsPath, { recursive: true })
  const mgr = new CommunitySkillManager(avatarsPath, stubLogger)
  const sourceDir = path.join(root, 'clone', 'skills')
  const destDir = path.join(root, 'dest')
  fs.mkdirSync(sourceDir, { recursive: true })
  // syncSingleSource 在调用 copySkillFiles 前会先建好 destDir/skills
  fs.mkdirSync(path.join(destDir, 'skills'), { recursive: true })
  return { mgr, sourceDir, destDir }
}

function copySkillFiles(
  mgr: CommunitySkillManager,
  sourceDir: string,
  destDir: string,
  source: Partial<CommunitySkillSource>,
): CommunitySkillInfo[] {
  return (mgr as unknown as {
    copySkillFiles(s: string, d: string, src: CommunitySkillSource): CommunitySkillInfo[]
  }).copySkillFiles(sourceDir, destDir, source as CommunitySkillSource)
}

function writeDirSkill(sourceDir: string, name: string): void {
  fs.mkdirSync(path.join(sourceDir, name, 'references'), { recursive: true })
  fs.writeFileSync(
    path.join(sourceDir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} 的目录型技能描述\ndomain: design\n---\n\n# ${name}\n正文\n`,
    'utf-8',
  )
  fs.writeFileSync(path.join(sourceDir, name, 'references', 'ref.md'), '参考资料', 'utf-8')
}

test('目录型技能按一个技能列出：name=目录名、frontmatter 从 SKILL.md 读、整目录拷入', () => {
  const { mgr, sourceDir, destDir } = makeFixture()
  fs.writeFileSync(path.join(sourceDir, 'flat.md'), '---\ndescription: 单文件技能\n---\n正文', 'utf-8')
  writeDirSkill(sourceDir, 'dir-skill')

  const skills = copySkillFiles(mgr, sourceDir, destDir, {})

  assert.strictEqual(skills.length, 2, '单文件 + 目录型各一个')
  const dirSkill = skills.find(s => s.name === 'dir-skill')
  assert.ok(dirSkill, '目录型技能必须出现在列表里（UI 列表数据源）')
  assert.strictEqual(dirSkill.file, 'dir-skill/SKILL.md', 'file 记相对路径而非裸 SKILL.md')
  assert.strictEqual(dirSkill.description, 'dir-skill 的目录型技能描述', 'frontmatter 从 SKILL.md 读')
  assert.strictEqual(dirSkill.domain, 'design')

  // 零转换：SKILL.md + references/ 整目录落盘
  assert.ok(fs.existsSync(path.join(destDir, 'skills', 'dir-skill', 'SKILL.md')))
  assert.ok(fs.existsSync(path.join(destDir, 'skills', 'dir-skill', 'references', 'ref.md')))
  assert.ok(fs.existsSync(path.join(destDir, 'skills', 'flat.md')), '单文件技能路径不受影响')
})

test('不含 SKILL.md 的子目录不算技能、不落盘', () => {
  const { mgr, sourceDir, destDir } = makeFixture()
  fs.mkdirSync(path.join(sourceDir, 'assets'))
  fs.writeFileSync(path.join(sourceDir, 'assets', 'notes.md'), '不是技能', 'utf-8')

  const skills = copySkillFiles(mgr, sourceDir, destDir, {})

  assert.strictEqual(skills.length, 0)
  assert.ok(!fs.existsSync(path.join(destDir, 'skills', 'assets')), '非技能目录不得拷入')
})

test('source.skills 白名单对目录型技能同样生效', () => {
  const { mgr, sourceDir, destDir } = makeFixture()
  fs.writeFileSync(path.join(sourceDir, 'flat.md'), '单文件', 'utf-8')
  writeDirSkill(sourceDir, 'wanted')
  writeDirSkill(sourceDir, 'unwanted')

  const skills = copySkillFiles(mgr, sourceDir, destDir, { skills: ['wanted'] })

  assert.deepStrictEqual(skills.map(s => s.name), ['wanted'])
  assert.ok(!fs.existsSync(path.join(destDir, 'skills', 'unwanted')))
  assert.ok(!fs.existsSync(path.join(destDir, 'skills', 'flat.md')))
})

test('目录型技能内的 symlink 与 .git 不落盘（第三方仓库不可信）', () => {
  const { mgr, sourceDir, destDir } = makeFixture()
  writeDirSkill(sourceDir, 'dir-skill')
  fs.symlinkSync('/etc/passwd', path.join(sourceDir, 'dir-skill', 'evil'))
  fs.mkdirSync(path.join(sourceDir, 'dir-skill', '.git'))
  fs.writeFileSync(path.join(sourceDir, 'dir-skill', '.git', 'config'), 'secret', 'utf-8')

  const skills = copySkillFiles(mgr, sourceDir, destDir, {})

  assert.strictEqual(skills.length, 1)
  const dest = path.join(destDir, 'skills', 'dir-skill')
  assert.ok(!fs.lstatSync(path.join(dest, 'evil'), { throwIfNoEntry: false }), 'symlink 必须被跳过')
  assert.ok(!fs.existsSync(path.join(dest, '.git')), '.git 必须被跳过')
  assert.ok(fs.existsSync(path.join(dest, 'references', 'ref.md')), '正常文件照常复制')
})
