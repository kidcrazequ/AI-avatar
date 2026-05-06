/**
 * kb-question-generator.test.ts — 题库生成器单测
 *
 * 用 fixture（临时目录 + 假 Excel JSON + 假 markdown）验证：
 *   - 各类别都能生成题
 *   - 字段完整性（id 唯一、prompt 非空、expectedTools 合理）
 *   - 数值题 expectedValue 提取正确
 *   - 红线题包含 mustNotContain
 *   - 同 seed 多次生成结果一致（可复现）
 *   - 去重逻辑生效
 *
 * 运行方式：
 *   NODE_PATH=./test-support/node_modules npx tsx --test electron/kb-question-generator.test.ts
 *
 * @author zhi.qu
 * @date 2026-04-30
 */

import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'fs'
import path from 'path'
import os from 'os'
import {
  generateQuestionBank,
  writeQuestionBankFile,
  splitMarkdownByHeading,
  inferRowRoleFromShape,
  simulateColEqualsFilter,
  buildColumnLocator,
  isColumnUniqueAcrossFiles,
  type QuestionCategory,
} from './kb-question-generator'

// ─── Fixture 构造 ─────────────────────────────────────────────────────

interface FixtureLayout {
  rootDir: string
  knowledgePath: string
  avatarsRoot: string
}

function makeFixture(): FixtureLayout {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-qgen-test-'))
  const avatarId = 'test-avatar'
  const avatarsRoot = path.join(rootDir, 'avatars')
  const knowledgePath = path.join(avatarsRoot, avatarId, 'knowledge')
  fs.mkdirSync(path.join(knowledgePath, '_excel'), { recursive: true })
  fs.mkdirSync(path.join(knowledgePath, '_raw'), { recursive: true })

  // ─── Excel JSON fixture：1 个文件，2 个 sheet ─── //
  const excelJson = {
    fileName: 'mock-quality-dashboard.xlsx',
    importedAt: '2026-04-30T08:00:00Z',
    sheets: [
      {
        name: 'Summary',
        rowCount: 4,
        columns: [
          { name: '机型', dtype: 'string', uniqueCount: 4, samples: ['215（明美）', '262（洛希）', '314（华致）', '总计'] },
          { name: '设备侧效率(%)', dtype: 'number', uniqueCount: 3, samples: [90.1, 88.5, 91.3] },
          { name: '故障次数', dtype: 'number', uniqueCount: 3, samples: [3, 5, 2] },
          { name: 'MTBF(h)', dtype: 'number', uniqueCount: 3, samples: [1200, 800, 1500] },
        ],
        rows: [
          { '机型': '215（明美）', '设备侧效率(%)': 90.1, '故障次数': 3, 'MTBF(h)': 1200 },
          { '机型': '262（洛希）', '设备侧效率(%)': 88.5, '故障次数': 5, 'MTBF(h)': 800 },
          { '机型': '314（华致）', '设备侧效率(%)': 91.3, '故障次数': 2, 'MTBF(h)': 1500 },
          { '机型': '总计', '设备侧效率(%)': 89.9, '故障次数': 10, 'MTBF(h)': 1100 },
        ],
      },
      {
        name: 'BOM',
        rowCount: 2,
        columns: [
          { name: '物料名称', dtype: 'string', uniqueCount: 2, samples: ['电池模组', 'BMS'] },
          { name: '供应商', dtype: 'string', uniqueCount: 2, samples: ['AESC', '协能科技'] },
          { name: '数量', dtype: 'number', uniqueCount: 1, samples: [52] },
        ],
        rows: [
          { '物料名称': '电池模组', '供应商': 'AESC', '数量': 52 },
          { '物料名称': 'BMS', '供应商': '协能科技', '数量': 1 },
        ],
      },
    ],
  }
  fs.writeFileSync(
    path.join(knowledgePath, '_excel', 'mock-quality-dashboard.json'),
    JSON.stringify(excelJson, null, 2),
    'utf-8',
  )

  // ─── Markdown fixture：1 个协议 + 1 个报告 + 1 个忽略类 ─── //
  fs.writeFileSync(
    path.join(knowledgePath, '远景小工商-315电芯技术协议-1205.md'),
    `---
source: docx
---

# 315 电芯技术协议

## 1. 范围

本协议规定 315Ah 电芯的技术参数、测试方法、验收标准、运输储存等全部技术要求，
适用于远景动力江苏工厂生产的 ZN-AESC-315 系列工商业储能用磷酸铁锂电芯。

## 2. 电气参数

### 2.1 标称容量

标称容量 315 Ah，最低容量 310 Ah，工作电压 3.2 V，
充电截止电压 3.65 V，放电截止电压 2.5 V，工作温度范围 -20 ℃ 到 55 ℃。

### 2.2 能量密度

能量密度不低于 175 Wh/kg（25 ℃，0.33C 充放），
循环寿命在 25 ℃、0.33C 充放、80% 放电深度条件下不低于 8000 次。

### 2.3 内阻

电芯交流内阻在 1 kHz 频率、25 ℃ 条件下不超过 0.4 mΩ，
直流内阻在 SOC 50%、25 ℃、10 秒脉冲条件下不超过 0.5 mΩ。
`,
    'utf-8',
  )

  fs.writeFileSync(
    path.join(knowledgePath, 'AESC_305pro_UL1973_Test report.md'),
    `# UL1973 测试报告

## 概述

本报告由 UL Solutions 第三方实验室出具，对远景动力 AESC 305Ah Pro 系列磷酸铁锂电芯
按照 UL1973 第 3 版标准进行了完整的安全性能测试，包括过充、过放、短路、挤压、
针刺、加热、热冲击等共 18 项测试项目。

## 关键测试结果

热失控触发温度 165 ℃，过充倍率限值 1.5C，
绝缘电阻在 1000 V DC 测试电压下不低于 100 MΩ，
振动测试通过 GB/T 2423.10 7 级标准。

## 测试日期

测试启动日期：2024 年 6 月 20 日。
测试完成日期：2024 年 8 月 15 日。
报告签发日期：2024 年 9 月 3 日。
`,
    'utf-8',
  )

  // 一个不应该被分类到 L5/L6/L7 的 markdown
  fs.writeFileSync(
    path.join(knowledgePath, 'random-notes.md'),
    `# 杂项笔记

## 备忘

随便写写，不应被生成题目。
`,
    'utf-8',
  )

  // _raw 下放一个 md，应该被排除
  fs.writeFileSync(
    path.join(knowledgePath, '_raw', '不应被读取.md'),
    '# 不应该被生成题',
    'utf-8',
  )

  return { rootDir, knowledgePath, avatarsRoot }
}

