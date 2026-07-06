/**
 * load_skill 目录型技能引用二次读取（B1 · agentskills.io 对齐）单测。
 *
 * 意图（WHY）：目录型技能（SKILL.md + references/ + scripts/ + assets/）的
 * SKILL.md 正文会引用 references/<域>.md，模型需要二次读取——skill_id 复用为
 * "<技能名>/references/<文件名>" 形态。这里钉死三件事：
 *   1. 正常路径可读（local / shared / community 三级 + 启用状态强制不被绕过）；
 *   2. 路径逃逸一律拒绝（..、绝对路径、超一层深、白名单外子目录、符号链接指向目录外）；
 *   3. 加载目录型技能时回显配套文件清单（模型的唯一发现渠道，schema 未加参数）。
 *
 * 运行：
 *   NODE_PATH=./test-support/node_modules npx tsx --test \
 *     ../packages/core/src/tests/tool-router-load-skill-reference.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { ToolRouter } from '../tool-router'

const AVATAR_ID = 'skill-ref-test'

interface Sandbox {
  root: string
  avatarsPath: string
  skillsDir: string
  sharedSkillsDir: string
  cleanup: () => void
}

function setupSandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-skillref-'))
  const avatarsPath = path.join(root, 'avatars')
  const skillsDir = path.join(avatarsPath, AVATAR_ID, 'skills')
  const sharedSkillsDir = path.join(root, 'shared', 'skills')
  fs.mkdirSync(skillsDir, { recursive: true })
  fs.mkdirSync(sharedSkillsDir, { recursive: true })
  return {
    root,
    avatarsPath,
    skillsDir,
    sharedSkillsDir,
    cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* noop */ } },
  }
}

/** 造一个目录型技能：SKILL.md + references/guide.md（+ 可选 scripts/run.py） */
function writeDirSkill(parentDir: string, name: string, opts?: { withScript?: boolean }): string {
  const dir = path.join(parentDir, name)
  fs.mkdirSync(path.join(dir, 'references'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: 测试目录型技能\n---\n\n# ${name}\n\n细节见 references/guide.md`,
  )
  fs.writeFileSync(path.join(dir, 'references', 'guide.md'), `# ${name} 参考\n\n这里是 ${name} 的领域参考内容。`)
  if (opts?.withScript) {
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'scripts', 'run.py'), 'print("ok")\n')
  }
  return dir
}

async function loadSkill(router: ToolRouter, skillId: string) {
  return router.execute(AVATAR_ID, { name: 'load_skill', arguments: { skill_id: skillId } })
}

// ═══════════════════════ 正常路径 ═══════════════════════

test('local 目录型技能：加载 SKILL.md 时回显配套文件清单（发现渠道）', async () => {
  const sb = setupSandbox()
  try {
    writeDirSkill(sb.skillsDir, 'demo-skill', { withScript: true })
    const router = new ToolRouter(sb.avatarsPath)
    const res = await loadSkill(router, 'demo-skill')
    assert.equal(res.error, undefined, `加载不应报错: ${res.error ?? ''}`)
    assert.match(res.content, /细节见 references\/guide\.md/, '应包含 SKILL.md 正文')
    // 清单是模型知道"可二次读取"的唯一渠道（load_skill schema 未加新参数）
    assert.match(res.content, /demo-skill\/references\/guide\.md/, '应列出 references 文件供二次读取')
    assert.match(res.content, /demo-skill\/scripts\/run\.py/, '应列出 scripts 文件')
  } finally { sb.cleanup() }
})

test('local 目录型技能：references 相对路径二次读取成功', async () => {
  const sb = setupSandbox()
  try {
    writeDirSkill(sb.skillsDir, 'demo-skill')
    const router = new ToolRouter(sb.avatarsPath)
    const res = await loadSkill(router, 'demo-skill/references/guide.md')
    assert.equal(res.error, undefined, `引用读取不应报错: ${res.error ?? ''}`)
    assert.match(res.content, /demo-skill 的领域参考内容/, '应返回 references/guide.md 的正文')
  } finally { sb.cleanup() }
})

