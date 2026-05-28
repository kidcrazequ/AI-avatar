/**
 * tool-router generate_document 工具集成测试
 *
 * 覆盖 generate_document 工具的端到端路径：
 *   1. ✅ md 格式正常生成（无 documentRenderers 注入）+ 落盘内容回读校验
 *   2. ✅ pdf 格式正常生成（注入 mock renderPdf，验证 HTML 正确传入）
 *   3. ✅ docx 格式正常生成（注入 mock renderDocx）
 *   4. ❌ format 非法返回 error
 *   5. ❌ ir 为空字符串返回 error
 *   6. ❌ ir 长度超 MAX_IR_LENGTH 返回 error 且不落盘
 *   7. ❌ filename 含路径分隔符被 assertSafeSegment 拦截
 *   8. ❌ templateName 含 .. 路径穿越被拦截
 *   9. ❌ pdf 但未注入 documentRenderers 返回 error
 *  10. ❌ 同名文件存在且未传 overwrite=true 返回 error
 *  11. ✅ overwrite=true 允许覆盖
 *  12. ❌ IR 校验失败（缺 frontmatter title）返回 error 且不落盘
 *  13. ❌ 渲染器抛错时半成品文件被清理
 *  14. ❌ 输出文件 > 20MB 被自动 unlink + error
 *  15. ✅ cite 块的 sources 字段被回收到 payload
 *  16. ✅ 与 export_excel 的 _usage 文案一致（决策 B3）
 *
 * 设计原则：
 *   - 不依赖真实 Electron API：pdf/docx 渲染走 mock hook，只校验调用契约 + 写盘行为
 *   - 每个测试独立沙盒（os.tmpdir + crypto.randomUUID），互不干扰
 *
 * 运行方式：
 *   cd packages/core && npm run build
 *   node --test dist/tests/tool-router.generate-document.test.js
 *
 * @author zhi.qu
 * @date 2026-05-08
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { ToolRouter, type DocumentRendererHook } from '../tool-router'

// ---------------------------------------------------------------------------
// 沙盒辅助：每个测试独立的临时 avatars/ 根
// ---------------------------------------------------------------------------

interface Sandbox {
  avatarsPath: string
  avatarId: string
  conversationId: string
  workspaceRoot: string
  exportsDir: string
  cleanup: () => void
}

function setupSandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `soul-gen-doc-${crypto.randomUUID()}-`))
  const avatarsPath = path.join(root, 'avatars')
  const avatarId = 'gen-doc-test-avatar'
  const conversationId = `conv-${crypto.randomUUID()}`
  const workspaceRoot = path.join(avatarsPath, avatarId, 'workspaces', conversationId)
  fs.mkdirSync(workspaceRoot, { recursive: true })
  const exportsDir = path.join(workspaceRoot, 'exports')

  return {
    avatarsPath,
    avatarId,
    conversationId,
    workspaceRoot,
    exportsDir,
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true })
      } catch (e) {
        console.warn(`[gen-doc-test] 清理沙盒失败: ${root}: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  }
}

/** 构造一个最小可用 IR markdown 字符串（含 frontmatter title + 1 个段落） */
function minimalIR(title = '测试文档'): string {
  return `---\ntitle: ${title}\n---\n\n# ${title}\n\n这是一个简单的段落。\n`
}

/** 构造一个带 cite 块的 IR */
function irWithCite(): string {
  return `---\ntitle: 引用测试\n---\n# 标题\n\n:::cite source="knowledge/a.md" page=12\n引文 1\n:::\n\n:::cite source="knowledge/b.md"\n引文 2\n:::\n`
}

/** 构造一个 mock pdf 渲染器：写入指定字节的占位文件，返回 size */
function mockPdfRenderer(byteContent = 'PDF_MOCK'): {
  hook: DocumentRendererHook
  capturedHtml: string[]
  capturedPath: string[]
} {
  const capturedHtml: string[] = []
  const capturedPath: string[] = []
  return {
    hook: {
      renderPdf: async (html, outputPath) => {
        capturedHtml.push(html)
        capturedPath.push(outputPath)
        fs.writeFileSync(outputPath, byteContent, 'utf-8')
        return { size: fs.statSync(outputPath).size }
      },
      renderDocx: async () => { throw new Error('docx not used in this test') },
    },
    capturedHtml,
    capturedPath,
  }
}