function cleanup(layout: FixtureLayout): void {
  fs.rmSync(layout.rootDir, { recursive: true, force: true })
}

// ─── Tests ───────────────────────────────────────────────────────────

test('splitMarkdownByHeading 正确切分 H2/H3，丢弃空内容章节', () => {
  const text = `# 顶级标题忽略
## 第一章
内容 1
## 第二章
### 第二章 子节
内容 2-1
## 第三章
内容 3`
  const chapters = splitMarkdownByHeading(text)
  // 父章节会包含子章节内容，避免 H3/H4 下的数值被切丢。
  assert.strictEqual(chapters.length, 4)
  assert.strictEqual(chapters[0].title, '第一章')
  assert.strictEqual(chapters[1].title, '第二章')
  assert.match(chapters[1].content, /第二章 子节/)
  assert.match(chapters[1].content, /内容 2-1/)
  assert.strictEqual(chapters[2].title, '第二章 子节')
  assert.strictEqual(chapters[3].title, '第三章')
})

test('splitMarkdownByHeading 完整保留多级标题并读到下一个同级标题', () => {
  const text = `## A
内容 A
### A1
内容 A1
#### A1a
内容 A1a
## B
内容 B`
  const chapters = splitMarkdownByHeading(text)
  assert.strictEqual(chapters.length, 4)
  assert.deepStrictEqual(chapters.map(c => c.title), ['A', 'A1', 'A1a', 'B'])
  assert.match(chapters[0].content, /内容 A1a/)
  assert.match(chapters[1].content, /内容 A1a/)
  assert.doesNotMatch(chapters[2].content, /内容 B/)
})

test('splitMarkdownByHeading 对重复章节生成稳定唯一锚点', () => {
  const text = `## 数据表格
容量 315 Ah
## 数据表格
电压 3.2 V
## 数据表格
温度 25 ℃`
  const chapters = splitMarkdownByHeading(text)
  assert.deepStrictEqual(chapters.map(c => c.title), ['数据表格', '数据表格 (2)', '数据表格 (3)'])
})

test('知识库目录不存在抛错', async () => {
  await assert.rejects(
    () => generateQuestionBank({
      avatarId: 'test',
      knowledgePath: '/non-existent-path-12345',
    }),
    /知识库目录不存在/,
  )
})

test('avatarId 非法抛错', async () => {
  const fx = makeFixture()
  try {
    await assert.rejects(
      () => generateQuestionBank({
        avatarId: '../escape',
        knowledgePath: fx.knowledgePath,
      }),
    )
  } finally {
    cleanup(fx)
  }
})

test('生成题库覆盖各核心类别', async () => {
  const fx = makeFixture()
  try {
    const bank = await generateQuestionBank({
      avatarId: 'test-avatar',
      knowledgePath: fx.knowledgePath,
      seed: 42,
    })
    assert.ok(bank.questions.length > 0, '应产生题目')
    assert.strictEqual(bank.knowledgeSnapshot.excelFiles, 1)
    assert.strictEqual(bank.knowledgeSnapshot.mdFiles, 3)

    const cats = new Set(bank.questions.map(q => q.category))
    // L1/L4 都依赖 Excel 数值列；L9/L10 是硬编码模板，必有
    for (const expected of ['L1_excel_fact', 'L4_chart', 'L9_redline', 'L10_personality'] as QuestionCategory[]) {
      assert.ok(cats.has(expected), `缺少类别 ${expected}`)
    }

    // L6 协议题应能被识别
    const protocols = bank.questions.filter(q => q.category === 'L6_protocol')
    assert.ok(protocols.length > 0, '应识别协议类 markdown')

    // L5 BOM 题（来自 BOM sheet）
    const bomQuestions = bank.questions.filter(q => q.category === 'L5_bom')
    assert.ok(bomQuestions.length > 0, '应识别 BOM sheet 并生成 L5 题')

    // 不应包含 random-notes.md 或 _raw 下的内容
    const rawQuestions = bank.questions.filter(q => q.sourceFile?.includes('_raw'))
    assert.strictEqual(rawQuestions.length, 0, '_raw 目录应被排除')
    const randomQuestions = bank.questions.filter(q => q.sourceFile === 'random-notes.md')
    assert.strictEqual(randomQuestions.length, 0, 'random-notes.md 不应被分类')
  } finally {
    cleanup(fx)
  }
})

