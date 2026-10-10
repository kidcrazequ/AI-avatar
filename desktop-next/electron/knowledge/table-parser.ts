import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import iconv from 'iconv-lite';
import type { SourceCell, SourceTable } from '../../shared/knowledge';
import { knowledgeLimits } from '../../shared/knowledge';

export function decodeText(bytes: Buffer): { text: string; encoding: string } {
  if (bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) return { text: iconv.decode(bytes.subarray(2), 'utf16-le'), encoding: 'utf16-le' };
  if (bytes.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) return { text: iconv.decode(bytes.subarray(2), 'utf16-be'), encoding: 'utf16-be' };
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''), encoding: 'utf8' }; }
  catch {
    const text = iconv.decode(bytes, 'gb18030');
    if (text.includes('\uFFFD')) throw new Error('无法可靠识别文本编码，请另存为 UTF-8');
    return { text, encoding: 'gb18030' };
  }
}

function records(text: string, delimiter: string, sample = false): string[][] {
  const result: string[][] = []; let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else if (quoted) quoted = false;
      else if (field === '') quoted = true;
      else field += c;
    } else if (!quoted && c === delimiter) { row.push(field); field = ''; }
    else if (!quoted && (c === '\n' || c === '\r')) {
      row.push(field); result.push(row); row = []; field = '';
      if (c === '\r' && text[i + 1] === '\n') i++;
      if (sample && result.length === 30) return result;
      if (result.length > knowledgeLimits.rows) throw new Error('表格超过物理行数上限');
    } else field += c;
  }
  if (quoted) throw new Error('CSV 引号未闭合，未发布不完整表格');
  if (field || row.length) { row.push(field); result.push(row); }
  if (result.some(r => r.length > knowledgeLimits.columns)) throw new Error('表格超过列数上限');
  return result;
}

function csv(file: string): { workbook: XLSX.WorkBook; encoding: string; delimiter: string } {
  const decoded = decodeText(fs.readFileSync(file));
  const choices = path.extname(file).toLowerCase() === '.tsv' ? ['\t'] : [',', '\t', ';', '|'];
  // Inspect complete records, so quoted line breaks and separators do not skew detection.
  const delimiter = choices.map(d => {
    const widths = records(decoded.text, d, true).filter(r => r.some(Boolean)).map(r => r.length);
    const frequencies = new Map<number, number>(); widths.forEach(w => frequencies.set(w, (frequencies.get(w) ?? 0) + 1));
    const best = [...frequencies].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0] ?? [1, 0];
    return { d, score: best[0] > 1 ? best[1] * 100 + best[0] : 0 };
  }).sort((a, b) => b.score - a.score)[0].d;
  const rows = records(decoded.text, delimiter);
  if (!rows.length) throw new Error('表格为空');
  // CSV fields remain strings: identifiers, leading zeroes and long integers stay exact.
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), '数据');
  return { workbook, encoding: decoded.encoding, delimiter };
}

function blocks(cells: SourceCell[]): SourceTable['blocks'] {
  const byRow = new Map<number, SourceCell[]>();
  for (const cell of cells) if (cell.display || cell.formula) { const row = byRow.get(cell.row) ?? []; row.push(cell); byRow.set(cell.row, row); }
  const occupied = [...byRow.keys()].sort((a, b) => a - b);
  const ranges: Array<{ start: number; end: number; rows: number[] }> = [];
  for (const row of occupied) { const last = ranges.at(-1); if (!last || row > last.end + 1) ranges.push({ start: row, end: row, rows: [row] }); else { last.end = row; last.rows.push(row); } }
  return ranges.map(range => {
    const candidates = range.rows.filter(r => r <= range.start + 12);
    const score = (r: number) => { const row = byRow.get(r)!; return row.filter(c => c.type === 's' && c.display).length * 2 + row.length - (r - range.start) * 0.2; };
    const headerRow = candidates.sort((a, b) => score(b) - score(a) || a - b)[0];
    const header = new Map(byRow.get(headerRow)!.map(c => [c.column, c.display.trim()]));
    const typesByColumn = new Map<number, Set<string>>();
    for (let r = headerRow + 1; r <= range.end; r++) for (const cell of byRow.get(r) ?? []) if (cell.value !== null) { const types = typesByColumn.get(cell.column) ?? new Set<string>(); types.add(cell.type); typesByColumn.set(cell.column, types); }
    const counts = new Map<string, number>();
    const width = range.rows.reduce((max, r) => byRow.get(r)!.reduce((n, cell) => Math.max(n, cell.column), max), 0);
    const columns = Array.from({ length: width }, (_, i) => {
      const title = header.get(i + 1) || `列${XLSX.utils.encode_col(i)}`;
      const count = (counts.get(title) ?? 0) + 1; counts.set(title, count);
      const types = typesByColumn.get(i + 1) ?? new Set<string>();
      return { column: i + 1, title, key: count === 1 ? title : `${title}_${count}`, dtype: types.size !== 1 ? 'mixed' : types.has('n') ? 'number' : types.has('d') ? 'date' : types.has('b') ? 'boolean' : 'string' };
    });
    return { startRow: range.start, endRow: range.end, headerRow, columns };
  });
}

