/**
 * knowledge-cards 编译器单元测试。
 *
 * 测试意图：本模块是 knowledge_navigate 工具的定位底座，分身按卡片给出的
 * `文件路径#行区间` 引用原文。因此行号必须精确、章节切分必须抗代码块干扰、
 * 上限截断必须如实上报——这些不是实现细节，错了会导致分身引用到错误段落，
 * 直接破坏溯源纪律。
 *
 * @author zhi.qu
 * @date 2026-07-20
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  buildKnowledgeCards,
  cardsIndexPath,
  loadCardsIndex,
  saveCardsIndex,
  CARDS_DIRNAME,
  type SectionCard,
} from '../knowledge-cards'

/** 建临时知识目录并写入 fixture，回调结束后清理 */
function withKnowledgeDir(files: Record<string, string>, fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-cards-'))
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(dir, ...rel.split('/'))
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, content, 'utf-8')
    }
    fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** 按标题路径取节，便于断言（顺序无关，读起来也比下标清楚） */
function findSection(sections: SectionCard[], headingPath: string[]): SectionCard {
  const found = sections.find(s => s.headingPath.join(' > ') === headingPath.join(' > '))
  assert.ok(found, `未找到章节: ${headingPath.join(' > ')}`)
  return found
}

describe('buildKnowledgeCards — 文档卡', () => {
  it('无 H1 时标题回退为文件名（去扩展名）', () => {
    // WHY：导航列表以标题为唯一可读入口。摄取管线产出的文件大量缺 H1（如纯表格导出），
    // 若标题为空，分身在文档卡列表里就看不出这是什么文件，导航第一级直接失效。
    withKnowledgeDir(
      {
        '国标/GB 12158 静电导则.md': '## 二级标题起头\n\n正文内容\n',
        '无任何标题.md': '这是一份没有任何标题的文档。\n',
      },
      dir => {
        const { index } = buildKnowledgeCards(dir)
        const byPath = new Map(index.documents.map(d => [d.path, d]))
        assert.equal(byPath.get('国标/GB 12158 静电导则.md')!.title, 'GB 12158 静电导则')
        assert.equal(byPath.get('无任何标题.md')!.title, '无任何标题')
      }
    )
  })

  it('有 H1 时用首个 H1 作标题，且 keywords 去重并封顶 20', () => {
    // WHY：keywords 是导航第一级的检索线索，无上限会让大文档卡片膨胀撑爆
    // navigate 工具的返回预算；重复词占位则挤掉真正有区分度的词。
    const headings = Array.from({ length: 30 }, (_, i) => `## 章节 关键词${i}`).join('\n\n')
    withKnowledgeDir({ 'a.md': `# 电气安规手册\n\n${headings}\n` }, dir => {
      const doc = buildKnowledgeCards(dir).index.documents[0]
      assert.equal(doc.title, '电气安规手册')
      assert.equal(doc.keywords.length, 20)
      assert.equal(new Set(doc.keywords).size, 20, 'keywords 必须已去重')
      // '章节' 在 30 个标题里重复出现，只应占一个槽位
      assert.equal(doc.keywords.filter(k => k === '章节').length, 1)
    })
  })

  it('summaryHint 跳过摄取管线的注释头与 frontmatter，取正文首段前 160 字', () => {
    // WHY：真实知识文件普遍以 `<!-- 来源相对路径 -->` + `---` 元数据块开头（见小凯知识库）。
    // 逐字取"首个段落"会把 source_path 这类元数据当摘要，导航列表全是文件系统路径噪音。
    const body = '本文档说明工商业储能柜的接地与绝缘要求。'
    const content =
      '<!-- 来源相对路径: 工商业储能/安规.md; 精读日期: 2026-06-05 -->\n' +
      '\n' +
      '---\n' +
      'source_path: /Users/kian/Downloads/安规.pptx\n' +
      'source_type: pptx\n' +
      '---\n' +
      '\n' +
      '# 安规\n' +
      '\n' +
      `${body}\n`
    withKnowledgeDir({ 'a.md': content }, dir => {
      const doc = buildKnowledgeCards(dir).index.documents[0]
      assert.equal(doc.summaryHint, body)
    })
  })

  it('summaryHint 截断到 160 字符', () => {
    const long = '电'.repeat(300)
    withKnowledgeDir({ 'a.md': `# 标题\n\n${long}\n` }, dir => {
      assert.equal(buildKnowledgeCards(dir).index.documents[0].summaryHint.length, 160)
    })
  })
})