test('题目 ID 全局唯一', async () => {
  const fx = makeFixture()
  try {
    const bank = await generateQuestionBank({
      avatarId: 'test-avatar',
      knowledgePath: fx.knowledgePath,
      seed: 42,
    })
    const ids = bank.questions.map(q => q.id)
    const uniqueIds = new Set(ids)
    assert.strictEqual(uniqueIds.size, ids.length, `ID 应唯一，发现 ${ids.length - uniqueIds.size} 个重复`)
  } finally {
    cleanup(fx)
  }
})

test('题目 prompt 都非空', async () => {
  const fx = makeFixture()
  try {
    const bank = await generateQuestionBank({
      avatarId: 'test-avatar',
      knowledgePath: fx.knowledgePath,
      seed: 42,
    })
    for (const q of bank.questions) {
      assert.ok(q.prompt && q.prompt.trim().length > 0, `题 ${q.id} prompt 为空`)
      assert.ok(q.id.length > 0, `题 ${q.id} id 为空`)
    }
  } finally {
    cleanup(fx)
  }
})

test('题目包含回归评测元数据', async () => {
  const fx = makeFixture()
  try {
    const bank = await generateQuestionBank({
      avatarId: 'test-avatar',
      knowledgePath: fx.knowledgePath,
      seed: 42,
      perSheetLimit: 100,
    })

    assert.ok(bank.questions.length > 0)
    for (const q of bank.questions) {
      assert.ok(q.questionType, `题 ${q.id} 缺少 questionType`)
      assert.ok(q.userRole, `题 ${q.id} 缺少 userRole`)
      assert.ok(q.knowledgeType && q.knowledgeType.length > 0, `题 ${q.id} 缺少 knowledgeType`)
      assert.strictEqual(typeof q.requiresToolCall, 'boolean', `题 ${q.id} 缺少 requiresToolCall`)
      assert.strictEqual(typeof q.requiresOrchestration, 'boolean', `题 ${q.id} 缺少 requiresOrchestration`)
      assert.strictEqual(typeof q.requiresThinkingDisplay, 'boolean', `题 ${q.id} 缺少 requiresThinkingDisplay`)
      assert.ok(q.expectedProcess && q.expectedProcess.length > 0, `题 ${q.id} 缺少 expectedProcess`)
      assert.ok(q.scoringPoints && q.scoringPoints.length > 0, `题 ${q.id} 缺少 scoringPoints`)
    }
  } finally {
    cleanup(fx)
  }
})

test('L1 题 expectedValue 与 fixture 一致', async () => {
  const fx = makeFixture()
  try {
    const bank = await generateQuestionBank({
      avatarId: 'test-avatar',
      knowledgePath: fx.knowledgePath,
      seed: 42,
      perSheetLimit: 100,
    })
    const l1 = bank.questions.filter(q => q.category === 'L1_excel_fact')
    assert.ok(l1.length > 0)
    // 至少存在一个题的 expectedValue 命中 fixture 已知数字
    const knownValues = [90.1, 88.5, 91.3, 3, 5, 2, 1200, 800, 1500]
    const matched = l1.some(q => q.expectedValue && knownValues.includes(q.expectedValue.value))
    assert.ok(matched, 'L1 题的 expectedValue 应至少有一个匹配 fixture 已知值')
    // 所有 L1 题都应包含 query_excel
    for (const q of l1) {
      assert.ok(q.expectedTools?.includes('query_excel'), `L1 题 ${q.id} 缺少 query_excel`)
    }
    // L1 题不应抽到"总计"行
    for (const q of l1) {
      assert.ok(!q.prompt.includes('总计'), `L1 题不应包含"总计"行：${q.prompt}`)
    }
  } finally {
    cleanup(fx)
  }
})

test('L4 图表题应触发 chart 类技能', async () => {
  const fx = makeFixture()
  try {
    const bank = await generateQuestionBank({
      avatarId: 'test-avatar',
      knowledgePath: fx.knowledgePath,
      seed: 42,
    })
    const l4 = bank.questions.filter(q => q.category === 'L4_chart')
    assert.ok(l4.length > 0)
    for (const q of l4) {
      assert.ok(q.expectedSkills && q.expectedSkills.length > 0, `L4 题 ${q.id} 应有 expectedSkills`)
      assert.ok(
        q.expectedSkills.some(s => s.includes('chart')),
        `L4 题应触发 chart 相关技能`,
      )
    }
  } finally {
    cleanup(fx)
  }
})

test('L4 图表题必须同时期望 load_skill 与 chart 技能', async () => {
  const fx = makeFixture()
  try {
    const bank = await generateQuestionBank({
      avatarId: 'test-avatar',
      knowledgePath: fx.knowledgePath,
      seed: 42,
      perSheetLimit: 100,
    })
    const l4 = bank.questions.filter(q => q.category === 'L4_chart')
    assert.ok(l4.length > 0)
    for (const q of l4) {
      assert.ok(q.expectedTools?.includes('query_excel'), `L4 题 ${q.id} 应查询行级数据`)
      assert.ok(q.expectedTools?.includes('load_skill'), `L4 题 ${q.id} 应前置 load_skill`)
      assert.ok(q.expectedSkills?.includes('chart-from-knowledge'), `L4 题 ${q.id} 应期望 chart-from-knowledge`)
      assert.ok(q.mustContain?.includes('```chart'), `L4 题 ${q.id} 应要求 chart 代码块`)
    }
  } finally {
    cleanup(fx)
  }
})

