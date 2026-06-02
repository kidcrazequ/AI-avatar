/**
 * skill-manager-delete.test.ts — SkillManager.deleteSkill 目录感知删除回归
 *
 * WHY：skills.sh 装的技能是目录形式（<id>/SKILL.md + rules/ 等）。旧实现只 unlink SKILL.md，
 * 会把 rules/ 等子目录留成孤儿。这里锁定「dir-form 删整目录、flat-form 删单文件」两条路径。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SkillManager } from '@soul/core'

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-sm-del-'))
  const avatarsPath = path.join(root, 'avatars')
  const skillsDir = path.join(avatarsPath, 'bot', 'skills')
  fs.mkdirSync(skillsDir, { recursive: true })
  return { mgr: new SkillManager(avatarsPath), skillsDir }
}

test('deleteSkill removes the whole directory for dir-form (SKILL.md) skills', () => {
  const { mgr, skillsDir } = setup()
  const dir = path.join(skillsDir, 'multi')
  fs.mkdirSync(path.join(dir, 'rules'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: multi\ndescription: d\n---\n# multi')
  fs.writeFileSync(path.join(dir, 'rules', 'a.md'), 'rule a')

  mgr.deleteSkill('bot', 'multi')
  assert.ok(!fs.existsSync(dir), '整个技能目录应被删除（含 rules/），不留孤儿')
})

test('deleteSkill still unlinks single-file (flat) skills', () => {
  const { mgr, skillsDir } = setup()
  const file = path.join(skillsDir, 'flat.md')
  fs.writeFileSync(file, '---\nname: flat\ndescription: d\n---\n# flat')

  mgr.deleteSkill('bot', 'flat')
  assert.ok(!fs.existsSync(file), 'flat .md 文件应被删除')
})
