/**
 * 端到端格式化测试：对选定样本文件跑完整 parser → cleaner → formatDocument → 写 md 管线
 * 不同于 dry-run 诊断脚本，这个会真调 LLM + Vision OCR
 *
 * 用法: cd desktop-app && npx tsx ../testdocs/format-samples.ts
 * 前置: xiaodu.db 里要有 chat_api_key / ocr_api_key（小首 UI 里存的）
 * 输出: testdocs/format-samples/{序号}-{描述}.md
 */

import path from 'path'
import fs from 'fs'
import { execSync } from 'child_process'
import { DocumentParser } from '../desktop-app/electron/document-parser'
import { createLLMFn } from '../desktop-app/electron/llm-factory'
import {
  formatDocument,
  cleanPdfFullText,
  stripDocxToc,
  callVisionOcr,
  mergeVisionIntoText,
} from '../packages/core/dist/index'

const DB_PATH = '/Users/cnlm007398/Library/Application Support/soul-desktop/xiaodu.db'
const OUTPUT_DIR = path.join(__dirname, 'format-samples')
const ROOT = '/Users/cnlm007398/堵杰的文档/堵杰的文档/Process'

interface Sample {
  num: number
  label: string
  category: string
  rel: string
}

const SAMPLES: Sample[] = [
  { num: 1, label: '01-docx-long-contract', category: 'docx 长合同(~47k 字)',
    rel: '框架合同/框架合同2024/13.附件十三 远景能源供应商行为准则-2023版.docx' },
  { num: 2, label: '02-docx-short-contract', category: 'docx 短合同(~2k 字)',
    rel: '框架合同/框架合同2024/12.附件十二 供应链协同协议-最新版.docx' },
  { num: 3, label: '03-doc-legacy', category: '.doc 旧格式(OLE2)',
    rel: '质量/合格证和出厂测试报告/量道-PR-31QHSEPR-QC-03  液冷柜261KWh检验报告 A1(1).doc' },
  { num: 4, label: '04-pptx', category: 'PowerPoint',
    rel: '质量/质量赋能.pptx' },
  { num: 5, label: '05-xlsx', category: 'Excel 表格',
    rel: '质量/合格证和出厂测试报告/产品出厂检验报告.xlsx' },
  { num: 6, label: '06-pdf-small-text', category: 'PDF 小文本(~124KB)',
    rel: '质量/合格证和出厂测试报告/远景合格证 V1.pdf' },
  { num: 7, label: '07-pdf-large-text', category: 'PDF 大文本(~1.6MB 防腐规范)',
    rel: '质量/验收标准/TS-0006864远景风力发电机组通用防腐技术工艺规范V7.0.pdf' },
  { num: 8, label: '08-pdf-mixed', category: 'PDF 图片+文字(~1.4MB MPO 手册)',
    rel: 'EDV/说明/EM-BRPCS-Rec-0001 流程MPO工作手册-20240702-V1.0发布版.pdf' },
  { num: 9, label: '09-pdf-scan', category: 'PDF 纯扫描件(~3MB)',
    rel: '质量/合格证和出厂测试报告/DC24000506.pdf' },
  { num: 10, label: '10-image-png', category: '纯图片(main.ts OCR bug 修复验证)',
    rel: '质量/验收标准/变频器空机柜验收清单.png' },
]

