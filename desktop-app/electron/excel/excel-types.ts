/**
 * Excel 解析相关的纯类型定义。
 *
 * 从 document-parser.ts 抽出，供 excel-parse-core（主线程 / worker 共用）与
 * document-parser 共享。document-parser 仍 re-export 这些类型以保持对外 API 不变。
 */

/** Excel 列 schema */
export interface ExcelColumnSchema {
  name: string
  /** 列的数据类型：纯数字 / 日期样 / 其他（字符串） */
  dtype: 'number' | 'date-like' | 'string'
  /** 该列唯一值数量 */
  uniqueCount: number
  /** 首 N 个唯一样本值（供 LLM 理解列含义） */
  samples: Array<string | number>
  /** 数值/日期列的最小值（字符串以便 JSON 序列化日期） */
  min?: string | number
  /** 数值/日期列的最大值 */
  max?: string | number
}

/**
 * 行元数据角色（与业务无关的纯数据角色识别）：
 *   - 'data'     : 真实数据行（默认）
 *   - 'subtitle' : 子表/小节标题行（col1 有值但同行其他列大多为 null，典型为合并单元格小标题）
 *   - 'subtotal' : 小计行（label 含"小计/Subtotal"）
 *   - 'total'    : 总计行（label 含"总计/合计/总和/Total"）
 *
 * 用途：query_excel 类工具/出题器可借此区分"可被精确按行 filter 的数据行"与"表格元数据行"。
 * 不会序列化到 row 对象内（避免污染 LLM 看到的 cell 数据），而是与 rows 一一对应放在并行数组里。
 */
export type ExcelRowMetaRole = 'data' | 'subtitle' | 'subtotal' | 'total'

/** Excel sheet 结构 */
export interface ExcelSheetData {
  name: string
  rowCount: number
  columns: ExcelColumnSchema[]
  /** 全量行（对象数组，key = 列名） */
  rows: Array<Record<string, string | number | null>>
  /**
   * 与 rows 一一对应的行角色数组（i 位置对应 rows[i] 的角色）。
   * 旧版本 _excel JSON 可能缺失此字段，使用方应做好 optional 处理。
   */
  rowMetaRoles?: ExcelRowMetaRole[]
}

/** Excel 导入后产出的结构化数据（写入 knowledge/_excel/<basename>.json） */
export interface ExcelStructuredData {
  fileName: string
  /** 导入时间戳 ISO8601 */
  importedAt: string
  sheets: ExcelSheetData[]
}
