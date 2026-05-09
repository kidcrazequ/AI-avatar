/**
 * 单测用：用已安装的 docx@9.x 库生成带中英文标题层级的最小 .docx 二进制。
 *
 * 用途：验证 DocumentParser.parseWord 走 mammoth.convertToHtml + Turndown 主路径时
 *       能保留 Word 标题层级（H1/H2/H3 → `# / ## / ###` ATX markdown）。
 *
 * 设计要点：
 *   - docx 库默认产出英文样式 ID（Heading1/2/3），与 mammoth 默认 styleMap 兼容
 *   - parseWord 中显式声明的 styleMap 同时覆盖中文 `标题 1` 与英文 `Heading 1`
 *   - 不在 fixture 文件里写入图片，保持 < 10KB 体积
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx'

/**
 * 构造一个带 H1/H2/H3 标题层级 + 正文段落的最小 docx。
 *
 * 内容结构（与单测断言对齐）：
 *   # 设计文档      (H1)
 *   ## 概述         (H2)
 *      本文档介绍 Soul 系统。
 *   ## 架构         (H2)
 *   ### 前端        (H3)
 *      Electron + React。
 *   ### 后端        (H3)
 *      Node.js 主进程。
 */
export async function buildHeadingsDocx(): Promise<Buffer> {
  const doc = new Document({
    creator: 'soul-test',
    title: '设计文档',
    sections: [
      {
        children: [
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun({ text: '设计文档' })],
          }),
          new Paragraph({
            heading: HeadingLevel.HEADING_2,
            children: [new TextRun({ text: '概述' })],
          }),
          new Paragraph({
            children: [new TextRun({ text: '本文档介绍 Soul 系统。' })],
          }),
          new Paragraph({
            heading: HeadingLevel.HEADING_2,
            children: [new TextRun({ text: '架构' })],
          }),
          new Paragraph({
            heading: HeadingLevel.HEADING_3,
            children: [new TextRun({ text: '前端' })],
          }),
          new Paragraph({
            children: [new TextRun({ text: 'Electron + React。' })],
          }),
          new Paragraph({
            heading: HeadingLevel.HEADING_3,
            children: [new TextRun({ text: '后端' })],
          }),
          new Paragraph({
            children: [new TextRun({ text: 'Node.js 主进程。' })],
          }),
        ],
      },
    ],
  })
  return await Packer.toBuffer(doc)
}
