/**
 * 格式化 dry-run 测试：对 _raw/ 下所有文件进行解析 → 清洗 → 章节切分 → 乱码检测
 * 不调 LLM，只输出诊断报告。
 *
 * 用法: cd desktop-app && npx tsx ../testdocs/dry-run-format.ts
 */

import path from 'path'
import fs from 'fs'
import { DocumentParser, isGarbledText } from '../desktop-app/electron/document-parser'
import { cleanPdfFullText, stripDocxToc } from '../packages/core/dist/utils/ocr-html-cleaner'
import { splitIntoChapters } from '../packages/core/dist/document-formatter'

const KNOWLEDGE_DIR = path.join(__dirname, '../avatars/小堵-工商储专家/knowledge')
const RAW_DIR = path.join(KNOWLEDGE_DIR, '_raw')

// 不需要格式化的文件类型
const SKIP_EXTS = new Set(['.xlsx', '.xls', '.csv', '.pptx', '.ppt', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'])

interface FileReport {
  fileName: string
  ext: string
  skipped: boolean
  skipReason?: string
  rawChars?: number
  cleanedChars?: number
  isGarbled?: boolean
  garbledRatio?: number
  chapterCount?: number
  chapters?: Array<{ title: string; chars: number }>
  wholeFileChapter?: boolean  // 整个文件变成单个"全文"章节
  ocrPages?: number
  parseError?: string
}

async function main() {
  const files = fs.readdirSync(RAW_DIR).filter(f => !f.startsWith('.'))
  console.log(`\n📁 _raw/ 下共 ${files.length} 个文件\n`)

  const reports: FileReport[] = []
  const parser = new DocumentParser()

  for (const fileName of files) {
    const ext = path.extname(fileName).toLowerCase()
    const report: FileReport = { fileName, ext, skipped: false }

    // 跳过不需要格式化的类型
    if (SKIP_EXTS.has(ext)) {
      report.skipped = true
      report.skipReason = `${ext} 文件不需要 LLM 格式化`
      reports.push(report)
      continue
    }

    try {
      // 1. 解析
      const parsed = await parser.parseFile(path.join(RAW_DIR, fileName))
      report.rawChars = (parsed.text || '').length
      report.ocrPages = parsed.images?.length || 0

      // 2. 清洗
      let cleanedText = parsed.text || ''
      if (ext === '.pdf') {
        cleanedText = cleanPdfFullText(cleanedText)
      } else if (ext === '.docx' || ext === '.doc') {
        cleanedText = stripDocxToc(cleanPdfFullText(cleanedText))
      }
      report.cleanedChars = cleanedText.length

      // 3. 乱码检测
      report.isGarbled = isGarbledText(cleanedText)
      if (report.isGarbled) {
        // 计算详细比率
        const stripped = cleanedText.replace(/\s+/g, '')
        const commonChars = stripped.replace(/[A-Za-z0-9\u4E00-\u9FFF\u3000-\u303F\uFF00-\uFFEF.,;:!?'"()\[\]{}<>@#$%^&*+=\-_/\\|~`，。；：！？、""''（）【】《》—…·\u00A0\u2000-\u206F]/g, '')
        report.garbledRatio = Math.round((commonChars.length / stripped.length) * 100)
      }

      // 4. 章节切分
      if (!report.isGarbled && cleanedText.length >= 100) {
        const chapters = splitIntoChapters(cleanedText)
        report.chapterCount = chapters.length
        report.chapters = chapters.map(ch => ({
          title: ch.title.slice(0, 50),
          chars: ch.content.length,
        }))
        report.wholeFileChapter = chapters.length === 1 && chapters[0].title === '全文'
      }
    } catch (err) {
      report.parseError = err instanceof Error ? err.message : String(err)
    }

    reports.push(report)
  }

  // 输出报告
  console.log('=' .repeat(80))
  console.log('  格式化 DRY-RUN 诊断报告')
  console.log('='.repeat(80))

  // 1. 跳过的文件
  const skipped = reports.filter(r => r.skipped)
  if (skipped.length > 0) {
    console.log(`\n📋 跳过 ${skipped.length} 个文件（不需要格式化）:`)
    for (const r of skipped) {
      console.log(`  ⏭  ${r.fileName} — ${r.skipReason}`)
    }
  }

  // 2. 解析失败
  const failed = reports.filter(r => r.parseError)
  if (failed.length > 0) {
    console.log(`\n❌ 解析失败 ${failed.length} 个:`)
    for (const r of failed) {
      console.log(`  ✗ ${r.fileName} — ${r.parseError}`)
    }
  }

  // 3. 乱码文件
  const garbled = reports.filter(r => r.isGarbled)
  if (garbled.length > 0) {
    console.log(`\n🔣 乱码文件 ${garbled.length} 个（需要 OCR 重新处理）:`)
    for (const r of garbled) {
      console.log(`  ⚠ ${r.fileName} — 异常字符占 ${r.garbledRatio}%, raw ${r.rawChars} chars, OCR页 ${r.ocrPages}`)
    }
  }

  // 4. 整文件未切分（"全文"章节）
  const wholefile = reports.filter(r => r.wholeFileChapter)
  if (wholefile.length > 0) {
    console.log(`\n📄 未识别到章节结构 ${wholefile.length} 个（整文件作为"全文"处理）:`)
    for (const r of wholefile) {
      console.log(`  ⚠ ${r.fileName} — ${r.cleanedChars} chars, 无法切分章节`)
    }
  }

  // 5. 正常切分的文件
  const normal = reports.filter(r => !r.skipped && !r.parseError && !r.isGarbled && !r.wholeFileChapter)
  if (normal.length > 0) {
    console.log(`\n✅ 正常切分 ${normal.length} 个:`)
    for (const r of normal) {
      const maxChapter = r.chapters?.reduce((max, ch) => ch.chars > max ? ch.chars : max, 0) || 0
      console.log(`  ✓ ${r.fileName}`)
      console.log(`    raw ${r.rawChars} → cleaned ${r.cleanedChars} chars | ${r.chapterCount} 章节 | 最大章节 ${maxChapter} chars | OCR页 ${r.ocrPages}`)
      if (r.chapters && r.chapters.length <= 15) {
        for (const ch of r.chapters) {
          console.log(`      「${ch.title}」 ${ch.chars} chars`)
        }
      }
    }
  }

  // 6. 汇总
  console.log('\n' + '='.repeat(80))
  console.log(`  汇总: ${files.length} 文件 | ${skipped.length} 跳过 | ${failed.length} 失败 | ${garbled.length} 乱码 | ${wholefile.length} 未切分 | ${normal.length} 正常`)
  console.log('='.repeat(80))

  // 保存报告
  const reportPath = path.join(__dirname, 'dry-run-report.json')
  fs.writeFileSync(reportPath, JSON.stringify(reports, null, 2), 'utf-8')
  console.log(`\n报告已保存: ${reportPath}\n`)
}

main().catch(err => {
  console.error('测试失败:', err)
  process.exit(1)
})
