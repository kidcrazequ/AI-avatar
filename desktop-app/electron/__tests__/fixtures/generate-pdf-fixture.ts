/**
 * 单测用：手工拼接最小 PDF 1.4 二进制（无第三方依赖）。
 *
 * 用途：
 *   - 验证 DocumentParser.parsePdf 在多页 PDF 上会注入 `### 第 N 页` 三级标题
 *   - 验证单页 PDF 不注入（保持现有行为）
 *
 * 设计要点：
 *   - 不依赖 pdfkit / pdf-lib（desktop-app 未安装），完全用 Node fs/Buffer 拼接
 *   - 标准 14 字体 Helvetica（pdfjs 内置，无需嵌入字体文件）
 *   - 简单 BT/ET + Tj 文本流，pdfjs-dist 能正确解析每页文字
 *   - xref 表的字节偏移在写入时实时计算，避免手工算偏移出错
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

/**
 * 转义 PDF 字符串字面量内的特殊字符（() 与 \）。
 * PDF 字符串语法：(text)，括号或反斜杠须 \( \) \\ 转义。
 */
function escapePdfString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

/**
 * 生成最小可解析的多页 PDF。
 *
 * 对象布局（约定）：
 *   1: /Catalog
 *   2: /Pages
 *   3, 5, 7, ...: 第 i 页 /Page 对象（i 从 0 起）
 *   4, 6, 8, ...: 第 i 页 /Page 对应的 Contents stream
 *   最后一个对象：/Font Helvetica
 *
 * @param pages 每页要显示的纯 ASCII 文本（避免 PDF 字符串编码复杂度）
 * @returns 可写入 .pdf 文件的 Buffer
 */
export function buildMinimalPdf(pages: string[]): Buffer {
  if (pages.length === 0) {
    throw new Error('buildMinimalPdf: pages 不能为空')
  }

  const numPages = pages.length
  const fontObjId = 3 + numPages * 2
  const totalObjs = fontObjId + 1

  const objectBodies: Record<number, string> = {}

  objectBodies[1] = `<< /Type /Catalog /Pages 2 0 R >>`

  const pageObjIds: number[] = []
  for (let i = 0; i < numPages; i++) {
    pageObjIds.push(3 + i * 2)
  }
  const kidsRef = pageObjIds.map(id => `${id} 0 R`).join(' ')
  objectBodies[2] = `<< /Type /Pages /Kids [${kidsRef}] /Count ${numPages} >>`

  for (let i = 0; i < numPages; i++) {
    const pageId = 3 + i * 2
    const contentId = 4 + i * 2
    objectBodies[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Contents ${contentId} 0 R ` +
      `/Resources << /Font << /F1 ${fontObjId} 0 R >> >> >>`
    const stream = `BT /F1 12 Tf 50 700 Td (${escapePdfString(pages[i])}) Tj ET`
    objectBodies[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  }

  objectBodies[fontObjId] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`

  // 序列化（'binary' 编码以保证 Buffer.byteLength 与最终字节数一致）
  let body = `%PDF-1.4\n`
  // 二进制标记注释：4 个高位字节告诉工具这是二进制 PDF（PDF 1.4 推荐做法）
  body += `%\u00C4\u00E5\u00F2\u00E5\u00EB\u00A7\u00F3\u00A0\u00D0\u00C4\u00C6\n`

  const offsets: number[] = new Array(totalObjs).fill(0)
  for (let i = 1; i <= fontObjId; i++) {
    offsets[i] = Buffer.byteLength(body, 'binary')
    body += `${i} 0 obj\n${objectBodies[i]}\nendobj\n`
  }

  const xrefStart = Buffer.byteLength(body, 'binary')
  body += `xref\n0 ${totalObjs}\n`
  // 第 0 项是固定的 free entry
  body += `0000000000 65535 f \n`
  for (let i = 1; i <= fontObjId; i++) {
    body += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  body += `trailer\n<< /Size ${totalObjs} /Root 1 0 R >>\n`
  body += `startxref\n${xrefStart}\n`
  body += `%%EOF\n`

  return Buffer.from(body, 'binary')
}
