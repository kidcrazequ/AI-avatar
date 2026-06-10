/**
 * wecom-chat-importer 纯函数测试。
 *
 * 测试意图（不只是行为）：
 * - 截图转写是溯源链路的源头——解析/合并阶段**宁可重复，绝不丢消息**
 *   （丢一条消息 = 知识库里这段对话凭空消失，用户无从发现）
 * - 识别失败必须显式出现在产物里（缺图断档不可沉默，见
 *   feedback-soul-prefer-refuse-over-placeholder）
 */
import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  parseChatSegment,
  mergeChatSegments,
  sanitizeChatTitle,
  buildChatMarkdownBody,
} from './wecom-chat-importer'

describe('parseChatSegment', () => {
  it('提取标题行并保留消息行顺序', () => {
    const seg = parseChatSegment(
      '[标题] 储能项目交付群\n### 2026-05-20\n- **张三** 10:30：今天上午到货\n- **李四** 10:32：[图片]\n',
    )
    assert.equal(seg.title, '储能项目交付群')
    assert.deepEqual(seg.lines, [
      '### 2026-05-20',
      '- **张三** 10:30：今天上午到货',
      '- **李四** 10:32：[图片]',
    ])
  })

  it('标题为「未知」时视为无标题（避免生成「未知-日期.md」这类文件名）', () => {
    const seg = parseChatSegment('[标题] 未知\n- **张三**：好的')
    assert.equal(seg.title, null)
    assert.deepEqual(seg.lines, ['- **张三**：好的'])
  })

  it('空行与多余空白被滤除，消息内容不被改写', () => {
    const seg = parseChatSegment('\n\n  - **张三** 10:30：参数是 380V / 50Hz  \n\n')
    assert.deepEqual(seg.lines, ['- **张三** 10:30：参数是 380V / 50Hz'])
  })
})

describe('mergeChatSegments', () => {
  it('相邻截图的重叠消息只保留一份（滚动截屏重叠区）', () => {
    const a = parseChatSegment('[标题] 群A\n- **张三** 10:30：消息1\n- **李四** 10:31：消息2\n- **王五** 10:32：消息3')
    const b = parseChatSegment('[标题] 群A\n- **李四** 10:31：消息2\n- **王五** 10:32：消息3\n- **赵六** 10:33：消息4')
    const merged = mergeChatSegments([a, b])
    assert.deepEqual(merged.lines, [
      '- **张三** 10:30：消息1',
      '- **李四** 10:31：消息2',
      '- **王五** 10:32：消息3',
      '- **赵六** 10:33：消息4',
    ])
  })

  it('重叠行存在 OCR 空白差异时仍能去重（归一化比较）', () => {
    const a = parseChatSegment('- **张三** 10:30：到货 时间确认')
    const b = parseChatSegment('- **张三** 10:30：到货时间确认\n- **李四** 10:31：收到')
    const merged = mergeChatSegments([a, b])
    assert.deepEqual(merged.lines, ['- **张三** 10:30：到货 时间确认', '- **李四** 10:31：收到'])
  })

  it('无重叠时不丢任何行（宁可重复绝不丢消息的边界：完全不同的两屏）', () => {
    const a = parseChatSegment('- **张三**：上午的事')
    const b = parseChatSegment('- **李四**：下午的事')
    const merged = mergeChatSegments([a, b])
    assert.deepEqual(merged.lines, ['- **张三**：上午的事', '- **李四**：下午的事'])
  })

  it('标题取第一个非空标题（首张截图标题被遮挡的场景）', () => {
    const a = parseChatSegment('[标题] 未知\n- **张三**：1')
    const b = parseChatSegment('[标题] 交付群\n- **李四**：2')
    assert.equal(mergeChatSegments([a, b]).title, '交付群')
  })

  it('相邻重复的日期分隔行只保留一份', () => {
    const a = parseChatSegment('### 2026-05-20\n- **张三**：1')
    const b = parseChatSegment('### 2026-05-20\n- **李四**：2')
    const merged = mergeChatSegments([a, b])
    assert.deepEqual(merged.lines, ['### 2026-05-20', '- **张三**：1', '- **李四**：2'])
  })
})

describe('sanitizeChatTitle', () => {
  it('清洗出可作文件名的片段，与 KnowledgePanel baseName 规则一致', () => {
    assert.equal(sanitizeChatTitle('储能项目交付群（华东）'), '储能项目交付群_华东')
    assert.equal(sanitizeChatTitle(null), '')
  })
})

describe('buildChatMarkdownBody', () => {
  it('识别失败的截图显式标注断档，不沉默生成"看似完整"的记录', () => {
    const body = buildChatMarkdownBody({
      title: '交付群',
      lines: ['- **张三**：1'],
      screenshotCount: 3,
      failedOrdinals: [2],
    })
    assert.ok(body.includes('第 2 张截图识别失败'))
    assert.ok(body.includes('缺失'))
  })

  it('全部成功时不输出断档警告', () => {
    const body = buildChatMarkdownBody({
      title: '交付群',
      lines: ['- **张三**：1'],
      screenshotCount: 1,
      failedOrdinals: [],
    })
    assert.ok(!body.includes('识别失败'))
    assert.ok(body.startsWith('# 交付群'))
  })
})
