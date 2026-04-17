/**
 * 子任务 4 回归测试：knowledge-retriever.ts sort 稳定二级键
 *
 * 目标：
 *  1) 5 处 sort 调用都已挂上二级键（file/heading 或 key）
 *  2) 平分时排序输出确定（与输入顺序无关）
 *  3) 非平分时主键排序不被破坏
 *
 * 运行方式：cd desktop-app && node_modules/.bin/tsx ../testdocs/test-rag-sort-stable.ts
 */
import fs from 'fs'
import path from 'path'
import assert from 'assert'

// ── 源码静态断言：5 处 sort 都必须带二级键 ──
const src = fs.readFileSync(
  path.resolve(__dirname, '../packages/core/src/knowledge-retriever.ts'),
  'utf-8',
)

// 主键 + file/heading 二级键 — 应出现至少 4 次
const scoreTieRe = /\(b\.score - a\.score\)[^\n]*a\.file\.localeCompare\(b\.file\)[^\n]*a\.heading\.localeCompare\(b\.heading\)/g
const scoreTieCount = (src.match(scoreTieRe) || []).length
assert.ok(
  scoreTieCount >= 4,
  `score+file+heading 二级键应出现至少 4 次（实得 ${scoreTieCount}）：L390/L429/L447/L497`,
)
console.log(`✓ score+file+heading 二级键出现 ${scoreTieCount} 次`)

// sim 主键 + key 二级键 — 应出现 1 次
const simTieRe = /\(b\.sim - a\.sim\)[^\n]*a\.key\.localeCompare\(b\.key\)/g
const simTieCount = (src.match(simTieRe) || []).length
assert.strictEqual(
  simTieCount,
  1,
  `sim+key 二级键应恰好出现 1 次（实得 ${simTieCount}）：L464 vectorScored`,
)
console.log(`✓ sim+key 二级键出现 1 次`)

// 确认原裸主键 sort 全部已消失
const bareScoreRe = /sort\(\(a, b\) => b\.score - a\.score\)/g
assert.strictEqual((src.match(bareScoreRe) || []).length, 0, '仍有未替换的裸 score sort')
const bareSimRe = /sort\(\(a, b\) => b\.sim - a\.sim\)/g
assert.strictEqual((src.match(bareSimRe) || []).length, 0, '仍有未替换的裸 sim sort')
console.log('✓ 所有裸主键 sort 都已替换')

// ── 行为模拟：复刻两种 comparator ──
type ScoreItem = { score: number; file: string; heading: string }
const cmpScore = (a: ScoreItem, b: ScoreItem) =>
  (b.score - a.score) ||
  a.file.localeCompare(b.file) ||
  a.heading.localeCompare(b.heading)

type SimItem = { sim: number; key: string }
const cmpSim = (a: SimItem, b: SimItem) => (b.sim - a.sim) || a.key.localeCompare(b.key)

// 平分测试：多条同 score，输入顺序打乱，输出应按 (file, heading) 字典序稳定
const tieItems: ScoreItem[] = [
  { score: 0.5, file: 'c.md', heading: 'B' },
  { score: 0.5, file: 'a.md', heading: 'Z' },
  { score: 0.5, file: 'a.md', heading: 'A' },
  { score: 0.5, file: 'b.md', heading: 'A' },
  { score: 0.5, file: 'c.md', heading: 'A' },
]
const shuffles: ScoreItem[][] = [
  [...tieItems],
  [...tieItems].reverse(),
  [tieItems[2], tieItems[0], tieItems[4], tieItems[1], tieItems[3]],
  [tieItems[4], tieItems[3], tieItems[2], tieItems[1], tieItems[0]],
]
const expectedOrder = ['a.md/A', 'a.md/Z', 'b.md/A', 'c.md/A', 'c.md/B']
for (const input of shuffles) {
  const sorted = [...input].sort(cmpScore)
  const actual = sorted.map(i => `${i.file}/${i.heading}`)
  assert.deepStrictEqual(actual, expectedOrder, `平分排序不稳定 — input=${JSON.stringify(input.map(i=>i.file+'/'+i.heading))}`)
}
console.log(`✓ 平分场景下 4 种打乱输入均产出相同字典序`)

// 非平分：主键必须被尊重
const mixed: ScoreItem[] = [
  { score: 0.3, file: 'a.md', heading: 'A' },
  { score: 0.9, file: 'z.md', heading: 'Z' },
  { score: 0.6, file: 'm.md', heading: 'M' },
  { score: 0.9, file: 'a.md', heading: 'Z' }, // 与 z.md/Z 同分，字典序在前
]
const sortedMixed = [...mixed].sort(cmpScore)
assert.deepStrictEqual(
  sortedMixed.map(i => `${i.file}/${i.heading}:${i.score}`),
  ['a.md/Z:0.9', 'z.md/Z:0.9', 'm.md/M:0.6', 'a.md/A:0.3'],
  '非平分场景下主键排序失效',
)
console.log('✓ 非平分场景下 score 主键仍优先，平分处按字典序')

// sim comparator 平分测试
const simTie: SimItem[] = [
  { sim: 0.8, key: 'f/h2' },
  { sim: 0.8, key: 'f/h1' },
  { sim: 0.8, key: 'a/h' },
]
const sortedSim = [...simTie].sort(cmpSim)
assert.deepStrictEqual(
  sortedSim.map(i => i.key),
  ['a/h', 'f/h1', 'f/h2'],
  'sim 平分时应按 key 字典序',
)
console.log('✓ sim 平分场景下按 key 字典序稳定')

// sim 非平分
const simMix: SimItem[] = [
  { sim: 0.1, key: 'aaa' },
  { sim: 0.9, key: 'zzz' },
  { sim: 0.5, key: 'mmm' },
]
assert.deepStrictEqual(
  [...simMix].sort(cmpSim).map(i => i.key),
  ['zzz', 'mmm', 'aaa'],
  'sim 主键优先',
)
console.log('✓ sim 主键优先')

console.log('\n全部通过 ✅')