describe('buildKnowledgeCards — 章节切分', () => {
  it('中文标题按嵌套层级生成 headingPath，行区间与原文精确对齐', () => {
    // WHY：这是整个模块的核心承诺——分身拿 startLine/endLine 去读原文。
    // 差一行就会漏掉标题行或串到下一节，引用与实际内容对不上。
    // fixture 行号（1-based）：
    //   1 引言第一行 / 2 空 / 3 # 安规 / 4 安规正文 / 5 空 /
    //   6 ## 接地要求 / 7 接地正文 / 8 空 / 9 ## 绝缘要求 / 10 绝缘正文 / 11 空 /
    //   12 # 附录 / 13 附录正文
    const content = [
      '引言第一行',
      '',
      '# 安规',
      '安规正文',
      '',
      '## 接地要求',
      '接地正文',
      '',
      '## 绝缘要求',
      '绝缘正文',
      '',
      '# 附录',
      '附录正文',
    ].join('\n') + '\n'

    withKnowledgeDir({ '安规/主文档.md': content }, dir => {
      const { index } = buildKnowledgeCards(dir)
      const sections = index.sections['安规/主文档.md']

      // 首个标题前的非空内容独立成 '(引言)' 节，否则这段正文无法被导航到
      const preface = findSection(sections, ['(引言)'])
      assert.deepEqual([preface.startLine, preface.endLine], [1, 2])

      // 父节区间覆盖其全部子节，止于下一个同级标题前一行
      const angui = findSection(sections, ['安规'])
      assert.deepEqual([angui.startLine, angui.endLine], [3, 11])

      const jiedi = findSection(sections, ['安规', '接地要求'])
      assert.deepEqual([jiedi.startLine, jiedi.endLine], [6, 8])

      const jueyuan = findSection(sections, ['安规', '绝缘要求'])
      assert.deepEqual([jueyuan.startLine, jueyuan.endLine], [9, 11])

      // 末节延伸到文件最后一行（13 行，而非 split 产生的空尾行 14）
      const fulu = findSection(sections, ['附录'])
      assert.deepEqual([fulu.startLine, fulu.endLine], [12, 13])

      // 行区间必须真能切回原文：按 startLine/endLine 取回的首行就是标题行
      const lines = content.split('\n')
      assert.equal(lines[jiedi.startLine - 1], '## 接地要求')
      assert.equal(lines.slice(jiedi.startLine - 1, jiedi.endLine).join('\n'), '## 接地要求\n接地正文\n')
      assert.equal(jiedi.charCount, '## 接地要求\n接地正文\n'.length)

      // 中文标题切词落到 keywords（导航第二级的检索线索）
      assert.deepEqual(jiedi.keywords, ['接地要求'])
      assert.equal(index.documents[0].sectionCount, sections.length)
    })
  })

  it('代码围栏内的 # 行不切节', () => {
    // WHY：技术知识库里 shell 注释、Python 注释、markdown 示例大量以 # 开头。
    // 不识别围栏会把注释切成章节，行区间随之全盘错位——这是最高频的误切来源。
    const content = [
      '# 部署手册',      // 1
      '',                 // 2
      '```bash',          // 3
      '# 这是注释不是标题', // 4
      'echo hi',          // 5
      '```',              // 6
      '',                 // 7
      '~~~python',        // 8
      '## 也是注释',       // 9
      '~~~',              // 10
      '',                 // 11
      '## 真章节',         // 12
      '正文',             // 13
    ].join('\n') + '\n'

    withKnowledgeDir({ 'a.md': content }, dir => {
      const { index } = buildKnowledgeCards(dir)
      const sections = index.sections['a.md']
      assert.equal(sections.length, 2, `只应有 2 节，实得: ${JSON.stringify(sections.map(s => s.headingPath))}`)
      assert.deepEqual([findSection(sections, ['部署手册']).startLine, findSection(sections, ['部署手册']).endLine], [1, 13])
      const real = findSection(sections, ['部署手册', '真章节'])
      assert.deepEqual([real.startLine, real.endLine], [12, 13])
    })
  })

  it('全文无标题时产出单个 (全文) 节', () => {
    // WHY：无标题文档若产出 0 节，navigate 第二级会返回空，分身以为文档是空的。
    const content = '第一行\n第二行\n第三行\n'
    withKnowledgeDir({ 'a.md': content }, dir => {
      const { index } = buildKnowledgeCards(dir)
      const sections = index.sections['a.md']
      assert.equal(sections.length, 1)
      assert.deepEqual(sections[0].headingPath, ['(全文)'])
      assert.deepEqual([sections[0].startLine, sections[0].endLine], [1, 3])
      // 章节 charCount = 区间内各行以 \n 连接后的长度，不含文件末尾换行
      //（末尾换行不属于任何一行）；文档 charCount 则是原文全长，故两者差 1。
      assert.equal(sections[0].charCount, '第一行\n第二行\n第三行'.length)
      assert.equal(buildKnowledgeCards(dir).index.documents[0].charCount, content.length)
    })
  })

  it('超 maxSectionsPerDoc 时截断并如实上报丢弃节数', () => {
    // WHY：Rule 12 fail loud。截断若静默，调用方会以为文档只有 3 节，
    // 后半篇内容永久不可导航且无人知情。丢弃数必须能被脚本打印出来。
    const heads = Array.from({ length: 10 }, (_, i) => `## 第${i + 1}节\n正文\n`).join('\n')
    withKnowledgeDir({ 'big.md': `# 大文档\n\n${heads}` }, dir => {
      const r = buildKnowledgeCards(dir, null, { maxSectionsPerDoc: 3 })
      assert.equal(r.index.sections['big.md'].length, 3)
      assert.equal(r.index.documents[0].sectionCount, 3, 'sectionCount 应反映实际保留数')
      assert.deepEqual(r.droppedSections, [{ docPath: 'big.md', dropped: 8 }])
    })
  })

  it('未超上限时 droppedSections 为空', () => {
    withKnowledgeDir({ 'a.md': '# 标题\n正文\n' }, dir => {
      assert.deepEqual(buildKnowledgeCards(dir).droppedSections, [])
    })
  })
})

