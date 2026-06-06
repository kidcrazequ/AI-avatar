/**
 * Excel/CSV 解析的纯逻辑核心（无 Electron / DocumentParser / this 依赖）。
 *
 * 从 document-parser.ts 的 parseExcel 方法簇逐字抽出，改为模块级函数，
 * 以便在 worker_threads 里运行（见 #16：大 xlsx 同步解析会冻结主进程，
 * worker 化后可用 worker.terminate() 让 PARSE_TIMEOUT_MS 真正生效）。
 *
 * 本模块只依赖 xlsx（纯 JS）与 excel-types；不读写任何全局状态，
 * 可被主线程直接调用，也可被 worker 入口调用。
 */
import type { ParsedDocument } from '../document-parser'
import type { ExcelColumnSchema, ExcelRowMetaRole, ExcelSheetData } from './excel-types'

/** 单 sheet 最大行数（超出截断，避免超大表撑爆内存 / markdown） */
const EXCEL_MAX_ROWS_PER_SHEET = 5000

/**
 * 解析 Excel/CSV 文件为 Markdown + 结构化数据。每个 sheet 变成一个
 * `## {sheetName}` section，下面跟一个 GFM 表格；同时提取列 schema
 * 和全量行对象数组，写入 structuredData 字段供 query_excel 工具使用。
 *
 * 无需额外依赖：xlsx（SheetJS 社区版）为纯 JS，同时支持 .xlsx 和 .csv。
 *
 * 注意：XLSX.readFile + sheet_to_json 是同步 CPU 密集操作，调用方应放在
 * worker 线程里跑，避免锁死主进程事件循环。
 */
export function parseExcelCore(filePath: string, fileName: string): ParsedDocument {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const XLSX = require('xlsx')
  const workbook = XLSX.readFile(filePath, { cellDates: true, cellNF: false })
  const sheetNames: string[] = workbook.SheetNames || []
  if (sheetNames.length === 0) {
    throw new Error(`Excel/CSV 文件不含任何 sheet: ${fileName}`)
  }

  const sections: string[] = []
  const sheetDataList: ExcelSheetData[] = []
  let totalRows = 0
  let truncated = false

  for (const name of sheetNames) {
    const sheet = workbook.Sheets[name]
    if (!sheet) continue
    const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: '',
      blankrows: false,
      raw: false,
    })
    if (rows.length === 0) {
      sections.push(`## ${name}\n\n_（空 sheet）_\n`)
      sheetDataList.push({ name, rowCount: 0, columns: [], rows: [] })
      continue
    }

    const originalRowCount = rows.length
    let workingRows = rows
    if (rows.length > EXCEL_MAX_ROWS_PER_SHEET) {
      workingRows = rows.slice(0, EXCEL_MAX_ROWS_PER_SHEET)
      truncated = true
    }
    totalRows += workingRows.length

    // Markdown 表格（可视化用）
    const markdownTable = rowsToMarkdownTable(workingRows)
    const suffix = originalRowCount > workingRows.length
      ? `\n\n> ⚠️ 已截断至 ${workingRows.length} 行（原 ${originalRowCount} 行）\n`
      : ''
    sections.push(`## ${name}\n\n${markdownTable}${suffix}`)

    // 结构化数据（query_excel 工具用）
    sheetDataList.push(buildSheetData(name, workingRows))
  }

  const header =
    `> 导入自 Excel: ${fileName} | ${sheetNames.length} sheet${sheetNames.length > 1 ? 's' : ''} | ${totalRows} row${totalRows !== 1 ? 's' : ''}` +
    (truncated ? ' | 部分 sheet 已截断' : '') +
    '\n\n---\n'

  return {
    text: header + '\n' + sections.join('\n\n'),
    images: [],
    fileName,
    fileType: 'excel',
    sheetNames,
    structuredData: {
      fileName,
      importedAt: new Date().toISOString(),
      sheets: sheetDataList,
    },
  }
}

