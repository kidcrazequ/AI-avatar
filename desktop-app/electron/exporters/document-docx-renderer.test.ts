/**
 * document-docx-renderer 单元测试（DOCX 图片嵌入相关）
 *
 * 覆盖：
 *   1. 正常嵌入相对路径 PNG（写盘的 .docx 字节数显著大于无图基线，确认图片入 zip）
 *   2. 自动缩放 800 px 宽 PNG → 通过 logger.activity 捕获 target=600x... 验证缩放发生
 *   3. 文件不存在：降级为占位段，不抛错
 *   4. 远程 URL（https://...）：降级
 *   5. 路径越界（../../../etc/passwd）：降级
 *   6. 不支持格式（.webp）：降级
 *
 * 设计原则：
 *   - 用临时目录 fixture（os.tmpdir + crypto.randomUUID），测试结束清理
 *   - 不 mock fs / docx：调真实 renderDocumentDocx 端到端验证
 *   - 用 capturedLogs 数组记录 logger.activity，断言降级原因 / 嵌入参数
 *   - PNG 数据用最小有效 IHDR 头构造（image-size 只读 width/height bytes，不校验 CRC）
 *
 * 运行方式：
 *   cd desktop-app && npx --yes tsx --test electron/exporters/document-docx-renderer.test.ts
 *
 * @author zhi.qu
 * @date 2026-05-08
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import type { DocumentIR } from '@soul/core'
import { renderDocumentDocx } from './document-docx-renderer'

// ---------------------------------------------------------------------------
// 沙盒辅助
// ---------------------------------------------------------------------------

interface Sandbox {
  imageRoot: string
  outputPath: string
  cleanup: () => void
}

function setupSandbox(): Sandbox {
  const root = path.join(os.tmpdir(), `soul-docx-test-${crypto.randomUUID()}`)
  fs.mkdirSync(root, { recursive: true })
  return {
    imageRoot: root,
    outputPath: path.join(root, 'out.docx'),
    cleanup: () => {
      try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
    },
  }
}

interface CapturedLog {
  source: string
  payload: string
}

interface MockLogger {
  activity: (source: string, payload: string) => void
  error: (source: string, err: Error) => void
  logs: CapturedLog[]
  errors: Array<{ source: string; err: Error }>
}

function makeLogger(): MockLogger {
  const logs: CapturedLog[] = []
  const errors: Array<{ source: string; err: Error }> = []
  return {
    activity: (source, payload) => { logs.push({ source, payload }) },
    error: (source, err) => { errors.push({ source, err }) },
    logs,
    errors,
  }
}

// ---------------------------------------------------------------------------
// PNG fixture：image-size@1.x 的 PNG 解析仅读 IHDR 中 width/height（offset 16/20），
// 不校验 CRC，所以构造最小 PNG 头即可被识别尺寸。docx ImageRun 内部直接把 buffer
// 当 zip 内文件原样写入，不解析像素数据。
// ---------------------------------------------------------------------------

function makePngBytes(width: number, height: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdrLen = Buffer.from([0x00, 0x00, 0x00, 0x0d])
  const ihdrType = Buffer.from('IHDR', 'ascii')
  const ihdrData = Buffer.alloc(13)
  ihdrData.writeUInt32BE(width, 0)
  ihdrData.writeUInt32BE(height, 4)
  ihdrData[8] = 8 // bit depth
  ihdrData[9] = 2 // color type RGB
  // compression / filter / interlace = 0（已 alloc）
  const ihdrCrc = Buffer.alloc(4)
  // 追加最小 IDAT + IEND 占位字节，方便部分严格的 zip 阅读器正常打开
  const idat = Buffer.from([
    0x00, 0x00, 0x00, 0x00, 0x49, 0x44, 0x41, 0x54, 0x00, 0x00, 0x00, 0x00,
  ])
  const iend = Buffer.from([
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ])
  return Buffer.concat([sig, ihdrLen, ihdrType, ihdrData, ihdrCrc, idat, iend])
}

function buildIR(blocks: DocumentIR['blocks']): DocumentIR {
  return {
    metadata: { title: 'docx 图片嵌入测试' },
    blocks,
  }
}

function findLogPayload(logs: CapturedLog[], source: string): string | undefined {
  return logs.find(l => l.source === source)?.payload
}

// ---------------------------------------------------------------------------
// case 1：正常嵌入 PNG
// ---------------------------------------------------------------------------

test('case 1：相对路径 PNG 正常嵌入到 docx，文件大小较无图基线显著增大', async () => {
  const sandbox = setupSandbox()
  try {
    const pngBytes = makePngBytes(120, 80)
    fs.writeFileSync(path.join(sandbox.imageRoot, 'pic.png'), pngBytes)

    const logger = makeLogger()
    const ir = buildIR([
      { type: 'paragraph', text: 'before' },
      { type: 'image', src: 'pic.png', alt: '示例图', caption: '示例标题' },
      { type: 'paragraph', text: 'after' },
    ])
    const result = await renderDocumentDocx(ir, sandbox.outputPath, {
      logger,
      imageRoot: sandbox.imageRoot,
    })

    assert.ok(result.size > 0, '应生成非空 .docx')

    // 同 IR 但去掉图片块 → 比较大小，图片入 zip 必带来增量
    const baselineOut = path.join(sandbox.imageRoot, 'baseline.docx')
    const baselineIR = buildIR([
      { type: 'paragraph', text: 'before' },
      { type: 'paragraph', text: 'after' },
    ])
    const baseline = await renderDocumentDocx(baselineIR, baselineOut, { logger: makeLogger() })
    assert.ok(
      result.size > baseline.size,
      `含图 .docx (${result.size}) 应明显大于无图基线 (${baseline.size})`,
    )

    // logger 应记录嵌入成功
    const embedLog = findLogPayload(logger.logs, 'document-docx-image-embed')
    assert.ok(embedLog, 'logger.activity 应记录 document-docx-image-embed')
    assert.match(embedLog!, /src=pic\.png/, '应记录原始 src')
    assert.match(embedLog!, /type=png/, '应识别 type=png')
    assert.match(embedLog!, /intrinsic=120x80/, '应记录读出的尺寸')
    assert.match(embedLog!, /target=120x80/, '宽度未超 600 时不缩放')

    // 不应有 fallback 日志
    const fallback = findLogPayload(logger.logs, 'document-docx-image-fallback')
    assert.equal(fallback, undefined, '不应触发降级')
  } finally {
    sandbox.cleanup()
  }
})

// ---------------------------------------------------------------------------
// case 2：自动缩放 800 px 宽 PNG → 验证 target=600x...
// ---------------------------------------------------------------------------

test('case 2：800x600 PNG 自动缩放到宽 600 px，等比缩放高度 450 px', async () => {
  const sandbox = setupSandbox()
  try {
    const pngBytes = makePngBytes(800, 600)
    fs.writeFileSync(path.join(sandbox.imageRoot, 'big.png'), pngBytes)

    const logger = makeLogger()
    const ir = buildIR([
      { type: 'image', src: 'big.png' },
    ])
    await renderDocumentDocx(ir, sandbox.outputPath, {
      logger,
      imageRoot: sandbox.imageRoot,
    })

    const embedLog = findLogPayload(logger.logs, 'document-docx-image-embed')
    assert.ok(embedLog, '应记录嵌入成功')
    assert.match(embedLog!, /intrinsic=800x600/)
    assert.match(embedLog!, /target=600x450/, '800x600 → 等比缩放到 600x450（ratio=0.75）')
  } finally {
    sandbox.cleanup()
  }
})

// ---------------------------------------------------------------------------
// case 3：文件不存在 → 降级
// ---------------------------------------------------------------------------

test('case 3：文件不存在时降级为占位段，不抛错', async () => {
  const sandbox = setupSandbox()
  try {
    const logger = makeLogger()
    const ir = buildIR([
      { type: 'image', src: 'missing.png', alt: '丢失的图' },
    ])
    const result = await renderDocumentDocx(ir, sandbox.outputPath, {
      logger,
      imageRoot: sandbox.imageRoot,
    })
    assert.ok(result.size > 0, '占位降级仍能产出有效 .docx')

    const fallback = findLogPayload(logger.logs, 'document-docx-image-fallback')
    assert.ok(fallback, '应记录降级原因')
    assert.match(fallback!, /reason=not-found/)
    assert.match(fallback!, /src=missing\.png/)
  } finally {
    sandbox.cleanup()
  }
})

// ---------------------------------------------------------------------------
// case 4：远程 URL（https://...）→ 降级
// ---------------------------------------------------------------------------

test('case 4：远程 https URL 降级为占位段（v1 不下载远程图）', async () => {
  const sandbox = setupSandbox()
  try {
    const logger = makeLogger()
    const ir = buildIR([
      { type: 'image', src: 'https://example.com/foo.png' },
    ])
    const result = await renderDocumentDocx(ir, sandbox.outputPath, {
      logger,
      imageRoot: sandbox.imageRoot,
    })
    assert.ok(result.size > 0)

    const fallback = findLogPayload(logger.logs, 'document-docx-image-fallback')
    assert.ok(fallback)
    assert.match(fallback!, /reason=remote-url/)
  } finally {
    sandbox.cleanup()
  }
})

// ---------------------------------------------------------------------------
// case 5：路径越界 → 降级
// ---------------------------------------------------------------------------

test('case 5：路径越界（../../../etc/passwd）触发 resolveUnderRoot 拦截，降级', async () => {
  const sandbox = setupSandbox()
  try {
    const logger = makeLogger()
    const ir = buildIR([
      { type: 'image', src: '../../../etc/passwd' },
    ])
    const result = await renderDocumentDocx(ir, sandbox.outputPath, {
      logger,
      imageRoot: sandbox.imageRoot,
    })
    assert.ok(result.size > 0)

    const fallback = findLogPayload(logger.logs, 'document-docx-image-fallback')
    assert.ok(fallback)
    assert.match(fallback!, /reason=path-traversal/)
  } finally {
    sandbox.cleanup()
  }
})

// ---------------------------------------------------------------------------
// case 6：不支持格式（.webp）→ 降级
// ---------------------------------------------------------------------------

test('case 6：扩展名 .webp 不在白名单，降级（即使文件真实存在）', async () => {
  const sandbox = setupSandbox()
  try {
    // 写一个最小 webp 占位字节，让 fs.stat 命中文件
    fs.writeFileSync(
      path.join(sandbox.imageRoot, 'pic.webp'),
      Buffer.from([0x52, 0x49, 0x46, 0x46]),
    )

    const logger = makeLogger()
    const ir = buildIR([
      { type: 'image', src: 'pic.webp' },
    ])
    const result = await renderDocumentDocx(ir, sandbox.outputPath, {
      logger,
      imageRoot: sandbox.imageRoot,
    })
    assert.ok(result.size > 0)

    const fallback = findLogPayload(logger.logs, 'document-docx-image-fallback')
    assert.ok(fallback)
    assert.match(fallback!, /reason=unsupported-ext:\.webp/)
  } finally {
    sandbox.cleanup()
  }
})
