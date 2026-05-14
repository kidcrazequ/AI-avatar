#!/usr/bin/env tsx
/**
 * 端到端模拟 Phase 1 (Blueprint) + Phase 5 (Prompt cache 分段)：
 *
 *   1. 装载所有 expert-packs/<id>/
 *   2. 对每个分身：
 *      - loadBlueprintFromAvatarDir → AgentBlueprint
 *      - 用真实 soul.md + CLAUDE.md 模拟当前 chatStore 拼出来的 systemPrompt
 *      - getPromptCacheStats 输出 cacheable 占比
 *   3. 表格汇总：分身 → 总字符 / 可缓存字符 / 占比 / 段数
 *   4. 全局汇总：平均占比、最佳/最差分身
 *
 * 运行：
 *   cd desktop-app && npx tsx scripts/agent-runtime-simulate.ts
 *
 * 该脚本与 desktop-app 解耦（不启 Electron），可在 CI 跑。
 */

import fs from 'fs'
import path from 'path'
// 直接 require worktree 的 packages/core（绕过 node_modules/@soul/core 符号链接到主仓库的问题）
// 真实 runtime（Electron main）会通过 IPC 走 electron/agent-runtime-bridge.ts，不依赖此处导入。
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AgentRuntime = require('../../packages/core/dist/agent-runtime') as typeof import('../../packages/core/src/agent-runtime')

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const EXPERT_PACKS_DIR = path.join(REPO_ROOT, 'expert-packs')

interface SimResult {
  id: string
  name: string
  totalChars: number
  /** 保守版：仅 persona + skill-index 可缓存，CLAUDE.md+soul.md 整段当作 legacy uncached */
  conservativeCacheable: number
  conservativeRatio: number
  /** 理想版：CLAUDE.md + soul.md 也归入 cacheable（它们其实极少变） */
  idealCacheable: number
  idealRatio: number
  segmentCount: number
  skillCount: number
  knowledgeFileCount: number
  segments: Array<{ id: string; chars: number; cacheable: boolean }>
}

function readMaybe(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8')
  } catch {
    return ''
  }
}

function countKnowledgeFiles(avatarDir: string): number {
  const kbDir = path.join(avatarDir, 'knowledge')
  if (!fs.existsSync(kbDir)) return 0
  let n = 0
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.isFile()) n++
    }
  }
  walk(kbDir)
  return n
}

/**
 * 模拟现在 chatStore 拼出来的 effectiveSystemPrompt：
 *   = CLAUDE.md（核心规则）+ soul.md（人格）+ HARD_RULES 占位
 * 真实场景还会拼 skill 内容 / 知识检索结果，这里给一段固定占位代表
 * "本轮检索到的 RAG 命中"（每次变 = 不可缓存）。
 */
function simulateLegacySystemPrompt(avatarDir: string): string {
  const claudeMd = readMaybe(path.join(avatarDir, 'CLAUDE.md'))
  const soulMd = readMaybe(path.join(avatarDir, 'soul.md'))
  // HARD_RULES + 对话历史压缩提示等放尾巴
  const tailRules =
    '\n\n---\n【硬性规则】1. 答前必须看知识库 2. 没数据就说没数据 3. 不要编造数字\n'
  return `${claudeMd}\n\n${soulMd}${tailRules}`
}

function simulateRagHits(): string[] {
  // 模拟 3 条 BM25 命中，每条 600 字
  return [
    '【knowledge/财务报表/三大报表勾稽.md L120-L180】'.padEnd(600, '·'),
    '【knowledge/财务报表/现金流量表填列.md L20-L80】'.padEnd(600, '·'),
    '【knowledge/预算/滚动预测模板.md L1-L40】'.padEnd(600, '·'),
  ]
}

function simulateOne(avatarDir: string): SimResult | null {
  const id = path.basename(avatarDir)
  let bp: ReturnType<typeof AgentRuntime.loadBlueprintFromAvatarDir>
  try {
    bp = AgentRuntime.loadBlueprintFromAvatarDir({
      avatarDir,
      repoRoot: REPO_ROOT,
    })
  } catch (err) {
    console.error(`✗ ${id} 装配失败:`, err instanceof Error ? err.message : err)
    return null
  }

  const legacyPrompt = simulateLegacySystemPrompt(avatarDir)
  const hits = simulateRagHits()

  // 模拟动态尾巴（@mentions intro + attachmentGuide），假定每轮 ~400 字
  const dynamicTail = '【@mentions intro】协作分身 @design 的身份简介……\n'.padEnd(400, '·')

  const baseSegments = AgentRuntime.buildSegmentedSystemPrompt({
    blueprint: bp,
    knowledgeHits: hits,
  })

  // 保守版：legacy 整段（含 dynamic）不缓存 — 旧 bridge 行为
  const conservativeSegments = [
    ...baseSegments,
    AgentRuntime.makeSegment('legacy.systemPrompt', legacyPrompt + dynamicTail, false),
  ]
  const conservativeTot = AgentRuntime.totalLength(conservativeSegments)

  // 理想版（新 bridge 行为）：stable 段 cacheable，dynamic 尾巴 uncached
  const stableCacheable = baseSegments.filter((s) => s.cacheable)
  const baseUncached = baseSegments.filter((s) => !s.cacheable)
  const idealSegments = [
    ...stableCacheable,
    AgentRuntime.makeSegment('rules.stable', legacyPrompt, true),
    AgentRuntime.makeSegment('dynamic.tail', dynamicTail, false),
    ...baseUncached,
  ]
  const idealTot = AgentRuntime.totalLength(idealSegments)

  return {
    id,
    name: bp.identity.name,
    totalChars: conservativeTot.total,
    conservativeCacheable: conservativeTot.cacheable,
    conservativeRatio: conservativeTot.total === 0 ? 0 : conservativeTot.cacheable / conservativeTot.total,
    idealCacheable: idealTot.cacheable,
    idealRatio: idealTot.total === 0 ? 0 : idealTot.cacheable / idealTot.total,
    segmentCount: conservativeSegments.length,
    skillCount: bp.skills.length,
    knowledgeFileCount: countKnowledgeFiles(avatarDir),
    segments: idealSegments.map((s) => ({
      id: s.id,
      chars: s.body.length,
      cacheable: s.cacheable,
    })),
  }
}

