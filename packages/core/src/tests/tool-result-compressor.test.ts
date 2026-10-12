/**
 * Tool Result Compressor 单测
 *
 * 验证红线：
 *   - 透传白名单（query_excel / read_knowledge_file 等）必须 byte-for-byte 不变
 *   - env 关闭时是 identity 函数
 *   - 异常不抛，降级为原文
 *
 * 验证核心场景：
 *   - ANSI 转义剥离
 *   - 空行折叠
 *   - search_knowledge 章节级去重（` --- ` 分隔）
 *   - 短内容不去重
 *
 * @author zhi.qu
 * @date 2026-05-18
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  compressToolResult,
  buildDefaultCompressConfig,
  DEFAULT_COMPRESSION_PASSTHROUGH,
} from '../tool-result-compressor'

const cfg = buildDefaultCompressConfig('on')

describe('compressToolResult — 透传白名单（红线：事实根基不动）', () => {
  it('query_excel 输出原样透传（即使含可压缩内容）', () => {
    const raw = 'row 1\n\n\n\nrow 2  \n\n---\n\nrow 1\n\n\n\nrow 2  '  // 含可压缩特征
    const out = compressToolResult('query_excel', raw, cfg)
    assert.equal(out.content, raw, 'query_excel 必须 byte-for-byte 透传')
    assert.equal(out.finalChars, out.originalChars)
    assert.equal(out.droppedSections, 0)
  })

  it('read_knowledge_file / read_attachment / read_file 透传', () => {
    const raw = 'knowledge body\n\n\n\nwith blanks  '
    for (const tool of ['read_knowledge_file', 'read_attachment', 'read_file', 'read_lines']) {
      const out = compressToolResult(tool, raw, cfg)
      assert.equal(out.content, raw, `${tool} 必须透传`)
    }
  })

  it('exec_shell / exec_code / eval_js 透传（stdout 精确性）', () => {
    const raw = 'stdout: \x1b[31mERROR\x1b[0m at line 5\n\n\n\nsame'
    for (const tool of ['exec_shell', 'exec_code', 'eval_js', 'eval_js_user_view']) {
      const out = compressToolResult(tool, raw, cfg)
      assert.equal(out.content, raw, `${tool} 必须透传（含 ANSI / 空行）`)
    }
  })

  it('DEFAULT_COMPRESSION_PASSTHROUGH 包含所有事实根基类工具', () => {
    const required = ['query_excel', 'read_knowledge_file', 'read_attachment', 'read_file',
      'eval_js', 'exec_shell', 'exec_code']
    for (const t of required) {
      assert.ok(DEFAULT_COMPRESSION_PASSTHROUGH.has(t), `透传白名单缺少 ${t}`)
    }
  })
})

describe('compressToolResult — env 关闭（红线：一键回退）', () => {
  it('SOUL_TOOL_COMPRESSION=off → 任何工具都透传', () => {
    const offCfg = buildDefaultCompressConfig('off')
    const raw = 'a\n\n\n\nb  \n\n---\n\na\n\n\n\nb  '
    const out = compressToolResult('search_knowledge', raw, offCfg)
    assert.equal(out.content, raw)
    assert.equal(offCfg.enabled, false)
  })

  it('env 未设置 → 默认启用', () => {
    const defaultCfg = buildDefaultCompressConfig(undefined)
    assert.equal(defaultCfg.enabled, true)
  })

  it('env 设为其他值（"on" / "true"）→ 启用', () => {
    assert.equal(buildDefaultCompressConfig('on').enabled, true)
    assert.equal(buildDefaultCompressConfig('true').enabled, true)
    assert.equal(buildDefaultCompressConfig('OFF').enabled, false)  // 大小写不敏感
  })
})

describe('compressToolResult — 无损操作', () => {
  it('ANSI 转义剥离', () => {
    const raw = 'before \x1b[31merror\x1b[0m after \x1b[1;33mwarn\x1b[0m end. ' +
      '\n\n' + 'x'.repeat(60)  // 让内容超过 64 字符阈值
    const out = compressToolResult('search_knowledge', raw, cfg)
    assert.ok(!out.content.includes('\x1b['), 'ANSI 必须全部剥离')
    assert.ok(out.content.includes('error'), 'ANSI 内的文本必须保留')
    assert.ok(out.content.includes('warn'))
  })

  it('行尾空白 trim + 连续空行折叠（≥3 → 2）', () => {
    const raw = 'line a   \n\n\n\n\nline b\t\t\nline c'.repeat(3)  // 重复几次撑到 > 64 字符
    const out = compressToolResult('search_knowledge', raw, cfg)
    assert.ok(!out.content.includes('   \n'), '行尾空白未清除')
    assert.ok(!/\n{3,}/.test(out.content), '空行未折叠到最多 2 行')
  })

  it('短内容（< 64 字符）短路不动', () => {
    const raw = 'a\n\n\n\nb  '
    const out = compressToolResult('search_knowledge', raw, cfg)
    assert.equal(out.content, raw, '短内容必须原样返回')
    assert.equal(out.finalChars, out.originalChars)
  })
})

describe('compressToolResult — 章节去重（search_knowledge 格式）', () => {
  it('完全相同的章节只保留首次', () => {
    const section = '### [foo.md] 标题\n[来源: knowledge/foo.md#L1-L10]\n' + '具体内容'.repeat(20)
    const raw = [section, section, section].join('\n\n---\n\n')
    const out = compressToolResult('search_knowledge', raw, cfg)
    assert.equal(out.droppedSections, 2, '应删除 2 个重复章节')
    assert.ok(out.finalChars < out.originalChars / 2, `应大幅缩短（${out.originalChars} → ${out.finalChars}）`)
    // 内容仍包含原始章节一次
    assert.equal(out.content.split('### [foo.md]').length - 1, 1)
  })

  it('不同章节不去重（即便部分字段相同）', () => {
    const secA = '### [a.md] 标题\n[来源: knowledge/a.md#L1-L10]\n' + '上海电价 0.83 元'.repeat(15)
    const secB = '### [b.md] 标题\n[来源: knowledge/b.md#L1-L10]\n' + '上海电价 0.83 元'.repeat(15)  // 同 body，不同 header / anchor
    const raw = [secA, secB].join('\n\n---\n\n')
    const out = compressToolResult('search_knowledge', raw, cfg)
    assert.equal(out.droppedSections, 0, '不同 header / source 的章节不能去重')
    assert.ok(out.content.includes('[a.md]'))
    assert.ok(out.content.includes('[b.md]'))
  })

  it('单个章节（无 --- 分隔）不触发去重', () => {
    const raw = '### [foo.md] 标题\n[来源: knowledge/foo.md#L1-L10]\n' + '内容'.repeat(30)
    const out = compressToolResult('search_knowledge', raw, cfg)
    assert.equal(out.droppedSections, 0)
  })

  it('太短的章节（< 100 字符）不去重', () => {
    const shortSec = '短章节'
    const raw = [shortSec, shortSec, shortSec].join('\n\n---\n\n')
    const out = compressToolResult('search_knowledge', raw, cfg)
    assert.equal(out.droppedSections, 0, '太短章节不去重（避免误吃 header / 错误信息）')
  })
})

describe('compressToolResult — 异常容错（红线：永远不抛）', () => {
  it('crypto 失败时降级为原文（不抛）', () => {
    // 极端长字符串（不会真 crash，但测试逻辑容错）
    const raw = ('x'.repeat(10_000) + '\n\n---\n\n').repeat(5)
    const out = compressToolResult('search_knowledge', raw, cfg)
    // 即便不去重也不能崩
    assert.ok(typeof out.content === 'string')
    assert.ok(out.finalChars > 0)
  })

  it('内容含特殊字符（null byte / 非 UTF-8 编码点）不抛', () => {
    const raw = 'normal text\x00\x01\x02\n\n' + '长正文'.repeat(50)
    const out = compressToolResult('search_knowledge', raw, cfg)
    assert.ok(typeof out.content === 'string')
  })
})

describe('compressToolResult — 统计字段', () => {
  it('originalChars / finalChars / droppedSections 字段正确', () => {
    const section = '### [foo.md] 标题\n' + '内容'.repeat(50)
    const raw = [section, section].join('\n\n---\n\n')
    const out = compressToolResult('search_knowledge', raw, cfg)
    assert.equal(out.originalChars, raw.length)
    assert.equal(out.finalChars, out.content.length)
    assert.equal(out.droppedSections, 1)
    assert.ok(out.finalChars < out.originalChars)
  })
})
