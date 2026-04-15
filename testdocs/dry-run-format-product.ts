/**
 * 递归版 dry-run 格式化测试：对指定目录下所有文件进行解析 → 清洗 → 章节切分 → 乱码检测
 * 不调 LLM，只输出诊断报告。
 *
 * 用法: cd desktop-app && npx tsx ../testdocs/dry-run-format-product.ts [目录]
 *   默认目录: /Users/cnlm007398/堵杰的文档/堵杰的文档/Product
 */

import path from 'path'
import fs from 'fs'
import os from 'os'
import { createRequire } from 'module'
import { DocumentParser, isGarbledText } from '../desktop-app/electron/document-parser'
import { cleanPdfFullText, stripDocxToc } from '../packages/core/dist/utils/ocr-html-cleaner'
import { splitIntoChapters } from '../packages/core/dist/document-formatter'

// dry-run 脚本自身在 testdocs/ 下，没有 node_modules；通过 createRequire 指向
// desktop-app 路径解析 adm-zip / node-unrar-js（这些依赖装在 desktop-app/node_modules）
const desktopRequire = createRequire('/Users/cnlm007398/AI/soul/desktop-app/package.json')

const TARGET_DIR = process.argv[2] || '/Users/cnlm007398/堵杰的文档/堵杰的文档/Product'

// 不需要格式化的文件类型
const SKIP_EXTS = new Set([
  '.xlsx', '.xls', '.csv', '.pptx', '.ppt',
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp',
  '.stp', '.step',
  '.dwg',  // CAD 图纸，parser 不支持
])

// 归档格式：dry-run 会解压后递归扫描内部文件（和生产 folder-importer 一致）
const ARCHIVE_EXTS = new Set(['.zip', '.rar', '.7z', '.tar', '.tgz'])

interface FileReport {
  relPath: string
  ext: string
  sizeBytes: number
  skipped: boolean
  skipReason?: string
  rawChars?: number
  cleanedChars?: number
  isGarbled?: boolean
  garbledRatio?: number
  chapterCount?: number
  chapters?: Array<{ title: string; chars: number }>
  wholeFileChapter?: boolean
  tableLike?: boolean      // 表格型 PDF（大量短行/KV 行），章节切分对它无意义
  empty?: boolean          // cleanedChars < 100 AND ocrPages == 0 (真·无救)
  visionHandoff?: boolean  // cleanedChars 小 或 乱码，但 ocrPages > 0 → 下游 Vision 兜底
  shortDoc?: boolean       // 100 <= cleanedChars < 1500 且无章节 → 正常的短文档直送
  ocrPages?: number
  parseError?: string
}

/** 判定文本是否呈"表格/数据表"结构：短行比例高，不适合章节切分 */
function isTableLike(text: string): boolean {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0)
  if (lines.length < 20) return false
  const shortLines = lines.filter(l => l.length <= 20).length
  const shortRatio = shortLines / lines.length
  // 短行 > 45% 判为表格型（单字符行、数字行、K=V 短行密集）
  return shortRatio > 0.45
}

/**
 * 归档解压到临时目录。
 * - .zip → adm-zip
 * - .rar → node-unrar-js
 * 返回临时目录路径；归档所在目录的文件 walker 会把这个临时目录当成子目录递归。
 * 其他归档格式暂不支持（7z 需 node-7z + 二进制；tar 需 tar 包），会被跳过并记录。
 */
async function extractArchive(archivePath: string): Promise<string | null> {
  const ext = path.extname(archivePath).toLowerCase()
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dry-run-archive-'))
  try {
    if (ext === '.zip') {
      const AdmZip = desktopRequire('adm-zip')
      const zip = new AdmZip(archivePath)
      zip.extractAllTo(tempDir, true)
      return tempDir
    }
    if (ext === '.rar') {
      const unrar = desktopRequire('node-unrar-js')
      const data = fs.readFileSync(archivePath)
      const extractor = await unrar.createExtractorFromData({
        data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      })
      const extracted = extractor.extract()
      for (const f of Array.from(extracted.files as Iterable<{
        fileHeader: { name: string; flags: { directory: boolean } }
        extraction?: Uint8Array
      }>)) {
        if (f.fileHeader.flags.directory) continue
        if (!f.extraction) continue
        const out = path.join(tempDir, f.fileHeader.name)
        fs.mkdirSync(path.dirname(out), { recursive: true })
        fs.writeFileSync(out, Buffer.from(f.extraction))
      }
      return tempDir
    }
  } catch (err) {
    console.warn(`[walk] 解压失败 ${path.basename(archivePath)}:`, err instanceof Error ? err.message : err)
    fs.rmSync(tempDir, { recursive: true, force: true })
    return null
  }
  // 未支持格式
  fs.rmSync(tempDir, { recursive: true, force: true })
  return null
}

