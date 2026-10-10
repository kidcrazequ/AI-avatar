// One capability table drives file selection, intake validation and parser routing.
export const knowledgeFormats = [
  { kind: 'text', extensions: ['md', 'txt'] },
  { kind: 'html', extensions: ['html', 'htm'] },
  { kind: 'pdf', extensions: ['pdf'] },
  { kind: 'word', extensions: ['docx'] },
  { kind: 'slides', extensions: ['pptx'] },
  { kind: 'table', extensions: ['xlsx', 'xls', 'csv', 'tsv'] },
  { kind: 'image', extensions: ['png', 'jpg', 'jpeg'] },
] as const;
export const knowledgeExtensions: string[] = knowledgeFormats.flatMap(format => [...format.extensions]);
export const extractionSignature = 'soul-source-v1/2026-10-10';
export const knowledgeLimits = { fileBytes: 200 * 1024 * 1024, batchBytes: 1024 * 1024 * 1024, members: 500, pages: 2000, ocrPages: 200, pixels: 40_000_000, cells: 1_000_000, rows: 200_000, columns: 2048, sheets: 100, bodyBytes: 64 * 1024 * 1024, parseMs: 10 * 60_000 };
export type ImportItemState = 'queued' | 'extracting' | 'ready' | 'partial' | 'reused' | 'failed' | 'cancelled';
export interface KnowledgeImportItem { id: string; relativePath: string; sha256: string; bytes: number; state: ImportItemState; documentId: string; version: string; error: string; warnings: string[] }
export interface KnowledgeImportBatch { id: string; collectionId: string; scope: string; at: string; updated: string; state: 'queued' | 'running' | 'completed' | 'partial' | 'cancelled'; items: KnowledgeImportItem[]; skipped: Array<{ path: string; reason: string }> }
export interface SourceLocation { lineStart: number; lineEnd: number; kind: 'text' | 'page' | 'slide' | 'sheet' | 'asset'; page?: number; sheet?: string; rowStart?: number; rowEnd?: number; asset?: string; method: 'native' | 'ocr' }
export interface SourceAsset { path: string; sha256: string; bytes: number; origin: string; page?: number; slide?: number; ocr: 'recognized' | 'empty' | 'failed' | 'unsupported'; text: string; confidence?: number; error?: string; derivedFrom?: string; preprocessing?: { method: 'upscale' | 'suppress-red'; scale: number; removedPixels: number }; segmentation?: 'auto' | 'block' }
export interface SourceManifest { schema: 1; documentId: string; version: string; relativePath: string; originalName: string; original: string; originalSha256: string; originalBytes: number; signature: string; created: string; bodySha256: string; bodyBytes: number; status: 'ready' | 'partial'; warnings: string[]; locations: SourceLocation[]; assets: SourceAsset[]; tables: Array<{ path: string; sha256: string; sheet: string; cells: number; rows: number; columns: number }> }
export interface SourceCell { row: number; column: number; address: string; type: string; value: string | number | boolean | null; display: string; formula?: string; numberFormat?: string }
export interface SourceTable { schema: 1; sheet: string; range: string; rows: number; columns: number; cells: SourceCell[]; merges: Array<{ startRow: number; startColumn: number; endRow: number; endColumn: number }>; blocks: Array<{ startRow: number; endRow: number; headerRow: number; columns: Array<{ column: number; key: string; title: string; dtype: string }> }>; encoding?: string; delimiter?: string }
export interface KnowledgeAPI {
  learning: import('./knowledge-learning').LearningAPI;
  formats(): Promise<{ extensions: string[]; limits: typeof knowledgeLimits }>;
  chooseImport(collectionId: string, scope: string, kind: 'files' | 'directory' | 'zip'): Promise<KnowledgeImportBatch | null>;
  batches(collectionId: string, scope: string): Promise<KnowledgeImportBatch[]>;
  cancel(batchId: string, scope: string): Promise<void>;
  retry(batchId: string, scope: string): Promise<void>;
  versions(collectionId: string, documentId: string, scope: string): Promise<SourceManifest[]>;
  restore(collectionId: string, documentId: string, version: string, expectedVersion: string, scope: string): Promise<void>;
  openOriginal(collectionId: string, documentId: string, version: string, scope: string): Promise<void>;
  onChanged(listener: () => void): () => void;
}
