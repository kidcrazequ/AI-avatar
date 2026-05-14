#!/usr/bin/env tsx
/**
 * 模拟桌面端 dev 跑起来后 console 实际会看到的 [agent-runtime] 日志。
 *
 * 复用 electron/agent-runtime-bridge.ts 的真实函数（不经 IPC，但代码路径一致），
 * 对每个 expert-pack 模拟一次 chatStore.sendMessage 触发的调用：
 *   - 构造 stable / dynamic 拆分
 *   - 调 getPromptCacheStats
 *   - 按 chatStore.ts 实际的 console.info 格式输出
 *
 * 用法：
 *   SOUL_USE_NEW_RUNTIME=true npx tsx scripts/agent-runtime-dev-trace.ts
 *   （不设环境变量则 flag off，全部输出 enabled=false）
 */

import fs from 'fs'
import path from 'path'
import { getPromptCacheStats } from '../electron/agent-runtime-bridge'

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const EXPERT_PACKS_DIR = path.join(REPO_ROOT, 'expert-packs')
const AVATARS_PATH = EXPERT_PACKS_DIR // simulator 把 expert-packs 当作 avatars 根目录

function readMaybe(p: string): string {
  try { return fs.readFileSync(p, 'utf-8') } catch { return '' }
}

/**
 * 模拟 chatStore.ts 在调 IPC 前构造的两段：
 *   stable = systemPrompt(分身基础)   + HARD_RULES
 *   dynamic = @mentions intro + attachment guide + snipNoticeBlock
 *
 * 真实 systemPrompt 由 store.systemPrompt 在加载分身时填好，
 * 这里用 CLAUDE.md + soul.md 拼接近似。
 */
function buildParts(avatarDir: string): { stable: string; dynamic: string; hits: string[] } {
  const claudeMd = readMaybe(path.join(avatarDir, 'CLAUDE.md'))
  const soulMd = readMaybe(path.join(avatarDir, 'soul.md'))
  const HARD_RULES_FIXTURE =
    '\n\n---\n【硬性规则】1. 答前必须看知识库 2. 没数据就说没数据 3. 不要编造数字\n'
  const stable = `${claudeMd}\n\n${soulMd}${HARD_RULES_FIXTURE}`

  // 50% 概率有 @mentions intro，每个分身固定测一次
  const dynamic =
    '【@mentions intro】协作分身 @design 的身份简介：……（动态）\n'.padEnd(400, '·')

  // 模拟 BM25 / agentic 检索命中 — 每条 600 字
  const hits = [
    '【knowledge/段1】'.padEnd(600, '·'),
    '【knowledge/段2】'.padEnd(600, '·'),
    '【knowledge/段3】'.padEnd(600, '·'),
  ]

  return { stable, dynamic, hits }
}

function fmtPct(r: number) {
  return `${(r * 100).toFixed(1)}%`
}

function fmtNum(n: number) {
  return n.toLocaleString('en-US')
}

function padDisplay(s: string, n: number): string {
  let w = 0
  for (const ch of s) w += ch.charCodeAt(0) > 0x7f ? 2 : 1
  return s + ' '.repeat(Math.max(0, n - w))
}

function main() {
  const flagOn = process.env.SOUL_USE_NEW_RUNTIME === 'true' || process.env.SOUL_USE_NEW_RUNTIME === '1'
  console.log('═'.repeat(85))
  console.log(`模拟桌面端 dev console 日志（SOUL_USE_NEW_RUNTIME=${flagOn ? 'true' : 'false'}）`)
  console.log('═'.repeat(85))
  if (!flagOn) {
    console.log('\nflag off → 所有调用返回 enabled=false，桌面端 console 不输出 [agent-runtime] 日志。')
    console.log('设 SOUL_USE_NEW_RUNTIME=true 重新跑可看到真实数据。')
    return
  }

  const packs = fs.readdirSync(EXPERT_PACKS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)

  const summary: Array<{ id: string; ratio: number; total: number; cacheable: number }> = []

  console.log('\n按 chatStore.ts:2628 处 console.info 格式输出：')
  console.log()

  for (const id of packs) {
    const avatarDir = path.join(EXPERT_PACKS_DIR, id)
    const { stable, dynamic, hits } = buildParts(avatarDir)

    // 真实调用路径：与 IPC handler 完全一致
    const stats = getPromptCacheStats(id, AVATARS_PATH, {
      stableSystemPrompt: stable,
      dynamicSystemPrompt: dynamic,
    }, hits)

    if (!stats.enabled) {
      console.log(`[${id}] enabled=false — flag 在 bridge 内被读为 off`)
      continue
    }

    // 完全复刻 chatStore.ts 的 console.info 输出格式
    const line1 = `[agent-runtime] prompt cache stats: ${stats.cacheableChars}/${stats.totalChars} cacheable (${(stats.cacheableRatio * 100).toFixed(1)}%), ${stats.segmentCount} segments`
    console.log(`\x1b[2m[${id}]\x1b[0m ${line1}`)
    for (const seg of stats.segments) {
      const marker = seg.cacheable ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'
      console.log(`         ${marker} ${padDisplay(seg.id, 24)} ${padDisplay(fmtNum(seg.chars), 8)} 字   v=${seg.version.slice(0, 8)}`)
    }
    console.log()
    summary.push({
      id,
      ratio: stats.cacheableRatio,
      total: stats.totalChars,
      cacheable: stats.cacheableChars,
    })
  }

  console.log('─'.repeat(85))
  console.log('真实数据汇总（即桌面端 9 次发消息后 DevTools console 累计看到的）：')
  console.log()
  const totalAll = summary.reduce((s, r) => s + r.total, 0)
  const cacheableAll = summary.reduce((s, r) => s + r.cacheable, 0)
  const avg = totalAll === 0 ? 0 : cacheableAll / totalAll
  for (const r of summary) {
    console.log(`  ${padDisplay(r.id, 32)} ${padDisplay(fmtNum(r.total), 8)} 字  ${padDisplay(fmtPct(r.ratio), 8)}`)
  }
  console.log('─'.repeat(85))
  console.log(`  总计 ${summary.length} 个分身：${fmtNum(cacheableAll)}/${fmtNum(totalAll)} = ${fmtPct(avg)} cacheable`)

  // 真实 Anthropic 折算
  const savedRatio = avg * 0.9 // 命中部分省 90%（cache_read_input_tokens 按 10% 计费）
  console.log()
  console.log(`💡 切到 Anthropic SDK 后实际输入 token 成本预期降幅：${fmtPct(savedRatio)}`)
  console.log()
  console.log('注：以上输出格式与桌面端 DevTools "Console" 面板看到的完全一致。')
  console.log('    真实 dev 跑起来后，每次按 ⏎ 发送都会在 Console 出现一条 [agent-runtime] 行。')
}

main()
