/**
 * deep-reader.ts 单元测试
 *
 * 覆盖（测试意图 = 精读管线的业务红线）：
 *   - splitBookIntoChapters：markdown h1/h2 优先切分、PDF 页码标记不算章节标题、
 *     页码区间锚点正确（来源溯源红线依赖它）、小章节合并、超长章节二切
 *   - estimateDeepRead：预算矩阵生效（study/technical 比 reference/text 贵）、
 *     调用数 = 章节数 + 4 个综合件
 *   - chapterFileName：宽度/清洗稳定（断点续跑按文件名探测产物，格式漂移 = 续跑失效）
 *   - runDeepRead：产物齐全 + frontmatter 溯源字段；全部章节失败必须抛错拒绝写
 *     综合件（"拒答 > 占位骨架"红线）；shouldSkip 续跑不重复调 LLM；abort 中断
 *
 * 运行方式：
 *   cd packages/core && npm run build
 *   node --test dist/tests/deep-reader.test.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  chapterFileName,
  estimateDeepRead,
  runDeepRead,
  splitBookIntoChapters,
  DEEP_READ_SYNTHESIS_FILES,
  type BookChapter,
  type DeepReadProduct,
} from '../deep-reader'

/** 生成指定长度的中文填充段落 */
function filler(chars: number): string {
  return '储能系统的安全设计需要从电芯本征安全出发逐层构建。'.repeat(Math.ceil(chars / 25)).slice(0, chars)
}

describe('splitBookIntoChapters', () => {
  it('markdown h1/h2 优先切分，### 第 N 页 是页码标记不是章节', () => {
    const text = [
      '# 第一章 绪论',
      '### 第 1 页',
      filler(2500),
      '## 第二章 方法',
      '### 第 12 页',
      filler(2500),
      '### 第 15 页',
      filler(2500),
    ].join('\n\n')
    const chapters = splitBookIntoChapters(text)
    assert.equal(chapters.length, 2)
    assert.equal(chapters[0].title, '第一章 绪论')
    assert.equal(chapters[1].title, '第二章 方法')
  })

  it('页码区间锚点：章节起止页来自 PDF 页码标记（来源溯源依赖）', () => {
    const text = [
      '# 第一章',
      '### 第 1 页',
      filler(2500),
      '### 第 9 页',
      filler(2500),
      '# 第二章',
      filler(2500),
      '### 第 23 页',
      filler(2500),
    ].join('\n\n')
    const chapters = splitBookIntoChapters(text)
    assert.equal(chapters[0].pageStart, 1)
    assert.equal(chapters[0].pageEnd, 9)
    // 第二章起点没有新页码标记 → 沿用上一章末页，终点取章内最后一个标记
    assert.equal(chapters[1].pageStart, 9)
    assert.equal(chapters[1].pageEnd, 23)
  })

  it('无页码标记时 pageStart/pageEnd 不存在（非 PDF 不编造页码）', () => {
    const text = `# 第一章\n\n${filler(2500)}\n\n# 第二章\n\n${filler(2500)}`
    const chapters = splitBookIntoChapters(text)
    for (const ch of chapters) {
      assert.equal(ch.pageStart, undefined)
      assert.equal(ch.pageEnd, undefined)
    }
  })

  it('过小章节并入前一章；超长章节按段落二切并标注（第N部分）', () => {
    const longBody = Array.from({ length: 20 }, () => filler(2000)).join('\n\n') // 40K chars
    const text = [
      '# 大章',
      longBody,
      '# 小章',
      '只有一句话。', // < 2000 chars → 并入前一章
    ].join('\n\n')
    const chapters = splitBookIntoChapters(text)
    assert.ok(chapters.length >= 2, '超长章节应二切')
    assert.ok(chapters.every(ch => ch.content.length <= 28_000), '每章不超过单次蒸馏输入上限')
    assert.ok(chapters[0].title.includes('第1部分'))
    assert.ok(!chapters.some(ch => ch.title === '小章'), '过小章节不应独立成章')
  })

  it('纯文本中文章节模式回退（无 markdown 标题的 PDF 提取文本）', () => {
    const text = [
      '第一章 总则',
      '',
      filler(2500),
      '',
      '第二章 设计要求',
      '',
      filler(2500),
    ].join('\n')
    const chapters = splitBookIntoChapters(text)
    assert.equal(chapters.length, 2)
    assert.ok(chapters[0].title.startsWith('第一章'))
  })
})

describe('estimateDeepRead', () => {
  const chapters: BookChapter[] = [
    { title: 'A', content: filler(10_000), index: 0 },
    { title: 'B', content: filler(10_000), index: 1 },
  ]

  it('调用数 = 章节数 + 4 个综合件', () => {
    assert.equal(estimateDeepRead(chapters, 'study', 'text').llmCalls, 6)
  })

  it('预算矩阵生效：technical/study 的产出预估高于 text/reference', () => {
    const high = estimateDeepRead(chapters, 'study', 'technical')
    const low = estimateDeepRead(chapters, 'reference', 'text')
    assert.ok(high.outputTokens > low.outputTokens)
  })
})