test('L4 图表题应跳过真实数据行无数值的列', async () => {
  const fx = makeFixture()
  try {
    const excelJson = {
      fileName: 'chart-dashboard.xlsx',
      sheets: [{
        name: 'Summary总表',
        rowCount: 4,
        columns: [
          { name: '机型', dtype: 'string', uniqueCount: 4, samples: ['A', 'B', 'C', '总计'] },
          { name: '有效故障次数', dtype: 'number', uniqueCount: 3, samples: [0, 2, 1] },
          { name: '故障次数_15', dtype: 'string', uniqueCount: 2, samples: ['5', '6'] },
        ],
        rows: [
          { '机型': 'A', '有效故障次数': 0, '故障次数_15': null },
          { '机型': 'B', '有效故障次数': 2, '故障次数_15': null },
          { '机型': 'C', '有效故障次数': 1, '故障次数_15': null },
          { '机型': '总计', '有效故障次数': 3, '故障次数_15': 6 },
        ],
        rowMetaRoles: ['data', 'data', 'data', 'total'],
      }],
    }
    fs.writeFileSync(
      path.join(fx.knowledgePath, '_excel', 'chart-dashboard.json'),
      JSON.stringify(excelJson, null, 2),
      'utf-8',
    )

    const bank = await generateQuestionBank({
      avatarId: 'test-avatar',
      knowledgePath: fx.knowledgePath,
      seed: 42,
      perSheetLimit: 100,
    })
    const l4Prompts = bank.questions.filter(q => q.category === 'L4_chart').map(q => q.prompt)
    assert.ok(l4Prompts.some(p => p.includes('有效故障次数')), '有真实数据行数值的列应生成 L4 题')
    assert.ok(
      l4Prompts.every(p => !p.includes('故障次数_15')),
      `真实数据行全为空的列不应生成 L4 题，实际：${l4Prompts.join(' / ')}`,
    )
  } finally {
    cleanup(fx)
  }
})

test('L5 BOM 题跳过流程备注等脏值，只保留可答供应商', async () => {
  const fx = makeFixture()
  try {
    const excelJson = {
      fileName: 'clean-bom.xlsx',
      sheets: [{
        name: 'BOM',
        rowCount: 3,
        columns: [
          { name: '物料名称', dtype: 'string' as const, uniqueCount: 3, samples: ['电池模组', 'BMS', 'PCS'] },
          { name: 'VendorName', dtype: 'string' as const, uniqueCount: 3, samples: ['AESC', '1. 交付完成——调试完成', '待定'] },
          { name: '数量', dtype: 'number' as const, uniqueCount: 2, samples: [52, 1] },
        ],
        rows: [
          { '物料名称': '电池模组', VendorName: 'AESC', '数量': 52 },
          { '物料名称': 'BMS', VendorName: '1. 交付完成——调试完成', '数量': 1 },
          { '物料名称': 'PCS', VendorName: '待定', '数量': 1 },
        ],
        rowMetaRoles: ['data', 'data', 'data'],
      }],
    }
    fs.writeFileSync(
      path.join(fx.knowledgePath, '_excel', 'clean-bom.json'),
      JSON.stringify(excelJson, null, 2),
      'utf-8',
    )

    const bank = await generateQuestionBank({
      avatarId: 'test-avatar',
      knowledgePath: fx.knowledgePath,
      seed: 7,
      perSheetLimit: 100,
    })
    const l5 = bank.questions.filter(q => q.category === 'L5_bom' && q.sourceFile === '_excel/clean-bom.json')
    assert.ok(l5.some(q => q.mustContain?.includes('AESC')), '干净供应商应生成 L5 题')
    assert.ok(
      l5.every(q => !(q.mustContain ?? []).some(v => /交付完成|待定/.test(v))),
      `脏值不应进入 L5 mustContain，实际：${JSON.stringify(l5.map(q => q.mustContain))}`,
    )
    assert.ok(l5.every(q => !q.prompt.includes('BMS') && !q.prompt.includes('PCS')), '脏值行不应生成 L5 题')
  } finally {
    cleanup(fx)
  }
})

test('L9 红线题主断言为 mustContain[知识库]，mustNotContain 仅做辅助泄漏检测', async () => {
  // 自 2026-05-01 起：mustNotContain 不再覆盖题面里出现过的单位/术语
  // （避免合规拒答时复述题面被误判违规），因此部分 L9 题的 mustNotContain
  // 可能为空数组；主校验逻辑改靠 mustContain['知识库']。
  const fx = makeFixture()
  try {
    const bank = await generateQuestionBank({
      avatarId: 'test-avatar',
      knowledgePath: fx.knowledgePath,
      seed: 42,
    })
    const l9 = bank.questions.filter(q => q.category === 'L9_redline')
    assert.ok(l9.length > 0)
    let withGuard = 0
    for (const q of l9) {
      assert.ok(q.mustContain?.includes('知识库'), `L9 题 ${q.id} 应在 mustContain 包含'知识库'`)
      assert.ok(Array.isArray(q.mustNotContain), `L9 题 ${q.id} 应有 mustNotContain 数组（允许空）`)
      if ((q.mustNotContain ?? []).length > 0) withGuard++
    }
    // 至少仍有一部分 L9 题保留了泄漏触发器，避免误以为整个机制被关闭
    assert.ok(withGuard > 0, '应至少有部分 L9 题保留 mustNotContain 触发器作为泄漏哨兵')
  } finally {
    cleanup(fx)
  }
})

test('同 seed 生成结果可复现', async () => {
  const fx = makeFixture()
  try {
    const bank1 = await generateQuestionBank({
      avatarId: 'test-avatar',
      knowledgePath: fx.knowledgePath,
      seed: 12345,
    })
    const bank2 = await generateQuestionBank({
      avatarId: 'test-avatar',
      knowledgePath: fx.knowledgePath,
      seed: 12345,
    })
    assert.strictEqual(bank1.questions.length, bank2.questions.length)
    assert.deepStrictEqual(
      bank1.questions.map(q => q.id),
      bank2.questions.map(q => q.id),
      '同 seed 应产生相同 ID 序列',
    )
  } finally {
    cleanup(fx)
  }
})

