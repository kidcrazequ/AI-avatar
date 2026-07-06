/**
 * SkillManager.addLocalSkillToIndex — 对话沉淀晋升的 skill-index.yaml 写入
 *
 * 覆盖（电子边界审查指出的缺口）：
 *   - 幂等：同名 entry 已存在（任意 section）→ 不重复写入，返回 false
 *   - local_skills: 段已存在 → 段内插入；不存在 → 末尾新建段
 *   - index 文件不存在 → 从头创建
 *   - domain 含 `#` → 剔除（自制行级解析器会把值内 # 当注释静默截断）+ 30 字符截断
 *   - skillId 非法字符 → 抛错（与 createSkill 同基线）
 *   - 已有条目与注释原样保留（只追加不重排）
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { SkillManager } from '../skill-manager'

function withWorkspace(body: (mgr: SkillManager, indexPath: string, avatarId: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-index-test-'))
  const avatarsRoot = path.join(root, 'avatars')
  const avatarId = 'a1'
  fs.mkdirSync(path.join(avatarsRoot, avatarId, 'skills'), { recursive: true })
  try {
    body(new SkillManager(avatarsRoot), path.join(avatarsRoot, avatarId, 'skills', 'skill-index.yaml'), avatarId)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

describe('SkillManager.addLocalSkillToIndex', () => {
  it('index 不存在时从头创建：新建 local_skills 段 + 完整 entry', () => {
    withWorkspace((mgr, indexPath, avatarId) => {
      const updated = mgr.addLocalSkillToIndex(avatarId, 'weekly-report', { description: '当用户要写周报时使用' })
      assert.equal(updated, true)
      const raw = fs.readFileSync(indexPath, 'utf-8')
      assert.match(raw, /^local_skills:$/m)
      assert.match(raw, /^ {2}- name: weekly-report$/m)
      assert.match(raw, /^ {4}path: skills\/weekly-report\.md$/m)
      assert.match(raw, /^ {4}source: local$/m)
    })
  })

  it('幂等：同名 entry 已存在（哪怕在其他 section）→ 返回 false 且文件不变', () => {
    withWorkspace((mgr, indexPath, avatarId) => {
      fs.writeFileSync(indexPath, 'version: "1.0"\nshared_skills:\n  - name: weekly-report\n    path: shared/skills/weekly-report.md\n')
      const before = fs.readFileSync(indexPath, 'utf-8')
      const updated = mgr.addLocalSkillToIndex(avatarId, 'weekly-report')
      assert.equal(updated, false)
      assert.equal(fs.readFileSync(indexPath, 'utf-8'), before, '幂等路径不得改写文件')
    })
  })

  it('local_skills 段已存在 → 段内插入，已有条目与注释原样保留', () => {
    withWorkspace((mgr, indexPath, avatarId) => {
      const seed = 'version: "1.0"\n# 顶部注释要保留\nlocal_skills:\n  - name: old-skill\n    path: skills/old-skill.md\n    source: local\n'
      fs.writeFileSync(indexPath, seed)
      const updated = mgr.addLocalSkillToIndex(avatarId, 'new-skill')
      assert.equal(updated, true)
      const raw = fs.readFileSync(indexPath, 'utf-8')
      assert.match(raw, /# 顶部注释要保留/)
      assert.match(raw, /- name: old-skill/)
      assert.match(raw, /- name: new-skill/)
      assert.equal((raw.match(/^local_skills:$/gm) ?? []).length, 1, '不得重复建段')
    })
  })

  it('domain 含 # 与超长 → # 被剔除、30 字符截断（防行级解析器把值当注释截断）', () => {
    withWorkspace((mgr, indexPath, avatarId) => {
      mgr.addLocalSkillToIndex(avatarId, 's1', { domain: `流程 # 这段不能变成注释${'长'.repeat(40)}` })
      const raw = fs.readFileSync(indexPath, 'utf-8')
      const domainMatch = raw.match(/^ {4}domain: (.+)$/m)
      assert.ok(domainMatch, '应写入 domain 行')
      assert.ok(!domainMatch[1].includes('#'), 'domain 值不得含 #')
      assert.ok(domainMatch[1].length <= 30, `domain 应截断到 30 字符，实际 ${domainMatch[1].length}`)
    })
  })

  it('skillId 非法字符（路径逃逸/空格）→ 抛错', () => {
    withWorkspace((mgr, _indexPath, avatarId) => {
      assert.throws(() => mgr.addLocalSkillToIndex(avatarId, 'bad skill'))
      assert.throws(() => mgr.addLocalSkillToIndex(avatarId, '../escape'))
    })
  })
})
