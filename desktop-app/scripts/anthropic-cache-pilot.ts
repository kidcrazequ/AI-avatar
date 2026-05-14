#!/usr/bin/env tsx
/**
 * Anthropic prompt-caching 真实试点：直接 fetch 调 messages API，
 * 用真实分身的 system prompt 拼成 cache_control 数组，连续发两次同样请求，
 * 输出 cache_creation_input_tokens / cache_read_input_tokens 真实数字。
 *
 * 不装 SDK / 不动 chatStore / 不影响生产路径。
 *
 * 用法：
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   npx tsx scripts/anthropic-cache-pilot.ts [avatar-id]
 *
 *   avatar-id 默认 "小堵-工商储专家"，可换 finance-expert 等。
 *
 * 退出码：
 *   0  两次都成功，cache_read_input_tokens > 0
 *   1  网络/凭证/超时错误
 *   2  cache 未命中（实测异常，需检查 system 数组格式）
 */

import fs from 'fs'
import path from 'path'
import { AgentRuntime } from '@soul/core'

const API_KEY = process.env.ANTHROPIC_API_KEY
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5'
const REPO_ROOT = path.resolve(__dirname, '..', '..')
const AVATARS_PATH = path.join(REPO_ROOT, 'expert-packs')
const DEFAULT_AVATAR = '小堵-工商储专家'

if (!API_KEY) {
  console.error('错误：未设置 ANTHROPIC_API_KEY 环境变量。')
  console.error('从 https://console.anthropic.com/settings/keys 取一个，然后：')
  console.error('  export ANTHROPIC_API_KEY=sk-ant-... && npx tsx scripts/anthropic-cache-pilot.ts')
  process.exit(1)
}

const avatarId = process.argv[2] || DEFAULT_AVATAR
const avatarDir = path.join(AVATARS_PATH, avatarId)
if (!fs.existsSync(avatarDir)) {
  console.error(`分身目录不存在：${avatarDir}`)
  process.exit(1)
}

/** 模拟 chatStore 实际生产的 systemPrompt：CLAUDE.md + soul.md + HARD_RULES */
function buildStableSystemPrompt(): string {
  const claudeMd = fs.existsSync(path.join(avatarDir, 'CLAUDE.md'))
    ? fs.readFileSync(path.join(avatarDir, 'CLAUDE.md'), 'utf-8')
    : ''
  const soulMd = fs.existsSync(path.join(avatarDir, 'soul.md'))
    ? fs.readFileSync(path.join(avatarDir, 'soul.md'), 'utf-8')
    : ''
  const HARD_RULES =
    '\n\n---\n【硬性规则】1. 答前必须看知识库 2. 没数据就说没数据 3. 不要编造数字\n'
  return `${claudeMd}\n\n${soulMd}${HARD_RULES}`
}

function buildSystemBlocks(): AgentRuntime.AnthropicSystemBlock[] {
  const bp = AgentRuntime.loadBlueprintFromAvatarDir({ avatarDir, repoRoot: REPO_ROOT })
  const baseSegments = AgentRuntime.buildSegmentedSystemPrompt({
    blueprint: bp,
    knowledgeHits: [], // 试点不带 RAG
  })
  const stableCacheable = baseSegments.filter((s) => s.cacheable)
  const stableRules = AgentRuntime.makeSegment('rules.stable', buildStableSystemPrompt(), true)
  // 全部 cacheable（试点对齐 Phase 5 理想版）
  const segments = [...stableCacheable, stableRules]
  return AgentRuntime.toAnthropicSystemBlocks(segments)
}