describe('chapterFileName', () => {
  it('两位补零 + 标题清洗稳定（断点续跑按此探测产物，格式不可漂移）', () => {
    const ch: BookChapter = { title: '第3章 数据模型（上）', content: '', index: 2 }
    assert.equal(chapterFileName(ch, 12), '03-第3章_数据模型_上.md')
  })

  it('超过 99 章用三位编号', () => {
    const ch: BookChapter = { title: 'X', content: '', index: 0 }
    assert.ok(chapterFileName(ch, 120).startsWith('001-'))
  })
})

describe('runDeepRead', () => {
  const makeChapters = (n: number): BookChapter[] =>
    Array.from({ length: n }, (_, i) => ({
      title: `第${i + 1}章`,
      content: filler(3000),
      index: i,
      pageStart: i * 10 + 1,
      pageEnd: i * 10 + 9,
    }))

  const collectProducts = () => {
    const products: DeepReadProduct[] = []
    return {
      products,
      onProduct: async (p: DeepReadProduct) => {
        products.push(p)
      },
    }
  }

  it('正常路径：章节笔记 + 术语表/模式/速查 + 索引齐全，frontmatter 带溯源字段', async () => {
    const { products, onProduct } = collectProducts()
    const result = await runDeepRead(makeChapters(2), {
      bookTitle: '测试之书',
      outputDir: '精读/测试之书',
      rawFileRelPath: '_raw/测试之书.pdf',
      depth: 'study',
      contentType: 'text',
      callLLM: async () => '## 核心思想\n这是蒸馏结果。\n\n## 要点\n1. 要点一',
      onProduct,
    })

    assert.equal(result.failedChapters.length, 0)
    const kinds = products.map(p => p.kind).sort()
    assert.deepEqual(kinds, ['chapter', 'chapter', 'cheatsheet', 'glossary', 'index', 'patterns'])

    const chapterFile = products.find(p => p.kind === 'chapter')!
    assert.ok(chapterFile.content.includes('source_type: deep-read'), '必须标注二手来源类型')
    assert.ok(chapterFile.content.includes('raw_file: _raw/测试之书.pdf'), '必须带原书锚点')
    assert.ok(chapterFile.content.includes('pages: 1-9'), '必须带页码区间')

    const indexFile = products.find(p => p.kind === 'index')!
    assert.ok(indexFile.relativePath.endsWith('00-索引.md'))
    assert.ok(indexFile.content.includes('| 1 |'), '索引必须含章节表')
  })

  it('全部章节蒸馏失败 → 抛错拒绝写综合件（拒答 > 占位骨架）', async () => {
    const { products, onProduct } = collectProducts()
    await assert.rejects(
      runDeepRead(makeChapters(2), {
        bookTitle: '坏书',
        outputDir: '精读/坏书',
        depth: 'reference',
        contentType: 'text',
        callLLM: async () => {
          throw new Error('LLM 永远失败')
        },
        onProduct,
      }),
      /全部 2 个章节蒸馏失败/,
    )
    assert.equal(products.length, 0, '失败时不得写入任何占位产物')
  })

  it('单章失败不中断：失败章节进 failedChapters，索引如实标注', async () => {
    const { products, onProduct } = collectProducts()
    let call = 0
    const result = await runDeepRead(makeChapters(2), {
      bookTitle: '半好书',
      outputDir: '精读/半好书',
      depth: 'reference',
      contentType: 'text',
      callLLM: async (_sys, user) => {
        // 第1章的两次尝试（含重试）都失败；其余调用成功
        if (user.includes('第1章')) {
          call++
          throw new Error('第一章超时')
        }
        return '## 核心思想\nok\n\n## 要点\n1. ok'
      },
      onProduct,
    })
    assert.equal(result.failedChapters.filter(f => f.title === '第1章').length, 1)
    assert.ok(call >= 2, '失败章节应重试')
    const indexFile = products.find(p => p.kind === 'index')!
    assert.ok(indexFile.content.includes('蒸馏失败'), '索引必须如实标注失败章节')
    assert.ok(!products.some(p => p.kind === 'chapter' && p.relativePath.includes('01-')), '失败章节不得写占位笔记')
  })

  it('shouldSkip 续跑：已存在章节不再调 LLM，仍参与综合件', async () => {
    const llmInputs: string[] = []
    const { onProduct } = collectProducts()
    const chapters = makeChapters(2)
    const skipPath = `精读/续跑书/${chapterFileName(chapters[0], 2)}`
    const result = await runDeepRead(chapters, {
      bookTitle: '续跑书',
      outputDir: '精读/续跑书',
      depth: 'reference',
      contentType: 'text',
      callLLM: async (_sys, user) => {
        llmInputs.push(user)
        return '## 核心思想\nok\n\n## 要点\n1. ok'
      },
      onProduct,
      shouldSkip: rel => rel === skipPath,
      priorChapterNotes: [{ relativePath: skipPath, content: '## 核心思想\n旧笔记核心\n\n## 要点\n1. 旧要点' }],
    })
    assert.equal(result.skippedChapters, 1)
    assert.ok(!llmInputs.some(u => u.includes('--- 章节原文开始 ---') && u.includes('第1章')), '跳过章节不得重新蒸馏')
    assert.ok(llmInputs.some(u => u.includes('旧笔记核心')), '旧笔记必须参与综合件摘要')
  })

  it('纯续跑（零新增章节 + 综合件已存在）：不重付综合 LLM 调用，索引不得谎报"生成失败"', async () => {
    const { products, onProduct } = collectProducts()
    const chapters = makeChapters(2)
    const dir = '精读/全完书'
    const existing = new Set([
      ...chapters.map(ch => `${dir}/${chapterFileName(ch, 2)}`),
      ...DEEP_READ_SYNTHESIS_FILES.map(f => `${dir}/${f}`),
    ])
    let llmCalls = 0
    const result = await runDeepRead(chapters, {
      bookTitle: '全完书',
      outputDir: dir,
      depth: 'reference',
      contentType: 'text',
      callLLM: async () => {
        llmCalls++
        return '## 核心框架\nok\n\n## 主题索引\n- **X** → 第1章'
      },
      onProduct,
      shouldSkip: rel => existing.has(rel),
      priorChapterNotes: chapters.map(ch => ({
        relativePath: `${dir}/${chapterFileName(ch, 2)}`,
        content: '## 核心思想\n旧\n\n## 要点\n1. 旧',
      })),
    })
    assert.equal(llmCalls, 1, '只允许索引核心框架这 1 次调用，3 个综合件必须沿用磁盘已有文件')
    assert.equal(result.skippedChapters, 2)
    const indexFile = products.find(p => p.kind === 'index')!
    assert.ok(!indexFile.content.includes('生成失败'), '磁盘上存在的综合件不得被标成生成失败')
    assert.ok(indexFile.content.includes('[术语表](术语表.md)'), '沿用的综合件仍要以链接形式列出')
    assert.ok(indexFile.content.includes('续跑沿用'), '索引必须如实标注续跑章节')
  })

  it('onProduct 写盘失败 → 中止全部 worker 止损，且抛出的是写盘错误而非 AbortError', async () => {
    let llmCalls = 0
    await assert.rejects(
      runDeepRead(makeChapters(6), {
        bookTitle: '写盘失败书',
        outputDir: '精读/写盘失败书',
        depth: 'reference',
        contentType: 'text',
        callLLM: async () => {
          llmCalls++
          return '## 核心思想\nok\n\n## 要点\n1. ok'
        },
        onProduct: async () => {
          throw new Error('磁盘满了')
        },
      }),
      /磁盘满了/,
    )
    // 并发 3：首个写盘失败后兄弟 worker 应被 abort，不再为剩余章节烧 LLM
    assert.ok(llmCalls <= 3, `写盘失败后不得继续烧钱（实际调用 ${llmCalls} 次）`)
  })

  it('超长书：综合件 digest 总量有上限，不随章节数无界增长', async () => {
    const synthesisPrompts: string[] = []
    const many = Array.from({ length: 300 }, (_, i) => ({
      title: `第${i + 1}章`, content: filler(2500), index: i,
    }))
    const { onProduct } = collectProducts()
    await runDeepRead(many, {
      bookTitle: '巨书',
      outputDir: '精读/巨书',
      depth: 'reference',
      contentType: 'text',
      callLLM: async (_sys, user) => {
        if (user.includes('各章笔记摘录')) synthesisPrompts.push(user)
        return '## 核心思想\nok\n\n## 要点\n1. ok'
      },
      onProduct,
    })
    assert.ok(synthesisPrompts.length >= 4)
    for (const p of synthesisPrompts) {
      assert.ok(p.length < 120_000, `综合调用输入必须有界（实际 ${p.length} 字符）`)
    }
  })

  it('abort 信号中断在飞任务', async () => {
    const ac = new AbortController()
    const { onProduct } = collectProducts()
    const job = runDeepRead(makeChapters(3), {
      bookTitle: '中断书',
      outputDir: '精读/中断书',
      depth: 'reference',
      contentType: 'text',
      callLLM: () => new Promise<string>(() => { /* 永不 resolve，模拟在飞请求 */ }),
      abortSignal: ac.signal,
      onProduct,
    })
    setTimeout(() => ac.abort(), 50)
    await assert.rejects(job, (err: Error) => err.name === 'AbortError')
  })
})
