/**
 * Phase 10 验证：6 步 pipeline + 一致性自检 + 产物布局
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import os from 'os'
import {
  checkConsistency,
  renderConflictsMarkdown,
  runIngestPipeline,
  runVisionTrack,
  writeArtefacts,
  type ExtractorAdapter,
  type ExtractedDocument,
  type OcrAdapter,
  type VisionLLMAdapter,
  type LearningNotesAdapter,
} from '../agent-runtime'

function makeStubDoc(over: Partial<ExtractedDocument> = {}): ExtractedDocument {
  return {
    format: 'pdf',
    fileName: 'sample.pdf',
    text: '# 样本\n\n这是一段提取出的文本。',
    tables: [
      {
        source: 'page-1',
        headers: ['月份', '收入'],
        rows: [
          ['1月', 100],
          ['2月', 200],
        ],
        rowMeta: ['data', 'data'],
      },
    ],
    images: [
      {
        id: 'img-1',
        dataUrl:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
      },
    ],
    metadata: { pageCount: 1 },
    ...over,
  }
}

describe('Phase 10 — consistency checker', () => {
  it('rowMeta 长度不一致 → 冲突', () => {
    const doc = makeStubDoc({
      images: [], // 排除 OCR 覆盖率干扰
      tables: [
        {
          source: 't',
          headers: ['a'],
          rows: [['x'], ['y']],
          rowMeta: ['data'], // 仅 1 个，但 rows 是 2
        },
      ],
    })
    const c = checkConsistency(doc, [])
    assert.equal(c.length, 1)
    assert.equal(c[0].kind, 'table-row-count')
  })

  it('OCR 覆盖率不足 → 冲突', () => {
    const doc = makeStubDoc()
    const c = checkConsistency(doc, [], { minOcrCoverage: 0.5 })
    assert.equal(c.length, 1)
    assert.equal(c[0].kind, 'ocr-coverage')
  })

  it('OCR 全覆盖 → 无冲突', () => {
    const doc = makeStubDoc()
    const c = checkConsistency(doc, [{ imageId: 'img-1', text: 't' }])
    assert.equal(c.length, 0)
  })

  it('PDF pageCount 与 perPageChars 不一致 → 冲突', () => {
    const doc = makeStubDoc({
      images: [],
      metadata: { pageCount: 5, perPageChars: [{ num: 1, chars: 100 }] },
    })
    const c = checkConsistency(doc, [])
    const pageConflict = c.find((x) => x.kind === 'page-count')
    assert.ok(pageConflict)
  })

  it('renderConflictsMarkdown：无冲突时返回简短说明', () => {
    const md = renderConflictsMarkdown([])
    assert.match(md, /未发现冲突/)
  })
})

describe('Phase 10 — vision track 双轨', () => {
  it('OCR + caption 都跑通', async () => {
    const ocr: OcrAdapter = {
      async recognize(imgs) {
        return imgs.map((i) => ({ imageId: i.id, text: `ocr:${i.id}` }))
      },
    }
    const v: VisionLLMAdapter = {
      async caption(imgs) {
        return imgs.map((i) => ({ imageId: i.id, caption: `cap:${i.id}` }))
      },
    }
    const r = await runVisionTrack([{ id: 'a', dataUrl: 'data:image/png;base64,xx' }], {
      ocr,
      visionLLM: v,
    })
    assert.equal(r.ocr[0].text, 'ocr:a')
    assert.equal(r.captions[0].caption, 'cap:a')
  })

  it('OCR 抛错时 vision track 仍能返回 captions', async () => {
    const ocr: OcrAdapter = {
      async recognize() {
        throw new Error('tesseract 挂了')
      },
    }
    const v: VisionLLMAdapter = {
      async caption(imgs) {
        return imgs.map((i) => ({ imageId: i.id, caption: 'ok' }))
      },
    }
    let errSeen = false
    const r = await runVisionTrack([{ id: 'a', dataUrl: 'data:image/png;base64,xx' }], {
      ocr,
      visionLLM: v,
      onError: (track) => {
        if (track === 'ocr') errSeen = true
      },
    })
    assert.equal(errSeen, true)
    assert.equal(r.ocr.length, 0)
    assert.equal(r.captions.length, 1)
  })
})

describe('Phase 10 — writeArtefacts 产物布局', () => {
  it('写出 原文.md + _tables + _assets + README', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-'))
    const doc = makeStubDoc()
    const written = await writeArtefacts({ topicDir: dir, doc })
    assert.ok(fs.existsSync(path.join(dir, '原文.md')))
    assert.ok(fs.existsSync(path.join(dir, '_tables', 'page-1.json')))
    assert.ok(fs.existsSync(path.join(dir, '_assets', 'img-1.png')))
    assert.ok(fs.existsSync(path.join(dir, 'README.md')))
    assert.ok(written.length >= 4)
    const tableContent = JSON.parse(fs.readFileSync(path.join(dir, '_tables', 'page-1.json'), 'utf-8'))
    assert.equal(tableContent.headers[1], '收入')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('有冲突时写 _conflicts.md', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-'))
    const doc = makeStubDoc()
    await writeArtefacts({
      topicDir: dir,
      doc,
      conflicts: [
        {
          kind: 'ocr-coverage',
          message: '覆盖率不足',
          details: { coverage: 0.1 },
        },
      ],
    })
    assert.ok(fs.existsSync(path.join(dir, '_conflicts.md')))
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('学习笔记写入 学习笔记.md', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-'))
    const doc = makeStubDoc()
    await writeArtefacts({ topicDir: dir, doc, notes: '关键点：xxx' })
    assert.ok(fs.existsSync(path.join(dir, '学习笔记.md')))
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('Phase 10 — runIngestPipeline 端到端', () => {
  it('6 步全跑通：onStep 回调 + 产物 + 冲突', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-'))
    const fakeFile = path.join(tmp, 'sample.pdf')
    fs.writeFileSync(fakeFile, 'dummy')

    const extractor: ExtractorAdapter = {
      supports: ['.pdf'],
      extract: async () => makeStubDoc(),
    }
    const ocr: OcrAdapter = {
      async recognize(imgs) {
        return imgs.map((i) => ({ imageId: i.id, text: `ocr:${i.id}` }))
      },
    }
    const ln: LearningNotesAdapter = {
      async generate() {
        return '## 学习笔记\n\n- 关键发现 A\n- 关键发现 B'
      },
    }

    const steps: string[] = []
    const r = await runIngestPipeline(
      fakeFile,
      { knowledgeRoot: tmp },
      {
        extractors: [extractor],
        ocr,
        learningNotes: ln,
        onStep: (s) => steps.push(s),
      }
    )

    assert.deepEqual(steps, ['extract', 'vision', 'consistency', 'learning-notes', 'write', 'index'])
    assert.ok(fs.existsSync(path.join(r.topicDir, '原文.md')))
    assert.ok(fs.existsSync(path.join(r.topicDir, '学习笔记.md')))
    assert.equal(r.conflicts.length, 0)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('无 extractor 处理该后缀 → 抛错', async () => {
    await assert.rejects(
      () =>
        runIngestPipeline(
          '/tmp/foo.unknown',
          { knowledgeRoot: '/tmp' },
          { extractors: [] }
        ),
      /没有可用 extractor/
    )
  })
})