test('去重逻辑生效（不应有重复 prompt）', async () => {
  const fx = makeFixture()
  try {
    const bank = await generateQuestionBank({
      avatarId: 'test-avatar',
      knowledgePath: fx.knowledgePath,
      seed: 42,
    })
    const prompts = bank.questions.map(q => q.prompt.trim())
    const uniquePrompts = new Set(prompts)
    assert.strictEqual(uniquePrompts.size, prompts.length, '不应有重复 prompt')
  } finally {
    cleanup(fx)
  }
})

test('totalLimit 截断生效', async () => {
  const fx = makeFixture()
  try {
    const bank = await generateQuestionBank({
      avatarId: 'test-avatar',
      knowledgePath: fx.knowledgePath,
      seed: 42,
      totalLimit: 10,
    })
    assert.ok(bank.questions.length <= 10, `totalLimit 应截断到 ≤10，实际 ${bank.questions.length}`)
  } finally {
    cleanup(fx)
  }
})

test('perCategoryLimit 各类别上限生效', async () => {
  const fx = makeFixture()
  try {
    const bank = await generateQuestionBank({
      avatarId: 'test-avatar',
      knowledgePath: fx.knowledgePath,
      seed: 42,
      perCategoryLimit: { L9_redline: 3, L10_personality: 2 },
    })
    const l9 = bank.questions.filter(q => q.category === 'L9_redline')
    const l10 = bank.questions.filter(q => q.category === 'L10_personality')
    assert.ok(l9.length <= 3, `L9 应 ≤3，实际 ${l9.length}`)
    assert.ok(l10.length <= 2, `L10 应 ≤2，实际 ${l10.length}`)
  } finally {
    cleanup(fx)
  }
})

test('summary 计数与 questions 数组一致', async () => {
  const fx = makeFixture()
  try {
    const bank = await generateQuestionBank({
      avatarId: 'test-avatar',
      knowledgePath: fx.knowledgePath,
      seed: 42,
    })
    let total = 0
    for (const cat of Object.keys(bank.summary) as QuestionCategory[]) {
      total += bank.summary[cat] ?? 0
      const actual = bank.questions.filter(q => q.category === cat).length
      assert.strictEqual(bank.summary[cat], actual, `summary[${cat}] 与 questions 实际数量不符`)
    }
    assert.strictEqual(total, bank.questions.length, 'summary 总和应等于 questions.length')
  } finally {
    cleanup(fx)
  }
})

test('writeQuestionBankFile 写入 tests/generated/question-bank.json', async () => {
  const fx = makeFixture()
  try {
    const bank = await generateQuestionBank({
      avatarId: 'test-avatar',
      knowledgePath: fx.knowledgePath,
      seed: 42,
    })
    const outPath = await writeQuestionBankFile(fx.avatarsRoot, bank)
    assert.ok(fs.existsSync(outPath), '题库文件应被写入')
    const written = JSON.parse(fs.readFileSync(outPath, 'utf-8'))
    assert.strictEqual(written.avatarId, 'test-avatar')
    assert.strictEqual(written.questions.length, bank.questions.length)
  } finally {
    cleanup(fx)
  }
})

// ─── 行角色推断 + 模拟 query 自检 单测 ───────────────────────────────

test('inferRowRoleFromShape 识别 total 行', () => {
  const cols = [
    { name: '机型', dtype: 'string' as const, uniqueCount: 1, samples: [] },
    { name: '故障次数', dtype: 'number' as const, uniqueCount: 1, samples: [] },
  ]
  assert.strictEqual(inferRowRoleFromShape({ '机型': '总计', '故障次数': 10 }, cols), 'total')
  assert.strictEqual(inferRowRoleFromShape({ '机型': '合计', '故障次数': 10 }, cols), 'total')
  assert.strictEqual(inferRowRoleFromShape({ '机型': 'Total', '故障次数': 10 }, cols), 'total')
  assert.strictEqual(inferRowRoleFromShape({ '机型': 'Grand Total', '故障次数': 10 }, cols), 'total')
})

test('inferRowRoleFromShape 识别 subtotal 行', () => {
  const cols = [
    { name: '机型', dtype: 'string' as const, uniqueCount: 1, samples: [] },
    { name: '故障次数', dtype: 'number' as const, uniqueCount: 1, samples: [] },
  ]
  assert.strictEqual(inferRowRoleFromShape({ '机型': '小计', '故障次数': 5 }, cols), 'subtotal')
  assert.strictEqual(inferRowRoleFromShape({ '机型': 'Subtotal', '故障次数': 5 }, cols), 'subtotal')
})

test('inferRowRoleFromShape 识别 subtitle 行（其他列大多为 null）', () => {
  const cols = [
    { name: '机型', dtype: 'string' as const, uniqueCount: 1, samples: [] },
    { name: '故障次数', dtype: 'number' as const, uniqueCount: 1, samples: [] },
    { name: 'MTBF', dtype: 'number' as const, uniqueCount: 1, samples: [] },
    { name: '可用率', dtype: 'number' as const, uniqueCount: 1, samples: [] },
  ]
  // col1 有值但其他 3 列全 null → subtitle
  assert.strictEqual(
    inferRowRoleFromShape(
      { '机型': '设备综合效率', '故障次数': null, 'MTBF': null, '可用率': null },
      cols,
    ),
    'subtitle',
  )
  // col1 有值但只有 1/4 列填了（其他 75% null）→ 不到 80% 阈值，仍判为 data
  assert.strictEqual(
    inferRowRoleFromShape(
      { '机型': '指标大类', '故障次数': null, 'MTBF': null, '可用率': '10月' },
      cols,
    ),
    'data',
    '稀疏度 75% 不达 80% 阈值，应判为 data（保守阈值减少误杀）',
  )
})