test('单文件技能没有 references：引用读取拒绝（只对目录型技能开放）', async () => {
  const sb = setupSandbox()
  try {
    fs.writeFileSync(path.join(sb.skillsDir, 'flat.md'), '---\nname: flat\n---\n\n# flat')
    const router = new ToolRouter(sb.avatarsPath)
    const res = await loadSkill(router, 'flat/references/guide.md')
    assert.ok(res.error, '单文件技能的引用读取必须报错')
    assert.match(res.error!, /不是目录型技能/)
  } finally { sb.cleanup() }
})

test('引用文件不存在：明确报错而非空内容', async () => {
  const sb = setupSandbox()
  try {
    writeDirSkill(sb.skillsDir, 'demo-skill')
    const router = new ToolRouter(sb.avatarsPath)
    const res = await loadSkill(router, 'demo-skill/references/missing.md')
    assert.ok(res.error, '不存在的引用必须报错')
    assert.match(res.error!, /引用文件不存在/)
  } finally { sb.cleanup() }
})

// ═══════════════════════ 启用状态强制（与 loadSkill 主路径同一套） ═══════════════════════

test('local 技能被 .config.json 禁用：引用读取同样拒绝（不绕过启用状态）', async () => {
  const sb = setupSandbox()
  try {
    writeDirSkill(sb.skillsDir, 'demo-skill')
    fs.writeFileSync(path.join(sb.skillsDir, '.config.json'), JSON.stringify({ disabledSkills: ['demo-skill'] }))
    const router = new ToolRouter(sb.avatarsPath)
    const res = await loadSkill(router, 'demo-skill/references/guide.md')
    assert.ok(res.error, '被禁用技能的引用读取必须报错')
  } finally { sb.cleanup() }
})

test('shared 目录型技能：skill-index.yaml 引用后可读，未引用拒绝', async () => {
  const sb = setupSandbox()
  try {
    writeDirSkill(sb.sharedSkillsDir, 'shared-dir-skill')
    const router = new ToolRouter(sb.avatarsPath)

    // 未在 skill-index.yaml 引用 → 拒绝（防猜 ID 绕过启用状态）
    const before = await loadSkill(router, 'shared-dir-skill/references/guide.md')
    assert.ok(before.error, '未引用的 shared 技能必须拒绝')

    fs.writeFileSync(
      path.join(sb.skillsDir, 'skill-index.yaml'),
      'shared_skills:\n  - name: shared-dir-skill\n    path: shared/skills/shared-dir-skill/SKILL.md\n    source: shared\n',
    )
    const after = await loadSkill(router, 'shared-dir-skill/references/guide.md')
    assert.equal(after.error, undefined, `引用后应可读: ${after.error ?? ''}`)
    assert.match(after.content, /shared-dir-skill 的领域参考内容/)
  } finally { sb.cleanup() }
})

test('community 目录型技能：按 yaml 声明 path 定位后引用可读', async () => {
  const sb = setupSandbox()
  try {
    const packSkillsDir = path.join(sb.sharedSkillsDir, 'community', 'pack1', 'skills')
    fs.mkdirSync(packSkillsDir, { recursive: true })
    writeDirSkill(packSkillsDir, 'comm-skill')
    fs.writeFileSync(
      path.join(sb.skillsDir, 'skill-index.yaml'),
      'community_skills:\n  - name: comm-skill\n    path: shared/skills/community/pack1/skills/comm-skill/SKILL.md\n    source: community\n',
    )
    const router = new ToolRouter(sb.avatarsPath)
    const res = await loadSkill(router, 'comm-skill/references/guide.md')
    assert.equal(res.error, undefined, `community 引用读取不应报错: ${res.error ?? ''}`)
    assert.match(res.content, /comm-skill 的领域参考内容/)
  } finally { sb.cleanup() }
})

