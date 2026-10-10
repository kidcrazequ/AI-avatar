import type { SourceLocation, SourceCell, SourceTable } from './knowledge';

export interface KnowledgeReference { key: string; version: string; manifestHash: string }
export interface KnowledgeSource { id: string; name: string; source: string; hash: string; reference: KnowledgeReference; status: 'ready' | 'partial'; warnings: string[] }
export interface SourceCitation { id: string; source: string; version: string; bodySha256: string; originalSha256: string; status: 'ready' | 'partial'; warnings: string[] }
export interface KnowledgeHit extends SourceCitation { name: string; score: number; content: string; lineStart: number; lineEnd: number; locations: SourceLocation[]; tables: Array<{ sheet: string; addresses: string[] }> }
export interface KnowledgeSearch { chunks: KnowledgeHit[]; coverage: { hits: number; mode: 'rrf'; hint: 'empty' | 'partial'; channels: string[] }; notice: string }
export interface KnowledgeRange extends SourceCitation { content: string; lineStart: number; lineEnd: number; totalLines: number; nextLine: number | null; locations: SourceLocation[] }
export interface TableDescription extends SourceCitation { tables: Array<Omit<SourceTable, 'cells'> & { cells: number; formulas: number; missingFormulaValues: number; defaultHeaderRow: number; columnsByPhysicalHeader: SourceTable['blocks'][number]['columns'] }>; notice: string }
export interface TableQuery extends SourceCitation { sheet: string; headerRow: number; columns: SourceTable['blocks'][number]['columns']; rows: Array<{ row: number; cells: SourceCell[] }>; matched: number; nextOffset: number | null; merges: SourceTable['merges']; aggregate?: { operation: string; value: number; count: number; excluded: number }; notice: string }
export type LookupRequest =
  | { operation: 'search'; query: string; limit?: number; caseSensitive?: boolean }
  | { operation: 'read'; id: string; lineStart?: number; lineEnd?: number; page?: number; section?: string }
  | { operation: 'describe'; id: string }
  | { operation: 'table'; id: string; sheet: string; headerRow?: number; rowStart?: number; rowEnd?: number; columns?: string[]; filters?: Array<{ column: string; operator: 'eq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte'; value: string | number | boolean }>; offset?: number; limit?: number; aggregate?: { column: string; operation: 'sum' | 'average' | 'min' | 'max' | 'count' } };
export type LookupResult = KnowledgeSearch | KnowledgeRange | TableDescription | TableQuery;
export interface KnowledgeLookupAPI { execute(scope: string, collectionId: string, request: LookupRequest): Promise<LookupResult> }
