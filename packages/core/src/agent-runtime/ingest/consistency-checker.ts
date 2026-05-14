/**
 * 一致性自检（无 LLM）。
 *
 * 不变量：
 *   - 每个 ExtractedTable 的 rowMeta（若有）长度 == rows.length
 *   - 每个 image 都应该有对应 OCR 结果（OCR 覆盖率 ≥ 阈值）
 *   - metadata.pageCount（若 PDF）应该 ≥ 提取到的页数下限
 */

import type {
  ConsistencyConflict,
  ExtractedDocument,
  OcrResult,
} from './types'

export interface ConsistencyCheckOptions {
  /** OCR 覆盖率下限（0..1），默认 0.5 */
  minOcrCoverage?: number
}

export function checkConsistency(
  doc: ExtractedDocument,
  ocr: readonly OcrResult[] = [],
  opts: ConsistencyCheckOptions = {}
): ConsistencyConflict[] {
  const conflicts: ConsistencyConflict[] = []
  const minCov = opts.minOcrCoverage ?? 0.5

  // 表格 rowMeta 对齐
  for (const t of doc.tables) {
    if (t.rowMeta && t.rowMeta.length !== t.rows.length) {
      conflicts.push({
        kind: 'table-row-count',
        message: `表 "${t.source}" rowMeta 长度 ${t.rowMeta.length} 与 rows 长度 ${t.rows.length} 不一致`,
        details: { source: t.source, rowMetaLen: t.rowMeta.length, rowsLen: t.rows.length },
      })
    }
  }

  // 图片 OCR 覆盖率
  if (doc.images.length > 0) {
    const ocrIds = new Set(ocr.map((o) => o.imageId))
    const covered = doc.images.filter((i) => ocrIds.has(i.id)).length
    const coverage = covered / doc.images.length
    if (coverage < minCov) {
      conflicts.push({
        kind: 'ocr-coverage',
        message: `OCR 覆盖率 ${(coverage * 100).toFixed(1)}% 低于阈值 ${(minCov * 100).toFixed(0)}%`,
        details: { covered, total: doc.images.length, coverage },
      })
    }
  }

  // PDF pageCount 与 metadata.perPageChars 一致性
  if (doc.format === 'pdf' && Array.isArray(doc.metadata['perPageChars'])) {
    const perPage = doc.metadata['perPageChars'] as Array<{ num: number; chars: number }>
    const declared = doc.metadata['pageCount']
    if (typeof declared === 'number' && declared !== perPage.length) {
      conflicts.push({
        kind: 'page-count',
        message: `PDF pageCount=${declared} 与 perPageChars 长度 ${perPage.length} 不一致`,
        details: { declared, perPageLen: perPage.length },
      })
    }
  }

  return conflicts
}

/** 把 conflicts 渲染为 `_conflicts.md`（供 pipeline 写盘） */
export function renderConflictsMarkdown(conflicts: readonly ConsistencyConflict[]): string {
  if (conflicts.length === 0) {
    return '# 一致性检查\n\n本次未发现冲突。\n'
  }
  const lines = ['# 一致性检查冲突', '', `共 ${conflicts.length} 项：`, '']
  for (const c of conflicts) {
    lines.push(`## ${c.kind}`)
    lines.push('')
    lines.push(c.message)
    lines.push('')
    lines.push('```json')
    lines.push(JSON.stringify(c.details, null, 2))
    lines.push('```')
    lines.push('')
  }
  return lines.join('\n')
}