interface UsageInfo {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

async function callAnthropic(systemBlocks: AgentRuntime.AnthropicSystemBlock[], userMsg: string): Promise<{
  usage: UsageInfo
  durationMs: number
  outputText: string
}> {
  const start = Date.now()
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 256,
      system: systemBlocks,
      messages: [{ role: 'user', content: userMsg }],
    }),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Anthropic API ${res.status}: ${text}`)
  }
  const body = JSON.parse(text) as { usage: UsageInfo; content: Array<{ type: string; text?: string }> }
  const outputText = body.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n')
  return { usage: body.usage, durationMs: Date.now() - start, outputText }
}

function fmt(n: number | undefined): string {
  if (n === undefined) return '—'
  return n.toLocaleString('en-US')
}

async function main() {
  console.log('═'.repeat(75))
  console.log(`Anthropic prompt-caching 真实试点`)
  console.log(`分身：${avatarId}  /  模型：${MODEL}`)
  console.log('═'.repeat(75))

  const systemBlocks = buildSystemBlocks()
  const sysTotalChars = systemBlocks.reduce((s, b) => s + b.text.length, 0)
  const cachedBlockCount = systemBlocks.filter((b) => b.cache_control).length
  console.log(`\nsystem 数组：${systemBlocks.length} blocks，总 ${fmt(sysTotalChars)} 字符，其中 ${cachedBlockCount} 个带 cache_control`)

  const USER_MSG = '你是谁？一句话介绍。'
  console.log(`\n第 1 次发送（首次写入 cache）...`)
  const r1 = await callAnthropic(systemBlocks, USER_MSG)
  console.log(`  耗时 ${r1.durationMs}ms`)
  console.log(`  usage: input=${fmt(r1.usage.input_tokens)} output=${fmt(r1.usage.output_tokens)}`)
  console.log(`         cache_creation=${fmt(r1.usage.cache_creation_input_tokens)} cache_read=${fmt(r1.usage.cache_read_input_tokens)}`)

  console.log(`\n第 2 次发送（同样 system，应该命中 cache）...`)
  const r2 = await callAnthropic(systemBlocks, USER_MSG)
  console.log(`  耗时 ${r2.durationMs}ms`)
  console.log(`  usage: input=${fmt(r2.usage.input_tokens)} output=${fmt(r2.usage.output_tokens)}`)
  console.log(`         cache_creation=${fmt(r2.usage.cache_creation_input_tokens)} cache_read=${fmt(r2.usage.cache_read_input_tokens)}`)

  console.log('\n' + '─'.repeat(75))
  console.log('结果分析：')

  const cacheRead = r2.usage.cache_read_input_tokens ?? 0
  const cacheCreate = r1.usage.cache_creation_input_tokens ?? 0
  const inputAt2 = r2.usage.input_tokens

  if (cacheRead === 0) {
    console.log(`  ⚠️  第 2 次 cache_read_input_tokens = 0，cache 未命中！`)
    console.log(`     可能原因：cache_control 未生效 / system 数组顺序不稳定 / model 不支持 caching`)
    process.exit(2)
  }

  const totalInputAt2 = cacheRead + inputAt2
  const cacheHitRatio = cacheRead / totalInputAt2
  console.log(`  ✓ 第 2 次 cache 命中：${fmt(cacheRead)} tokens 走 cache_read（${(cacheHitRatio * 100).toFixed(1)}%）`)
  console.log(`     非 cache input：${fmt(inputAt2)} tokens`)

  // 价格（Claude Sonnet 4.5 当前公开价；与官方页面一致时可保持，否则用户改 PRICING）
  const PRICE_INPUT_PER_M = 3.0      // $3/M
  const PRICE_CACHE_WRITE_PER_M = 3.75 // $3.75/M (1.25x)
  const PRICE_CACHE_READ_PER_M = 0.30  // $0.30/M (0.1x)
  const PRICE_OUTPUT_PER_M = 15.0    // $15/M

  function cost(input: number, cacheCreate: number, cacheRead: number, output: number): number {
    return (input * PRICE_INPUT_PER_M +
      cacheCreate * PRICE_CACHE_WRITE_PER_M +
      cacheRead * PRICE_CACHE_READ_PER_M +
      output * PRICE_OUTPUT_PER_M) / 1_000_000
  }

  const cost1 = cost(r1.usage.input_tokens, cacheCreate, r1.usage.cache_read_input_tokens ?? 0, r1.usage.output_tokens)
  const cost2 = cost(inputAt2, 0, cacheRead, r2.usage.output_tokens)
  const cost2NoCache = cost(inputAt2 + cacheRead, 0, 0, r2.usage.output_tokens)
  const savedRatio = 1 - cost2 / cost2NoCache

  console.log()
  console.log(`  价格估算（$/条）：`)
  console.log(`    第 1 次（写 cache）:           $${cost1.toFixed(4)}`)
  console.log(`    第 2 次（命中 cache）:         $${cost2.toFixed(4)}`)
  console.log(`    第 2 次假设无 cache（对比）:   $${cost2NoCache.toFixed(4)}`)
  console.log(`    → 命中 cache 后每条省 ${(savedRatio * 100).toFixed(1)}%`)

  // 按 50 条/天 × 365 折算
  const dailyConv = 50
  const annualSaving = (cost2NoCache - cost2) * dailyConv * 365
  console.log(`  按每天 ${dailyConv} 条对话，年化省 $${annualSaving.toFixed(2)}/分身`)

  console.log()
  console.log('  💡 这是单条简短消息的数据；真实生产对话因为 output_tokens 更多')
  console.log('     绝对成本会高些，但 cache 命中比例不变')
  console.log('═'.repeat(75))
}

main().catch((err) => {
  console.error('\n失败：', err instanceof Error ? err.message : err)
  process.exit(1)
})
