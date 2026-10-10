import { knowledgeLimits } from '../../shared/knowledge';

// Legacy rows are normalized exports, not original Excel coordinates. Never
// manufacture cell addresses, formulas, omitted rows or lost numeric precision.
export function readLegacyExport(bytes: Buffer): { fileName: string; sheets: Array<{ name: string; text: string }> } {
  if (bytes.length > knowledgeLimits.bodyBytes) throw new Error('旧版表格导出超过兼容读取上限');
  const value = JSON.parse(bytes.toString('utf8')) as any;
  if (!value || typeof value.fileName !== 'string' || value.fileName.length > 1800 || !/\.(xlsx|xls|csv|tsv)$/i.test(value.fileName) || !Array.isArray(value.sheets) || !value.sheets.length || value.sheets.length > knowledgeLimits.sheets) throw new Error('不是受支持的 Soul 旧版 _excel 导出');
  let cells = 0;
  const sheets = value.sheets.map((sheet: any) => {
    if (!sheet || typeof sheet.name !== 'string' || sheet.name.length > 200 || !Array.isArray(sheet.columns) || sheet.columns.length > knowledgeLimits.columns || !Array.isArray(sheet.rows) || sheet.rows.length > knowledgeLimits.rows || sheet.rowCount !== sheet.rows.length) throw new Error('旧版导出的工作表结构不完整');
    const columns = sheet.columns.map((column: any) => column?.name);
    if (columns.some((column: any) => typeof column !== 'string' || !column || column.length > 2000) || new Set(columns).size !== columns.length) throw new Error('旧版导出的列名无效或重复');
    const rows = sheet.rows.map((row: any, index: number) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('旧版导出的数据行无效');
      const values = Object.entries(row);
      if ((cells += values.length) > knowledgeLimits.cells || values.some(([key, item]) => !columns.includes(key) || !(item === null || typeof item === 'string' || typeof item === 'number' && Number.isFinite(item)))) throw new Error('旧版导出的单元格无效或超限');
      return `导出行 ${index + 1}：` + values.map(([key, item]) => `${JSON.stringify(key)}=${JSON.stringify(item)}`).join(' | ');
    });
    return { name: sheet.name, text: `## ${sheet.name}\n旧版导出列：${columns.map((column: string) => JSON.stringify(column)).join(' | ')}\n${rows.join('\n')}` };
  });
  return { fileName: value.fileName, sheets };
}
