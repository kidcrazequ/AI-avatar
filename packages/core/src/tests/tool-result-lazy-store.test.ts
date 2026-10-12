/**
 * Tool Result Lazy Store 单测
 *
 * 验证红线：
 *   - 默认 off，env 显式 on 才启用
 *   - 工具白名单外的不 lazy
 *   - call_id 格式严格校验（防路径穿越）
 *   - 失败降级为原文，不抛
 *
 * 验证核心场景：
 *   - web_fetch 长 body → lazy 化（body 字段替换为 body_lazy_ref，正文落盘）
 *   - read_tool_ref 分页（offset/limit）
 *   - read_tool_ref 文件不存在错误信息
 *   - 短内容（< 阈值）不 lazy
 *
 * @author zhi.qu
 * @date 2026-05-18
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import os from 'os'
import {
  buildDefaultLazyStoreConfig,
  maybeStoreLazyRef,
  readToolRef,
  isValidCallId,
  DEFAULT_LAZY_TOOLS,
  READ_TOOL_REF_HARD_LIMIT,
} from '../tool-result-lazy-store'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-lazy-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const onCfg = buildDefaultLazyStoreConfig('on')
const offCfg = buildDefaultLazyStoreConfig('off')

const makeWebFetchJson = (bodyLen: number): string => JSON.stringify({
  url: 'https://example.com/long-page',
  status: 200,
  content_type: 'text/html; charset=utf-8',
  format: 'markdown',
  char_count: bodyLen,
  truncated: false,
  body: 'x'.repeat(bodyLen),
})

describe('lazy-store — env 开关（红线：默认 off）', () => {
  it('env 未设置 → 默认 off', () => {
    const cfg = buildDefaultLazyStoreConfig(undefined)
    assert.equal(cfg.enabled, false)
  })

  it('env=off / 其他值 → off', () => {
    assert.equal(buildDefaultLazyStoreConfig('off').enabled, false)
    assert.equal(buildDefaultLazyStoreConfig('false').enabled, false)
    assert.equal(buildDefaultLazyStoreConfig('').enabled, false)
  })

  it('env=on / ON → 启用', () => {
    assert.equal(buildDefaultLazyStoreConfig('on').enabled, true)
    assert.equal(buildDefaultLazyStoreConfig('ON').enabled, true)
  })

  it('off 时即使是 web_fetch 长输出也透传', () => {
    const raw = makeWebFetchJson(10_000)
    const out = maybeStoreLazyRef(raw, offCfg, {
      workspaceRoot: tmpDir,
      toolName: 'web_fetch',
      toolArgs: { url: 'https://example.com/' },
    })
    assert.equal(out.stored, false)
    assert.equal(out.content, raw)
    assert.ok(!fs.existsSync(path.join(tmpDir, 'tool-refs')), 'off 时不应创建 tool-refs 目录')
  })
})

describe('lazy-store — 工具白名单（红线：事实根基类不 lazy）', () => {
  it('DEFAULT_LAZY_TOOLS 仅含 web_fetch（v1 范围）', () => {
    assert.equal(DEFAULT_LAZY_TOOLS.size, 1)
    assert.ok(DEFAULT_LAZY_TOOLS.has('web_fetch'))
  })

  it('search_knowledge / query_excel / read_knowledge_file 即使内容大也不 lazy', () => {
    const raw = makeWebFetchJson(20_000) // 假装是 search_knowledge 的输出格式
    for (const tool of ['search_knowledge', 'query_excel', 'read_knowledge_file', 'read_attachment', 'eval_js', 'exec_shell']) {
      const out = maybeStoreLazyRef(raw, onCfg, {
        workspaceRoot: tmpDir,
        toolName: tool,
        toolArgs: {},
      })
      assert.equal(out.stored, false, `${tool} 必须不 lazy（事实根基红线）`)
      assert.equal(out.content, raw)
    }
  })
})

describe('lazy-store — web_fetch 核心场景', () => {
  it('长 body（≥ 4000 字符）→ 落盘 + body 字段替换为 body_lazy_ref', () => {
    const bodyLen = 12_000
    const raw = makeWebFetchJson(bodyLen)
    const out = maybeStoreLazyRef(raw, onCfg, {
      workspaceRoot: tmpDir,
      toolName: 'web_fetch',
      toolArgs: { url: 'https://example.com/long-page' },
    })
    assert.equal(out.stored, true, '应触发 lazy')
    assert.ok(out.callId, '应返回 callId')
    assert.ok(isValidCallId(out.callId!), 'callId 格式应合法')

    // 落盘文件存在
    const refPath = path.join(tmpDir, 'tool-refs', `${out.callId}.md`)
    assert.ok(fs.existsSync(refPath), '正文文件应已落盘')
    assert.equal(fs.readFileSync(refPath, 'utf-8').length, bodyLen)

    // content 已替换：body 删除，body_lazy_ref 出现
    const parsed = JSON.parse(out.content)
    assert.equal(parsed.body, undefined, 'body 字段应被删')
    assert.ok(parsed.body_lazy_ref, 'body_lazy_ref 应注入')
    assert.equal(parsed.body_lazy_ref.call_id, out.callId)
    assert.equal(parsed.body_lazy_ref.char_count, bodyLen)
    assert.equal(parsed.body_lazy_ref.source_url, 'https://example.com/long-page')
    assert.match(parsed.body_lazy_ref.hint, /read_tool_ref/)

    // 元数据保留
    assert.equal(parsed.url, 'https://example.com/long-page')
    assert.equal(parsed.status, 200)
    assert.equal(parsed.char_count, bodyLen)

    // 大幅减少 prompt token 占用
    assert.ok(out.content.length < raw.length / 4, `prompt 内容应大幅缩短（${raw.length} → ${out.content.length}）`)
  })

  it('短 body（< 4000 字符）不 lazy', () => {
    const raw = makeWebFetchJson(2000)
    const out = maybeStoreLazyRef(raw, onCfg, {
      workspaceRoot: tmpDir,
      toolName: 'web_fetch',
      toolArgs: { url: 'https://example.com/short' },
    })
    assert.equal(out.stored, false)
    assert.equal(out.content, raw)
  })

  it('非 JSON 内容（异常路径）透传，不抛', () => {
    const raw = 'plain text response that is not valid JSON, with lots of content ' + 'x'.repeat(10_000)
    const out = maybeStoreLazyRef(raw, onCfg, {
      workspaceRoot: tmpDir,
      toolName: 'web_fetch',
      toolArgs: { url: 'https://example.com/' },
    })
    assert.equal(out.stored, false, '非 JSON 不应触发 lazy')
    assert.equal(out.content, raw)
  })

  it('JSON 里没 body 字段时透传', () => {
    const raw = JSON.stringify({ url: 'https://example.com/', status: 404, error: 'not found' })
    const out = maybeStoreLazyRef(raw, onCfg, {
      workspaceRoot: tmpDir,
      toolName: 'web_fetch',
      toolArgs: { url: 'https://example.com/' },
    })
    assert.equal(out.stored, false)
  })
})

describe('lazy-store — call_id 校验（红线：防路径穿越）', () => {
  it('合法格式: tool-{12hex}', () => {
    assert.ok(isValidCallId('tool-a8f2c4e9b1c2'))
    assert.ok(isValidCallId('tool-000000000000'))
    assert.ok(isValidCallId('tool-ffffffffffff'))
  })

  it('非法格式拒绝', () => {
    assert.ok(!isValidCallId(''))
    assert.ok(!isValidCallId('tool-'))
    assert.ok(!isValidCallId('tool-XYZ123456789'), '大写 hex 拒绝')
    assert.ok(!isValidCallId('tool-a8f2c4e9b1'), '长度不对')
    assert.ok(!isValidCallId('tool-a8f2c4e9b1c2d'), '过长拒绝')
    assert.ok(!isValidCallId('../etc/passwd'), '路径穿越拒绝')
    assert.ok(!isValidCallId('tool-../../etc'), '注入拒绝')
    assert.ok(!isValidCallId('toolxa8f2c4e9b1c2'), 'prefix 必须是 tool-')
  })

  it('readToolRef 对非法 callId 抛错', () => {
    assert.throws(() => readToolRef(tmpDir, '../../etc/passwd'), /非法 call_id/)
    assert.throws(() => readToolRef(tmpDir, 'tool-INVALID'), /非法 call_id/)
  })
})

describe('lazy-store — readToolRef 分页与异常', () => {
  it('完整读出（offset=0, limit=ALL）', () => {
    const body = 'A'.repeat(100) + 'B'.repeat(100) + 'C'.repeat(100)
    fs.mkdirSync(path.join(tmpDir, 'tool-refs'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'tool-refs', 'tool-aaaaaaaaaaaa.md'), body, 'utf-8')

    const out = readToolRef(tmpDir, 'tool-aaaaaaaaaaaa', 0, 1000)
    assert.equal(out.content.length, 300)
    assert.equal(out.total_chars, 300)
    assert.equal(out.truncated, false)
  })

  it('offset + limit 分页', () => {
    // 用非重复模式（字符 + 索引）确保分页能区分
    const body = Array.from({ length: 10_000 }, (_, i) => String.fromCharCode(0x4e00 + (i % 1024))).join('')
    fs.mkdirSync(path.join(tmpDir, 'tool-refs'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'tool-refs', 'tool-bbbbbbbbbbbb.md'), body, 'utf-8')

    const first = readToolRef(tmpDir, 'tool-bbbbbbbbbbbb', 0, 100)
    assert.equal(first.content.length, 100)
    assert.equal(first.offset, 0)
    assert.equal(first.truncated, true, '应标记 truncated')
    assert.equal(first.total_chars, 10_000)

    const second = readToolRef(tmpDir, 'tool-bbbbbbbbbbbb', 100, 100)
    assert.equal(second.content.length, 100)
    assert.equal(second.offset, 100)
    assert.equal(second.truncated, true)
    // first 和 second 内容不同（分页生效）
    assert.notEqual(first.content, second.content)
    // 分页拼接 = 原 body 前 200 字符
    assert.equal(first.content + second.content, body.slice(0, 200))
  })

  it('单次硬上限 READ_TOOL_REF_HARD_LIMIT', () => {
    const body = 'x'.repeat(50_000)
    fs.mkdirSync(path.join(tmpDir, 'tool-refs'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'tool-refs', 'tool-cccccccccccc.md'), body, 'utf-8')

    const out = readToolRef(tmpDir, 'tool-cccccccccccc', 0, 100_000) // 请求超大 limit
    assert.equal(out.content.length, READ_TOOL_REF_HARD_LIMIT, '应被硬上限截断')
    assert.equal(out.limit, READ_TOOL_REF_HARD_LIMIT)
    assert.equal(out.truncated, true)
  })

  it('文件不存在 → 抛明确错误', () => {
    assert.throws(
      () => readToolRef(tmpDir, 'tool-999999999999'),
      /lazy ref 文件不存在/,
    )
  })
})

describe('lazy-store — 端到端（lazy 化 + readToolRef 取回）', () => {
  it('store → 读出的内容 = 原 body', () => {
    const body = '上海电价峰谷数据：' + 'X'.repeat(20_000)
    const raw = JSON.stringify({
      url: 'https://fgw.sh.gov.cn/policy.html',
      status: 200,
      content_type: 'text/html',
      format: 'markdown',
      char_count: body.length,
      truncated: false,
      body,
    })

    const stored = maybeStoreLazyRef(raw, onCfg, {
      workspaceRoot: tmpDir,
      toolName: 'web_fetch',
      toolArgs: { url: 'https://fgw.sh.gov.cn/policy.html' },
    })
    assert.equal(stored.stored, true)

    // 读首段
    const first = readToolRef(tmpDir, stored.callId!, 0, 100)
    assert.equal(first.content.length, 100)
    assert.equal(first.total_chars, body.length)
    // 首段应含中文前缀
    assert.ok(first.content.startsWith('上海电价峰谷数据'))

    // 完整读出（分多次拼接）= 原 body
    let assembled = ''
    let offset = 0
    while (offset < body.length) {
      const seg = readToolRef(tmpDir, stored.callId!, offset, READ_TOOL_REF_HARD_LIMIT)
      assembled += seg.content
      offset += seg.content.length
      if (!seg.truncated) break
    }
    assert.equal(assembled, body, '分页拼接应等于原始 body')
  })
})
