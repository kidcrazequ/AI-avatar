/**
 * 子任务 5.4 回归测试：chatStore.ts 的 sendMessage 路径已接入 chart-cache
 *
 * 目标（静态校验，不起真 Electron）：
 *  1) 顶层 import 含 hashQueryContent from '@soul/core'
 *  2) sendMessage 内有早命中分支：shouldEnableChartConsistencyMode + hashQueryContent
 *     + getChartCacheHit + 命中后 set + saveMessage 'assistant' + return（跳过 LLM）
 *  3) excelBasenamesUsed Set 在 sendMessage 里声明，并在 query_excel 分支追加
 *  4) 最终回复处理前有写入分支：chartConsistencyMode + /```chart/ 检测 + saveChartCacheEntry
 *  5) 写入 payload 含 queryHash / queryPreview / assistantContent / excelBasenames 四个字段
 *
 * 运行方式：cd desktop-app && node_modules/.bin/tsx ../testdocs/test-chart-cache-chatstore-wiring.ts
 */
import fs from 'fs'
import path from 'path'
import assert from 'assert'

const chatStore = fs.readFileSync(
  path.resolve(__dirname, '../desktop-app/src/stores/chatStore.ts'),
  'utf-8',
)

// ── 1) 顶层 import ─────────────────────────────────────────
assert.ok(
  /from '@soul\/core'[^\n]*\bhashQueryContent\b/.test(chatStore)
    || /\bhashQueryContent\b[^\n]*from '@soul\/core'/.test(chatStore),
  "chatStore 顶层需从 '@soul/core' 导入 hashQueryContent",
)
console.log('✓ 顶层 import hashQueryContent')

// ── 2) 早命中分支 ─────────────────────────────────────────
const earlyBlock = chatStore.match(
  /shouldEnableChartConsistencyMode\(content[\s\S]{0,800}?electronAPI\.getChartCacheHit[\s\S]{0,1200}?(?=\/\/ 程序化 RAG)/,
)
assert.ok(earlyBlock, '缺少"shouldEnableChartConsistencyMode → getChartCacheHit"的早命中块')
const block = earlyBlock![0]
assert.ok(/cacheResult\.hit/.test(block), '早命中块需判定 cacheResult.hit')
assert.ok(/saveMessage\(conversationId,\s*'assistant',\s*cacheResult\.assistantContent\)/.test(block),
  '早命中块需 saveMessage(conversationId, "assistant", cacheResult.assistantContent)')
assert.ok(/activeChatRequest = null/.test(block), '早命中块需清 activeChatRequest')
assert.ok(/\n\s*return\n/.test(block), '早命中块命中后要 return 跳过后续 LLM 循环')
assert.ok(/hashQueryContent\(content\)/.test(block), '早命中块需用 hashQueryContent(content) 算 key')
console.log('✓ 早命中：shouldEnableChartConsistencyMode + getChartCacheHit + return')

// ── 3) excelBasenamesUsed 声明 + query_excel 分支追加 ────
assert.ok(
  /const excelBasenamesUsed = new Set<string>\(\)/.test(chatStore),
  '需在 sendMessage 里声明 excelBasenamesUsed Set',
)
const qeBranch = chatStore.match(
  /tc\.function\.name === 'query_excel'[\s\S]{0,400}?excelBasenamesUsed\.add[\s\S]{0,200}?queryExcelResultCache\.get/,
)
assert.ok(qeBranch, 'query_excel 分支需在走 cache 查询前把 toolArgs.file 追加进 excelBasenamesUsed')
console.log('✓ excelBasenamesUsed 声明 + query_excel 分支追加')

// ── 4) 写入分支 ───────────────────────────────────────────
const writeBlock = chatStore.match(
  /if \(chartConsistencyMode && \/```chart\/\.test\(assistantText\)\)[\s\S]{0,800}?saveChartCacheEntry[\s\S]{0,520}?\n\s*\/\/ 所有工具调用结束/,
)
assert.ok(writeBlock, '缺少写入 cache 的分支（chartConsistencyMode && ```chart 检测）或位置不对')
const writeText = writeBlock![0]
for (const field of ['queryHash', 'queryPreview', 'assistantContent', 'excelBasenames']) {
  assert.ok(new RegExp(`\\b${field}\\b`).test(writeText), `saveChartCacheEntry payload 需含 ${field}`)
}
assert.ok(/Array\.from\(excelBasenamesUsed\)/.test(writeText),
  '写入 payload 的 excelBasenames 应是 Array.from(excelBasenamesUsed)')
assert.ok(
  /collectQueryExcelBasenamesFromApiMessages\(apiMessages\)/.test(writeText),
  '写入前需调用 collectQueryExcelBasenamesFromApiMessages(apiMessages) 合并 query_excel 的 file',
)
console.log('✓ 写入分支：saveChartCacheEntry 4 字段齐全 + 位置在最终处理前')

// ── 5) 失败静默：cache IPC 失败不影响正常对话 ─────────────
assert.ok(/cache 查询失败/.test(chatStore), '早命中分支需有失败静默降级注释或 void cacheErr')
assert.ok(/写 cache 失败/.test(chatStore), '写入分支需有失败静默降级注释')
console.log('✓ cache IPC 失败静默降级')

console.log('\n全部通过 ✅')