describe('buildKnowledgeCards — 扫描范围', () => {
  it('排除索引产物目录、点开头与 .backup 名字，只收 .md', () => {
    // WHY：_cards 是本模块自己的产物，扫进去会索引自噬（每次构建都比上次更大）；
    // knowledge.backup-* 是摄取前的历史副本，收进来会让分身引用到过期知识。
    withKnowledgeDir(
      {
        'ok.md': '# 正常\n',
        '子目录/ok2.md': '# 正常2\n',
        '_cards/index.json': '{}',
        '_cards/leak.md': '# 不该被收\n',
        '_wiki/w.md': '# 不该被收\n',
        '_index/i.md': '# 不该被收\n',
        '_excel/e.md': '# 不该被收\n',
        'node_modules/n.md': '# 不该被收\n',
        '.hidden/h.md': '# 不该被收\n',
        '.hidden.md': '# 不该被收\n',
        'knowledge.backup-20260610/b.md': '# 不该被收\n',
        'old.backup.md': '# 不该被收\n',
        'readme.txt': '不是 markdown',
      },
      dir => {
        const r = buildKnowledgeCards(dir)
        assert.deepEqual(r.index.documents.map(d => d.path).sort(), ['ok.md', '子目录/ok2.md'])
        assert.equal(r.scannedFiles, 2)
      }
    )
  })

  it('路径用 posix 分隔符（跨平台与工具层引用格式一致）', () => {
    withKnowledgeDir({ 'a/b/c.md': '# x\n' }, dir => {
      assert.equal(buildKnowledgeCards(dir).index.documents[0].path, 'a/b/c.md')
    })
  })

  it('builtAtMs 取自注入的 now（可测且构建时间可复现）', () => {
    withKnowledgeDir({ 'a.md': '# x\n' }, dir => {
      assert.equal(buildKnowledgeCards(dir, null, { now: () => 12345 }).index.builtAtMs, 12345)
    })
  })
})