/** 构造一个 mock docx 渲染器 */
function mockDocxRenderer(byteContent = 'DOCX_MOCK_BIN'): {
  hook: DocumentRendererHook
  capturedIRs: unknown[]
  capturedPath: string[]
} {
  const capturedIRs: unknown[] = []
  const capturedPath: string[] = []
  return {
    hook: {
      renderPdf: async () => { throw new Error('pdf not used in this test') },
      renderDocx: async (ir, outputPath) => {
        capturedIRs.push(ir)
        capturedPath.push(outputPath)
        fs.writeFileSync(outputPath, byteContent, 'utf-8')
        return { size: fs.statSync(outputPath).size }
      },
    },
    capturedIRs,
    capturedPath,
  }
}

// ---------------------------------------------------------------------------
// case 1：md 格式正常生成
// ---------------------------------------------------------------------------

test('case 1: md 格式正常生成 + 落盘内容包含原始标题', async () => {
  const sandbox = setupSandbox()
  try {
    const router = new ToolRouter(sandbox.avatarsPath)
    const result = await router.execute(
      sandbox.avatarId,
      {
        name: 'generate_document',
        arguments: { format: 'md', ir: minimalIR('我的标题'), filename: 'test1' },
      },
      undefined,
      sandbox.conversationId,
    )

    assert.equal(result.error, undefined, `不应返回 error，实际: ${result.error}`)
    const payload = JSON.parse(result.content) as Record<string, unknown>
    assert.equal(payload.success, true)
    assert.equal(payload.format, 'md')
    assert.equal(payload.file_path, 'exports/test1.md')
    assert.equal(payload.template_name, 'default')
    assert.ok(typeof payload.file_size_bytes === 'number' && (payload.file_size_bytes as number) > 0)
    assert.ok(typeof payload.block_count === 'number' && (payload.block_count as number) >= 2)

    const absolutePath = path.join(sandbox.exportsDir, 'test1.md')
    assert.ok(fs.existsSync(absolutePath), '落盘文件应存在')
    const content = fs.readFileSync(absolutePath, 'utf-8')
    assert.match(content, /title: 我的标题/)
    assert.match(content, /# 我的标题/)
  } finally {
    sandbox.cleanup()
  }
})

// ---------------------------------------------------------------------------
// case 2：pdf 格式（mock 渲染器）
// ---------------------------------------------------------------------------

test('case 2: pdf 格式调用 documentRenderers.renderPdf 并写入文件', async () => {
  const sandbox = setupSandbox()
  try {
    const mock = mockPdfRenderer('FAKE_PDF_CONTENT')
    const router = new ToolRouter(sandbox.avatarsPath, { documentRenderers: mock.hook })

    const result = await router.execute(
      sandbox.avatarId,
      {
        name: 'generate_document',
        arguments: { format: 'pdf', ir: minimalIR('PDF 测试'), filename: 'test2' },
      },
      undefined,
      sandbox.conversationId,
    )

    assert.equal(result.error, undefined)
    const payload = JSON.parse(result.content) as Record<string, unknown>
    assert.equal(payload.format, 'pdf')
    assert.equal(payload.file_path, 'exports/test2.pdf')

    assert.equal(mock.capturedHtml.length, 1, 'renderPdf 必须被调用一次')
    assert.match(mock.capturedHtml[0], /<!DOCTYPE html>/, '传入 HTML 必为完整文档')
    assert.match(mock.capturedHtml[0], /<title>PDF 测试<\/title>/)
    assert.equal(mock.capturedPath[0], path.join(sandbox.exportsDir, 'test2.pdf'))

    assert.ok(fs.existsSync(path.join(sandbox.exportsDir, 'test2.pdf')))
  } finally {
    sandbox.cleanup()
  }
})

// ---------------------------------------------------------------------------
// case 3：docx 格式（mock 渲染器）
// ---------------------------------------------------------------------------

test('case 3: docx 格式调用 documentRenderers.renderDocx 接收 ir 对象', async () => {
  const sandbox = setupSandbox()
  try {
    const mock = mockDocxRenderer('FAKE_DOCX_BIN')
    const router = new ToolRouter(sandbox.avatarsPath, { documentRenderers: mock.hook })

    const result = await router.execute(
      sandbox.avatarId,
      {
        name: 'generate_document',
        arguments: { format: 'docx', ir: minimalIR('Word 文档'), filename: 'test3' },
      },
      undefined,
      sandbox.conversationId,
    )

    assert.equal(result.error, undefined)
    const payload = JSON.parse(result.content) as Record<string, unknown>
    assert.equal(payload.format, 'docx')
    assert.equal(payload.file_path, 'exports/test3.docx')

    assert.equal(mock.capturedIRs.length, 1)
    const capturedIR = mock.capturedIRs[0] as { metadata: { title: string }; blocks: unknown[] }
    assert.equal(capturedIR.metadata.title, 'Word 文档')
    assert.ok(Array.isArray(capturedIR.blocks))
  } finally {
    sandbox.cleanup()
  }
})

// ---------------------------------------------------------------------------
// case 4：format 非法
// ---------------------------------------------------------------------------

test('case 4: format 非法应返回 error', async () => {
  const sandbox = setupSandbox()
  try {
    const router = new ToolRouter(sandbox.avatarsPath)
    const result = await router.execute(
      sandbox.avatarId,
      { name: 'generate_document', arguments: { format: 'epub', ir: minimalIR(), filename: 'x' } },
      undefined,
      sandbox.conversationId,
    )
    assert.ok(result.error)
    assert.match(result.error!, /format 必须为/)
  } finally {
    sandbox.cleanup()
  }
})

// ---------------------------------------------------------------------------
// case 5：ir 为空字符串
// ---------------------------------------------------------------------------

test('case 5: ir 为空字符串应返回 error', async () => {
  const sandbox = setupSandbox()
  try {
    const router = new ToolRouter(sandbox.avatarsPath)
    const result = await router.execute(
      sandbox.avatarId,
      { name: 'generate_document', arguments: { format: 'md', ir: '   ', filename: 'x' } },
      undefined,
      sandbox.conversationId,
    )
    assert.ok(result.error)
    assert.match(result.error!, /ir 必须为非空字符串/)
  } finally {
    sandbox.cleanup()
  }
})

// ---------------------------------------------------------------------------
// case 6：ir 长度超限
// ---------------------------------------------------------------------------

test('case 6: ir 长度超 200K 应返回 error 且不落盘', async () => {
  const sandbox = setupSandbox()
  try {
    const router = new ToolRouter(sandbox.avatarsPath)
    const huge = '---\ntitle: t\n---\n' + 'a'.repeat(200_001)
    const result = await router.execute(
      sandbox.avatarId,
      { name: 'generate_document', arguments: { format: 'md', ir: huge, filename: 'huge' } },
      undefined,
      sandbox.conversationId,
    )
    assert.ok(result.error)
    assert.match(result.error!, /ir 长度.*超过上限/)
    assert.ok(!fs.existsSync(path.join(sandbox.exportsDir, 'huge.md')))
  } finally {
    sandbox.cleanup()
  }
})

// ---------------------------------------------------------------------------
// case 7：filename 含路径分隔符
// ---------------------------------------------------------------------------

test('case 7: filename 含路径分隔符应被 assertSafeSegment 拦截', async () => {
  const sandbox = setupSandbox()
  try {
    const router = new ToolRouter(sandbox.avatarsPath)
    const result = await router.execute(
      sandbox.avatarId,
      { name: 'generate_document', arguments: { format: 'md', ir: minimalIR(), filename: '../../etc/passwd' } },
      undefined,
      sandbox.conversationId,
    )
    assert.ok(result.error)
    assert.match(result.error!, /非法filename|路径分隔符/)
  } finally {
    sandbox.cleanup()
  }
})

// ---------------------------------------------------------------------------
// case 8：templateName 含路径穿越
// ---------------------------------------------------------------------------

test('case 8: templateName 含 .. 应被 assertSafeSegment 拦截', async () => {
  const sandbox = setupSandbox()
  try {
    const router = new ToolRouter(sandbox.avatarsPath)
    const result = await router.execute(
      sandbox.avatarId,
      {
        name: 'generate_document',
        arguments: { format: 'md', ir: minimalIR(), filename: 'x', templateName: '../etc' },
      },
      undefined,
      sandbox.conversationId,
    )
    assert.ok(result.error, `应返回 error，但收到 content: ${result.content}`)
    assert.match(result.error!, /非法|路径|穿越|文档模板/)
  } finally {
    sandbox.cleanup()
  }
})

// ---------------------------------------------------------------------------
// case 9：pdf 但未注入 documentRenderers
// ---------------------------------------------------------------------------

test('case 9: pdf 格式但未注入 documentRenderers 应返回 error', async () => {
  const sandbox = setupSandbox()
  try {
    const router = new ToolRouter(sandbox.avatarsPath)
    const result = await router.execute(
      sandbox.avatarId,
      { name: 'generate_document', arguments: { format: 'pdf', ir: minimalIR(), filename: 'x' } },
      undefined,
      sandbox.conversationId,
    )
    assert.ok(result.error)
    assert.match(result.error!, /主进程渲染器|documentRenderers/)
  } finally {
    sandbox.cleanup()
  }
})

// ---------------------------------------------------------------------------
// case 10：同名文件存在且未传 overwrite
// ---------------------------------------------------------------------------

test('case 10: 同名文件存在且未传 overwrite 应返回 error', async () => {
  const sandbox = setupSandbox()
  try {
    const router = new ToolRouter(sandbox.avatarsPath)
    fs.mkdirSync(sandbox.exportsDir, { recursive: true })
    fs.writeFileSync(path.join(sandbox.exportsDir, 'dup.md'), '已存在', 'utf-8')

    const result = await router.execute(
      sandbox.avatarId,
      { name: 'generate_document', arguments: { format: 'md', ir: minimalIR(), filename: 'dup' } },
      undefined,
      sandbox.conversationId,
    )
    assert.ok(result.error)
    assert.match(result.error!, /已存在/)
    // 原文件不被覆盖
    assert.equal(fs.readFileSync(path.join(sandbox.exportsDir, 'dup.md'), 'utf-8'), '已存在')
  } finally {
    sandbox.cleanup()
  }
})

// ---------------------------------------------------------------------------
// case 11：overwrite=true 允许覆盖
// ---------------------------------------------------------------------------

test('case 11: overwrite=true 应允许覆盖', async () => {
  const sandbox = setupSandbox()
  try {
    const router = new ToolRouter(sandbox.avatarsPath)
    fs.mkdirSync(sandbox.exportsDir, { recursive: true })
    fs.writeFileSync(path.join(sandbox.exportsDir, 'dup.md'), '旧内容', 'utf-8')

    const result = await router.execute(
      sandbox.avatarId,
      {
        name: 'generate_document',
        arguments: { format: 'md', ir: minimalIR('新标题'), filename: 'dup', overwrite: true },
      },
      undefined,
      sandbox.conversationId,
    )
    assert.equal(result.error, undefined)
    const content = fs.readFileSync(path.join(sandbox.exportsDir, 'dup.md'), 'utf-8')
    assert.match(content, /title: 新标题/)
  } finally {
    sandbox.cleanup()
  }
})

// ---------------------------------------------------------------------------
// case 12：IR 校验失败（缺 frontmatter title）
// ---------------------------------------------------------------------------

test('case 12: IR 校验失败（缺 title）应返回 error 且不落盘', async () => {
  const sandbox = setupSandbox()
  try {
    const router = new ToolRouter(sandbox.avatarsPath)
    const irWithoutTitle = '---\nauthor: zhi\n---\n\n# 仅有内容没标题\n'
    const result = await router.execute(
      sandbox.avatarId,
      { name: 'generate_document', arguments: { format: 'md', ir: irWithoutTitle, filename: 'no-title' } },
      undefined,
      sandbox.conversationId,
    )
    assert.ok(result.error)
    assert.match(result.error!, /IR 校验失败/)
    assert.ok(!fs.existsSync(path.join(sandbox.exportsDir, 'no-title.md')))
  } finally {
    sandbox.cleanup()
  }
})

// ---------------------------------------------------------------------------
// case 13：渲染器抛错时半成品被清理
// ---------------------------------------------------------------------------

test('case 13: docx 渲染器抛错时半成品文件被清理', async () => {
  const sandbox = setupSandbox()
  try {
    const failingHook: DocumentRendererHook = {
      renderPdf: async () => { throw new Error('not used') },
      renderDocx: async (_ir, outputPath) => {
        // 模拟"已写一半再失败"：先创建半成品再抛错
        fs.writeFileSync(outputPath, 'partial', 'utf-8')
        throw new Error('docx 库内部错误')
      },
    }
    const router = new ToolRouter(sandbox.avatarsPath, { documentRenderers: failingHook })
    const result = await router.execute(
      sandbox.avatarId,
      { name: 'generate_document', arguments: { format: 'docx', ir: minimalIR(), filename: 'fail-docx' } },
      undefined,
      sandbox.conversationId,
    )
    assert.ok(result.error)
    assert.match(result.error!, /docx 渲染失败|docx 库内部错误/)
    assert.ok(!fs.existsSync(path.join(sandbox.exportsDir, 'fail-docx.docx')), '半成品必被清理')
  } finally {
    sandbox.cleanup()
  }
})

// ---------------------------------------------------------------------------
// case 14：输出 > 20MB 自动 unlink
// ---------------------------------------------------------------------------

test('case 14: 输出文件 > 20MB 应自动 unlink + error', async () => {
  const sandbox = setupSandbox()
  try {
    // mock 一个故意写超 20MB 的渲染器
    const oversizeHook: DocumentRendererHook = {
      renderPdf: async (_html, outputPath) => {
        const buf = Buffer.alloc(20 * 1024 * 1024 + 1024, 0x41) // 略超 20MB
        fs.writeFileSync(outputPath, buf)
        return { size: buf.length }
      },
      renderDocx: async () => ({ size: 0 }),
    }
    const router = new ToolRouter(sandbox.avatarsPath, { documentRenderers: oversizeHook })
    const result = await router.execute(
      sandbox.avatarId,
      { name: 'generate_document', arguments: { format: 'pdf', ir: minimalIR(), filename: 'huge-pdf' } },
      undefined,
      sandbox.conversationId,
    )
    assert.ok(result.error)
    assert.match(result.error!, /超过上限.*20 MB/)
    assert.ok(!fs.existsSync(path.join(sandbox.exportsDir, 'huge-pdf.pdf')), '超限文件必被清理')
  } finally {
    sandbox.cleanup()
  }
})

// ---------------------------------------------------------------------------
// case 15：cite 块 sources 字段回收
// ---------------------------------------------------------------------------

test('case 15: cite 块的 sources 应被回收到 payload', async () => {
  const sandbox = setupSandbox()
  try {
    const router = new ToolRouter(sandbox.avatarsPath)
    const result = await router.execute(
      sandbox.avatarId,
      { name: 'generate_document', arguments: { format: 'md', ir: irWithCite(), filename: 'with-cite' } },
      undefined,
      sandbox.conversationId,
    )
    assert.equal(result.error, undefined)
    const payload = JSON.parse(result.content) as Record<string, unknown>
    assert.ok(Array.isArray(payload.sources))
    const sources = payload.sources as Array<{ source: string; page?: number }>
    assert.equal(sources.length, 2)
    assert.equal(sources[0].source, 'knowledge/a.md')
    assert.equal(sources[0].page, 12)
    assert.equal(sources[1].source, 'knowledge/b.md')
    assert.equal(sources[1].page, undefined)
  } finally {
    sandbox.cleanup()
  }
})

// ---------------------------------------------------------------------------
// case 16：与 export_excel 的 _usage 文案对齐（决策 B3）
// ---------------------------------------------------------------------------

test('case 16: payload._usage 与 export_excel 文案一致（决策 B3）', async () => {
  const sandbox = setupSandbox()
  try {
    const router = new ToolRouter(sandbox.avatarsPath)
    const result = await router.execute(
      sandbox.avatarId,
      { name: 'generate_document', arguments: { format: 'md', ir: minimalIR(), filename: 'usage-test' } },
      undefined,
      sandbox.conversationId,
    )
    const payload = JSON.parse(result.content) as Record<string, unknown>
    const usage = String(payload._usage ?? '')
    assert.match(usage, /文件已落盘.*工作区/)
    assert.match(usage, /文件卡片/)
    assert.match(usage, /已生成.*可在下方文件卡片点击打开/)
  } finally {
    sandbox.cleanup()
  }
})
