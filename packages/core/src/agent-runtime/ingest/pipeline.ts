/**
 * Ingestion 6 步 pipeline 编排器。
 *
 * 调用方注入：ExtractorAdapter（一组，按后缀分发）、可选 OcrAdapter、
 * 可选 VisionLLMAdapter、可选 LearningNotesAdapter。
 *
 * 失败语义：
 *   - extract 失败 → 整个 ingest 失败抛出
 *   - vision track 失败 → 静默跳过（onError 回调），一致性自检会捕获 OCR 覆盖率不足
 *   - learning notes 失败 → 跳过（notes=null）
 *   - 写盘失败 → 抛出
 */

import path from 'path'
import type {
  ArtefactLayout,
  ConsistencyConflict,
  ExtractorAdapter,
  IngestRunResult,
  LearningNotesAdapter,
  OcrAdapter,
  ValidationLevel,
  VisionLLMAdapter,
  VisionTrackResult,
} from './types'
import { runVisionTrack } from './vision-track'
import { checkConsistency } from './consistency-checker'
import { writeArtefacts } from './artefact-writer'

export interface IngestPipelineOptions {
  extractors: ReadonlyArray<ExtractorAdapter>
  ocr?: OcrAdapter
  visionLLM?: VisionLLMAdapter
  learningNotes?: LearningNotesAdapter
  /** 学习笔记校验级别；缺省 'A'（单模型） */
  validationLevel?: ValidationLevel
  /** topic 目录命名策略；默认基于文件名 */
  topicDirNamer?: (filePath: string) => string
  /** OCR 覆盖率下限 */
  minOcrCoverage?: number
  /** 每步钩子（用于日志 / 进度 UI） */
  onStep?: (step: IngestStep, info: Record<string, unknown>) => void
}

export type IngestStep =
  | 'extract'
  | 'vision'
  | 'consistency'
  | 'learning-notes'
  | 'write'
  | 'index'

export async function runIngestPipeline(
  filePath: string,
  layout: { knowledgeRoot: string },
  opts: IngestPipelineOptions
): Promise<IngestRunResult> {
  // 1. extract
  const ext = path.extname(filePath).toLowerCase()
  const extractor = opts.extractors.find((e) => e.supports.includes(ext))
  if (!extractor) {
    throw new Error(`没有可用 extractor 处理后缀 "${ext}" — 文件：${filePath}`)
  }
  opts.onStep?.('extract', { ext, filePath })
  const doc = await extractor.extract(filePath)

  // 2. vision track（可选）
  let vision: VisionTrackResult | null = null
  if (doc.images.length > 0 && (opts.ocr || opts.visionLLM)) {
    opts.onStep?.('vision', { imageCount: doc.images.length })
    vision = await runVisionTrack(doc.images, {
      ocr: opts.ocr,
      visionLLM: opts.visionLLM,
      onError: (track, err) => {
        opts.onStep?.('vision', { track, error: err instanceof Error ? err.message : String(err) })
      },
    })
  }

  // 3. 一致性自检
  opts.onStep?.('consistency', {})
  const conflicts: ConsistencyConflict[] = checkConsistency(doc, vision?.ocr ?? [], {
    minOcrCoverage: opts.minOcrCoverage,
  })

  // 4. 学习笔记（可选）
  let notes: string | null = null
  if (opts.learningNotes) {
    opts.onStep?.('learning-notes', { level: opts.validationLevel ?? 'A' })
    try {
      notes = await opts.learningNotes.generate(doc, opts.validationLevel ?? 'A')
    } catch (err) {
      opts.onStep?.('learning-notes', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // 5. 写盘
  const topicName = opts.topicDirNamer
    ? opts.topicDirNamer(filePath)
    : defaultTopicName(filePath)
  const layoutResolved: ArtefactLayout = {
    topicDir: path.join(layout.knowledgeRoot, topicName),
  }
  opts.onStep?.('write', { topicDir: layoutResolved.topicDir })
  const artefactPaths = await writeArtefacts({
    topicDir: layoutResolved.topicDir,
    doc,
    vision,
    conflicts,
    notes,
  })

  // 6. （README 已由 writeArtefacts 写入；这里只做 onStep 上报，留给上层 knowledge-indexer 进一步处理）
  opts.onStep?.('index', { artefactCount: artefactPaths.length })

  return {
    doc,
    vision,
    conflicts,
    notes,
    topicDir: layoutResolved.topicDir,
    artefactPaths,
  }
}

function defaultTopicName(filePath: string): string {
  const base = path.basename(filePath, path.extname(filePath))
  return base.replace(/[^\w一-鿿.-]+/g, '_').slice(0, 80) || 'untitled'
}