describe('buildKnowledgeCards — 增量构建', () => {
  it('mtime 与 charCount 均未变则整卡复用', () => {
    // WHY：小凯 ~2000 文件全量解析成本高，增量是这套索引在大库可用的前提。
    // 复用必须连章节卡一起复用，否则 sections 会丢失。
    withKnowledgeDir({ 'a.md': '# A\n正文\n', 'b.md': '# B\n正文\n' }, dir => {
      const first = buildKnowledgeCards(dir)
      const second = buildKnowledgeCards(dir, first.index)
      assert.equal(second.scannedFiles, 2)
      assert.equal(second.skippedUnchanged, 2)
      assert.deepEqual(second.index.documents, first.index.documents)
      assert.deepEqual(second.index.sections, first.index.sections)
    })
  })

  it('内容变化的文件重新解析，其余仍复用', () => {
    withKnowledgeDir({ 'a.md': '# A\n正文\n', 'b.md': '# B\n正文\n' }, dir => {
      const first = buildKnowledgeCards(dir)
      fs.writeFileSync(path.join(dir, 'a.md'), '# A 改过\n新正文\n## 新增节\nx\n', 'utf-8')
      const second = buildKnowledgeCards(dir, first.index)
      assert.equal(second.skippedUnchanged, 1, '只有 b.md 该被复用')
      const a = second.index.documents.find(d => d.path === 'a.md')!
      assert.equal(a.title, 'A 改过')
      assert.equal(second.index.sections['a.md'].length, 2)
    })
  })

  it('内容长度相同但 mtime 变化时也重新解析', () => {
    // WHY：单靠 charCount 判据会漏掉"等长改写"（如改一个参数值 380V→400V），
    // 分身会一直读到旧章节结构。mtime 是第二道判据，必须真的参与判断。
    withKnowledgeDir({ 'a.md': '# 电压 380V\n正文\n' }, dir => {
      const first = buildKnowledgeCards(dir)
      const abs = path.join(dir, 'a.md')
      fs.writeFileSync(abs, '# 电压 400V\n正文\n', 'utf-8')
      const t = new Date(Date.now() + 60_000)
      fs.utimesSync(abs, t, t)
      const second = buildKnowledgeCards(dir, first.index)
      assert.equal(second.skippedUnchanged, 0)
      assert.equal(second.index.documents[0].title, '电压 400V')
    })
  })

  it('新增文件被解析，删除文件从索引消失', () => {
    withKnowledgeDir({ 'a.md': '# A\n' }, dir => {
      const first = buildKnowledgeCards(dir)
      fs.writeFileSync(path.join(dir, 'c.md'), '# C\n', 'utf-8')
      fs.rmSync(path.join(dir, 'a.md'))
      const second = buildKnowledgeCards(dir, first.index)
      assert.deepEqual(second.index.documents.map(d => d.path), ['c.md'])
      assert.equal(second.skippedUnchanged, 0)
      assert.ok(!('a.md' in second.index.sections), '删除的文档不该残留章节卡')
    })
  })

  it('prev 为 null / undefined 时全量构建', () => {
    withKnowledgeDir({ 'a.md': '# A\n' }, dir => {
      assert.equal(buildKnowledgeCards(dir, null).skippedUnchanged, 0)
      assert.equal(buildKnowledgeCards(dir).skippedUnchanged, 0)
    })
  })
})