// ═══════════════════════ 路径逃逸攻击 ═══════════════════════

test('逃逸攻击：..、绝对路径、超一层深、白名单外子目录全部拒绝', async () => {
  const sb = setupSandbox()
  try {
    writeDirSkill(sb.skillsDir, 'demo-skill')
    // 技能目录外放一个"机密"文件，作为逃逸目标
    fs.writeFileSync(path.join(sb.skillsDir, 'secret.md'), '机密内容不可泄露')
    const router = new ToolRouter(sb.avatarsPath)

    const attacks: Array<{ ref: string; why: string }> = [
      { ref: 'demo-skill/references/../secret.md', why: '.. 回溯（4 段，超一层深）' },
      { ref: 'demo-skill/../demo-skill/references/guide.md', why: '技能名后接 ..' },
      { ref: 'demo-skill/references/..', why: '文件名段是 ..' },
      { ref: '/etc/passwd', why: '绝对路径（首段为空）' },
      { ref: 'demo-skill/references/sub/deep.md', why: 'references/ 下嵌套（限一层深）' },
      { ref: 'demo-skill/private/guide.md', why: '白名单外子目录' },
      { ref: 'demo-skill\\references\\guide.md', why: '反斜杠路径分隔符' },
      { ref: '../avatars/skill-ref-test/skills/demo-skill/references/guide.md', why: '整体相对路径回溯' },
    ]
    for (const { ref, why } of attacks) {
      const res = await loadSkill(router, ref)
      assert.ok(res.error, `${why} 必须被拒绝: ${ref}`)
      assert.ok(!res.content.includes('机密内容'), `${why} 不得泄露技能目录外内容: ${ref}`)
    }
  } finally { sb.cleanup() }
})

test('逃逸攻击：references/ 内符号链接指向技能目录外 → realpath 复查拒绝', async () => {
  const sb = setupSandbox()
  try {
    const skillDir = writeDirSkill(sb.skillsDir, 'demo-skill')
    // 技能目录外的目标文件
    const outside = path.join(sb.root, 'outside-secret.md')
    fs.writeFileSync(outside, '目录外机密')
    // references/evil.md 是指向外部的符号链接——resolve 层面看似在目录内
    fs.symlinkSync(outside, path.join(skillDir, 'references', 'evil.md'))
    const router = new ToolRouter(sb.avatarsPath)
    const res = await loadSkill(router, 'demo-skill/references/evil.md')
    assert.ok(res.error, '指向技能目录外的符号链接必须被拒绝')
    assert.ok(!res.content.includes('目录外机密'), '不得泄露符号链接目标内容')
  } finally { sb.cleanup() }
})

test('引用路径指向目录而非文件：拒绝', async () => {
  const sb = setupSandbox()
  try {
    const skillDir = writeDirSkill(sb.skillsDir, 'demo-skill')
    fs.mkdirSync(path.join(skillDir, 'references', 'subdir'))
    const router = new ToolRouter(sb.avatarsPath)
    const res = await loadSkill(router, 'demo-skill/references/subdir')
    assert.ok(res.error, '目录不是可读文件，必须报错')
    assert.match(res.error!, /是目录不是文件/)
  } finally { sb.cleanup() }
})

// ═══════════════════════ 向后兼容 ═══════════════════════

test('向后兼容：单文件技能 load_skill 行为不变（无清单追加）', async () => {
  const sb = setupSandbox()
  try {
    fs.writeFileSync(path.join(sb.skillsDir, 'flat.md'), '---\nname: flat\n---\n\n# flat 技能正文')
    const router = new ToolRouter(sb.avatarsPath)
    const res = await loadSkill(router, 'flat')
    assert.equal(res.error, undefined)
    assert.match(res.content, /flat 技能正文/)
    assert.ok(!res.content.includes('目录型技能'), '单文件技能不应追加目录型清单')
  } finally { sb.cleanup() }
})
