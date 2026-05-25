/**
 * @soul/core 单元测试
 * 覆盖 TemplateLoader、KnowledgeRetriever、SkillManager、SoulLoader 核心逻辑。
 *
 * 运行方式：
 *   cd packages/core && npm run build && node --test dist/tests/core.test.js
 *
 * @author zhi.qu
 * @date 2026-04-02
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TemplateLoader } from '../template-loader'
import { KnowledgeRetriever } from '../knowledge-retriever'
import { SkillManager } from '../skill-manager'
import { AvatarManager } from '../avatar-manager'
import { KnowledgeManager } from '../knowledge-manager'
import { extractTitle, extractFrontmatter, extractFrontmatterField, extractListItems } from '../utils/markdown-parser'

// ---------------------------------------------------------------------------
// 工具：临时目录管理
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'soul-core-test-'))
}

function cleanupDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// TemplateLoader 测试
// ---------------------------------------------------------------------------

describe('TemplateLoader', () => {
  let tmpDir: string

  before(() => {
    tmpDir = makeTempDir()
    // 写两个假模板文件
    fs.writeFileSync(path.join(tmpDir, 'soul-template.md'), '# Soul Template\n## 身份\n## 原则\n', 'utf-8')
    fs.writeFileSync(path.join(tmpDir, 'skill-template.md'), '---\nname: 示例技能\n---\n# 技能\n', 'utf-8')
  })

  after(() => cleanupDir(tmpDir))

  it('getTemplate 应返回模板内容', () => {
    const loader = new TemplateLoader(tmpDir)
    const content = loader.getTemplate('soul-template.md')
    assert.ok(content.includes('Soul Template'), '应包含模板标题')
  })

  it('getTemplate 文件不存在时返回空字符串', () => {
    const loader = new TemplateLoader(tmpDir)
    const content = loader.getTemplate('non-existent.md')
    assert.equal(content, '')
  })

  it('listTemplates 应列出所有 .md 文件并排序', () => {
    const loader = new TemplateLoader(tmpDir)
    const list = loader.listTemplates()
    assert.deepEqual(list, ['skill-template.md', 'soul-template.md'])
  })

  it('buildSoulCreationPrompt 应包含分身名称和模板内容', () => {
    const loader = new TemplateLoader(tmpDir)
    const prompt = loader.buildSoulCreationPrompt('测试分身')
    assert.ok(prompt.includes('测试分身'), '应包含分身名称')
    assert.ok(prompt.includes('Soul Template'), '应包含模板内容')
    assert.ok(prompt.includes('强制约束'), '应包含约束说明')
  })

  it('buildSkillCreationPrompt 应包含技能模板内容', () => {
    const loader = new TemplateLoader(tmpDir)
    const prompt = loader.buildSkillCreationPrompt()
    assert.ok(prompt.includes('示例技能'), '应包含技能模板内容')
  })

  it('buildTestCaseCreationPrompt 应包含 6 个测试类别', () => {
    const loader = new TemplateLoader(tmpDir)
    const prompt = loader.buildTestCaseCreationPrompt()
    assert.ok(prompt.includes('人格一致性'), '应包含人格一致性')
    assert.ok(prompt.includes('知识准确性'), '应包含知识准确性')
    assert.ok(prompt.includes('数据溯源'), '应包含数据溯源')
    assert.ok(prompt.includes('第一性原理'), '应包含第一性原理')
  })
})

// ---------------------------------------------------------------------------
// KnowledgeRetriever 测试
// ---------------------------------------------------------------------------

describe('KnowledgeRetriever', () => {
  let tmpDir: string

  before(() => {
    tmpDir = makeTempDir()
    // 写两个知识文件（含子目录）
    fs.writeFileSync(path.join(tmpDir, 'overview.md'), `# 工商储概述\n\n## 定义\n工商业储能系统用于峰谷套利，通过在电价低谷时充电、高峰时放电，帮助工商业用户降低用电成本。系统一般由电池组、变流器、能量管理系统和配电柜等核心设备组成。\n\n## 市场规模\n2024 年中国工商业储能市场规模超过 500 亿元，预计 2025 年将突破 800 亿元。主要驱动因素包括峰谷电价差扩大、分布式光伏配储政策推动。\n`, 'utf-8')
    const productsDir = path.join(tmpDir, 'products')
    fs.mkdirSync(productsDir)
    fs.writeFileSync(path.join(productsDir, 'battery.md'), `# 电池产品\n\n## 磷酸铁锂\n磷酸铁锂电池是目前工商业储能领域应用最广泛的电池类型。其主要优势包括：循环寿命可达 6000 次以上，能量密度约 160Wh/kg，安全性高，成本持续下降。广泛应用于储能电站、微电网和分布式光储系统。\n`, 'utf-8')
  })

  after(() => cleanupDir(tmpDir))

  it('listFiles 应列出所有知识文件', () => {
    const retriever = new KnowledgeRetriever(tmpDir)
    const files = retriever.listFiles()
    assert.ok(files.includes('overview.md'), '应包含根目录文件')
    assert.ok(files.some(f => f.includes('battery.md')), '应包含子目录文件')
  })

  it('readFile 应返回文件内容', () => {
    const retriever = new KnowledgeRetriever(tmpDir)
    const content = retriever.readFile('overview.md')
    assert.ok(content.includes('工商储概述'))
  })

  it('readFile 不存在的文件应抛出错误', () => {
    const retriever = new KnowledgeRetriever(tmpDir)
    assert.throws(() => retriever.readFile('not-exist.md'), /文件不存在/)
  })

  it('searchChunks 应按关键词匹配并返回结果', () => {
    const retriever = new KnowledgeRetriever(tmpDir)
    const results = retriever.searchChunks('磷酸铁锂 循环寿命')
    assert.ok(results.length > 0, '应有匹配结果')
    assert.ok(results[0].score > 0, '结果得分应大于 0')
    assert.ok(results[0].content.includes('磷酸铁锂') || results[0].heading.includes('磷酸铁锂'), '顶部结果应包含关键词')
  })

  it('searchChunks 无匹配关键词时返回空数组', () => {
    const retriever = new KnowledgeRetriever(tmpDir)
    const results = retriever.searchChunks('xxxxxxxxxxxxxxxxx')
    assert.equal(results.length, 0)
  })

  it('searchChunksWithCoverage 命中良好时 hint 应为 partial/high，无命中时为 empty', () => {
    const retriever = new KnowledgeRetriever(tmpDir)
    // 有命中：tmpDir 只有 2 个 chunk（overview + battery），最多召回 2 → partial 上限
    const good = retriever.searchChunksWithCoverage('磷酸铁锂 循环寿命', 5)
    assert.ok(good.chunks.length > 0, '应有命中')
    assert.ok(good.coverage.hits === good.chunks.length, 'coverage.hits 应等于实际命中数')
    assert.ok(good.coverage.totalCandidates >= good.chunks.length, 'totalCandidates 应 ≥ hits')
    assert.ok(good.coverage.topScore > 0, 'topScore 应 > 0')
    assert.equal(good.coverage.mode, 'bm25', '未注入 embedding 时模式应为 bm25')
    assert.ok(['low', 'partial', 'high'].includes(good.coverage.hint), `hint=${good.coverage.hint} 应不为 empty`)

    // 无命中：hint 必须为 empty
    const empty = retriever.searchChunksWithCoverage('xxxxxxxxxxxxxxxxx', 5)
    assert.equal(empty.chunks.length, 0)
    assert.equal(empty.coverage.hits, 0)
    assert.equal(empty.coverage.hint, 'empty')
  })
})

describe('KnowledgeRetriever Excel rag_only .md 不参与 RAG', () => {
  let tmpExcelDir: string

  before(() => {
    tmpExcelDir = makeTempDir()
    fs.writeFileSync(
      path.join(tmpExcelDir, 'dashboard-fake.md'),
      '---\nrag_only: true\nsource: excel\nexcel_json: _excel/x.json\n---\n\n## 总原始表\n\n| 机型 | 统计周期 | 设备侧效率 |\n| --- | --- | --- |\n| 215 | 2503 | 90.1% |\n',
      'utf-8',
    )
    fs.writeFileSync(
      path.join(tmpExcelDir, 'guide.md'),
      '# 指南\n\n215 机型设备侧效率请使用 query_excel 查询总原始表，勿用本文件代替表格。\n',
      'utf-8',
    )
  })

  after(() => cleanupDir(tmpExcelDir))

  it('searchChunks 不索引 Excel 结构 rag_only .md，避免误导性 BM25 命中', () => {
    const retriever = new KnowledgeRetriever(tmpExcelDir)
    const results = retriever.searchChunks('215 设备侧效率 2601', 10)
    assert.ok(!results.some(r => r.file === 'dashboard-fake.md'), 'Excel rag_only 导出 .md 不应进入检索结果')
  })
})

// ---------------------------------------------------------------------------
// SkillManager 测试
// ---------------------------------------------------------------------------

describe('SkillManager', () => {
  let tmpDir: string
  const avatarId = 'test-avatar'

  before(() => {
    tmpDir = makeTempDir()
    const skillsDir = path.join(tmpDir, avatarId, 'skills')
    fs.mkdirSync(skillsDir, { recursive: true })
    fs.writeFileSync(path.join(skillsDir, 'roi-calc.md'), `---\nname: ROI 计算\nversion: v1.0\n---\n# ROI 计算\n\n> **级别**：核心\n> **版本**：v1.0\n\n## 技能说明\n根据电价数据计算储能项目收益回报。\n`, 'utf-8')
  })

  after(() => cleanupDir(tmpDir))

  it('getSkills 应返回技能列表', () => {
    const manager = new SkillManager(tmpDir)
    const skills = manager.getSkills(avatarId)
    assert.equal(skills.length, 1)
    assert.equal(skills[0].id, 'roi-calc')
  })

  it('getSkill 应返回指定技能', () => {
    const manager = new SkillManager(tmpDir)
    const skill = manager.getSkill(avatarId, 'roi-calc')
    assert.ok(skill !== undefined)
    assert.equal(skill!.id, 'roi-calc')
    assert.ok(skill!.description.length > 0, '应包含技能描述')
  })

  it('getSkill 不存在时返回 undefined', () => {
    const manager = new SkillManager(tmpDir)
    const skill = manager.getSkill(avatarId, 'non-existent')
    assert.equal(skill, undefined)
  })

  it('toggleSkill 禁用后 getSkills 中 enabled 为 false', () => {
    const manager = new SkillManager(tmpDir)
    manager.toggleSkill(avatarId, 'roi-calc', false)
    const skills = manager.getSkills(avatarId)
    assert.equal(skills[0].enabled, false)
    // 恢复
    manager.toggleSkill(avatarId, 'roi-calc', true)
    const skills2 = manager.getSkills(avatarId)
    assert.equal(skills2[0].enabled, true)
  })

  it('getEnabledSkillsContent 应包含已启用技能内容', () => {
    const manager = new SkillManager(tmpDir)
    const content = manager.getEnabledSkillsContent(avatarId)
    assert.ok(content.includes('技能定义'), '应包含技能定义标题')
    assert.ok(content.includes('ROI 计算'), '应包含技能名称')
  })
})

// ---------------------------------------------------------------------------
// AvatarManager 测试
// ---------------------------------------------------------------------------

describe('AvatarManager', () => {
  let tmpAvatarsDir: string
  let tmpTemplatesDir: string

  before(() => {
    tmpAvatarsDir = makeTempDir()
    tmpTemplatesDir = makeTempDir()
    // 写一个简单的 knowledge-readme 模板
    fs.writeFileSync(
      path.join(tmpTemplatesDir, 'knowledge-readme-template.md'),
      '# {{AGENT_DISPLAY_NAME}} 知识库\n\n## 分类\n',
      'utf-8'
    )
  })

  after(() => {
    cleanupDir(tmpAvatarsDir)
    cleanupDir(tmpTemplatesDir)
  })

  it('listAvatars 空目录时返回空数组', () => {
    const manager = new AvatarManager(tmpAvatarsDir, tmpTemplatesDir)
    assert.deepEqual(manager.listAvatars(), [])
  })

  it('createAvatar 应创建完整目录结构', () => {
    const manager = new AvatarManager(tmpAvatarsDir, tmpTemplatesDir)
    const soulContent = '# 测试分身\n\n我是测试分身的自我介绍。\n'
    manager.createAvatar('avatar-001', soulContent, [], [])

    const avatarPath = path.join(tmpAvatarsDir, 'avatar-001')
    assert.ok(fs.existsSync(path.join(avatarPath, 'soul.md')), 'soul.md 应存在')
    assert.ok(fs.existsSync(path.join(avatarPath, 'CLAUDE.md')), 'CLAUDE.md 应存在')
    assert.ok(fs.existsSync(path.join(avatarPath, 'memory', 'MEMORY.md')), 'MEMORY.md 应存在')
    assert.ok(fs.existsSync(path.join(avatarPath, 'knowledge', 'README.md')), 'knowledge/README.md 应存在')
  })

  it('listAvatars 应返回已创建的分身', () => {
    const manager = new AvatarManager(tmpAvatarsDir, tmpTemplatesDir)
    const avatars = manager.listAvatars()
    assert.equal(avatars.length, 1)
    assert.equal(avatars[0].id, 'avatar-001')
  })

  it('createAvatar knowledge/README.md 应包含分身名称', () => {
    const readmePath = path.join(tmpAvatarsDir, 'avatar-001', 'knowledge', 'README.md')
    const content = fs.readFileSync(readmePath, 'utf-8')
    assert.ok(content.includes('测试分身'), '应包含分身名称')
  })

  it('parseImageDataUrlBase64 应解析 PNG / webp 等标准 data URL', () => {
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    assert.equal(AvatarManager.parseImageDataUrlBase64(`data:image/png;base64,${b64}`), b64)
    assert.equal(AvatarManager.parseImageDataUrlBase64(`data:image/webp;base64,${b64}`), b64)
  })

  it('parseImageDataUrlBase64 应支持含 + 的子类型并去除 base64 中的空白', () => {
    const b64 = 'YQ=='
    assert.equal(AvatarManager.parseImageDataUrlBase64(`data:image/svg+xml;base64,${b64}`), b64)
    assert.equal(AvatarManager.parseImageDataUrlBase64(` data:image/png;base64,${b64} `), b64)
    assert.equal(AvatarManager.parseImageDataUrlBase64(`data:image/png;base64,Y\nQ==`), b64)
  })

  it('saveAvatarImage 应将合法 PNG data URL 写入 avatar.png', () => {
    const manager = new AvatarManager(tmpAvatarsDir, tmpTemplatesDir)
    const tinyPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    )
    const dataUrl = `data:image/png;base64,${tinyPng.toString('base64')}`
    manager.saveAvatarImage('avatar-001', dataUrl)
    const pngPath = path.join(tmpAvatarsDir, 'avatar-001', 'avatar.png')
    assert.ok(fs.existsSync(pngPath))
    assert.ok(fs.readFileSync(pngPath).equals(tinyPng))
  })

  it('deleteAvatar 应删除分身目录', () => {
    const manager = new AvatarManager(tmpAvatarsDir, tmpTemplatesDir)
    manager.deleteAvatar('avatar-001')
    assert.equal(fs.existsSync(path.join(tmpAvatarsDir, 'avatar-001')), false)
    assert.deepEqual(manager.listAvatars(), [])
  })
})

// ---------------------------------------------------------------------------
// KnowledgeManager
// ---------------------------------------------------------------------------

describe('KnowledgeManager', () => {
  it('readFile 在 README.md 缺失时自动补全空库索引并可读', () => {
    const root = makeTempDir()
    const knowledgePath = path.join(root, 'avatar-readme-heal', 'knowledge')
    fs.mkdirSync(knowledgePath, { recursive: true })
    const km = new KnowledgeManager(knowledgePath)
    const text = km.readFile('README.md')
    assert.ok(text.includes('avatar-readme-heal'), 'README 标题应使用分身目录名')
    assert.ok(fs.existsSync(path.join(knowledgePath, 'README.md')))
    cleanupDir(root)
  })
})

// ---------------------------------------------------------------------------
// markdown-parser 工具函数测试
// ---------------------------------------------------------------------------

describe('markdown-parser utils', () => {
  const sampleMd = `---
name: 示例技能
version: v2.0
---

# 技能名称

> **级别**：核心
> **版本**：v2.0

## 触发条件

- 用户询问收益
- 用户提到套利
`

  it('extractTitle 应提取第一个 # 标题', () => {
    assert.equal(extractTitle(sampleMd), '技能名称')
  })

  it('extractFrontmatter 应解析 YAML frontmatter', () => {
    const fm = extractFrontmatter(sampleMd)
    assert.equal(fm['name'], '示例技能')
    assert.equal(fm['version'], 'v2.0')
  })

  it('extractFrontmatterField 应提取单个字段', () => {
    assert.equal(extractFrontmatterField(sampleMd, 'name'), '示例技能')
  })

  it('extractListItems 应提取列表项', () => {
    const items = extractListItems(sampleMd)
    assert.deepEqual(items, ['用户询问收益', '用户提到套利'])
  })

  it('extractTitle 无标题时返回空字符串', () => {
    assert.equal(extractTitle('普通段落文本'), '')
  })
})