/**
 * 推断单行的元数据角色（不依赖业务字典，只看数据形状）。
 * 输入要求：row 是已经过 buildSheetData 转好的对象行；columns 是该 sheet 的 schema。
 * 注意：此函数对单行独立判定，不做"汇总值=明细行加和"这类需要全表上下文的高阶判定。
 */
export function inferRowMetaRole(
  row: Record<string, string | number | null>,
  columns: ExcelColumnSchema[],
): ExcelRowMetaRole {
  if (columns.length === 0) return 'data'
  const labelColName = columns[0].name
  const labelRaw = row[labelColName]
  const labelStr = labelRaw === null || labelRaw === undefined ? '' : String(labelRaw).trim()

  // 注意：中文字符不构成 \b 词边界，必须分中/英文两套正则
  if (/^(总计|合计|总和|累计)/.test(labelStr)) return 'total'
  if (/^(Total|Grand[\s-]?Total)$/i.test(labelStr)) return 'total'
  if (/^小计/.test(labelStr)) return 'subtotal'
  if (/^Sub[\s-]?total$/i.test(labelStr)) return 'subtotal'

  // subtitle 启发：col1 有值，但其他列绝大多数（≥80%）为 null
  // 典型场景：Excel 合并单元格 / 多张子表合并到一个 sheet 时的小节标题行
  const otherCols = columns.slice(1)
  if (labelStr !== '' && otherCols.length > 0) {
    let nullCount = 0
    for (const c of otherCols) {
      const v = row[c.name]
      if (v === null || v === undefined || v === '') nullCount++
    }
    if (nullCount / otherCols.length >= 0.8) return 'subtitle'
  }

  return 'data'
}

/**
 * 智能表头检测 + 列名去重，返回统一的中间结构供 buildSheetData 和 rowsToMarkdownTable 共用。
 *
 * 算法：
 *   1. 扫描前 10 行，对每一行打分：非空字符串单元格越多分越高，纯数字/None 行扣分
 *   2. "封面行跳过"启发式：前 3 行内若首 cell 有值但其余 ≥80% 为空 → 视为封面/标题行，不参与打分
 *   3. 选最高分的行作为表头；若并列，取靠上的
 *   4. "两行表头合并"：若最佳行仍有 ≥30% 空 cell，检查其下一行能否补全 → 合并两行
 *   5. 表头行之前的所有行都跳过（合并标题、空行等）
 *   6. 单元格中的 \n（多行 merged 表头）替换为空格
 *   7. 完全没有合适行就 fallback 到 col1..colN（表单型 Excel）
 *   8. 同名列自动加 _2, _3 后缀避免 key 冲突
 */
