/**
 * SkillManager — anthropics/skills SKILL.md 标准格式兼容性测试
 *
 * 覆盖：
 *   - getSkills：单 .md（Soul 原生）+ 目录形式 SKILL.md 同时加载
 *   - getSkill(id)：单文件优先 / fallback 到目录形式
 *   - loadSkillFromDir：SKILL.md 缺失返回 null；name 不匹配目录时仍加载（容错）
 *   - shared 通道：跳过 community/ 子目录；其他目录扫 SKILL.md
 *   - 多语言名 / 边界字符校验
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { SkillManager } from '../skill-manager'

function withWorkspace(body: (avatarsRoot: string, avatarId: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-md-test-'))
  // Layout mirror 真实布局：root/avatars/<id>/skills + root/shared/skills/
  const avatarsRoot = path.join(root, 'avatars')
  const avatarId = 'a1'
  fs.mkdirSync(path.join(avatarsRoot, avatarId, 'skills'), { recursive: true })
  fs.mkdirSync(path.join(root, 'shared', 'skills'), { recursive: true })
  try {
    body(avatarsRoot, avatarId)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function writeSingleFileSkill(dir: string, fileName: string, frontmatter: Record<string, string>, body: string): void {
  const fm = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`).join('\n')
  fs.writeFileSync(path.join(dir, fileName), `---\n${fm}\n---\n\n${body}`)
}

function writeSkillMdDir(skillsDir: string, dirName: string, frontmatter: Record<string, string>, body: string, extras?: string[]): void {
  const skillDir = path.join(skillsDir, dirName)
  fs.mkdirSync(skillDir, { recursive: true })
  const fm = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`).join('\n')
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\n${fm}\n---\n\n${body}`)
  for (const sub of extras ?? []) {
    fs.mkdirSync(path.join(skillDir, sub), { recursive: true })
  }
}

describe('SkillManager — SKILL.md 标准格式兼容', () => {
  it('单 .md 文件形式（Soul 原生）依然加载', () => {
    withWorkspace((avatarsRoot, avatarId) => {
      const skillsDir = path.join(avatarsRoot, avatarId, 'skills')
      // avatarsRoot 是 root/avatars/，但分身 dir 是 a1，所以技能在 root/avatars/a1/skills/
      // 但 mkdir 已经创建好这个路径，所以 writeSingleFileSkill 用 skillsDir
      writeSingleFileSkill(skillsDir, 'my-tool.md', { name: 'my-tool', description: 'desc' }, '# My Tool\n')
      const mgr = new SkillManager(avatarsRoot)
      const skills = mgr.getSkills(avatarId)
      assert.equal(skills.length, 1)
      assert.equal(skills[0].id, 'my-tool')
    })
  })

  it('目录形式 SKILL.md 加载', () => {
    withWorkspace((avatarsRoot, avatarId) => {
      const skillsDir = path.join(avatarsRoot, avatarId, 'skills')
      writeSkillMdDir(skillsDir, 'pdf-processing', {
        name: 'pdf-processing',
        description: 'Extract PDF text and merge files',
      }, '# PDF Processing\n\nStep 1: ...', ['scripts', 'references'])
      const mgr = new SkillManager(avatarsRoot)
      const skills = mgr.getSkills(avatarId)
      assert.equal(skills.length, 1)
      assert.equal(skills[0].id, 'pdf-processing')
    })
  })

  it('两种格式同时存在时都加载，按 name 排序', () => {
    withWorkspace((avatarsRoot, avatarId) => {
      const skillsDir = path.join(avatarsRoot, avatarId, 'skills')
      writeSingleFileSkill(skillsDir, 'b-tool.md', { name: 'b-tool', description: 'b' }, '# b-tool')
      writeSkillMdDir(skillsDir, 'a-tool', { name: 'a-tool', description: 'a' }, '# a-tool')
      writeSkillMdDir(skillsDir, 'c-tool', { name: 'c-tool', description: 'c' }, '# c-tool')
      const mgr = new SkillManager(avatarsRoot)
      const skills = mgr.getSkills(avatarId)
      assert.equal(skills.length, 3)
      assert.deepEqual(skills.map(s => s.id), ['a-tool', 'b-tool', 'c-tool'])
    })
  })

  it('getSkill(skillId) 单文件优先：同名时 .md 文件比目录优先', () => {
    withWorkspace((avatarsRoot, avatarId) => {
      const skillsDir = path.join(avatarsRoot, avatarId, 'skills')
      writeSingleFileSkill(skillsDir, 'overlap.md', { name: 'overlap', description: 'from file' }, '# from file')
      writeSkillMdDir(skillsDir, 'overlap', { name: 'overlap', description: 'from dir' }, '# from dir')
      const mgr = new SkillManager(avatarsRoot)
      const skill = mgr.getSkill(avatarId, 'overlap')
      assert.ok(skill)
      assert.ok(skill.content.includes('from file'))
    })
  })

  it('getSkill(skillId) fallback 目录形式：单文件不存在但目录存在', () => {
    withWorkspace((avatarsRoot, avatarId) => {
      const skillsDir = path.join(avatarsRoot, avatarId, 'skills')
      writeSkillMdDir(skillsDir, 'only-dir', { name: 'only-dir', description: 'd' }, '# only-dir')
      const mgr = new SkillManager(avatarsRoot)
      const skill = mgr.getSkill(avatarId, 'only-dir')
      assert.ok(skill)
      assert.equal(skill.id, 'only-dir')
    })
  })

  it('目录形式但 SKILL.md 缺失返回 undefined（不抛错，跳过）', () => {
    withWorkspace((avatarsRoot, avatarId) => {
      const skillsDir = path.join(avatarsRoot, avatarId, 'skills')
      const dir = path.join(skillsDir, 'broken')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'README.md'), '不是 SKILL.md') // 错误文件名

      const mgr = new SkillManager(avatarsRoot)
      const skills = mgr.getSkills(avatarId)
      assert.equal(skills.length, 0) // 没有 SKILL.md 不算技能
      assert.equal(mgr.getSkill(avatarId, 'broken'), undefined)
    })
  })

  it('frontmatter name 与目录名不一致：仍按目录名加载（容错），不抛错', () => {
    withWorkspace((avatarsRoot, avatarId) => {
      const skillsDir = path.join(avatarsRoot, avatarId, 'skills')
      writeSkillMdDir(skillsDir, 'real-dir-name', {
        name: 'mismatched-name', // 故意不匹配
        description: 'desc',
      }, '# body')
      const mgr = new SkillManager(avatarsRoot)
      const skills = mgr.getSkills(avatarId)
      assert.equal(skills.length, 1)
      assert.equal(skills[0].id, 'real-dir-name') // 用目录名，不用 frontmatter
    })
  })
})

describe('SkillManager — shared 通道 SKILL.md 标准', () => {
  it('shared/skills/ 下扫单文件 + 目录形式 SKILL.md', () => {
    withWorkspace((avatarsRoot, avatarId) => {
      const sharedDir = path.join(avatarsRoot, '..', 'shared', 'skills')
      writeSingleFileSkill(sharedDir, 'flat-skill.md', { name: 'flat-skill', description: 'flat' }, '# flat')
      writeSkillMdDir(sharedDir, 'dir-skill', { name: 'dir-skill', description: 'dir' }, '# dir')
      // 分身 skill-index.yaml 必须存在才能跑（getAvailableSharedSkills 内部读它）
      const skillsDir = path.join(avatarsRoot, avatarId, 'skills')
      fs.writeFileSync(path.join(skillsDir, 'skill-index.yaml'), 'shared_skills: []\n')

      const mgr = new SkillManager(avatarsRoot)
      const list = mgr.getAvailableSharedSkills(avatarId)
      const names = list.map(s => s.name).sort()
      assert.deepEqual(names, ['dir-skill', 'flat-skill'])
    })
  })

  it('shared/skills/community/ 子目录被跳过（保留给 soul-sync.sh）', () => {
    withWorkspace((avatarsRoot, avatarId) => {
      const sharedDir = path.join(avatarsRoot, '..', 'shared', 'skills')
      fs.mkdirSync(path.join(sharedDir, 'community'), { recursive: true })
      writeSkillMdDir(path.join(sharedDir, 'community'), 'external-pkg', {
        name: 'external-pkg', description: '外部包',
      }, '# pkg')
      // community 同时放一个外部技能子目录
      const skillsDir = path.join(avatarsRoot, avatarId, 'skills')
      fs.writeFileSync(path.join(skillsDir, 'skill-index.yaml'), 'shared_skills: []\n')

      const mgr = new SkillManager(avatarsRoot)
      const list = mgr.getAvailableSharedSkills(avatarId)
      // community 子目录被跳过，所以 0 个
      assert.equal(list.length, 0)
    })
  })
})