function pad(s: string, n: number): string {
  // 中文字符宽度计 2，英文计 1（粗略）
  let w = 0
  for (const ch of s) w += ch.charCodeAt(0) > 0x7f ? 2 : 1
  return s + ' '.repeat(Math.max(0, n - w))
}

function fmtNum(n: number): string {
  return n.toLocaleString('en-US')
}

function fmtPct(r: number): string {
  return `${(r * 100).toFixed(1)}%`
}

function main() {
  console.log('═'.repeat(80))
  console.log('Phase 1 + Phase 5 端到端模拟：9 个 expert-pack 的 prompt cache 潜力')
  console.log('═'.repeat(80))

  const packs = fs
    .readdirSync(EXPERT_PACKS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(EXPERT_PACKS_DIR, e.name))

  const results: SimResult[] = []
  for (const dir of packs) {
    const r = simulateOne(dir)
    if (r) results.push(r)
  }

  console.log()
  console.log(pad('分身', 28), pad('skills', 8), pad('kb文件', 8), pad('总字符', 10), pad('保守', 9), pad('理想', 9))
  console.log('─'.repeat(85))
  for (const r of results) {
    console.log(
      pad(r.name, 28),
      pad(String(r.skillCount), 8),
      pad(String(r.knowledgeFileCount), 8),
      pad(fmtNum(r.totalChars), 10),
      pad(fmtPct(r.conservativeRatio), 9),
      pad(fmtPct(r.idealRatio), 9)
    )
  }

  // 全局汇总
  console.log('─'.repeat(85))
  const totalAll = results.reduce((s, r) => s + r.totalChars, 0)
  const consAll = results.reduce((s, r) => s + r.conservativeCacheable, 0)
  const idealAll = results.reduce((s, r) => s + r.idealCacheable, 0)
  const consRatio = totalAll === 0 ? 0 : consAll / totalAll
  const idealRatio = totalAll === 0 ? 0 : idealAll / totalAll
  const bestIdeal = [...results].sort((a, b) => b.idealRatio - a.idealRatio)[0]
  const worstIdeal = [...results].sort((a, b) => a.idealRatio - b.idealRatio)[0]
  console.log()
  console.log(`分身数：${results.length}`)
  console.log(`累计字符：${fmtNum(totalAll)}`)
  console.log(`保守版（当前 bridge 实现）：${fmtNum(consAll)} 可缓存 = ${fmtPct(consRatio)}`)
  console.log(`理想版（CLAUDE.md+soul.md 提升为 cacheable）：${fmtNum(idealAll)} 可缓存 = ${fmtPct(idealRatio)}`)
  console.log(`理想版最高：${bestIdeal.name} = ${fmtPct(bestIdeal.idealRatio)}`)
  console.log(`理想版最低：${worstIdeal.name} = ${fmtPct(worstIdeal.idealRatio)}`)

  // 抽样展示某个分身的 4 段构成
  if (results.length > 0) {
    const sample = results[0]
    console.log()
    console.log(`【抽样】${sample.name} 的 prompt 分段构成：`)
    for (const s of sample.segments) {
      console.log(
        `  - ${pad(s.id, 24)} ${pad(fmtNum(s.chars), 8)} 字  ${s.cacheable ? '✓ cacheable' : '✗ uncached'}`
      )
    }
  }

  console.log()
  console.log('═'.repeat(85))
  console.log('解读：')
  console.log('  - 保守版：仅 persona + skill-index 可缓存（当前 bridge 实现），潜力被 legacy 段拉低')
  console.log('  - 理想版：CLAUDE.md+soul.md+HARD_RULES 全部提升为 cacheable（它们实际上极少变）')
  console.log('  - 切到 Anthropic SDK 后，按"理想版"重组分段即可拿到对应 cache 命中率')
  console.log('  - 命中率折算降本：Anthropic prompt caching 命中部分计费 = 输入价 × 10%')
  console.log('    即 80% 命中可省 72% 输入 token 成本（命中部分省 90%）')
  console.log('═'.repeat(85))
}

main()