describe('索引持久化', () => {
  it('cardsIndexPath 指向 <knowledge>/_cards/index.json', () => {
    assert.equal(cardsIndexPath('/k'), path.join('/k', CARDS_DIRNAME, 'index.json'))
  })

  it('save 建目录并原子写，load 完整读回', () => {
    withKnowledgeDir({ 'a.md': '# A\n正文\n' }, dir => {
      const { index } = buildKnowledgeCards(dir, null, { now: () => 999 })
      saveCardsIndex(dir, index)
      assert.ok(fs.existsSync(cardsIndexPath(dir)), '_cards 目录应被自动创建')
      assert.deepEqual(loadCardsIndex(dir), index)
      // 原子写不留 tmp 残留文件
      const leftovers = fs.readdirSync(path.join(dir, CARDS_DIRNAME)).filter(n => n.endsWith('.tmp'))
      assert.deepEqual(leftovers, [])
    })
  })

  it('索引缺失时 loadCardsIndex 返回 null 而不抛错', () => {
    withKnowledgeDir({ 'a.md': '# A\n' }, dir => {
      assert.equal(loadCardsIndex(dir), null)
    })
  })

  it('索引损坏 / 版本不符 / 结构不符时返回 null 而不抛错', () => {
    // WHY：索引是可再生的缓存，不是数据源。坏索引若抛错会把调用方（应用启动、
    // navigate 工具）一起拖垮；正确行为是当作没有索引，走全量重建。
    withKnowledgeDir({ 'a.md': '# A\n' }, dir => {
      const p = cardsIndexPath(dir)
      fs.mkdirSync(path.dirname(p), { recursive: true })

      fs.writeFileSync(p, '{ 这不是 合法 json', 'utf-8')
      assert.equal(loadCardsIndex(dir), null, '截断/乱码 JSON')

      fs.writeFileSync(p, JSON.stringify({ version: 2, builtAtMs: 1, documents: [], sections: {} }), 'utf-8')
      assert.equal(loadCardsIndex(dir), null, '未来版本索引不可复用')

      fs.writeFileSync(p, JSON.stringify({ version: 1, builtAtMs: 1, documents: {}, sections: {} }), 'utf-8')
      assert.equal(loadCardsIndex(dir), null, 'documents 非数组')

      fs.writeFileSync(p, JSON.stringify({ version: 1, builtAtMs: 1, documents: [], sections: [] }), 'utf-8')
      assert.equal(loadCardsIndex(dir), null, 'sections 非对象')

      fs.writeFileSync(p, 'null', 'utf-8')
      assert.equal(loadCardsIndex(dir), null, 'JSON null')
    })
  })

  it('save 后 _cards 不被下一轮扫描收录（防索引自噬）', () => {
    // WHY：产物目录写在 knowledge/ 内部，若不排除，每次构建都会把上次索引
    // 当成知识文件收进来——库越滚越大且全是噪音。
    withKnowledgeDir({ 'a.md': '# A\n' }, dir => {
      saveCardsIndex(dir, buildKnowledgeCards(dir).index)
      const again = buildKnowledgeCards(dir)
      assert.equal(again.scannedFiles, 1)
      assert.deepEqual(again.index.documents.map(d => d.path), ['a.md'])
    })
  })
})

describe('buildKnowledgeCards — 异常输入', () => {
  it('知识目录不存在时抛出明确错误（fail loud，不静默返回空索引）', () => {
    // WHY：路径打错时静默返回 0 文档，调用方会以为"知识库是空的"，
    // 而不是"路径写错了"——这类静默失败在批量脚本里极难发现。
    const missing = path.join(os.tmpdir(), 'soul-cards-not-exist-' + Date.now())
    assert.throws(() => buildKnowledgeCards(missing), /知识目录不存在/)
  })

  it('传入文件而非目录时抛错', () => {
    withKnowledgeDir({ 'a.md': '# A\n' }, dir => {
      assert.throws(() => buildKnowledgeCards(path.join(dir, 'a.md')), /不是目录/)
    })
  })

  it('空知识目录产出空索引且不抛错', () => {
    withKnowledgeDir({}, dir => {
      const r = buildKnowledgeCards(dir)
      assert.equal(r.scannedFiles, 0)
      assert.deepEqual(r.index.documents, [])
      assert.deepEqual(r.index.sections, {})
    })
  })

  it('CRLF 文件行号与 LF 一致', () => {
    // WHY：Windows 侧编辑或某些导出管线产出 CRLF，行号若受 \r 影响会整体错位。
    const content = '# 标题\r\n正文\r\n\r\n## 子节\r\n子正文\r\n'
    withKnowledgeDir({ 'a.md': content }, dir => {
      const sections = buildKnowledgeCards(dir).index.sections['a.md']
      assert.equal(sections.length, 2)
      const sub = findSection(sections, ['标题', '子节'])
      assert.deepEqual([sub.startLine, sub.endLine], [4, 5])
    })
  })
})
