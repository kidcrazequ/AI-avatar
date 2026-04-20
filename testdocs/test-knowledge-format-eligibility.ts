/**
 * 校验：Excel/PPTX 等 frontmatter 应隐藏 FORMAT（与 KnowledgePanel 一致）
 *
 * 运行：cd desktop-app && node_modules/.bin/tsx ../testdocs/test-knowledge-format-eligibility.ts
 */
import assert from 'assert'
import { parseFrontmatter, shouldHideKnowledgeFormatButton } from '../desktop-app/src/utils/knowledge-frontmatter'

const excelMd = `---
rag_only: true
source: excel
excel_json: _excel/foo.json
sheets: ["总原始表"]
---

# x

body
`

const pptxMd = `---
rag_only: true
source: pptx
---

# p
`

const pdfWithRaw = `---
raw_file: _raw/report.pdf
---

# r
`

const mdPlain = `# no frontmatter
hello
`

assert.strictEqual(shouldHideKnowledgeFormatButton(parseFrontmatter(excelMd).meta), true, 'source:excel → hide')
assert.strictEqual(shouldHideKnowledgeFormatButton(parseFrontmatter(pptxMd).meta), true, 'source:pptx → hide')
assert.strictEqual(shouldHideKnowledgeFormatButton(parseFrontmatter(pdfWithRaw).meta), false, 'raw_file .pdf → show FORMAT')
const xlsxRaw = `---
raw_file: _raw/数据.xlsx
---
`
assert.strictEqual(shouldHideKnowledgeFormatButton(parseFrontmatter(xlsxRaw).meta), true, 'raw_file .xlsx → hide')
assert.strictEqual(shouldHideKnowledgeFormatButton(parseFrontmatter(mdPlain).meta), false, '无 meta → show')
const legacyExcelJsonOnly = `---
rag_only: true
excel_json: _excel/legacy.json
---
`
assert.strictEqual(shouldHideKnowledgeFormatButton(parseFrontmatter(legacyExcelJsonOnly).meta), true, '仅有 excel_json → hide')

console.log('✓ knowledge format 显隐逻辑全部通过')