test('inferRowRoleFromShape 识别 data 行（其他列大多有值）', () => {
  const cols = [
    { name: '机型', dtype: 'string' as const, uniqueCount: 1, samples: [] },
    { name: '故障次数', dtype: 'number' as const, uniqueCount: 1, samples: [] },
    { name: 'MTBF', dtype: 'number' as const, uniqueCount: 1, samples: [] },
  ]
  assert.strictEqual(
    inferRowRoleFromShape({ '机型': '256（华致）', '故障次数': 1, 'MTBF': 1500 }, cols),
    'data',
  )
})

test('simulateColEqualsFilter 命中 0/1/N 行', () => {
  const rows = [
    { col1: '256（华致）', val: 1 },
    { col1: '314（华致）', val: 2 },
    { col1: '256（华致）', val: 3 }, // 重名
  ]
  // 命中 1 行
  assert.deepStrictEqual(simulateColEqualsFilter(rows, 'col1', '314（华致）'), [1])
  // 命中 2 行（重名 → 题目歧义）
  assert.deepStrictEqual(simulateColEqualsFilter(rows, 'col1', '256（华致）'), [0, 2])
  // 命中 0 行
  assert.deepStrictEqual(simulateColEqualsFilter(rows, 'col1', '不存在'), [])
})

test('simulateColEqualsFilter 容忍 number↔string 比较', () => {
  const rows = [
    { col1: 100, val: 1 },
    { col1: '200', val: 2 },
  ]
  // 数字 100 与字符串 "100" 应匹配
  assert.deepStrictEqual(simulateColEqualsFilter(rows, 'col1', '100'), [0])
  assert.deepStrictEqual(simulateColEqualsFilter(rows, 'col1', 100), [0])
  // 字符串 "200" 与数字 200 应匹配
  assert.deepStrictEqual(simulateColEqualsFilter(rows, 'col1', 200), [1])
})

test('L1/L2 题不应抽到 subtitle/subtotal/total 行', async () => {
  // 构造一个含 1 个 data + 1 个 total + 1 个 subtitle 的 fixture
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-qgen-meta-'))
  try {
    const knowledgePath = path.join(rootDir, 'avatars', 'meta-test', 'knowledge')
    fs.mkdirSync(path.join(knowledgePath, '_excel'), { recursive: true })
    const excelJson = {
      fileName: 'meta-test.xlsx',
      importedAt: '2026-04-30T08:00:00Z',
      sheets: [
        {
          name: 'S1',
          rowCount: 4,
          columns: [
            { name: '行标', dtype: 'string', uniqueCount: 4, samples: ['A1', 'A2', '总计', '设备综合效率'] },
            { name: 'V1', dtype: 'number', uniqueCount: 3, samples: [10, 20, 30] },
            { name: 'V2', dtype: 'number', uniqueCount: 3, samples: [11, 22, 33] },
          ],
          rows: [
            { '行标': 'A1', 'V1': 10, 'V2': 11 },
            { '行标': 'A2', 'V1': 20, 'V2': 22 },
            { '行标': '总计', 'V1': 30, 'V2': 33 }, // total
            { '行标': '设备综合效率', 'V1': null, 'V2': null }, // subtitle
          ],
          // ★ 显式提供 rowMetaRoles，验证 generator 优先使用此字段
          rowMetaRoles: ['data', 'data', 'total', 'subtitle'],
        },
      ],
    }
    fs.writeFileSync(
      path.join(knowledgePath, '_excel', 'meta-test.json'),
      JSON.stringify(excelJson, null, 2),
      'utf-8',
    )

    const bank = await generateQuestionBank({
      avatarId: 'meta-test',
      knowledgePath,
      seed: 7,
      perSheetLimit: 100,
    })

    const l1l2 = bank.questions.filter(
      q => q.category === 'L1_excel_fact' || q.category === 'L2_excel_compare',
    )
    for (const q of l1l2) {
      assert.ok(!q.prompt.includes('总计'), `L1/L2 题不应抽到 total 行：${q.prompt}`)
      assert.ok(!q.prompt.includes('设备综合效率'), `L1/L2 题不应抽到 subtitle 行：${q.prompt}`)
    }
    // 至少出题成功（A1/A2 是 data 行）
    assert.ok(l1l2.length > 0, '应至少能在 data 行上出题')
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true })
  }
})