function prepareTable(rows: unknown[][]): {
  headers: string[]
  headerRowIndex: number
  bodyRows: unknown[][]
  maxCols: number
} {
  const maxCols = rows.reduce((acc, row) => Math.max(acc, row.length), 0)
  if (maxCols === 0) {
    return { headers: [], headerRowIndex: -1, bodyRows: rows, maxCols: 0 }
  }

  // 扫描深度从 5 → 10，覆盖封面行在前几行的 Excel 文件
  const SCAN_DEPTH = Math.min(10, rows.length)

  // 标记封面/标题行：前 3 行内，首 cell 有值但其余 ≥80% 为空
  const coverRowSet = new Set<number>()
  const COVER_CHECK_DEPTH = Math.min(3, rows.length)
  for (let i = 0; i < COVER_CHECK_DEPTH; i++) {
    const row = rows[i]
    if (maxCols <= 1) break
    const first = row[0]
    const hasFirst = first !== null && first !== undefined
      && !(typeof first === 'string' && first.trim() === '')
    if (!hasFirst) continue
    let emptyRest = 0
    for (let j = 1; j < maxCols; j++) {
      const cell = j < row.length ? row[j] : undefined
      if (cell === null || cell === undefined || (typeof cell === 'string' && cell.trim() === '')) {
        emptyRest++
      }
    }
    if (emptyRest / (maxCols - 1) >= 0.8) {
      coverRowSet.add(i)
    }
  }

  let bestHeaderIdx = -1
  let bestScore = -1
  for (let i = 0; i < SCAN_DEPTH; i++) {
    // 跳过封面/标题行
    if (coverRowSet.has(i)) continue

    const row = rows[i]
    let stringCells = 0
    let numericCells = 0
    let emptyCells = 0
    for (let j = 0; j < maxCols; j++) {
      const cell = j < row.length ? row[j] : undefined
      if (cell === null || cell === undefined || (typeof cell === 'string' && cell.trim() === '')) {
        emptyCells++
      } else if (typeof cell === 'number') {
        numericCells++
      } else if (typeof cell === 'string') {
        stringCells++
      }
    }
    const score = stringCells * 2 - numericCells - emptyCells * 0.3
    const fillRate = (stringCells + numericCells) / maxCols
    if (fillRate >= 0.5 && stringCells > numericCells && score > bestScore) {
      bestScore = score
      bestHeaderIdx = i
    }
  }

  let headers: string[]
  let bodyRows: unknown[][]
  /** 两行表头合并时，body 从合并的下一行开始 */
  let mergedSecondRow = false
  if (bestHeaderIdx >= 0) {
    const headerRow = rows[bestHeaderIdx]
    headers = Array.from({ length: maxCols }, (_, j) => {
      const cell = j < headerRow.length ? headerRow[j] : undefined
      if (cell === null || cell === undefined) return ''
      const s = String(cell).trim().replace(/\r?\n/g, ' ').replace(/\s+/g, ' ')
      return s
    })

    // 两行表头合并：若最佳行仍有 ≥30% 空 cell，检查下一行能否补全
    const emptyCellCount = headers.filter(h => h === '').length
    const nextIdx = bestHeaderIdx + 1
    if (emptyCellCount / maxCols >= 0.3 && nextIdx < rows.length) {
      const nextRow = rows[nextIdx]
      let canMerge = false
      let fillCount = 0
      for (let j = 0; j < maxCols; j++) {
        if (headers[j] !== '') continue
        const nextCell = j < nextRow.length ? nextRow[j] : undefined
        if (nextCell !== null && nextCell !== undefined
          && typeof nextCell === 'string' && nextCell.trim() !== '') {
          fillCount++
        }
      }
      // 下一行至少能补全一半的空 cell 才合并
      if (emptyCellCount > 0 && fillCount >= emptyCellCount * 0.5) {
        canMerge = true
      }
      if (canMerge) {
        for (let j = 0; j < maxCols; j++) {
          if (headers[j] !== '') continue
          const nextCell = j < nextRow.length ? nextRow[j] : undefined
          if (nextCell !== null && nextCell !== undefined) {
            const s = String(nextCell).trim().replace(/\r?\n/g, ' ').replace(/\s+/g, ' ')
            if (s) headers[j] = s
          }
        }
        mergedSecondRow = true
      }
    }

    // 仍为空的列位 fallback 到 colN
    headers = headers.map((h, j) => h || `col${j + 1}`)
    bodyRows = rows.slice(mergedSecondRow ? bestHeaderIdx + 2 : bestHeaderIdx + 1)
  } else {
    // 表单型 Excel（类型 B）：无合适表头行，fallback 到 col1..colN
    headers = Array.from({ length: maxCols }, (_, i) => `col${i + 1}`)
    bodyRows = rows
  }
  while (headers.length < maxCols) headers.push(`col${headers.length + 1}`)

  const seen = new Map<string, number>()
  headers = headers.map(h => {
    const count = seen.get(h) || 0
    seen.set(h, count + 1)
    return count === 0 ? h : `${h}_${count + 1}`
  })

  return { headers, headerRowIndex: bestHeaderIdx, bodyRows, maxCols }
}

/**
 * 把 sheet 的二维数组行转成 ExcelSheetData（对象数组 + 列 schema）。
 * 表头检测委托给 prepareTable()，保证与 markdown 输出用同一套逻辑。
 */
