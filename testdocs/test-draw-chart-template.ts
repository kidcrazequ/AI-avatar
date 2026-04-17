/**
 * 子任务 3 回归测试：draw-chart.md 强约束参数模板
 */
import fs from 'fs'
import path from 'path'
import assert from 'assert'

const p = path.resolve(__dirname, '../avatars/小堵-工商储专家/skills/draw-chart.md')
const md = fs.readFileSync(p, 'utf-8')

// ── 结构断言 ──
const idxTemplate = md.indexOf('### 参数模板')
const idxDataRules = md.indexOf('## 数据来源规则')
const idxGuard = md.indexOf('## 数据完整性守护')
assert.ok(idxDataRules > 0, '"数据来源规则" 段应保留')
assert.ok(idxTemplate > 0, '必须新增 "### 参数模板" 段')
assert.ok(idxGuard > 0, '"数据完整性守护" 段应保留')
assert.ok(
  idxDataRules < idxTemplate && idxTemplate < idxGuard,
  `参数模板段必须位于"数据来源规则"之后、"数据完整性守护"之前（rules=${idxDataRules}, tpl=${idxTemplate}, guard=${idxGuard}）`,
)

const templateBlock = md.slice(idxTemplate, idxGuard)

// ── 模板 A / B 双份 ──
assert.ok(/格式 A[^\n]*M1[~～-]M2/.test(templateBlock), '必须有格式 A（月区间）标题')
assert.ok(/格式 B[^\n]*YYYY[^\n]*X 指标/.test(templateBlock), '必须有格式 B（全年）标题')

// ── 必需字段写死 ──
const mustContainAll: Array<[RegExp, string]> = [
  [/"file":\s*"00_工商储-产品质量指标dashboard_260303"/, 'file 固定文件名'],
  [/"sheet":\s*"月度"/, 'sheet 固定 "月度"'],
  [/"\$gte":\s*"<YYYY>-<MM1>"/, '格式 A 月份下界占位符'],
  [/"\$lte":\s*"<YYYY>-<MM2>"/, '格式 A 月份上界占位符'],
  [/"\$gte":\s*"<YYYY>-01"/, '格式 B 全年下界'],
  [/"\$lte":\s*"<YYYY>-12"/, '格式 B 全年上界'],
  [/"columns":\s*\["月份",\s*"<X 指标中文原名>"\]/, 'columns 首项为 "月份"'],
]
for (const [re, label] of mustContainAll) {
  assert.ok(re.test(templateBlock), `模板缺失必备字段：${label}（正则 ${re}）`)
  console.log(`✓ 必备字段：${label}`)
}

// ── 填槽硬规矩 ──
const mustRules: Array<[RegExp, string]> = [
  [/零填充两位月份/, '零填充月份规则'],
  [/"\$gte"[\s\S]{0,30}"\$lte"[\s\S]{0,30}对象形式/, '月份必须对象形式（禁止降级为字符串）'],
  [/不要额外追加/, 'columns 禁止追加无关列'],
]
for (const [re, label] of mustRules) {
  assert.ok(re.test(templateBlock), `填槽硬规矩缺失：${label}`)
  console.log(`✓ 硬规矩：${label}`)
}

// ── 与 cache 层联动说明 ──
assert.ok(
  /normalizeQueryExcelArgs/.test(templateBlock),
  '参数模板段应说明与 chatStore.normalizeQueryExcelArgs cache 的联动',
)
console.log('✓ 与 cache 层联动说明存在')

// ── 原有关键段未被破坏 ──
const preserved: Array<[RegExp, string]> = [
  [/## ⚠️ 技术栈说明/, 'ECharts 技术栈警示'],
  [/### ❌ Chart\.js 格式/, 'Chart.js 反例'],
  [/### ✅ ECharts 格式/, 'ECharts 正例'],
  [/### 关键差异对照表/, '差异对照表'],
  [/### 输出前自检清单/, '输出前自检清单'],
  [/## UED 设计规范/, 'UED 规范'],
  [/### 示例 1：月度趋势/, '示例 1'],
  [/## 失败回退/, '失败回退'],
  [/## 禁止事项/, '禁止事项'],
]
for (const [re, label] of preserved) {
  assert.ok(re.test(md), `原有段落被破坏：${label}`)
  console.log(`✓ 原有段落保留：${label}`)
}

assert.ok(md.length > 8000, `文件异常变短（${md.length} chars）`)
const lineCount = md.split('\n').length
assert.ok(lineCount > 390 && lineCount < 450, `行数异常（${lineCount}）`)
console.log(`✓ 文件规模健康：${lineCount} 行 / ${md.length} chars`)

console.log('\n全部通过 ✅')