async function main() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  // 读 xiaodu.db 设置（用系统 sqlite3 CLI 避开 better-sqlite3 的 Node ABI 版本问题）
  const getSetting = (key: string): string => {
    try {
      const out = execSync(
        `sqlite3 "${DB_PATH}" "SELECT value FROM settings WHERE key = '${key}';"`,
        { encoding: 'utf-8' },
      )
      return out.trim()
    } catch {
      return ''
    }
  }
  const chatApiKey = getSetting('chat_api_key')
  const chatBaseUrl = getSetting('chat_base_url') || 'https://api.deepseek.com/v1'
  const chatModel = getSetting('chat_model') || 'deepseek-chat'
  const ocrApiKey = getSetting('ocr_api_key') || getSetting('vision_api_key')
  const ocrBaseUrl = getSetting('ocr_base_url') || getSetting('vision_base_url') || 'https://dashscope.aliyuncs.com/compatible-mode/v1'

  if (!chatApiKey) {
    console.error('xiaodu.db 里没有 chat_api_key，无法运行格式化。请先在 UI 配置。')
    process.exit(1)
  }
  console.log(`📦 chat: ${chatModel} @ ${chatBaseUrl.slice(0, 60)}`)
  console.log(`📦 ocr:  ${ocrApiKey ? 'ENABLED' : '未配置（纯图片/扫描件无法兜底）'}`)

  const callLLM = createLLMFn(chatApiKey, chatBaseUrl, chatModel)
  const parser = new DocumentParser()

  const summary: Array<{ num: number; label: string; status: string; chars: number; chapters: number; ms: number }> = []

  for (const sample of SAMPLES) {
    console.log(`\n${'='.repeat(80)}\n[${sample.num}/${SAMPLES.length}] ${sample.category}\n  ${sample.rel}\n${'='.repeat(80)}`)
    const full = path.join(ROOT, sample.rel)
    const outPath = path.join(OUTPUT_DIR, `${sample.label}.md`)
    const t0 = Date.now()

    if (!fs.existsSync(full)) {
      console.error(`  ❌ 文件不存在`)
      summary.push({ num: sample.num, label: sample.label, status: '文件不存在', chars: 0, chapters: 0, ms: 0 })
      continue
    }

    try {
      // 1. 解析
      const parsed = await parser.parseFile(full)
      const ext = path.extname(full).toLowerCase()
      let text = parsed.text || ''
      console.log(`  parse: ${text.length} chars, ${parsed.images?.length || 0} images`)

      // 2. 清洗
      if (ext === '.pdf') {
        text = cleanPdfFullText(text)
      } else if (ext === '.docx' || ext === '.doc') {
        text = stripDocxToc(cleanPdfFullText(text))
      }

      // 3. Vision OCR 合并（若有图且配了 key）
      if (parsed.images && parsed.images.length > 0 && ocrApiKey) {
        console.log(`  vision OCR 中（${parsed.images.length} 张）...`)
        try {
          const ocrOutcome = await callVisionOcr(parsed.images, {
            apiKey: ocrApiKey, baseUrl: ocrBaseUrl,
          })
          if (ocrOutcome.results.length > 0) {
            if (parsed.perPageChars) {
              const visionForMerge: Array<{ pageNum: number; content: string }> = []
              for (let vi = 0; vi < ocrOutcome.results.length; vi++) {
                const content = ocrOutcome.results[vi]
                if (content === null) continue
                visionForMerge.push({
                  pageNum: parsed.imagePageNumbers?.[vi] ?? (vi + 1),
                  content,
                })
              }
              if (visionForMerge.length > 0) {
                text = mergeVisionIntoText(text, visionForMerge, parsed.perPageChars)
              }
            } else {
              // 纯图片 / 图片型 docx：OCR 结果直接作正文
              const ocrTexts = ocrOutcome.results.filter((r): r is string => r !== null && r.trim().length > 0)
              if (ocrTexts.length > 0) {
                const joined = ocrTexts.join('\n\n')
                text = text.trim() ? `${text}\n\n${joined}` : joined
              }
            }
          }
          console.log(`  vision 合并完: ${text.length} chars`)
        } catch (e) {
          console.warn(`  vision OCR 失败:`, e instanceof Error ? e.message : e)
        }
      }

      // 4. 格式化（真调 LLM）
      let finalContent: string
      if (text.trim().length < 100) {
        // 文本过少，不走 formatDocument 直接写
        finalContent = `# ${path.basename(sample.rel)}\n\n> 文本过少（${text.length} chars），跳过格式化\n\n${text}`
        console.log(`  文本过少，跳过 LLM 格式化`)
      } else {
        console.log(`  formatDocument 中...`)
        finalContent = await formatDocument(
          text,
          path.basename(sample.rel),
          sample.rel,
          callLLM,
          (p) => {
            if (p.current > 0 && p.current % 5 === 0) {
              console.log(`    章节 ${p.current}/${p.total}: ${p.chapterTitle}`)
            }
          },
        )
      }

      // 5. 写 md
      const frontmatter = [
        '---',
        `sample: ${sample.num}`,
        `category: ${sample.category}`,
        `source: ${sample.rel}`,
        `parser: ${parsed.fileType}`,
        `raw_chars: ${parsed.text?.length || 0}`,
        `cleaned_chars: ${text.length}`,
        `images: ${parsed.images?.length || 0}`,
        '---',
        '',
      ].join('\n')
      fs.writeFileSync(outPath, frontmatter + finalContent, 'utf-8')

      const ms = Date.now() - t0
      const chapterCount = (finalContent.match(/^## /gm) || []).length
      console.log(`  ✅ 输出 ${finalContent.length} chars / ${chapterCount} 章节 / ${Math.round(ms / 1000)}s → ${path.basename(outPath)}`)
      summary.push({ num: sample.num, label: sample.label, status: '✓', chars: finalContent.length, chapters: chapterCount, ms })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`  ❌ 失败: ${msg}`)
      fs.writeFileSync(outPath, `---\nsample: ${sample.num}\nstatus: FAILED\n---\n\n# 失败\n\n\`\`\`\n${msg}\n\`\`\`\n`, 'utf-8')
      summary.push({ num: sample.num, label: sample.label, status: `失败: ${msg.slice(0, 50)}`, chars: 0, chapters: 0, ms: Date.now() - t0 })
    }
  }

  console.log('\n' + '='.repeat(80))
  console.log('汇总')
  console.log('='.repeat(80))
  for (const s of summary) {
    console.log(`[${s.num}] ${s.label.padEnd(28)} ${s.status.padEnd(6)} ${String(s.chars).padStart(6)} chars | ${s.chapters} 章 | ${Math.round(s.ms / 1000)}s`)
  }
  console.log(`\n输出目录: ${OUTPUT_DIR}`)
}

main().catch(e => { console.error(e); process.exit(1) })