function buildSheetData(name: string, rows: unknown[][]): ExcelSheetData {
  if (rows.length === 0) {
    return { name, rowCount: 0, columns: [], rows: [] }
  }
  const { headers, bodyRows, maxCols } = prepareTable(rows)
  if (maxCols === 0) {
    return { name, rowCount: 0, columns: [], rows: [] }
  }

  // 转对象数组
  const objRows: Array<Record<string, string | number | null>> = bodyRows.map(row => {
    const obj: Record<string, string | number | null> = {}
    for (let i = 0; i < maxCols; i++) {
      const raw = row[i]
      obj[headers[i]] = normalizeCell(raw)
    }
    return obj
  })

  // 推断列 schema
  const columns: ExcelColumnSchema[] = headers.map(h => inferColumnSchema(h, objRows))

  // ★ 推断每行的元数据角色（data / subtitle / subtotal / total）
  // 用于 generator / query_excel 等工具区分"可精确 filter 的数据行"与"表格元数据行"。
  const rowMetaRoles: ExcelRowMetaRole[] = objRows.map(r => inferRowMetaRole(r, columns))

  return {
    name,
    rowCount: objRows.length,
    columns,
    rows: objRows,
    rowMetaRoles,
  }
}

/** 规范化单元格值：null/undefined → null；Date → ISO；尝试 parseFloat */
function normalizeCell(v: unknown): string | number | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) {
    // YYYY-MM-DD（日期型列更便于范围比较）
    const y = v.getFullYear()
    const m = String(v.getMonth() + 1).padStart(2, '0')
    const d = String(v.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean') return v ? 1 : 0
  const s = String(v).trim()
  if (s === '') return null
  // 尝试解析数字（保留整数/小数）
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = parseFloat(s)
    if (Number.isFinite(n)) return n
  }
  return s
}

/** 推断单列的 schema：dtype、唯一值、samples、min/max */
function inferColumnSchema(
  name: string,
  rows: Array<Record<string, string | number | null>>,
): ExcelColumnSchema {
  const values: Array<string | number> = []
  const seen = new Set<string>()
  for (const row of rows) {
    const v = row[name]
    if (v === null || v === undefined) continue
    values.push(v)
    seen.add(String(v))
  }

  // 判断 dtype
  let numericCount = 0
  let dateLikeCount = 0
  for (const v of values) {
    if (typeof v === 'number') numericCount++
    else if (typeof v === 'string' && /^\d{4}[-/]\d{1,2}([-/]\d{1,2})?$/.test(v)) dateLikeCount++
  }
  const total = values.length || 1
  let dtype: ExcelColumnSchema['dtype'] = 'string'
  if (numericCount / total >= 0.9) dtype = 'number'
  else if (dateLikeCount / total >= 0.9) dtype = 'date-like'

  // samples：最多 8 个唯一值
  const samples = Array.from(seen).slice(0, 8).map(s => {
    if (dtype === 'number') {
      const n = parseFloat(s)
      return Number.isFinite(n) ? n : s
    }
    return s
  })

  // min/max（仅对 number / date-like）
  let min: string | number | undefined
  let max: string | number | undefined
  if (dtype === 'number') {
    const nums = values.filter((v): v is number => typeof v === 'number')
    if (nums.length > 0) {
      min = Math.min(...nums)
      max = Math.max(...nums)
    }
  } else if (dtype === 'date-like') {
    const strs = values.filter((v): v is string => typeof v === 'string').sort()
    if (strs.length > 0) {
      min = strs[0]
      max = strs[strs.length - 1]
    }
  }

  return {
    name,
    dtype,
    uniqueCount: seen.size,
    samples,
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
  }
}

/**
 * 检测某行是否为"分节标题 / 合计行"，用于 ffill 的重置边界。
 * 简化版 inferRowMetaRole，直接作用于原始 unknown[] 行（无需列 schema）。
 */
function isMergeResetBoundary(row: unknown[], maxCols: number): boolean {
  if (maxCols <= 1) return false
  const first = row[0]
  if (first === null || first === undefined || (typeof first === 'string' && first.trim() === '')) {
    return false
  }
  const firstStr = String(first).trim()
  if (/^(总计|合计|总和|累计|小计)/.test(firstStr) || /^(Total|Grand[\s-]?Total|Sub[\s-]?total)$/i.test(firstStr)) {
    return true
  }
  let emptyCount = 0
  for (let j = 1; j < maxCols; j++) {
    const cell = j < row.length ? row[j] : undefined
    if (cell === null || cell === undefined || (typeof cell === 'string' && cell.trim() === '')) {
      emptyCount++
    }
  }
  return emptyCount / (maxCols - 1) >= 0.8
}