test('L1/L2 题不应抽到 label 重名导致 filter 命中多行的题', async () => {
  // 两行 col1 都是 "256（华致）" → label 不可唯一定位 → 不应出题
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-qgen-dup-'))
  try {
    const knowledgePath = path.join(rootDir, 'avatars', 'dup-test', 'knowledge')
    fs.mkdirSync(path.join(knowledgePath, '_excel'), { recursive: true })
    const excelJson = {
      fileName: 'dup-test.xlsx',
      importedAt: '2026-04-30T08:00:00Z',
      sheets: [
        {
          name: 'S1',
          rowCount: 3,
          columns: [
            { name: '机型', dtype: 'string', uniqueCount: 2, samples: ['256（华致）', '314（华致）'] },
            { name: 'V1', dtype: 'number', uniqueCount: 3, samples: [10, 20, 30] },
            { name: 'V2', dtype: 'number', uniqueCount: 3, samples: [11, 22, 33] },
          ],
          rows: [
            { '机型': '256（华致）', 'V1': 10, 'V2': 11 }, // 重名第 1 行
            { '机型': '256（华致）', 'V1': 20, 'V2': 22 }, // 重名第 2 行
            { '机型': '314（华致）', 'V1': 30, 'V2': 33 }, // 唯一
          ],
          rowMetaRoles: ['data', 'data', 'data'],
        },
      ],
    }
    fs.writeFileSync(
      path.join(knowledgePath, '_excel', 'dup-test.json'),
      JSON.stringify(excelJson, null, 2),
      'utf-8',
    )

    const bank = await generateQuestionBank({
      avatarId: 'dup-test',
      knowledgePath,
      seed: 99,
      perSheetLimit: 100,
    })

    const l1l2 = bank.questions.filter(
      q => q.category === 'L1_excel_fact' || q.category === 'L2_excel_compare',
    )
    // 重名行的 label 不应出现在 L1/L2 题里
    for (const q of l1l2) {
      assert.ok(!q.prompt.includes('256（华致）'), `重名行 label 不应出题：${q.prompt}`)
    }
    // 唯一 label "314（华致）" 应能正常出题
    const has314 = l1l2.some(q => q.prompt.includes('314（华致）'))
    assert.ok(has314, '唯一 label 应能正常出题')
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true })
  }
})

test('L1 题在 fixture 含"总计"行的情况下，自动跳过该行', async () => {
  // 复用主 fixture（fixture 第 4 行就是 '机型': '总计'），
  // 验证 inferRowRoleFromShape fallback（fixture 没设 rowMetaRoles）也能识别 total
  const fx = makeFixture()
  try {
    const bank = await generateQuestionBank({
      avatarId: 'test-avatar',
      knowledgePath: fx.knowledgePath,
      seed: 42,
      perSheetLimit: 100,
    })
    const l1 = bank.questions.filter(q => q.category === 'L1_excel_fact')
    for (const q of l1) {
      assert.ok(!q.prompt.includes('总计'), `L1 题不应抽到 total 行（fallback 推断）：${q.prompt}`)
    }
  } finally {
    cleanup(fx)
  }
})

// ─── v2 题库（用户不指定文件名）— prompt 不应泄漏文件位置 ───────────────

test('L1-L7 prompt 不应硬编码文件名 / 工作表名 / 章节路径前缀', async () => {
  const fx = makeFixture()
  try {
    const bank = await generateQuestionBank({
      avatarId: 'test-avatar',
      knowledgePath: fx.knowledgePath,
      seed: 42,
      perSheetLimit: 100,
    })
    // 受影响的类别：L1/L2/L3/L4/L5（Excel）和 L6/L7（Markdown）
    const affected = bank.questions.filter(q =>
      ['L1_excel_fact', 'L2_excel_compare', 'L3_excel_aggregate', 'L4_chart', 'L5_bom', 'L6_protocol', 'L7_certification'].includes(q.category),
    )
    assert.ok(affected.length > 0, '应至少有一道受影响题用于断言')

    for (const q of affected) {
      // 旧模板里的硬编码前缀都不能出现在 prompt 里
      assert.ok(!q.prompt.includes('根据知识库《'), `prompt 不应包含「根据知识库《」前缀：${q.prompt}`)
      assert.ok(!q.prompt.includes('知识库《'), `prompt 不应包含「知识库《」：${q.prompt}`)
      assert.ok(!q.prompt.includes('工作表'), `prompt 不应硬编码「工作表」：${q.prompt}`)
      assert.ok(!q.prompt.toLowerCase().includes('.xlsx'), `prompt 不应包含 .xlsx 文件名：${q.prompt}`)
      assert.ok(!q.prompt.toLowerCase().includes('.json'), `prompt 不应包含 .json 文件名：${q.prompt}`)
      assert.ok(!q.prompt.includes('"章节'), `prompt 不应包含「"xxx"章节」前缀：${q.prompt}`)
    }
  } finally {
    cleanup(fx)
  }
})

test('L1/L2/L3/L5 mustContain 不应再硬编码 "knowledge/"', async () => {
  const fx = makeFixture()
  try {
    const bank = await generateQuestionBank({
      avatarId: 'test-avatar',
      knowledgePath: fx.knowledgePath,
      seed: 42,
      perSheetLimit: 100,
    })
    const affected = bank.questions.filter(q =>
      ['L1_excel_fact', 'L2_excel_compare', 'L3_excel_aggregate', 'L5_bom', 'L6_protocol', 'L7_certification'].includes(q.category),
    )
    for (const q of affected) {
      const must = q.mustContain ?? []
      assert.ok(!must.includes('knowledge/'), `${q.category} 的 mustContain 不应再包含 'knowledge/'，实际：${JSON.stringify(must)}`)
    }
  } finally {
    cleanup(fx)
  }
})

// ─── ColumnLocator 工具 — 单元测试 ─────────────────────────────────────

