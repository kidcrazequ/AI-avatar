import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectArtifactDeliveryRequest,
  ensureArtifactDeliveryTools,
  extractDocumentAttachmentsFromText,
} from './chatStore'
import type { LLMTool } from '../services/llm-service'

function tool(name: string): LLMTool {
  return {
    type: 'function',
    function: {
      name,
      description: name,
      parameters: { type: 'object', properties: {} },
    },
  }
}

test('解决方案未指定格式时默认要求 PDF', () => {
  assert.deepEqual(
    detectArtifactDeliveryRequest('请生成一份园区综合能源解决方案'),
    { documentFormat: 'pdf', pptx: false },
  )
})

test('PPTX 与 PDF 可同时识别为两个真实文件交付', () => {
  assert.deepEqual(
    detectArtifactDeliveryRequest('生成解决方案，同时输出 PPTX 和 PDF'),
    { documentFormat: 'pdf', pptx: true },
  )
})

test('能力咨询不误触发文件生成', () => {
  assert.deepEqual(
    detectArtifactDeliveryRequest('AI 分身能否生成解决方案 PDF？'),
    { pptx: false },
  )
})

test('PPTX 导出结果可转成对话文件卡片', () => {
  const attachments = extractDocumentAttachmentsFromText(
    '{"outputPath":"exports/园区解决方案.pptx","slideCount":8}',
    'conv-1',
  )
  assert.equal(attachments.length, 1)
  assert.equal(attachments[0].format, 'pptx')
  assert.equal(attachments[0].filePath, 'exports/园区解决方案.pptx')
})

test('工具重排后仍保留方案文件交付所需工具', () => {
  const selected = [tool('read_file')]
  const available = [
    ...selected,
    tool('generate_document'),
    tool('write_file'),
    tool('export_pptx'),
  ]
  const result = ensureArtifactDeliveryTools(
    '生成解决方案，同时输出 PPTX 和 PDF',
    selected,
    available,
  )
  assert.deepEqual(
    result.map(item => item.function.name),
    ['read_file', 'generate_document', 'write_file', 'export_pptx'],
  )
})