/**
 * 对前 N 列做前向填充（forward fill），恢复 Excel 合并单元格的语义。
 *
 * 算法：
 *   1. 扫描前 MAX_FFILL_COLS（3）列，找出"合并候选列"
 *   2. 候选判定：列的空单元格占比 ≥ 10%（说明存在合并）且至少 2 个非空值
 *   3. 遇到"全填充列"（空率 < 10%）则中断序列——该列及其后的列不再 ffill
 *   4. 逐行前向填充：空 cell 复制上方最近非空值
 *   5. 分节标题 / 合计行作为重置边界，避免跨分组填充
 *
 * 只用于 markdown 输出，不影响 _excel/*.json 结构化数据。
 */
function ffillLeadingColumns(bodyRows: unknown[][], maxCols: number): unknown[][] {
  if (bodyRows.length <= 1 || maxCols === 0) return bodyRows

  const MAX_FFILL_COLS = Math.min(3, maxCols)
  const ffillCols: number[] = []

  for (let col = 0; col < MAX_FFILL_COLS; col++) {
    let emptyCount = 0
    let nonEmptyCount = 0
    for (const row of bodyRows) {
      const cell = col < row.length ? row[col] : undefined
      if (cell === null || cell === undefined || (typeof cell === 'string' && cell.trim() === '')) {
        emptyCount++
      } else {
        nonEmptyCount++
      }
    }
    const emptyRate = emptyCount / bodyRows.length

    if (emptyRate < 0.1) break

    if (nonEmptyCount >= 2) {
      ffillCols.push(col)
    }
  }

  if (ffillCols.length === 0) return bodyRows

  const result = bodyRows.map(row => [...row])
  const lastValues: unknown[] = new Array(ffillCols.length).fill(null)

  for (let i = 0; i < result.length; i++) {
    const row = result[i]

    if (isMergeResetBoundary(row, maxCols)) {
      lastValues.fill(null)
      continue
    }

    for (let ci = 0; ci < ffillCols.length; ci++) {
      const col = ffillCols[ci]
      const cell = col < row.length ? row[col] : undefined
      if (cell === null || cell === undefined || (typeof cell === 'string' && cell.trim() === '')) {
        if (lastValues[ci] !== null) {
          row[col] = lastValues[ci]
        }
      } else {
        lastValues[ci] = cell
      }
    }
  }

  return result
}

/**
 * 将二维数组转为 GFM markdown 表格。
 * 表头检测委托给 prepareTable()，与 buildSheetData 共用同一套智能检测算法。
 * 前向填充委托给 ffillLeadingColumns()，恢复合并单元格语义。
 */
function rowsToMarkdownTable(rows: unknown[][]): string {
  if (rows.length === 0) return '_（空）_'

  const escapeCell = (v: unknown): string => {
    if (v === null || v === undefined) return ''
    const s = String(v)
    return s
      .replace(/\\/g, '\\\\')
      .replace(/\|/g, '\\|')
      .replace(/\r?\n/g, '；')
      .trim()
  }

  const { headers, bodyRows, maxCols } = prepareTable(rows)
  if (maxCols === 0) return '_（无列）_'

  const filledRows = ffillLeadingColumns(bodyRows, maxCols)

  const headerEscaped = headers.map(h => escapeCell(h))
  const headerLine = '| ' + headerEscaped.join(' | ') + ' |'
  const separatorLine = '| ' + headerEscaped.map(() => '---').join(' | ') + ' |'
  const bodyLines = filledRows.map(row => {
    const padded = [...row]
    while (padded.length < maxCols) padded.push('')
    return '| ' + padded.map(c => escapeCell(c)).join(' | ') + ' |'
  })

  return [headerLine, separatorLine, ...bodyLines].join('\n')
}
