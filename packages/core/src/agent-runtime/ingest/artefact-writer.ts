/**
 * 把 ExtractedDocument + Vision/OCR + 学习笔记 + 冲突 落盘到 topic 目录：
 *
 *   <topicDir>/
 *     ├── 原文.md
 *     ├── _tables/<source>.json
 *     ├── _assets/<imageId>.png
 *     ├── _assets/<imageId>.ocr.txt        （可选）
 *     ├── _assets/<imageId>.caption.txt    （可选）
 *     ├── _conflicts.md                    （仅当有冲突）
 *     ├── 学习笔记.md                       （可选）
 *     └── README.md                        （索引）
 */

import fs from 'fs'
import path from 'path'
import type {
  ExtractedDocument,
  VisionTrackResult,
  ConsistencyConflict,
  ExtractedImage,
} from './types'
import { renderConflictsMarkdown } from './consistency-checker'

export interface WriteArtefactsOptions {
  topicDir: string
  doc: ExtractedDocument
  vision?: VisionTrackResult | null
  conflicts?: readonly ConsistencyConflict[]
  notes?: string | null
}

export async function writeArtefacts(opts: WriteArtefactsOptions): Promise<string[]> {
  const { topicDir, doc, vision, conflicts, notes } = opts
  await fs.promises.mkdir(topicDir, { recursive: true })
  const tablesDir = path.join(topicDir, '_tables')
  const assetsDir = path.join(topicDir, '_assets')
  if (doc.tables.length > 0) await fs.promises.mkdir(tablesDir, { recursive: true })
  if (doc.images.length > 0) await fs.promises.mkdir(assetsDir, { recursive: true })

  const written: string[] = []

  // 1. 原文.md
  const rawPath = path.join(topicDir, '原文.md')
  await fs.promises.writeFile(rawPath, doc.text, 'utf-8')
  written.push(rawPath)

  // 2. 表格 → _tables/<source>.json
  for (const t of doc.tables) {
    const safe = sanitizeFilename(t.source)
    const p = path.join(tablesDir, `${safe}.json`)
    await fs.promises.writeFile(p, JSON.stringify(t, null, 2), 'utf-8')
    written.push(p)
  }

  // 3. 图片 + OCR/caption → _assets
  for (const img of doc.images) {
    const imgPath = path.join(assetsDir, `${img.id}.png`)
    const buf = decodeDataUrl(img)
    if (buf) {
      await fs.promises.writeFile(imgPath, buf)
      written.push(imgPath)
    }
    const ocr = vision?.ocr.find((o) => o.imageId === img.id)
    if (ocr) {
      const ocrPath = path.join(assetsDir, `${img.id}.ocr.txt`)
      await fs.promises.writeFile(ocrPath, ocr.text, 'utf-8')
      written.push(ocrPath)
    }
    const cap = vision?.captions.find((c) => c.imageId === img.id)
    if (cap) {
      const capPath = path.join(assetsDir, `${img.id}.caption.txt`)
      await fs.promises.writeFile(capPath, cap.caption, 'utf-8')
      written.push(capPath)
    }
  }

  // 4. _conflicts.md（仅当有冲突）
  if (conflicts && conflicts.length > 0) {
    const cp = path.join(topicDir, '_conflicts.md')
    await fs.promises.writeFile(cp, renderConflictsMarkdown(conflicts), 'utf-8')
    written.push(cp)
  }

  // 5. 学习笔记
  if (notes) {
    const np = path.join(topicDir, '学习笔记.md')
    await fs.promises.writeFile(np, notes, 'utf-8')
    written.push(np)
  }

  // 6. README.md 索引
  const readmePath = path.join(topicDir, 'README.md')
  await fs.promises.writeFile(readmePath, buildReadme(doc, conflicts, notes), 'utf-8')
  written.push(readmePath)

  return written
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^\w一-鿿.-]+/g, '_').slice(0, 80) || 'untitled'
}

function decodeDataUrl(img: ExtractedImage): Buffer | null {
  const m = img.dataUrl.match(/^data:image\/[a-z+]+;base64,(.+)$/i)
  if (!m) return null
  return Buffer.from(m[1], 'base64')
}

function buildReadme(
  doc: ExtractedDocument,
  conflicts?: readonly ConsistencyConflict[],
  notes?: string | null
): string {
  const lines = [
    `# ${doc.fileName}`,
    '',
    `- 格式：${doc.format}`,
    `- 表格：${doc.tables.length} 张`,
    `- 图片：${doc.images.length} 张`,
  ]
  if (conflicts && conflicts.length > 0) {
    lines.push(`- 冲突：${conflicts.length} 项（见 _conflicts.md）`)
  }
  if (notes) lines.push('- 学习笔记：见 学习笔记.md')
  lines.push('', '## 文件', '', '- `原文.md` — 提取的主文本')
  if (doc.tables.length > 0) lines.push('- `_tables/` — 结构化表格 JSON')
  if (doc.images.length > 0) lines.push('- `_assets/` — 原始图片 + OCR/caption')
  return lines.join('\n') + '\n'
}
