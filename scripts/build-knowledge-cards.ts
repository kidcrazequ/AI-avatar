#!/usr/bin/env node
/**
 * scripts/build-knowledge-cards.ts
 *
 * 知识库概念卡离线编译（W4.4）。把 knowledge/**.md 编译成 _cards/index.json，
 * 供 knowledge_navigate 工具做"先定位、再钻取"导航。
 *
 * 用法：
 *   npx tsx scripts/build-knowledge-cards.ts <path>
 *
 * <path> 可以是分身目录（自动拼 knowledge/）或 knowledge 目录本身。
 *
 * 增量：自动读取已有 _cards/index.json，mtime + charCount 均未变的文档整卡复用，
 * 大库（小凯 ~2000 文件）重复运行只解析改动过的文件——这就是"断点续跑"，
 * 中途 Ctrl-C 后重跑不会从零开始（已落盘的上一版索引仍可复用）。
 *
 * 退出码：0 成功；1 路径 / 参数问题；3 其他错误
 *
 * @author zhi.qu
 * @date 2026-07-20
 */

import fs from 'fs'
import path from 'path'
import {
  buildKnowledgeCards,
  cardsIndexPath,
  loadCardsIndex,
  saveCardsIndex,
} from '../packages/core/src/knowledge-cards'

/**
 * 解析知识目录：优先当分身目录处理（拼 knowledge/），否则把入参本身当知识目录。
 * 两种写法都常用——批量脚本按分身遍历，手工调试直接指知识目录。
 */
function resolveKnowledgeDir(input: string): string {
  const abs = path.resolve(input)
  if (!fs.existsSync(abs)) {
    console.error(`[cards] 路径不存在: ${abs}`)
    process.exit(1)
  }
  if (!fs.statSync(abs).isDirectory()) {
    console.error(`[cards] 不是目录: ${abs}`)
    process.exit(1)
  }
  const nested = path.join(abs, 'knowledge')
  if (fs.existsSync(nested) && fs.statSync(nested).isDirectory()) return nested
  return abs
}

function main(): void {
  const input = process.argv[2]
  if (!input) {
    console.error('用法: npx tsx scripts/build-knowledge-cards.ts <分身目录 或 knowledge 目录>')
    process.exit(1)
  }

  const knowledgeDir = resolveKnowledgeDir(input)
  console.log(`[cards] 知识目录: ${knowledgeDir}`)

  const started = Date.now()
  const prev = loadCardsIndex(knowledgeDir)
  console.log(prev
    ? `[cards] 已有索引: ${prev.documents.length} 文档（增量构建）`
    : '[cards] 无可用索引（全量构建）')

  const result = buildKnowledgeCards(knowledgeDir, prev)
  saveCardsIndex(knowledgeDir, result.index)
  const elapsedMs = Date.now() - started

  const totalSections = Object.values(result.index.sections).reduce((n, s) => n + s.length, 0)
  console.log('─'.repeat(56))
  console.log(`[cards] scannedFiles       : ${result.scannedFiles}`)
  console.log(`[cards] skippedUnchanged   : ${result.skippedUnchanged}`)
  console.log(`[cards] documents          : ${result.index.documents.length}`)
  console.log(`[cards] sections (总计)    : ${totalSections}`)

  // 截断明细必须逐条打印：静默丢弃会让文档后半篇永久不可导航（Rule 12 fail loud）
  if (result.droppedSections.length === 0) {
    console.log('[cards] droppedSections    : 无')
  } else {
    const totalDropped = result.droppedSections.reduce((n, d) => n + d.dropped, 0)
    console.log(`[cards] droppedSections    : ${result.droppedSections.length} 个文档超上限，共丢弃 ${totalDropped} 节`)
    for (const d of result.droppedSections) {
      console.log(`  - ${d.docPath}  丢弃 ${d.dropped} 节`)
    }
  }

  console.log(`[cards] 耗时               : ${elapsedMs} ms`)
  console.log(`[cards] 索引文件           : ${cardsIndexPath(knowledgeDir)}`)
}

try {
  main()
} catch (err) {
  console.error(`[cards] 构建失败: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(3)
}