export function parseTables(file: string): SourceTable[] {
  const delimited = /\.(csv|tsv)$/i.test(file) ? csv(file) : null;
  const workbook = delimited?.workbook ?? XLSX.read(fs.readFileSync(file), { type: 'buffer', cellDates: true, cellNF: true, cellFormula: true, cellStyles: true, sheetStubs: true });
  if (!workbook.SheetNames.length || workbook.SheetNames.length > knowledgeLimits.sheets) throw new Error('工作表数量不符合导入上限');
  let total = 0;
  return workbook.SheetNames.map(sheet => {
    const source = workbook.Sheets[sheet];
    const range = source['!ref'] || 'A1:A1', bounds = XLSX.utils.decode_range(range);
    const rows = bounds.e.r + 1, columns = bounds.e.c + 1;
    if (rows > knowledgeLimits.rows || columns > knowledgeLimits.columns) throw new Error(`工作表 ${sheet} 超过行列上限，未截断发布`);
    const cells: SourceCell[] = [];
    // Iterate sparse cells, preserving physical coordinates and blank stubs without
    // allocating a dense rectangle for formatting-only rows far below the data.
    for (const address of Object.keys(source).filter(key => /^[A-Z]+[1-9]\d*$/.test(key))) {
      if (++total > knowledgeLimits.cells) throw new Error('工作簿超过单元格上限，未截断发布');
      const cell = source[address] as XLSX.CellObject, p = XLSX.utils.decode_cell(address);
      const value = cell.v instanceof Date ? cell.v.toISOString() : cell.v == null ? null : typeof cell.v === 'string' || typeof cell.v === 'number' || typeof cell.v === 'boolean' ? cell.v : String(cell.v);
      cells.push({ row: p.r + 1, column: p.c + 1, address, type: cell.t || 'z', value, display: cell.w ?? (cell.v == null ? '' : XLSX.utils.format_cell(cell)), ...(cell.f ? { formula: cell.f } : {}), ...(cell.z ? { numberFormat: String(cell.z) } : {}) });
    }
    cells.sort((a, b) => a.row - b.row || a.column - b.column);
    return { schema: 1, sheet, range, rows, columns, cells, merges: (source['!merges'] ?? []).map(m => ({ startRow: m.s.r + 1, startColumn: m.s.c + 1, endRow: m.e.r + 1, endColumn: m.e.c + 1 })), blocks: blocks(cells), ...(delimited ? { encoding: delimited.encoding, delimiter: delimited.delimiter } : {}) };
  });
}

export function tablePreview(table: SourceTable): string {
  const rows = new Map<number, SourceCell[]>();
  for (const cell of table.cells) if (cell.display || cell.formula) { const row = rows.get(cell.row) ?? []; row.push(cell); rows.set(cell.row, row); }
  const selected = [...rows.keys()].sort((a, b) => a - b).slice(0, 200);
  return `## ${table.sheet}\n\n物理范围：${table.range}；完整源表保留 ${table.cells.length} 个单元格。以下为前 ${selected.length} 个非空行预览。\n\n` + selected.map(r => `第 ${r} 行：` + rows.get(r)!.map(c => `${XLSX.utils.encode_col(c.column - 1)}=${c.display || '(无缓存值)'}${c.formula ? ` [公式=${c.formula}]` : ''}`).join(' | ')).join('\n');
}
