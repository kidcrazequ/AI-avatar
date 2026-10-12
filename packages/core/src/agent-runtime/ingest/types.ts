/**
 * 文档 Ingestion 类型定义。对齐 PAP `pap/knowledge_ingest/`。
 *
 * 6 步 pipeline：
 *   1. extract       确定性提取（PDF/Word/Excel/PPTX/HTML/Image → IR）
 *   2. visionTrack   图像处理（Tesseract OCR + 可选 Vision LLM caption）
 *   3. checkConsistency  一致性自检（行数对齐、图片数对齐 → _conflicts.md）
 *   4. learningNotes 可选 LLM 学习笔记（A=单模型 / B=跨模型互校）
 *   5. writeArtefacts 落盘 (原文.md / _tables / _assets / 学习笔记.md)
 *   6. rebuildIndex  更新 README.md / knowledge index
 */

export type DocFormat = 'pdf' | 'word' | 'excel' | 'pptx' | 'html' | 'image' | 'text'

export interface ExtractedTable {
  /** 来源（如 sheet 名 / PDF 页码） */
  source: string
  headers: string[]
  rows: Array<Array<string | number | null>>
  /** 行角色（与 rows 一一对应），见 soul 的 RowMetaRole */
  rowMeta?: Array<'data' | 'subtitle' | 'subtotal' | 'total'>
}

export interface ExtractedImage {
  /** 资源 id（如 page1_img1） */
  id: string
  /** base64 data URL */
  dataUrl: string
  /** 关联位置（页码 / sheet） */
  source?: string
}

export interface ExtractedDocument {
  format: DocFormat
  fileName: string
  /** 提取出的主文本，已转 Markdown */
  text: string
  tables: ExtractedTable[]
  images: ExtractedImage[]
  /** 自由 metadata（pageCount / sheetCount …） */
  metadata: Record<string, unknown>
}

export interface ExtractorAdapter {
  /** 该 extractor 处理哪些后缀（含 .） */
  supports: ReadonlyArray<string>
  extract(filePath: string): Promise<ExtractedDocument>
}

// ── Vision 双轨 ───────────────────────────────────────────────────────

export interface OcrResult {
  imageId: string
  text: string
  confidence?: number
}

export interface VisionCaption {
  imageId: string
  caption: string
}

export interface OcrAdapter {
  recognize(images: readonly ExtractedImage[]): Promise<OcrResult[]>
}

export interface VisionLLMAdapter {
  caption(images: readonly ExtractedImage[]): Promise<VisionCaption[]>
}

export interface VisionTrackResult {
  ocr: OcrResult[]
  captions: VisionCaption[]
}

// ── 一致性自检 ────────────────────────────────────────────────────────

export interface ConsistencyConflict {
  kind: 'table-row-count' | 'image-count-mismatch' | 'page-count' | 'ocr-coverage'
  message: string
  details: Record<string, unknown>
}

// ── 学习笔记 ──────────────────────────────────────────────────────────

export type ValidationLevel = 'A' | 'B'

export interface LearningNotesAdapter {
  generate(doc: ExtractedDocument, level: ValidationLevel): Promise<string>
}

// ── 产物布局 ──────────────────────────────────────────────────────────

export interface ArtefactLayout {
  /** topic 目录绝对路径，将存 原文.md / _tables / _assets / 学习笔记.md / README.md */
  topicDir: string
}

export interface IngestRunResult {
  doc: ExtractedDocument
  vision: VisionTrackResult | null
  conflicts: ConsistencyConflict[]
  notes: string | null
  topicDir: string
  artefactPaths: string[]
}
