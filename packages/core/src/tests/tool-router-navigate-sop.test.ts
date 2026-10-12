/**
 * knowledge_navigate 与 sop_report 的 ToolRouter 集成单测（W4.2 / W5.3）。
 *
 * 意图（WHY）：这两个工具的价值全在"纪律"，而纪律只在集成层才成立——
 *   1. 概念卡索引缺失时必须**明确报错并给构建命令**，绝不静默退回"知识库为空"
 *      的假象（用户红线：宁可拒答，不给占位）
 *   2. SOP 只对带 sop.yaml 的技能启用，其余技能必须完全走原散文链路（双轨兼容）
 *   3. 流程推进必须由状态机校验：没开流程就调 sop_report 要报错、槽位不齐不许跳步
 *
 * 运行：
 *   npx tsx --test packages/core/src/tests/tool-router-navigate-sop.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { ToolRouter } from '../tool-router'
import { buildKnowledgeCards, saveCardsIndex } from '../knowledge-cards'

const AVATAR_ID = 'navsop-test'
const CONV_ID = 'conv-1'

function setupSandbox(): { avatarsPath: string; knowledgePath: string; skillsPath: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-navsop-'))
  const avatarsPath = path.join(root, 'avatars')
  const knowledgePath = path.join(avatarsPath, AVATAR_ID, 'knowledge')
  const skillsPath = path.join(avatarsPath, AVATAR_ID, 'skills')
  fs.mkdirSync(knowledgePath, { recursive: true })
  fs.mkdirSync(skillsPath, { recursive: true })
  return {
    avatarsPath,
    knowledgePath,
    skillsPath,
    cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* noop */ } },
  }
}

test('knowledge_navigate：索引缺失 → 明确错误 + 构建命令，绝不伪装成空知识库', async () => {
  const { avatarsPath, cleanup } = setupSandbox()
  try {
    const router = new ToolRouter(avatarsPath)
    const res = await router.execute(AVATAR_ID, { name: 'knowledge_navigate', arguments: {} })
    assert.match(res.error ?? '', /概念卡索引不存在/)
    assert.match(res.error ?? '', /build-knowledge-cards/, '必须给出构建命令')
    assert.match(res.error ?? '', /search_knowledge|knowledge_grep/, '必须给出过渡检索路径')
    assert.equal(res.content, '', '不得返回看似成功的空结果')
  } finally {
    cleanup()
  }
})