const tempDirsToClean: string[] = []

async function walk(dir: string, base: string, out: Array<{ rel: string; full: string }>) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await walk(full, base, out)
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase()
      if (ARCHIVE_EXTS.has(ext)) {
        const rel = path.relative(base, full)
        const extracted = await extractArchive(full)
        if (extracted) {
          tempDirsToClean.push(extracted)
          // 用归档名作为前缀让报告一眼看出来源
          const innerBase = extracted
          const inner: Array<{ rel: string; full: string }> = []
          await walk(extracted, innerBase, inner)
          for (const item of inner) {
            out.push({ rel: `${rel}!/${item.rel}`, full: item.full })
          }
          console.log(`[walk] 归档 ${rel} 解压后找到 ${inner.length} 个文件`)
        } else {
          // 解压失败或不支持 — 记为普通文件让上层归"跳过"
          out.push({ rel, full })
        }
      } else {
        out.push({ rel: path.relative(base, full), full })
      }
    }
  }
}

async function main() {
  if (!fs.existsSync(TARGET_DIR)) {
    console.error(`目录不存在: ${TARGET_DIR}`)
    process.exit(1)
  }

  const files: Array<{ rel: string; full: string }> = []
  await walk(TARGET_DIR, TARGET_DIR, files)
  files.sort((a, b) => a.rel.localeCompare(b.rel))
  console.log(`\n📁 ${TARGET_DIR} 下共 ${files.length} 个文件（递归，含归档内部）\n`)

  const reports: FileReport[] = []
  const parser = new DocumentParser()

  let i = 0
  for (const { rel: relPath, full } of files) {
    i++
    const ext = path.extname(relPath).toLowerCase()
    const stat = fs.statSync(full)
    const report: FileReport = { relPath, ext, sizeBytes: stat.size, skipped: false }

    process.stdout.write(`[${i}/${files.length}] ${relPath.slice(0, 80)}\n`)

    if (SKIP_EXTS.has(ext)) {
      report.skipped = true
      report.skipReason = `${ext} 不需要 LLM 格式化`
      reports.push(report)
      continue
    }

    try {
      const parsed = await parser.parseFile(full)
      report.rawChars = (parsed.text || '').length
      report.ocrPages = parsed.images?.length || 0

      let cleanedText = parsed.text || ''
      if (ext === '.pdf') {
        cleanedText = cleanPdfFullText(cleanedText)
      } else if (ext === '.docx' || ext === '.doc') {
        cleanedText = stripDocxToc(cleanPdfFullText(cleanedText))
      }
      report.cleanedChars = cleanedText.length

      const rawGarbled = isGarbledText(cleanedText)
      if (rawGarbled) {
        const stripped = cleanedText.replace(/\s+/g, '')
        const commonChars = stripped.replace(/[A-Za-z0-9\u4E00-\u9FFF\u3000-\u303F\uFF00-\uFFEF.,;:!?'"()\[\]{}<>@#$%^&*+=\-_/\\|~`，。；：！？、""''（）【】《》—…·\u00A0\u2000-\u206F]/g, '')
        report.garbledRatio = stripped.length > 0 ? Math.round((commonChars.length / stripped.length) * 100) : 0
      }
      const ocrCount = report.ocrPages || 0

      // 优先判定：乱码 / 短文本 + 有 OCR 截图 = 下游 Vision 会兜底，不报警
      if ((rawGarbled || cleanedText.length < 100) && ocrCount > 0) {
        report.visionHandoff = true
      } else if (rawGarbled) {
        report.isGarbled = true   // 真乱码且无截图兜底
      } else if (cleanedText.length < 100) {
        report.empty = true       // 真·空文档 + 0 截图 = 无救
      } else if (cleanedText.length < 1500) {
        report.shortDoc = true    // 短文档：< 1500 chars 不值得切分
      } else if (isTableLike(cleanedText)) {
        report.tableLike = true   // 表格/数据表型，章节切分无意义
      } else {
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

  console.log('\n' + '='.repeat(80))
  console.log('  格式化 DRY-RUN 诊断报告（递归版）')
  console.log('='.repeat(80))

  const skipped = reports.filter(r => r.skipped)
  const failed = reports.filter(r => r.parseError)
  const garbled = reports.filter(r => r.isGarbled)
  const empty = reports.filter(r => r.empty)
  const visionHandoff = reports.filter(r => r.visionHandoff)
  const shortDoc = reports.filter(r => r.shortDoc)
  const tableLike = reports.filter(r => r.tableLike)
  const wholefile = reports.filter(r => r.wholeFileChapter)
  const normal = reports.filter(r => !r.skipped && !r.parseError && !r.isGarbled && !r.empty && !r.visionHandoff && !r.shortDoc && !r.tableLike && !r.wholeFileChapter)

  // 跳过类型分布
  if (skipped.length > 0) {
    const byExt = new Map<string, number>()
    for (const r of skipped) byExt.set(r.ext, (byExt.get(r.ext) || 0) + 1)
    console.log(`\n📋 跳过 ${skipped.length} 个文件（不需要格式化）:`)
    for (const [ext, n] of [...byExt.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${ext.padEnd(8)} ${n}`)
    }
  }

  if (failed.length > 0) {
    console.log(`\n❌ 解析失败 ${failed.length} 个:`)
    for (const r of failed) {
      console.log(`  ✗ ${r.relPath}`)
      console.log(`    ${r.parseError}`)
    }
  }

  if (garbled.length > 0) {
    console.log(`\n🔣 乱码文件 ${garbled.length} 个（需要 OCR 重新处理）:`)
    for (const r of garbled) {
      console.log(`  ⚠ ${r.relPath}`)
      console.log(`    异常字符占 ${r.garbledRatio}% | raw ${r.rawChars} chars | OCR 页 ${r.ocrPages}`)
    }
  }

  if (empty.length > 0) {
    console.log(`\n🫥 真空文档 ${empty.length} 个（<100 chars 且 0 OCR 截图 → 无救）:`)
    for (const r of empty) {
      console.log(`  ⚠ ${r.relPath} — raw ${r.rawChars} → cleaned ${r.cleanedChars}`)
    }
  }

  if (visionHandoff.length > 0) {
    console.log(`\n👁  Vision 兜底 ${visionHandoff.length} 个（文字稀疏/乱码但有 OCR 截图，下游 Vision 会处理）`)
  }

  if (shortDoc.length > 0) {
    console.log(`\n📝 短文档直送 ${shortDoc.length} 个（<1500 chars，不值得切分，直接送 LLM）`)
  }

  if (tableLike.length > 0) {
    console.log(`\n📊 表格/数据表型 ${tableLike.length} 个（短行占比 >45%，不需章节切分）`)
  }

  if (wholefile.length > 0) {
    console.log(`\n📄 未识别到章节结构 ${wholefile.length} 个（整文件作为"全文"处理）:`)
    for (const r of wholefile) {
      console.log(`  ⚠ ${r.relPath} — ${r.cleanedChars} chars`)
    }
  }

  if (normal.length > 0) {
    console.log(`\n✅ 正常切分 ${normal.length} 个（摘要）:`)
    for (const r of normal) {
      const maxChapter = r.chapters?.reduce((m, ch) => ch.chars > m ? ch.chars : m, 0) || 0
      console.log(`  ✓ ${r.relPath}`)
      console.log(`    raw ${r.rawChars} → cleaned ${r.cleanedChars} | ${r.chapterCount} 章节 | 最大 ${maxChapter} chars | OCR ${r.ocrPages}`)
    }
  }

  console.log('\n' + '='.repeat(80))
  console.log(`  汇总: ${files.length} 文件 | ${skipped.length} 跳过 | ${failed.length} 失败 | ${garbled.length} 真乱码 | ${empty.length} 真空 | ${visionHandoff.length} Vision兜底 | ${shortDoc.length} 短文档 | ${tableLike.length} 表格型 | ${wholefile.length} 未切分 | ${normal.length} 正常`)
  console.log('='.repeat(80))

  // 报告名按目标目录 basename 区分（多目录跑时不互相覆盖）
  const targetName = path.basename(TARGET_DIR).toLowerCase().replace(/[^a-z0-9]/g, '-') || 'output'
  const reportPath = path.join(__dirname, `dry-run-report-${targetName}.json`)
  fs.writeFileSync(reportPath, JSON.stringify(reports, null, 2), 'utf-8')
  console.log(`\n报告已保存: ${reportPath}\n`)

  // 清理归档解压出的临时目录
  for (const d of tempDirsToClean) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

main().catch(err => {
  console.error('测试失败:', err)
  process.exit(1)
})
