/**
 * 子任务 1 回归测试：temperature 优先级与图表一致性常量
 *
 * 目标：
 *  1) CHART_CONSISTENCY_TEMPERATURE 被降到 0，避免图表场景 temp 被拉高
 *  2) effectiveTemperature 的优先级为 收敛 fallback
 *
 * 运行方式：npx tsx testdocs/test-temp-priority.ts
 */
import fs from 'fs'
import path from 'path'
import assert from 'assert'

const src = fs.readFileSync(
  path.resolve(__dirname, '../desktop-app/src/stores/chatStore.ts'),
  'utf-8',
)

function grep1(re: RegExp, label: string): string {
  const m = src.match(re)
  if (!m) throw new Error(`未匹配到 ${label}: ${re}`)
  return m[1]
}

// ── 静态断言 ────────────────────────────────────────
const chartTemp = Number(
  grep1(/const\s+CHART_CONSISTENCY_TEMPERATURE\s*=\s*([0-9.]+)/, 'CHART_CONSISTENCY_TEMPERATURE'),
)
assert.strictEqual(chartTemp, 0, 'CHART_CONSISTENCY_TEMPERATURE 应为 0（之前 0.2 会把图表请求反向拉高）')

const detTemp = Number(
  grep1(/const\s+DETERMINISTIC_TEMPERATURE\s*=\s*([0-9.]+)/, 'DETERMINISTIC_TEMPERATURE'),
)
assert.strictEqual(detTemp, 0, 'DETERMINISTIC_TEMPERATURE 应为 0')

// 优先级结构断言：确定性分支必须在图表分支之前出现
const effBlock = src.match(
  /effectiveTemperature\s*=\s*shouldConvergeFast[\s\S]{0,400}?undefined\)\)/,
)
assert.ok(effBlock, '未找到 effectiveTemperature 定义块')
const idxDet = effBlock![0].indexOf('ENABLE_DETERMINISTIC_MODE')
const idxChart = effBlock![0].indexOf('chartConsistencyMode')
assert.ok(idxDet > 0, 'effectiveTemperature 分支需包含 ENABLE_DETERMINISTIC_MODE 判定')
assert.ok(idxChart > 0, 'effectiveTemperature 分支需包含 chartConsistencyMode 判定')
assert.ok(
  idxDet < idxChart,
  `优先级错误：DETERMINISTIC 必须在 chartConsistencyMode 之前判定（当前 det@${idxDet} vs chart@${idxChart}）`,
)

// ── 行为模拟 ────────────────────────────────────────
// 把代码里的 effectiveTemperature 表达式抽出来等价复刻，跑 6 种组合
function effectiveTemperature(args: {
  shouldConvergeFast: boolean
  enableDeterministic: boolean
  chartConsistency: boolean
}): number | undefined {
  const { shouldConvergeFast, enableDeterministic, chartConsistency } = args
  return shouldConvergeFast
    ? 0.2
    : enableDeterministic
      ? detTemp
      : chartConsistency
        ? chartTemp
        : undefined
}

const cases: Array<[string, Parameters<typeof effectiveTemperature>[0], number | undefined]> = [
  ['收敛优先——即便确定性+图表都开也应返回 0.2',
    { shouldConvergeFast: true, enableDeterministic: true, chartConsistency: true }, 0.2],
  ['确定性+图表命中——应返回确定性档 0（修复前会是 0.2）',
    { shouldConvergeFast: false, enableDeterministic: true, chartConsistency: true }, 0],
  ['仅确定性——0',
    { shouldConvergeFast: false, enableDeterministic: true, chartConsistency: false }, 0],
  ['仅图表（确定性关）——fallback 到 CHART_CONSISTENCY_TEMPERATURE=0',
    { shouldConvergeFast: false, enableDeterministic: false, chartConsistency: true }, 0],
  ['全关——undefined（不传 temperature，由服务端默认）',
    { shouldConvergeFast: false, enableDeterministic: false, chartConsistency: false }, undefined],
  ['图表不命中 + 确定性关——undefined',
    { shouldConvergeFast: false, enableDeterministic: false, chartConsistency: false }, undefined],
]

for (const [label, input, expected] of cases) {
  const got = effectiveTemperature(input)
  assert.strictEqual(got, expected, `失败: ${label} | 期望 ${expected} 实得 ${got}`)
  console.log(`✓ ${label} → ${got}`)
}

console.log('\n全部通过 ✅')