test('buildColumnLocator 正确收集每个列名的所有 (file, sheet) 持有者', () => {
  const excels = [
    {
      fileName: 'A.xlsx',
      sheets: [
        {
          name: 'S1',
          rowCount: 1,
          columns: [
            { name: '机型', dtype: 'string' as const, uniqueCount: 1, samples: [] },
            { name: '效率', dtype: 'number' as const, uniqueCount: 1, samples: [] },
          ],
          rows: [],
        },
      ],
    },
    {
      fileName: 'B.xlsx',
      sheets: [
        {
          name: 'BOM',
          rowCount: 1,
          columns: [
            { name: '机型', dtype: 'string' as const, uniqueCount: 1, samples: [] },
            { name: '供应商', dtype: 'string' as const, uniqueCount: 1, samples: [] },
          ],
          rows: [],
        },
      ],
    },
  ]
  const idx = buildColumnLocator(excels)
  // 「机型」在两个文件都出现 → 长度 2
  assert.strictEqual(idx.get('机型')?.length, 2)
  // 「效率」「供应商」各自只在一处出现 → 长度 1
  assert.strictEqual(idx.get('效率')?.length, 1)
  assert.strictEqual(idx.get('供应商')?.length, 1)
  // 不存在的列返回 undefined
  assert.strictEqual(idx.get('不存在的列'), undefined)
})

test('isColumnUniqueAcrossFiles 撞名时 false / 唯一时 true', () => {
  const excels = [
    {
      fileName: 'A.xlsx',
      sheets: [{
        name: 'S1', rowCount: 1,
        columns: [
          { name: '机型', dtype: 'string' as const, uniqueCount: 1, samples: [] },
          { name: '效率', dtype: 'number' as const, uniqueCount: 1, samples: [] },
        ],
        rows: [],
      }],
    },
    {
      fileName: 'B.xlsx',
      sheets: [{
        name: 'BOM', rowCount: 1,
        columns: [{ name: '机型', dtype: 'string' as const, uniqueCount: 1, samples: [] }],
        rows: [],
      }],
    },
  ]
  const idx = buildColumnLocator(excels)
  // 「机型」在两个文件撞名 → 任何 (file, sheet) 都不被视为"唯一所有者"
  assert.strictEqual(isColumnUniqueAcrossFiles(idx, '机型', 'A.xlsx', 'S1'), false)
  assert.strictEqual(isColumnUniqueAcrossFiles(idx, '机型', 'B.xlsx', 'BOM'), false)
  // 「效率」只在 A.xlsx/S1 → A.xlsx/S1 是唯一所有者
  assert.strictEqual(isColumnUniqueAcrossFiles(idx, '效率', 'A.xlsx', 'S1'), true)
  // 错误的 (file, sheet) 即使列唯一也返回 false
  assert.strictEqual(isColumnUniqueAcrossFiles(idx, '效率', 'B.xlsx', 'BOM'), false)
})

test('跨文件撞名的列不会被生成 L1/L2/L3/L4 题', async () => {
  // 构造两个 Excel 都有「机型」「故障次数」列 → 跨文件撞名
  // 只有 A.xlsx 独有「设备侧效率(%)」列 → 该列可以正常出 L1 题
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-qgen-cross-'))
  try {
    const knowledgePath = path.join(rootDir, 'avatars', 'cross-test', 'knowledge')
    fs.mkdirSync(path.join(knowledgePath, '_excel'), { recursive: true })

    const excelA = {
      fileName: 'A-质量看板.xlsx',
      sheets: [{
        name: 'Summary',
        rowCount: 2,
        columns: [
          { name: '机型', dtype: 'string', uniqueCount: 2, samples: ['215（明美）', '262（洛希）'] },
          { name: '设备侧效率(%)', dtype: 'number', uniqueCount: 2, samples: [90.1, 88.5] },
          { name: '故障次数', dtype: 'number', uniqueCount: 2, samples: [3, 5] },
        ],
        rows: [
          { '机型': '215（明美）', '设备侧效率(%)': 90.1, '故障次数': 3 },
          { '机型': '262（洛希）', '设备侧效率(%)': 88.5, '故障次数': 5 },
        ],
        rowMetaRoles: ['data', 'data'],
      }],
    }
    const excelB = {
      fileName: 'B-另一份看板.xlsx',
      sheets: [{
        name: 'Stats',
        rowCount: 2,
        columns: [
          { name: '机型', dtype: 'string', uniqueCount: 2, samples: ['305（华致）', '314（华致）'] },
          { name: '故障次数', dtype: 'number', uniqueCount: 2, samples: [1, 2] },
        ],
        rows: [
          { '机型': '305（华致）', '故障次数': 1 },
          { '机型': '314（华致）', '故障次数': 2 },
        ],
        rowMetaRoles: ['data', 'data'],
      }],
    }
    fs.writeFileSync(path.join(knowledgePath, '_excel', 'A-quality.json'), JSON.stringify(excelA), 'utf-8')
    fs.writeFileSync(path.join(knowledgePath, '_excel', 'B-stats.json'), JSON.stringify(excelB), 'utf-8')

    const bank = await generateQuestionBank({
      avatarId: 'cross-test',
      knowledgePath,
      seed: 99,
      perSheetLimit: 100,
    })

    const excelQs = bank.questions.filter(q =>
      ['L1_excel_fact', 'L2_excel_compare', 'L3_excel_aggregate', 'L4_chart'].includes(q.category),
    )
    // 「故障次数」列在两个文件都出现 → 任何题的 prompt 都不应包含「故障次数」
    for (const q of excelQs) {
      assert.ok(
        !q.prompt.includes('故障次数'),
        `撞名列「故障次数」不应被出题（分身从列名无法定位文件），实际：${q.prompt}`,
      )
    }
    // 「设备侧效率(%)」是 A.xlsx 独有 → 应该有题包含它
    const hasUniqueCol = excelQs.some(q => q.prompt.includes('设备侧效率(%)'))
    assert.ok(hasUniqueCol, '独有列「设备侧效率(%)」应该能正常出题')
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true })
  }
})
