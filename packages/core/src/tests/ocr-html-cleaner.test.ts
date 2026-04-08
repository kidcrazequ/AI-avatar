/**
 * ocr-html-cleaner.ts 单元测试
 *
 * 重点覆盖 cleanLlmOutput 中 v10 新增的两条规则：
 *   1. 前导自述清除（根据「xxx技能」规范/要求/流程 ... --- 之前的段落）
 *   2. 尾部签名/行动建议清除（--- 之后的 下一步/小堵敬上/执行完毕 等）
 *
 * 运行方式：
 *   cd packages/core && npm run build && node --test dist/tests/ocr-html-cleaner.test.js
 *
 * @author zhi.qu
 * @date 2026-04-03
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cleanLlmOutput } from '../utils/ocr-html-cleaner'

// ---------------------------------------------------------------------------
// 辅助：构建含前导自述的典型 LLM 输出
// ---------------------------------------------------------------------------

function withPreamble(body: string): string {
  return `根据「文档图片识别技能」规范，我已完成对《远景能源 ENS-L262 工商业储能一体机用户手册》的全页图像内容识别、结构化提取与知识融合。以下为严格按流程生成的 Markdown 知识文件，已：

 扫描全部 42 页，定位所有含图页面（第1、12页）  
 更新 knowledge/README.md

---
${body}`
}

function withTrailingActions(body: string): string {
  return `${body}

---

### 下一步行动建议

1. 立即保存该 Markdown 文件至 avatars/xiaodu-ci-storage/knowledge/
2. 创建图片存档目录

如需我基于此知识库开展方案设计，请发送项目基础信息。小堵将严格按第一性原理拆解。`
}

function withTrailingSignature(body: string): string {
  return `${body}

---

小堵 敬上`
}

function withTrailingDone(body: string): string {
  return `${body}

---

文档图片识别技能执行完毕。  
所有可提取参数已结构化、单位保留、图号溯源。`
}

// ---------------------------------------------------------------------------
// 测试用例
// ---------------------------------------------------------------------------

const SAMPLE_BODY = `# 远景能源 ENS-L262 技术知识库

## 1. 基础信息

| 项目 | 内容 |
|------|------|
| 型号 | ENS-L262 |
| 防护等级 | IP54 |`

describe('cleanLlmOutput — 前导自述清除', () => {
  it('清除「根据「...」规范」开头的自述段落', () => {
    const input = withPreamble(SAMPLE_BODY)
    const result = cleanLlmOutput(input)
    assert.ok(!result.startsWith('根据'), `开头不应含自述：${result.slice(0, 50)}`)
    assert.ok(result.includes('ENS-L262'), '正文内容应保留')
  })

  it('清除「根据「...」要求」变体', () => {
    const input = `根据「文档图片识别技能」要求，我将对《ENS-L419 用户手册》进行结构化知识提取与 Markdown 化整理。由于当前环境无法直接运行工具，但您已提供完整文字内容。

---
${SAMPLE_BODY}`
    const result = cleanLlmOutput(input)
    assert.ok(!result.startsWith('根据'), `开头不应含自述：${result.slice(0, 50)}`)
    assert.ok(result.includes('ENS-L262'), '正文内容应保留')
  })

  it('清除「根据知识库约束」变体', () => {
    const input = `根据知识库约束（\`avatars/xiaodu-ci-storage/knowledge/\` 下的文档内容），我已完整扫描并结构化解析全文。以下严格依据手册原文明确给出的数据进行提取。

所有参数均标注来源章节号或图号，未明示的数值一律视为知识缺口。

---
${SAMPLE_BODY}`
    const result = cleanLlmOutput(input)
    assert.ok(!result.startsWith('根据'), `开头不应含自述：${result.slice(0, 50)}`)
    assert.ok(result.includes('ENS-L262'), '正文内容应保留')
  })

  it('清除「根据用户指令」变体', () => {
    const input = `根据用户指令，我将严格依据《ENS-L419 用户手册》原文内容，仅提取明确写出的技术参数，不推导、不估算。

---
${SAMPLE_BODY}`
    const result = cleanLlmOutput(input)
    assert.ok(!result.startsWith('根据'), `开头不应含自述：${result.slice(0, 50)}`)
    assert.ok(result.includes('ENS-L262'), '正文内容应保留')
  })

  it('无前导自述时保持原文不变', () => {
    const result = cleanLlmOutput(SAMPLE_BODY)
    assert.ok(result.startsWith('# 远景能源'), '正文开头应保留')
    assert.ok(result.includes('ENS-L262'), '正文内容应保留')
  })
})

describe('cleanLlmOutput — 尾部行动建议/签名清除', () => {
  it('清除「下一步行动建议」段落', () => {
    const input = withTrailingActions(SAMPLE_BODY)
    const result = cleanLlmOutput(input)
    assert.ok(!result.includes('下一步行动建议'), '尾部行动建议应被移除')
    assert.ok(result.includes('ENS-L262'), '正文内容应保留')
  })

  it('清除「小堵 敬上」签名', () => {
    const input = withTrailingSignature(SAMPLE_BODY)
    const result = cleanLlmOutput(input)
    assert.ok(!result.includes('小堵 敬上'), '尾部签名应被移除')
    assert.ok(result.includes('ENS-L262'), '正文内容应保留')
  })

  it('清除「文档图片识别技能执行完毕」尾注', () => {
    const input = withTrailingDone(SAMPLE_BODY)
    const result = cleanLlmOutput(input)
    assert.ok(!result.includes('文档图片识别技能执行完毕'), '尾部执行完毕注应被移除')
    assert.ok(result.includes('ENS-L262'), '正文内容应保留')
  })

  it('无尾部内容时保持原文不变', () => {
    const result = cleanLlmOutput(SAMPLE_BODY)
    assert.ok(result.includes('IP54'), '参数内容应保留')
  })
})

describe('cleanLlmOutput — 前导+尾部同时存在', () => {
  it('同时清除前导自述和尾部签名', () => {
    const input = withTrailingSignature(withPreamble(SAMPLE_BODY))
    const result = cleanLlmOutput(input)
    assert.ok(!result.startsWith('根据'), '前导自述应被移除')
    assert.ok(!result.includes('小堵 敬上'), '尾部签名应被移除')
    assert.ok(result.includes('ENS-L262'), '正文内容应保留')
  })

  it('同时清除前导自述和尾部行动建议', () => {
    const input = withTrailingActions(withPreamble(SAMPLE_BODY))
    const result = cleanLlmOutput(input)
    assert.ok(!result.startsWith('根据'), '前导自述应被移除')
    assert.ok(!result.includes('下一步行动建议'), '尾部行动建议应被移除')
    assert.ok(result.includes('ENS-L262'), '正文内容应保留')
  })
})

describe('cleanLlmOutput — 原有规则回归', () => {
  it('去除 ```markdown 代码围栏', () => {
    const input = '```markdown\n' + SAMPLE_BODY + '\n```'
    const result = cleanLlmOutput(input)
    assert.ok(!result.startsWith('```'), '代码围栏应被移除')
    assert.ok(result.includes('ENS-L262'), '正文内容应保留')
  })

  it('去除尾部 LLM 自评（> 以上文档...）', () => {
    const input = SAMPLE_BODY + '\n\n---\n\n> 以上文档整理完成，如有疑问请告知。'
    const result = cleanLlmOutput(input)
    assert.ok(!result.includes('以上文档整理完成'), '尾部自评应被移除')
    assert.ok(result.includes('ENS-L262'), '正文内容应保留')
  })

  it('去除残留的 Vision 注释标记', () => {
    const input = SAMPLE_BODY + '\n<!-- 以下为第12页图片中提取的结构化数据，请融入上方对应章节 -->\n'
    const result = cleanLlmOutput(input)
    assert.ok(!result.includes('以下为第12页图片'), 'Vision 注释应被移除')
    assert.ok(result.includes('ENS-L262'), '正文内容应保留')
  })
})
