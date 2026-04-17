/**
 * 子任务 5.3 回归测试：preload / global.d.ts / main.ts 三侧 IPC 挂接一致
 *
 * 目标：
 *  1) preload.ts 有 getChartCacheHit / saveChartCacheEntry 两个方法
 *  2) global.d.ts 同样暴露这两个方法的类型签名
 *  3) IPC 通道名 ('get-chart-cache-hit' / 'save-chart-cache-entry') 三侧完全一致
 *  4) preload 与 main.ts 的参数个数对齐（invoke 透传 avatarId/queryHash 或 avatarId/payload）
 *
 * 运行方式：cd desktop-app && node_modules/.bin/tsx ../testdocs/test-chart-cache-ipc-wiring.ts
 */
import fs from 'fs'
import path from 'path'
import assert from 'assert'

const ROOT = path.resolve(__dirname, '..')
const preload = fs.readFileSync(path.join(ROOT, 'desktop-app/electron/preload.ts'), 'utf-8')
const globalDts = fs.readFileSync(path.join(ROOT, 'desktop-app/src/global.d.ts'), 'utf-8')
const mainTs = fs.readFileSync(path.join(ROOT, 'desktop-app/electron/main.ts'), 'utf-8')

// ── 1) preload.ts 侧 ───────────────────────────────────────
// get
const preGetRe = /getChartCacheHit:\s*\(avatarId:\s*string,\s*queryHash:\s*string\)\s*=>\s*ipcRenderer\.invoke\('get-chart-cache-hit',\s*avatarId,\s*queryHash\)/
assert.ok(preGetRe.test(preload), 'preload 需含 getChartCacheHit → get-chart-cache-hit')
// save
const preSaveRe = /saveChartCacheEntry:\s*\(avatarId:\s*string,\s*payload:[^)]*\)\s*=>\s*ipcRenderer\.invoke\('save-chart-cache-entry',\s*avatarId,\s*payload\)/
assert.ok(preSaveRe.test(preload), 'preload 需含 saveChartCacheEntry → save-chart-cache-entry')
console.log('✓ preload.ts 两条 IPC 绑定正确')

// ── 2) global.d.ts 侧 ─────────────────────────────────────
assert.ok(/getChartCacheHit:\s*\(avatarId:\s*string,\s*queryHash:\s*string\)\s*=>\s*Promise</.test(globalDts),
  'global.d.ts 需声明 getChartCacheHit')
assert.ok(/\{\s*hit:\s*true;\s*assistantContent:\s*string;\s*createdAt:\s*number\s*\}/.test(globalDts),
  'global.d.ts 命中分支应含 assistantContent + createdAt')
assert.ok(/\{\s*hit:\s*false\s*\}/.test(globalDts),
  'global.d.ts 未命中分支应是 { hit: false }')
assert.ok(/saveChartCacheEntry:\s*\(avatarId:\s*string,\s*payload:\s*\{/.test(globalDts),
  'global.d.ts 需声明 saveChartCacheEntry')
for (const field of ['queryHash', 'queryPreview', 'assistantContent', 'excelBasenames']) {
  assert.ok(new RegExp(`\\b${field}\\b`).test(globalDts), `saveChartCacheEntry 需含字段 ${field}`)
}
console.log('✓ global.d.ts 两条签名完整')

// ── 3) main.ts 侧 IPC 注册 ─────────────────────────────────
assert.ok(/wrapHandler\('get-chart-cache-hit',/.test(mainTs), "main.ts 需 wrapHandler('get-chart-cache-hit', ...)")
assert.ok(/wrapHandler\('save-chart-cache-entry',/.test(mainTs), "main.ts 需 wrapHandler('save-chart-cache-entry', ...)")
// 确认返回值形状与 global.d.ts 的联合类型对齐
assert.ok(/\{\s*hit:\s*true\s+as const,\s*assistantContent:\s*entry\.assistantContent,\s*createdAt:\s*entry\.createdAt\s*\}/.test(mainTs),
  'main.ts 命中返回结构应匹配 global.d.ts 声明')
console.log('✓ main.ts 两条 wrapHandler + 返回结构一致')

// ── 4) 通道名字符串三侧严格一致 ────────────────────────────
const channels = ['get-chart-cache-hit', 'save-chart-cache-entry']
for (const ch of channels) {
  assert.strictEqual(
    (preload.match(new RegExp(`'${ch}'`, 'g')) ?? []).length,
    1,
    `preload 应恰好出现一次 '${ch}'`,
  )
  assert.strictEqual(
    (mainTs.match(new RegExp(`'${ch}'`, 'g')) ?? []).length,
    1,
    `main.ts 应恰好出现一次 '${ch}'`,
  )
}
console.log('✓ 两条通道名在 preload / main.ts 各出现一次（无重复注册）')

console.log('\n全部通过 ✅')
