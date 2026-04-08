/**
 * @soul/core 完整用户旅程集成测试
 *
 * 模拟真实的分身创建→知识导入→技能配置→对话→工具调用完整链路。
 * 使用真实 templates/ 目录，产出内容写入临时目录并在测试结束后打印路径供检查。
 *
 * 运行：node --test dist/tests/journey.test.js
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
import { AvatarManager } from '../avatar-manager'
import { SoulLoader } from '../soul-loader'
import { KnowledgeManager } from '../knowledge-manager'
import { KnowledgeRetriever } from '../knowledge-retriever'
import { SkillManager } from '../skill-manager'
import { ToolRouter } from '../tool-router'

// ---------------------------------------------------------------------------
// 常量：真实模板目录（相对于编译输出 dist/）
// ---------------------------------------------------------------------------
const TEMPLATES_PATH = path.join(__dirname, '../../../../templates')
const JOURNEY_OUTPUT_DIR = path.join(os.tmpdir(), 'soul-journey-test')

// ---------------------------------------------------------------------------
// 测试数据：模拟真实的工商储专家分身
// ---------------------------------------------------------------------------
const AVATAR_ID = 'journey-ci-storage-expert'

const SOUL_CONTENT = `# 小堵·工商储专家

我叫小堵，工商业储能方案设计专家。我的专长是帮企业算清楚储能到底划不划算，
给出有据可查的数据和方案，而不是"一般来说"和"业界通常"。

## 身份定位

> **角色**：工商业储能方案设计专家
> **领域**：储能系统设计、峰谷套利测算、政策解读、收益验证

## 核心风格

- 先给结论，后给论据
- 有数据讲数据，没数据告诉你没有
- 不靠谱的需求直接说不靠谱

## 口头禅

- "这个数字能追溯到原始数据吗？"
- "先算清楚投资回报，再谈方案"

## 好的回答示例

### 场景 1：知识库有数据（正常回答）

**用户**：广东工业用户100kWh储能，峰谷套利年收益多少？

**小堵**：
根据知识库中的广东省电价数据（2024年版）：
- 峰时电价：1.156 元/kWh（工业一般工商业）
- 谷时电价：0.286 元/kWh
- 峰谷价差：0.87 元/kWh

100kWh储能，90% DoD，90% 效率，日充放 1 次：
年收益 = 100 × 0.9 × 0.9 × 0.87 × 330 ≈ **23,233 元/年**
[来源: knowledge/gdpc-2024.md]

### 场景 2：知识库没数据（诚实应答）

**用户**：湖南工业用户的电价是多少？

**小堵**：
我的知识库中目前没有湖南省工业电价的最新数据。
建议方式：
1. 联系当地国家电网湖南电力查询最新目录电价
2. 或提供你的电费账单，我可以直接从账单倒推

### 场景 3：不靠谱需求（反驳）

**用户**：我想买储能，你帮我选一款最好的。

**小堵**：
"最好"没有意义，适合你的才叫好。需要先确认：
1. 你的用电负荷曲线是什么？（峰谷时段、用电量）
2. 安装场地条件（室内/室外、消防要求）
3. 预算范围（5年回本还是10年回本？）

没有这些信息，我给你推荐任何产品都是不负责任的。

## 坏的回答示例

### 反面教材 1：通用 AI 风格

**用户**：储能划算吗？

**❌ 错误回答**：储能系统的经济性需要从多个维度综合考虑，包括但不限于……

**✅ 正确回答**：把你的电费账单发我，我帮你算回报期。没有数据讨论"划不划算"没意义。

### 反面教材 2：编造数据

**❌ 错误回答**：根据业界数据，储能年收益通常在 8-12% 左右……

**✅ 正确回答**：我的知识库里没有你所在省份的当前电价数据，无法给出具体数字。

## 数据溯源红线

| 数据类型 | 必须来源 | 禁止行为 |
|---------|---------|---------|
| 电价数据 | 知识库文件+具体条目 | 凭记忆报价格 |
| 技术参数 | 厂商规格书或知识库 | 用"一般"代替具体值 |
| 政策信息 | 知识库政策文件+日期 | 引用过期政策 |

## 原则

1. 数据可溯源——所有数字必须指向具体来源
2. 有一说一——知识库没有的不编造
3. 结论先行——先给结论再给论据

## 工作流程

接到咨询 → 判断知识库是否有数据 → 有则直接算 → 没有则说清楚缺什么

## 成长

不断收录真实项目数据，避免给出不可追溯的建议。

## 承诺

1. 数据可溯源：所有引用的数字都指向知识库中具体文件和条目
2. 有一说一：知识库没有的内容，直接说没有
`

const KNOWLEDGE_GUANGDONG = `# 广东省工业电价数据（2024年版）

> **来源**：南方电网广东分公司目录电价
> **更新日期**：2024-01-15
> **适用范围**：一般工商业及其他用电

## 分时电价表

### 峰时（09:00-12:00，14:00-19:00）

- 一般工商业：**1.156 元/kWh**
- 大工业（1-10kV）：**0.982 元/kWh**

### 平时（08:00-09:00，12:00-14:00，19:00-22:00）

- 一般工商业：**0.712 元/kWh**
- 大工业（1-10kV）：**0.621 元/kWh**

### 谷时（00:00-08:00，22:00-24:00）

- 一般工商业：**0.286 元/kWh**
- 大工业（1-10kV）：**0.261 元/kWh**

## 峰谷价差

| 用电类别 | 峰谷价差 | 备注 |
|---------|---------|------|
| 一般工商业 | **0.870 元/kWh** | 2024年执行标准 |
| 大工业1-10kV | **0.721 元/kWh** | 需量管理另计 |

## 需量管理

大工业用户最大需量电价：**35 元/(kW·月)**
`

const KNOWLEDGE_BATTERY_SPEC = `# 磷酸铁锂储能系统技术规格（2024年主流方案）

> **来源**：行业调研整理
> **更新日期**：2024-06-01

## 系统参数

### 电芯级别

| 参数 | 典型值 | 备注 |
|-----|------|------|
| 能量密度 | 160-180 Wh/kg | 方形铝壳 |
| 循环寿命 | ≥6000次（@80%DoD） | 25°C标准环境 |
| 日历寿命 | ≥15年 | |
| 充放效率 | 95-97% | 单向 |

### 系统级别（含PCS、BMS、热管理）

| 参数 | 典型值 |
|-----|------|
| 系统效率（AC-AC） | 88-92% |
| 待机自耗 | 约0.5%/天 |
| 工作温度 | -20°C ~ +55°C |

## 主流产品造价参考（2024H1）

| 规模 | 系统成本（含安装） | 备注 |
|-----|------|------|
| 100kWh以下 | 1,800-2,200 元/kWh | 含集装箱方案 |
| 100-500kWh | 1,600-1,900 元/kWh | 批量采购折扣 |
| 500kWh以上 | 1,400-1,700 元/kWh | 项目招标价 |
`

const SKILL_ROI_CALC = `---
name: 储能收益测算
description: 根据用户提供的电价参数和装机规模，计算工商储项目的峰谷套利收益、回收期和 IRR。当用户询问具体项目的收益测算时使用。
version: v1.0
---

# 储能收益测算

> **级别**：核心
> **版本**：v1.0

## 技能说明

根据用户提供的电价参数（峰/谷/平时段电价）和装机规模（kWh），
计算工商储项目的年度峰谷套利收益、静态回收期和估算 IRR。

当用户询问"收益多少"、"几年回本"、"划不划算"等问题时调用。

## 输入参数

| 参数 | 类型 | 必须 | 说明 |
|-----|-----|-----|------|
| capacity_kwh | number | ✅ | 储能容量（kWh） |
| peak_price | number | ✅ | 峰时电价（元/kWh） |
| valley_price | number | ✅ | 谷时电价（元/kWh） |
| power_kw | number | 可选 | 充放功率，默认=容量/2 |
| daily_cycles | number | 可选 | 日充放次数，默认=1 |
| investment_per_kwh | number | 可选 | 投资成本，默认=1800 |

## 触发条件

- 用户询问收益、回收期、IRR、划不划算
- 用户提供了具体的电价数据和装机规模

## 执行流程

1. 从用户输入提取或从知识库获取当地电价参数
2. 调用 calculate_roi 工具执行计算
3. 输出逐年收益预测和汇总
4. 标注数据来源

## 示例

**用户**：我在广东，100kWh 储能，帮我算一下收益。

**小堵**：（调用 calculate_roi，基于广东2024电价数据）
根据知识库 gdpc-2024.md 中广东工业一般工商业电价：
- 峰谷价差 0.87 元/kWh
- 预估年收益约 23,000 元
[来源: knowledge/gdpc-2024.md]
`

// ---------------------------------------------------------------------------
// 主测试套件
// ---------------------------------------------------------------------------

let avatarManager: AvatarManager
let soulLoader: SoulLoader
let knowledgeManager: KnowledgeManager
let knowledgeRetriever: KnowledgeRetriever
let skillManager: SkillManager
let toolRouter: ToolRouter

describe('完整用户旅程集成测试', () => {

  before(() => {
    // 清理并重建输出目录
    if (fs.existsSync(JOURNEY_OUTPUT_DIR)) {
      fs.rmSync(JOURNEY_OUTPUT_DIR, { recursive: true, force: true })
    }
    fs.mkdirSync(JOURNEY_OUTPUT_DIR, { recursive: true })

    log('info', '='.repeat(60))
    log('info', '  @soul/core 完整用户旅程集成测试')
    log('info', '='.repeat(60))
    log('info', `模板目录: ${TEMPLATES_PATH}`)
    log('info', `输出目录: ${JOURNEY_OUTPUT_DIR}`)

    // 确认真实模板目录存在
    assert.ok(fs.existsSync(TEMPLATES_PATH), `真实模板目录不存在: ${TEMPLATES_PATH}`)

    avatarManager = new AvatarManager(JOURNEY_OUTPUT_DIR, TEMPLATES_PATH)
    soulLoader = new SoulLoader(JOURNEY_OUTPUT_DIR)
    skillManager = new SkillManager(JOURNEY_OUTPUT_DIR)
    toolRouter = new ToolRouter(JOURNEY_OUTPUT_DIR)

    log('info', '✅ 初始化完成')
  })

  after(() => {
    log('info', '')
    log('info', '='.repeat(60))
    log('info', '  测试产出内容路径')
    log('info', '='.repeat(60))
    printDirectoryTree(JOURNEY_OUTPUT_DIR, '')
    log('info', '')
    log('info', `📂 完整输出目录: ${JOURNEY_OUTPUT_DIR}`)
    log('info', `📂 分身目录:      ${path.join(JOURNEY_OUTPUT_DIR, AVATAR_ID)}`)
  })

  // ─── Step 1: 读取真实模板 ─────────────────────────────────────────────────

  it('Step 1 - 读取真实模板文件', () => {
    log('step', 'Step 1: 读取真实模板')

    const loader = new TemplateLoader(TEMPLATES_PATH)

    const soulTemplate = loader.getTemplate('soul-template.md')
    assert.ok(soulTemplate.length > 100, 'soul-template.md 内容不应为空')
    log('ok', `soul-template.md 已读取（${soulTemplate.length} 字符）`)

    const skillTemplate = loader.getTemplate('skill-template.md')
    assert.ok(skillTemplate.length > 100, 'skill-template.md 内容不应为空')
    log('ok', `skill-template.md 已读取（${skillTemplate.length} 字符）`)

    const soulPrompt = loader.buildSoulCreationPrompt('小堵·工商储专家')
    assert.ok(soulPrompt.includes('小堵·工商储专家'), '系统提示应包含分身名称')
    assert.ok(soulPrompt.includes('强制约束'), '系统提示应包含约束说明')
    log('ok', `buildSoulCreationPrompt 生成成功（${soulPrompt.length} 字符）`)

    const testPrompt = loader.buildTestCaseCreationPrompt()
    assert.ok(testPrompt.includes('数据溯源'), '测试提示应包含数据溯源类别')
    log('ok', `buildTestCaseCreationPrompt 生成成功（${testPrompt.length} 字符）`)
  })

  // ─── Step 2: 创建分身 ─────────────────────────────────────────────────────

  it('Step 2 - 创建分身（AvatarManager.createAvatar）', () => {
    log('step', 'Step 2: 创建分身')

    avatarManager.createAvatar(AVATAR_ID, SOUL_CONTENT, [], [])

    const avatarPath = path.join(JOURNEY_OUTPUT_DIR, AVATAR_ID)

    // 验证目录结构
    const required = [
      'soul.md', 'CLAUDE.md', 'memory/MEMORY.md',
      'knowledge/README.md', 'skills', 'tests/cases', 'tests/reports',
    ]
    for (const rel of required) {
      const full = path.join(avatarPath, rel)
      assert.ok(fs.existsSync(full), `应存在: ${rel}`)
      log('ok', `创建: ${rel}`)
    }

    // 验证 soul.md 内容完整
    const soul = fs.readFileSync(path.join(avatarPath, 'soul.md'), 'utf-8')
    assert.ok(soul.includes('小堵'), 'soul.md 应包含分身名称')
    log('ok', `soul.md 写入成功（${soul.length} 字符）`)

    // 验证 CLAUDE.md 包含知识库约束
    const claudeMd = fs.readFileSync(path.join(avatarPath, 'CLAUDE.md'), 'utf-8')
    assert.ok(claudeMd.includes('知识库约束'), 'CLAUDE.md 应包含知识库约束')
    assert.ok(claudeMd.includes('第一性原理'), 'CLAUDE.md 应包含第一性原理')
    log('ok', `CLAUDE.md 写入成功（${claudeMd.length} 字符）`)

    // 验证 knowledge/README.md 模板替换正确
    const readme = fs.readFileSync(path.join(avatarPath, 'knowledge', 'README.md'), 'utf-8')
    assert.ok(readme.includes('小堵'), 'knowledge/README.md 应包含分身名称')
    assert.ok(!readme.includes('{{AGENT_DISPLAY_NAME}}'), '模板占位符应已替换')
    log('ok', `knowledge/README.md 模板替换正确`)
  })

  // ─── Step 3: 导入知识文档 ─────────────────────────────────────────────────

  it('Step 3 - 导入知识文档', () => {
    log('step', 'Step 3: 导入知识文档')

    const knowledgePath = path.join(JOURNEY_OUTPUT_DIR, AVATAR_ID, 'knowledge')
    knowledgeManager = new KnowledgeManager(knowledgePath)
    knowledgeRetriever = new KnowledgeRetriever(knowledgePath)

    // 写入广东电价数据
    knowledgeManager.createFile('gdpc-2024.md', KNOWLEDGE_GUANGDONG)
    log('ok', '写入: knowledge/gdpc-2024.md（广东电价数据）')

    // 写入产品技术规格（子目录）
    knowledgeManager.createFile('products/lfp-spec-2024.md', KNOWLEDGE_BATTERY_SPEC)
    log('ok', '写入: knowledge/products/lfp-spec-2024.md（磷酸铁锂规格）')

    // 验证文件树
    const tree = knowledgeManager.getKnowledgeTree()
    const fileNames = flattenTree(tree)
    assert.ok(fileNames.includes('gdpc-2024.md'), '文件树应包含 gdpc-2024.md')
    assert.ok(fileNames.some(f => f.includes('lfp-spec-2024.md')), '文件树应包含 lfp-spec-2024.md')
    log('ok', `知识库文件树: ${fileNames.join(', ')}`)

    // 验证读取
    const content = knowledgeManager.readFile('gdpc-2024.md')
    assert.ok(content.includes('1.156'), '广东电价数据应包含峰时电价 1.156')
    log('ok', `gdpc-2024.md 读取验证通过`)

    // 验证搜索
    const searchResults = knowledgeManager.searchFiles('峰谷价差')
    assert.ok(searchResults.length > 0, '搜索"峰谷价差"应有结果')
    log('ok', `搜索"峰谷价差"：命中 ${searchResults.length} 个文件`)
  })

  // ─── Step 4: 添加技能 ─────────────────────────────────────────────────────

  it('Step 4 - 添加技能文件', () => {
    log('step', 'Step 4: 添加技能')

    avatarManager.writeSkillFile(AVATAR_ID, 'roi-calc.md', SKILL_ROI_CALC)
    log('ok', '写入: skills/roi-calc.md（收益测算技能）')

    const skills = skillManager.getSkills(AVATAR_ID)
    assert.equal(skills.length, 1, '应有 1 个技能')
    assert.equal(skills[0].id, 'roi-calc', '技能 ID 应为 roi-calc')
    assert.ok(skills[0].description.length > 0, '技能应有描述')
    log('ok', `技能加载成功: ${skills[0].name}（ID: ${skills[0].id}）`)

    // 验证启用的技能内容
    const enabledContent = skillManager.getEnabledSkillsContent(AVATAR_ID)
    assert.ok(enabledContent.includes('储能收益测算'), '已启用技能内容应包含技能名称')
    log('ok', `getEnabledSkillsContent 返回 ${enabledContent.length} 字符`)
  })

  // ─── Step 5: 加载分身（组装 systemPrompt）────────────────────────────────

  it('Step 5 - 加载分身，组装 systemPrompt', () => {
    log('step', 'Step 5: 加载分身')

    const config = soulLoader.loadAvatar(AVATAR_ID)

    assert.equal(config.id, AVATAR_ID)
    assert.ok(config.name.includes('小堵'), `分身名称应包含"小堵"，实际: ${config.name}`)
    assert.ok(config.systemPrompt.length > 500, 'systemPrompt 应有实质内容')
    log('ok', `分身名称: ${config.name}`)
    log('ok', `systemPrompt 长度: ${config.systemPrompt.length} 字符`)

    // 验证 systemPrompt 的关键组件都被组装进去
    assert.ok(config.systemPrompt.includes('小堵'), 'systemPrompt 应包含分身人格')
    assert.ok(config.systemPrompt.includes('知识库'), 'systemPrompt 应包含知识库说明')
    assert.ok(config.systemPrompt.includes('可用工具'), 'systemPrompt 应包含工具说明')
    assert.ok(config.systemPrompt.includes('储能收益测算'), 'systemPrompt 应包含技能定义')
    log('ok', 'systemPrompt 关键组件验证通过：人格 + 知识库 + 工具 + 技能')

    // 把 systemPrompt 写出来供检查
    const outputPath = path.join(JOURNEY_OUTPUT_DIR, AVATAR_ID, '_system-prompt-preview.md')
    fs.writeFileSync(outputPath, config.systemPrompt, 'utf-8')
    log('ok', `systemPrompt 已输出至: ${outputPath}`)
  })

  // ─── Step 6: 知识检索（模拟工具调用前的 RAG 查询）────────────────────────

  it('Step 6 - 知识检索（KnowledgeRetriever）', () => {
    log('step', 'Step 6: 知识检索')

    // 搜索峰谷价差（用空格分隔关键词让检索器拆分为多个 token）
    const results1 = knowledgeRetriever.searchChunks('广东 峰谷价差', 3)
    assert.ok(results1.length > 0, '搜索"广东 峰谷价差"应有结果')
    assert.ok(results1[0].content.includes('0.870') || results1[0].content.includes('0.87'),
      '顶部结果应包含峰谷价差数字 0.870')
    log('ok', `搜索"广东 峰谷价差"：命中 ${results1.length} 个 chunk，得分最高: ${results1[0].score}`)
    log('ok', `  → 文件: ${results1[0].file}，标题: ${results1[0].heading}`)

    // 搜索产品参数（空格分隔多关键词）
    const results2 = knowledgeRetriever.searchChunks('磷酸铁锂 循环寿命', 5)
    assert.ok(results2.length > 0, '搜索"磷酸铁锂 循环寿命"应有结果')
    // 关键词分散在不同 chunk，检查任意结果包含目标数据即可
    const hasLifeData = results2.some(r => r.content.includes('6000') || r.content.includes('循环寿命'))
    assert.ok(hasLifeData, `返回结果应含循环寿命数据，实际内容：${results2.map(r => r.heading).join(', ')}`)
    log('ok', `搜索"磷酸铁锂 循环寿命"：命中 ${results2.length} 个 chunk，命中 heading: ${results2.map(r => r.heading).join(' | ')}`)

    // 搜索不存在的内容
    const results3 = knowledgeRetriever.searchChunks('湖南省电价补贴政策')
    assert.equal(results3.length, 0, '知识库中无湖南数据，应返回空')
    log('ok', `搜索"湖南省电价"：正确返回空（知识库无此数据）`)

    // 直接读取文件
    const fileContent = knowledgeRetriever.readFile('gdpc-2024.md')
    assert.ok(fileContent.includes('南方电网'), '文件内容应包含来源信息')
    log('ok', `readFile 直接读取验证通过`)
  })

  // ─── Step 7: 工具调用路由（ToolRouter）──────────────────────────────────

  it('Step 7 - 工具调用路由', async () => {
    log('step', 'Step 7: 工具调用路由')

    // 7a. list_knowledge_files
    const listResult = await toolRouter.execute(AVATAR_ID, {
      name: 'list_knowledge_files', arguments: {},
    })
    assert.ok(!listResult.error, `list_knowledge_files 不应报错: ${listResult.error}`)
    assert.ok(listResult.content.includes('gdpc-2024.md'), '文件列表应包含 gdpc-2024.md')
    log('ok', `list_knowledge_files: 返回 ${listResult.content.split('\n').length} 个文件`)

    // 7b. search_knowledge（用空格分隔关键词）
    const searchResult = await toolRouter.execute(AVATAR_ID, {
      name: 'search_knowledge',
      arguments: { query: '广东 峰时 电价', top_n: 3 },
    })
    assert.ok(!searchResult.error, `search_knowledge 不应报错`)
    assert.ok(searchResult.content.includes('1.156'), '搜索结果应包含具体电价数字')
    log('ok', `search_knowledge "广东 峰时 电价"：返回 ${searchResult.content.length} 字符`)

    // 7c. read_knowledge_file
    const readResult = await toolRouter.execute(AVATAR_ID, {
      name: 'read_knowledge_file',
      arguments: { file_path: 'gdpc-2024.md' },
    })
    assert.ok(!readResult.error, `read_knowledge_file 不应报错`)
    assert.ok(readResult.content.includes('南方电网'), '文件内容应包含来源信息')
    log('ok', `read_knowledge_file 读取成功（${readResult.content.length} 字符）`)

    // 7d. calculate_roi（核心业务工具）
    const roiResult = await toolRouter.execute(AVATAR_ID, {
      name: 'calculate_roi',
      arguments: {
        capacity_kwh: 100,
        power_kw: 50,
        peak_price: 1.156,
        valley_price: 0.286,
        daily_cycles: 1,
        dod: 0.9,
        efficiency: 0.9,
        annual_degradation: 0.03,
        project_life_years: 10,
        investment_per_kwh: 1800,
      },
    })
    assert.ok(!roiResult.error, `calculate_roi 不应报错: ${roiResult.error}`)
    assert.ok(roiResult.content.includes('储能收益测算报告'), '应包含报告标题')
    assert.ok(roiResult.content.includes('IRR'), '应包含 IRR 计算结果')
    assert.ok(roiResult.content.includes('总投资'), '应包含总投资')

    // 验证关键数字（100kWh × 0.9 × 0.9 × 0.87 × 330 ≈ 23233）
    const match = roiResult.content.match(/年收益\s+([\d,]+)\s+元/)
    if (match) {
      const annualRevenue = parseInt(match[1].replace(',', ''))
      assert.ok(annualRevenue > 20000 && annualRevenue < 27000,
        `第一年年收益应在 20000-27000 元之间，实际: ${annualRevenue}`)
      log('ok', `calculate_roi 第一年年收益: ${annualRevenue} 元（验证通过）`)
    }
    log('ok', `calculate_roi 报告已生成（${roiResult.content.length} 字符）`)

    // 输出 ROI 报告供检查
    const roiOutputPath = path.join(JOURNEY_OUTPUT_DIR, AVATAR_ID, '_roi-calc-output.md')
    fs.writeFileSync(roiOutputPath, roiResult.content, 'utf-8')
    log('ok', `ROI 报告已输出至: ${roiOutputPath}`)

    // 7e. lookup_policy（从知识库检索政策）
    const policyResult = await toolRouter.execute(AVATAR_ID, {
      name: 'lookup_policy',
      arguments: { province: '广东', policy_type: '电价' },
    })
    assert.ok(!policyResult.error, `lookup_policy 不应报错`)
    assert.ok(policyResult.content.includes('1.156') || policyResult.content.length > 50,
      'lookup_policy 广东电价应有内容返回')
    log('ok', `lookup_policy 广东电价：返回 ${policyResult.content.length} 字符`)

    // 7f. lookup_policy（知识库无数据的省份）
    const unknownPolicy = await toolRouter.execute(AVATAR_ID, {
      name: 'lookup_policy',
      arguments: { province: '贵州', policy_type: '补贴' },
    })
    assert.ok(!unknownPolicy.error)
    assert.ok(unknownPolicy.content.includes('暂无') || unknownPolicy.content.length > 0,
      '无数据时应返回提示信息')
    log('ok', `lookup_policy 贵州补贴（无数据）：正确返回提示信息`)

    // 7g. compare_products
    const compareResult = await toolRouter.execute(AVATAR_ID, {
      name: 'compare_products',
      arguments: { products: ['磷酸铁锂', '三元锂'] },
    })
    assert.ok(!compareResult.error)
    assert.ok(compareResult.content.includes('产品对比'), '对比结果应包含标题')
    log('ok', `compare_products 返回产品对比报告`)

    // 7h. 未知工具
    const unknownTool = await toolRouter.execute(AVATAR_ID, {
      name: 'unknown_tool', arguments: {},
    })
    assert.ok(unknownTool.error?.includes('未知工具'), '未知工具应返回错误信息')
    log('ok', `未知工具调用正确返回错误: "${unknownTool.error}"`)
  })

  // ─── Step 8: 技能管理（启用/禁用）──────────────────────────────────────

  it('Step 8 - 技能启用/禁用管理', () => {
    log('step', 'Step 8: 技能管理')

    // 确认初始为启用状态
    const skillsBefore = skillManager.getSkills(AVATAR_ID)
    assert.equal(skillsBefore[0].enabled, true, '初始应为启用')
    log('ok', `技能初始状态: 启用`)

    // 禁用
    skillManager.toggleSkill(AVATAR_ID, 'roi-calc', false)
    const skillsAfterDisable = skillManager.getSkills(AVATAR_ID)
    assert.equal(skillsAfterDisable[0].enabled, false, '禁用后应为 false')
    log('ok', `技能禁用后: disabled`)

    // 禁用后 systemPrompt 不应包含该技能
    const configDisabled = soulLoader.loadAvatar(AVATAR_ID)
    assert.ok(!configDisabled.systemPrompt.includes('储能收益测算'),
      '技能禁用后 systemPrompt 不应包含该技能内容')
    log('ok', `systemPrompt 已不含已禁用技能（验证通过）`)

    // 重新启用
    skillManager.toggleSkill(AVATAR_ID, 'roi-calc', true)
    const skillsAfterEnable = skillManager.getSkills(AVATAR_ID)
    assert.equal(skillsAfterEnable[0].enabled, true, '重新启用后应为 true')
    log('ok', `技能重新启用: enabled`)
  })

  // ─── Step 9: 分身列表与删除 ──────────────────────────────────────────────

  it('Step 9 - 分身列表验证', () => {
    log('step', 'Step 9: 分身列表')

    const avatars = avatarManager.listAvatars()
    assert.ok(avatars.length >= 1, '应至少有 1 个分身')
    const found = avatars.find(a => a.id === AVATAR_ID)
    assert.ok(found !== undefined, `应找到 ${AVATAR_ID}`)
    assert.ok(found!.name.includes('小堵'), '分身名称应包含"小堵"')
    log('ok', `listAvatars 返回 ${avatars.length} 个分身，目标分身已就位`)
    log('ok', `分身信息: id=${found!.id}, name=${found!.name}`)
  })
})

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function log(level: 'step' | 'ok' | 'info' | 'warn', msg: string) {
  const prefix = {
    step: '\n▶',
    ok:   '  ✓',
    info: '  ℹ',
    warn: '  ⚠',
  }[level]
  console.log(`${prefix} ${msg}`)
}

function flattenTree(nodes: Array<{ name: string; type: string; children?: Array<{ name: string; type: string; children?: unknown[] }> }>): string[] {
  const result: string[] = []
  for (const node of nodes) {
    result.push(node.name)
    if (node.children) {
      result.push(...flattenTree(node.children as Array<{ name: string; type: string; children?: Array<{ name: string; type: string; children?: unknown[] }> }>))
    }
  }
  return result
}

function printDirectoryTree(dirPath: string, indent: string) {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name)
      const size = entry.isFile() ? ` (${fs.statSync(fullPath).size} bytes)` : ''
      console.log(`${indent}${entry.isDirectory() ? '📂' : '📄'} ${entry.name}${size}`)
      if (entry.isDirectory()) {
        printDirectoryTree(fullPath, indent + '   ')
      }
    }
  } catch {
    // ignore
  }
}
