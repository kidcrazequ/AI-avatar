import fs from 'node:fs';
import path from 'node:path';
import type { SourceTable, SourceCell } from '../../shared/knowledge';
import type { KnowledgeSource, LookupRequest, LookupResult, SourceCitation, KnowledgeHit } from '../../shared/knowledge-lookup';
import { hash, sourcePath, type FrozenManifest } from './lookup-store';

type Loaded = FrozenManifest & { reference: KnowledgeSource['reference']; root: string; body: string; lines: string[] };
type Retriever = { searchChunksWithCoverage(query: string, n: number): { chunks: Array<{ file: string; content: string; score: number }> } };
const integer = (value: unknown, fallback: number, min: number, max: number): number => { if (value === undefined) return fallback; if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error('范围或分页参数无效'); return Number(value); };
const string = (value: unknown, max = 1000): string => { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('查询参数无效'); return value; };
const normalize = (value: string, sensitive = false): string => { const clean = value.normalize('NFKC').replace(/[\s*`_]/g, ''); return sensitive ? clean : clean.toLowerCase(); };
const citation = (doc: Loaded): SourceCitation => ({ id: doc.source.id, source: doc.source.source, version: doc.manifest.version, bodySha256: doc.manifest.bodySha256, originalSha256: doc.manifest.originalSha256, status: doc.manifest.status, warnings: doc.manifest.warnings });
const locations = (doc: Loaded, start: number, end: number) => doc.manifest.locations.filter(item => item.lineStart <= end && item.lineEnd >= start);
function table(doc: Loaded, sheet: string): SourceTable {
  const entry = doc.manifest.tables.find(item => item.sheet === sheet); if (!entry) throw new Error('此来源版本没有指定工作表');
  const bytes = fs.readFileSync(sourcePath(doc.root, entry.path)); if (hash(bytes) !== entry.sha256) throw new Error('来源表格哈希不匹配'); return JSON.parse(bytes.toString('utf8'));
}
function columnLetters(number: number): string { let value = ''; while (number) { number--; value = String.fromCharCode(65 + number % 26) + value; number = Math.floor(number / 26); } return value; }
function columns(data: SourceTable, headerRow: number) {
  const used = new Set<string>();
  return Array.from({ length: data.columns }, (_, index) => {
    const column = index + 1, cell = data.cells.find(c => c.row === headerRow && c.column === column);
    const merged = data.merges.find(m => m.startRow <= headerRow && m.endRow >= headerRow && m.startColumn <= column && m.endColumn >= column);
    const title = cell?.display || (merged && data.cells.find(c => c.row === merged.startRow && c.column === merged.startColumn)?.display) || columnLetters(column);
    let key = title, suffix = 2; while (used.has(key)) key = title + '_' + suffix++; used.add(key);
    return { column, title, key, dtype: 'mixed' };
  });
}
export class LookupEngine {
  private indexes = new Map<string, Retriever>();
  constructor(private root: string) {}
  private load(source: KnowledgeSource): Loaded {
    if (!source.reference || !/^[a-f0-9]{64}$/.test(source.reference.key) || !/^[a-f0-9]{64}$/.test(source.reference.manifestHash)) throw new Error('来源引用无效');
    const root = sourcePath(this.root, source.reference.key), bytes = fs.readFileSync(sourcePath(root, 'source.json'));
    if (hash(bytes) !== source.reference.manifestHash) throw new Error('来源清单被修改');
    const doc = JSON.parse(bytes.toString('utf8')) as FrozenManifest;
    if (doc.source.id !== source.id || doc.manifest.version !== source.reference.version || doc.manifest.bodySha256 !== source.hash) throw new Error('来源版本不一致');
    const body = fs.readFileSync(sourcePath(root, 'body.md'), 'utf8'); if (hash(body) !== doc.manifest.bodySha256) throw new Error('来源正文哈希不匹配');
    return { ...doc, root, body, lines: body.split('\n'), reference: source.reference };
  }
  execute(sources: KnowledgeSource[], request: LookupRequest): LookupResult {
    if (!request || typeof request !== 'object' || !Array.isArray(sources)) throw new Error('知识查询无效');
    // Authorization is resolved by the caller before any index is built; opaque refs never come from the renderer.
    if (request.operation === 'search') return this.search(sources.map(source => this.load(source)), request);
    const source = sources.find(item => item.id === string(request.id, 2000)); if (!source) throw new Error('当前授权范围或任务快照中没有此来源');
    const doc = this.load(source);
    if (request.operation === 'read') {
      if (request.page !== undefined && request.section !== undefined) throw new Error('页码与章节不能同时指定');
      let start = integer(request.lineStart, 1, 1, doc.lines.length), end = integer(request.lineEnd, Math.min(start + 199, doc.lines.length), start, doc.lines.length);
      if (request.page !== undefined) {
        const page = integer(request.page, 1, 1, 2000), entries = doc.manifest.locations.filter(item => item.page === page && ['page', 'slide', 'asset'].includes(item.kind));
        if (!entries.length) throw new Error('此来源版本没有指定页码'); const first = Math.min(...entries.map(item => item.lineStart)); end = Math.max(...entries.map(item => item.lineEnd)); start = integer(request.lineStart, first, first, end);
      }
      if (request.section !== undefined) {
        const heading = string(request.section); start = doc.lines.findIndex(line => /^#{1,6}\s/.test(line) && normalize(line.replace(/^#+\s*/, '')) === normalize(heading)) + 1;
        if (!start) throw new Error('此来源版本没有指定章节'); const level = /^#+/.exec(doc.lines[start - 1])![0].length;
        const next = doc.lines.findIndex((line, i) => i >= start && /^#{1,6}\s/.test(line) && /^#+/.exec(line)![0].length <= level); end = next < 0 ? doc.lines.length : next; start = integer(request.lineStart, start, start, end);
      }
      const requestedEnd = end;
      end = Math.min(end, start + 499); let count = 0, last = start - 1;
      while (last < end && count + doc.lines[last].length < 24000) { count += doc.lines[last].length + 1; last++; }
      if (last < start) throw new Error('单行超过阅读上限，请使用原件或表格工具');
      return { ...citation(doc), content: doc.lines.slice(start - 1, last).join('\n'), lineStart: start, lineEnd: last, totalLines: doc.lines.length, nextLine: last < requestedEnd || last < doc.lines.length && request.page === undefined && request.section === undefined && request.lineEnd === undefined ? last + 1 : null, locations: locations(doc, start, last) };
    }
    if (request.operation === 'describe') return { ...citation(doc), tables: doc.manifest.tables.map(entry => { const data = table(doc, entry.sheet); const { cells, ...rest } = data; return { ...rest, cells: cells.length, formulas: cells.filter(c => c.formula).length, missingFormulaValues: cells.filter(c => c.formula && (c.value === null || c.value === '')).length, defaultHeaderRow: 1, columnsByPhysicalHeader: columns(data, 1) }; }), notice: '默认使用物理第 1 行表头；blocks 是自动建议，可能包含误判。多表块请显式指定 headerRow、rowStart 和 rowEnd，或使用 A/B/C 物理列。' };
    if (request.operation !== 'table') throw new Error('知识操作无效');
    const data = table(doc, string(request.sheet)), headerRow = integer(request.headerRow, 1, 1, Math.max(data.rows, 1)), headers = columns(data, headerRow);
    const resolve = (key: unknown) => { const value = string(key), named = headers.find(c => c.key === value), physical = headers.find(c => columnLetters(c.column) === value.replace(/^@/, '')); if (!value.startsWith('@') && named && physical && named.column !== physical.column) throw new Error('列名与物理列冲突，请使用 @A 等明确物理列'); const found = value.startsWith('@') ? physical : named ?? physical; if (!found) throw new Error('列名或物理列无效'); return found.column; };
    if (request.columns !== undefined && (!Array.isArray(request.columns) || request.columns.length > data.columns)) throw new Error('返回列无效');
    const selected = request.columns?.map(resolve) ?? headers.map(c => c.column);
    if (request.filters !== undefined && (!Array.isArray(request.filters) || request.filters.length > 20)) throw new Error('筛选条件无效');
    const filters = (request.filters ?? []).map(filter => { if (!filter || !['eq', 'contains', 'gt', 'gte', 'lt', 'lte'].includes(filter.operator) || !['string', 'number', 'boolean'].includes(typeof filter.value) || typeof filter.value === 'number' && !Number.isFinite(filter.value)) throw new Error('筛选条件无效'); if (['gt', 'gte', 'lt', 'lte'].includes(filter.operator) && typeof filter.value !== 'number') throw new Error('数值筛选必须提供数值'); return { ...filter, column: resolve(filter.column) }; });
    const start = integer(request.rowStart, headerRow + 1, 1, Math.max(data.rows + 1, 1)), end = integer(request.rowEnd, data.rows, Math.min(start, data.rows), data.rows), limit = integer(request.limit, 50, 1, 200), offset = integer(request.offset, 0, 0, data.rows);
    const rows = new Map<number, SourceCell[]>(); for (const cell of data.cells) if (cell.row >= start && cell.row <= end) { const list = rows.get(cell.row) ?? []; list.push(cell); rows.set(cell.row, list); }
    const matched = [...rows].filter(([, cells]) => filters.every(filter => {
      const value = cells.find(c => c.column === filter.column)?.value;
      if (filter.operator === 'eq') return value === filter.value;
      if (filter.operator === 'contains') return typeof value === 'string' && value.includes(String(filter.value));
      if (typeof value !== 'number') return false; const expected = filter.value as number;
      return filter.operator === 'gt' ? value > expected : filter.operator === 'gte' ? value >= expected : filter.operator === 'lt' ? value < expected : value <= expected;
    }));
    let aggregate;
    if (request.aggregate) {
      const { operation } = request.aggregate; if (!['sum', 'average', 'min', 'max', 'count'].includes(operation)) throw new Error('聚合操作无效'); const column = resolve(request.aggregate.column);
      const values = matched.map(([, cells]) => cells.find(c => c.column === column)?.value), numbers = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
      if (operation !== 'count' && !numbers.length) throw new Error('指定列没有可聚合数值，不会推算缺失公式结果');
      aggregate = { operation, value: operation === 'count' ? values.filter(v => v !== null && v !== undefined && v !== '').length : operation === 'sum' ? numbers.reduce((a, b) => a + b, 0) : operation === 'average' ? numbers.reduce((a, b) => a + b, 0) / numbers.length : numbers.reduce((a, b) => operation === 'min' ? Math.min(a, b) : Math.max(a, b)), count: numbers.length, excluded: values.length - numbers.length };
      if (!Number.isFinite(aggregate.value)) throw new Error('聚合结果超出有限数值范围');
    }
    return { ...citation(doc), sheet: data.sheet, headerRow, columns: headers.filter(c => selected.includes(c.column)), rows: matched.slice(offset, offset + limit).map(([row, cells]) => ({ row, cells: cells.filter(c => selected.includes(c.column)) })), matched: matched.length, nextOffset: offset + limit < matched.length ? offset + limit : null, merges: data.merges, aggregate, notice: '基于完整物理网格；公式原式与缓存值分开，缓存值未重新计算。合并区域不复制虚构单元格值。' };
  }
  private search(docs: Loaded[], request: Extract<LookupRequest, { operation: 'search' }>) {
    if (request.caseSensitive !== undefined && typeof request.caseSensitive !== 'boolean') throw new Error('大小写选项无效');
    const query = string(request.query), limit = integer(request.limit, 5, 1, 100), q = normalize(query, request.caseSensitive);
    const anchors = [...query.matchAll(/[A-Za-z]+[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*|\d{5,}|[“"]([^”"]+)[”"]/g)].map(match => match[1] ?? match[0]);
    const segmented = [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(query.normalize('NFKC'))].filter(item => item.isWordLike && (!/\p{Script=Han}/u.test(item.segment) || item.segment.length > 1)).map(item => normalize(item.segment, request.caseSensitive));
    const words = [...new Set(segmented.filter(token => !['什么', '多少', '如何', '是否', '请问', '根据', '资料', '文件', '中的', '公司', '标准', '规定', '要求'].includes(token)))];
    const evidence = docs.map(doc => {
      const sheets = doc.manifest.tables.map(entry => { const data = table(doc, entry.sheet); return { sheet: data.sheet, cells: data.cells }; });
      const text = normalize(doc.body + '\n' + doc.source.name + '\n' + sheets.flatMap(s => s.cells.map(c => c.display)).join('\n'), request.caseSensitive);
      const tokens = words.filter(word => text.includes(word)), exact = text.includes(q), admissible = !anchors.some(anchor => !text.includes(normalize(anchor, request.caseSensitive))) && (exact || tokens.length > 0 && tokens.length / Math.max(words.length, 1) >= 0.25);
      let index = doc.lines.findIndex(line => normalize(line, request.caseSensitive).includes(q));
      if (index < 0) { let score = 0; doc.lines.forEach((line, i) => { const clean = normalize(line, request.caseSensitive), current = words.filter(word => clean.includes(word)).length; if (current > score) { score = current; index = i; } }); }
      const matches = sheets.map(s => ({ sheet: s.sheet, addresses: s.cells.filter(c => { const clean = normalize(c.display, request.caseSensitive); return clean.includes(q) || words.some(word => clean.includes(word)); }).slice(0, 30).map(c => c.address) })).filter(s => s.addresses.length);
      return { doc, exact, admissible, lexical: tokens.length / Math.max(words.length, 1), index: Math.max(0, index), tables: matches };
    });
    const signature = hash(docs.map(doc => doc.reference.key).join('\n'));
    let retriever = this.indexes.get(signature);
    if (!retriever && docs.length) {
      const directory = sourcePath(this.root, 'index-' + signature); fs.mkdirSync(directory, { recursive: true });
      docs.forEach((doc, i) => { const file = sourcePath(directory, i + '.md'), indexed = `# 来源文件：${doc.source.name}\n\n${doc.body}`; if (!fs.existsSync(file) || hash(fs.readFileSync(file)) !== hash(indexed)) fs.writeFileSync(file, indexed); });
      const { KnowledgeRetriever } = require('./retriever.cjs') as { KnowledgeRetriever: new (root: string) => Retriever };
      retriever = new KnowledgeRetriever(directory); this.indexes.set(signature, retriever); if (this.indexes.size > 4) this.indexes.delete(this.indexes.keys().next().value!);
    }
    const bm25 = retriever?.searchChunksWithCoverage(query, Math.max(30, limit * 4)).chunks ?? [], bmIds = [...new Set(bm25.map(hit => Number(path.basename(hit.file, '.md'))))];
    const lexical = evidence.map((entry, i) => ({ ...entry, i })).filter(e => e.admissible).sort((a, b) => Number(b.exact) - Number(a.exact) || b.lexical - a.lexical);
    const scores = new Map<number, number>();
    for (const ranking of [bmIds.filter(i => evidence[i]?.admissible), lexical.map(e => e.i)]) ranking.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + i + 1)));
    const chunks: KnowledgeHit[] = [...scores].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([i, score]) => {
      const e = evidence[i], start = Math.max(1, e.index - 4), end = Math.min(e.doc.lines.length, e.index + 16);
      return { ...citation(e.doc), name: e.doc.source.name, score, content: e.doc.lines.slice(start - 1, end).join('\n').slice(0, 8000), lineStart: start, lineEnd: end, locations: locations(e.doc, start, end), tables: e.tables };
    });
    return { chunks, coverage: { hits: chunks.length, mode: 'rrf' as const, hint: chunks.length ? 'partial' as const : 'empty' as const, channels: ['chinese-bm25', 'literal-structure'] }, notice: chunks.length ? '这是候选来源，不能以召回分数认定事实正确；请按行、页或完整表格核对，partial 来源仍有提取缺口。' : '当前授权来源中没有足够的字面证据；不得据此编造答案。' };
  }
}