test('knowledge_navigate：两级导航（文档卡 → 章节卡 + 行区间）', async () => {
  const { avatarsPath, knowledgePath, cleanup } = setupSandbox()
  try {
    fs.writeFileSync(
      path.join(knowledgePath, 'anzhuang.md'),
      '# 储能安装手册\n\n本手册讲工商储柜体安装。\n\n## 接地要求\n\n接地电阻不大于 4 欧姆。\n\n## 消防要求\n\n需配置七氟丙烷。\n',
      'utf-8',
    )
    saveCardsIndex(knowledgePath, buildKnowledgeCards(knowledgePath).index)
    const router = new ToolRouter(avatarsPath)

    // 一级：文档卡
    const docs = await router.execute(AVATAR_ID, { name: 'knowledge_navigate', arguments: {} })
    assert.equal(docs.error, undefined, `不应报错: ${docs.error ?? ''}`)
    const docPayload = JSON.parse(docs.content) as {
      document_count: number
      documents: Array<{ path: string; title: string; sections: number }>
      hint: string
    }
    assert.equal(docPayload.document_count, 1)
    assert.equal(docPayload.documents[0].title, '储能安装手册')
    assert.match(docPayload.hint, /knowledge_navigate\(doc=/, 'hint 必须引导下钻')

    // 二级：章节卡带行区间（溯源粒度的关键）
    const secs = await router.execute(AVATAR_ID, {
      name: 'knowledge_navigate',
      arguments: { doc: docPayload.documents[0].path },
    })
    assert.equal(secs.error, undefined)
    const secPayload = JSON.parse(secs.content) as {
      sections: Array<{ heading: string; lines: string }>
      hint: string
    }
    const headings = secPayload.sections.map((s) => s.heading)
    assert.ok(headings.some((h) => h.includes('接地要求')), `章节应含接地要求: ${headings.join(' | ')}`)
    assert.ok(
      secPayload.sections.every((s) => /^\d+-\d+$/.test(s.lines)),
      '每节必须带 起始-结束 行区间，供精读与来源标注',
    )
    assert.match(secPayload.hint, /来源标注|行区间/)

    // query 过滤 + 不存在的 doc 给近似候选
    const filtered = await router.execute(AVATAR_ID, {
      name: 'knowledge_navigate',
      arguments: { doc: docPayload.documents[0].path, query: '消防' },
    })
    const filteredPayload = JSON.parse(filtered.content) as { sections: Array<{ heading: string }> }
    assert.ok(filteredPayload.sections.every((s) => s.heading.includes('消防')))

    const missing = await router.execute(AVATAR_ID, {
      name: 'knowledge_navigate',
      arguments: { doc: 'buzai.md' },
    })
    assert.match(missing.error ?? '', /没有文档/)
  } finally {
    cleanup()
  }
})

const SOP_YAML = `sop_version: 1
skill: pilot-flow
goal: 演示流程
start: collect
terminal: [report]
interruption: pause
nodes:
  - id: collect
    name: 收集参数
    instruction: 问用户要装机容量
    expects: [装机容量]
    tools: []
    next:
      - to: report
        when: 装机容量已确认
  - id: report
    name: 输出报告
    instruction: 给出结论
    expects: []
    tools: []
    next: []
`

test('SOP 双轨：普通技能不触发流程；带 sop.yaml 的技能才注入流程模式', async () => {
  const { avatarsPath, skillsPath, cleanup } = setupSandbox()
  try {
    fs.writeFileSync(path.join(skillsPath, 'plain.md'), '# 普通技能\n\n随便写点步骤。\n', 'utf-8')
    fs.writeFileSync(path.join(skillsPath, 'pilot-flow.md'), '# 流程技能\n\n正文。\n', 'utf-8')
    fs.writeFileSync(path.join(skillsPath, 'pilot-flow.sop.yaml'), SOP_YAML, 'utf-8')
    const router = new ToolRouter(avatarsPath)

    const plain = await router.execute(AVATAR_ID, { name: 'load_skill', arguments: { skill_id: 'plain' } }, undefined, CONV_ID)
    assert.equal(plain.error, undefined)
    assert.ok(!plain.content.includes('流程模式已启用'), '无 sop.yaml 的技能必须走原链路')

    const flow = await router.execute(AVATAR_ID, { name: 'load_skill', arguments: { skill_id: 'pilot-flow' } }, undefined, CONV_ID)
    assert.equal(flow.error, undefined)
    assert.match(flow.content, /流程模式已启用/)
    assert.match(flow.content, /收集参数/, '应注入首节点指令')
    assert.match(flow.content, /sop_report/, 'tool 通道应引导调用 sop_report')
    assert.ok(!flow.content.includes('<sop_state>'), 'tool 通道不得出现 text 通道标记')
  } finally {
    cleanup()
  }
})

test('sop_report：未开流程报错；槽位不齐拒绝跳步；齐了才放行到终点', async () => {
  const { avatarsPath, skillsPath, cleanup } = setupSandbox()
  try {
    fs.writeFileSync(path.join(skillsPath, 'pilot-flow.md'), '# 流程技能\n\n正文。\n', 'utf-8')
    fs.writeFileSync(path.join(skillsPath, 'pilot-flow.sop.yaml'), SOP_YAML, 'utf-8')
    const router = new ToolRouter(avatarsPath)

    // 没 load_skill 就汇报 → 明确报错并引导
    const orphan = await router.execute(AVATAR_ID, { name: 'sop_report', arguments: { skill: 'pilot-flow' } }, undefined, CONV_ID)
    assert.match(orphan.error ?? '', /没有正在进行的 SOP 流程/)
    assert.match(orphan.error ?? '', /load_skill/)

    await router.execute(AVATAR_ID, { name: 'load_skill', arguments: { skill_id: 'pilot-flow' } }, undefined, CONV_ID)

    // 槽位未填就想跳到终点 → 拒转 + warning（防跳步，状态机存在的意义）
    const jump = await router.execute(AVATAR_ID, {
      name: 'sop_report',
      arguments: { skill: 'pilot-flow', next: 'report', done: true },
    }, undefined, CONV_ID)
    const jumpPayload = JSON.parse(jump.content) as { current_node: string; transitioned: boolean; warnings?: string[] }
    assert.equal(jumpPayload.transitioned, false, '槽位不齐不得转移')
    assert.equal(jumpPayload.current_node, 'collect')
    assert.ok((jumpPayload.warnings ?? []).length > 0, '拒转必须带 warning 让模型知道为什么')

    // 填齐槽位后合法转移到终点并完成
    const ok = await router.execute(AVATAR_ID, {
      name: 'sop_report',
      arguments: { skill: 'pilot-flow', filled: { 装机容量: '215kWh' }, next: 'report' },
    }, undefined, CONV_ID)
    const okPayload = JSON.parse(ok.content) as { current_node: string; transitioned: boolean }
    assert.equal(okPayload.transitioned, true)
    assert.equal(okPayload.current_node, 'report')

    const fin = await router.execute(AVATAR_ID, {
      name: 'sop_report',
      arguments: { skill: 'pilot-flow', done: true },
    }, undefined, CONV_ID)
    const finPayload = JSON.parse(fin.content) as { finished: boolean; collected: Record<string, string>; path: string[] }
    assert.equal(finPayload.finished, true)
    assert.equal(finPayload.collected['装机容量'], '215kWh', '完成时必须交回收集到的槽位')
    assert.ok(finPayload.path.length > 0, '必须交回走过的节点路径')

    // 完成后状态清理：再报一次应提示流程不存在
    const after = await router.execute(AVATAR_ID, { name: 'sop_report', arguments: { skill: 'pilot-flow' } }, undefined, CONV_ID)
    assert.match(after.error ?? '', /没有正在进行的 SOP 流程/)
  } finally {
    cleanup()
  }
})

test('sop.yaml 解析失败 → 明确警告，不静默当普通技能', async () => {
  const { avatarsPath, skillsPath, cleanup } = setupSandbox()
  try {
    fs.writeFileSync(path.join(skillsPath, 'broken.md'), '# 技能\n\n正文。\n', 'utf-8')
    // start 指向不存在的节点 → schema 校验失败
    fs.writeFileSync(
      path.join(skillsPath, 'broken.sop.yaml'),
      'sop_version: 1\nskill: broken\ngoal: g\nstart: nope\nterminal: [a]\ninterruption: pause\nnodes:\n  - id: a\n    name: A\n    instruction: i\n    expects: []\n    tools: []\n    next: []\n',
      'utf-8',
    )
    const router = new ToolRouter(avatarsPath)
    const res = await router.execute(AVATAR_ID, { name: 'load_skill', arguments: { skill_id: 'broken' } }, undefined, CONV_ID)
    assert.equal(res.error, undefined, '技能正文仍应可用')
    assert.match(res.content, /SOP 流程定义/, '必须显式告知流程未启用')
    assert.match(res.content, /解析失败/)
  } finally {
    cleanup()
  }
})
