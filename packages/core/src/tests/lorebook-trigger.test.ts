/**
 * lorebook-trigger 单元测试
 *
 * 覆盖：
 *   - loadTriggers：文件不存在 / yaml 损坏 / schema 不合法 / 部分非法项跳过
 *   - matchTriggers：单/多关键词命中、大小写不敏感、priority + hitCount 排序、max_entries 截断、空消息
 *   - buildTriggerInjection：max_chars 截断、total_max_chars 全局上限、文件读不到容错、空 matches
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  loadTriggers,
  matchTriggers,
  buildTriggerInjection,
  type TriggersConfig,
} from '../lorebook-trigger'

function withTempDir(body: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lorebook-test-'))
  try {
    body(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function writeYaml(dir: string, content: string): void {
  fs.writeFileSync(path.join(dir, '_triggers.yaml'), content, 'utf-8')
}

describe('lorebook-trigger / loadTriggers', () => {
  it('文件不存在返回 null', () => {
    withTempDir((dir) => {
      assert.equal(loadTriggers(dir), null)
    })
  })

  it('yaml 语法损坏返回 null（不抛错）', () => {
    withTempDir((dir) => {
      writeYaml(dir, '{not valid yaml [[[')
      assert.equal(loadTriggers(dir), null)
    })
  })

  it('triggers 非数组返回 null', () => {
    withTempDir((dir) => {
      writeYaml(dir, 'triggers: not-an-array')
      assert.equal(loadTriggers(dir), null)
    })
  })

  it('正确加载合法配置 + 应用默认值', () => {
    withTempDir((dir) => {
      writeYaml(dir, `
triggers:
  - keywords: ['铜铝', '铝排']
    knowledge: '电气/铜铝.md'
    priority: 10
    max_chars: 600
    note: '提到铜铝时常需对比'
`.trim())
      const cfg = loadTriggers(dir)
      assert.ok(cfg)
      assert.equal(cfg.triggers.length, 1)
      assert.deepEqual(cfg.triggers[0].keywords, ['铜铝', '铝排'])
      assert.equal(cfg.triggers[0].priority, 10)
      assert.equal(cfg.triggers[0].max_chars, 600)
      assert.equal(cfg.total_max_chars, 2400) // 默认值
      assert.equal(cfg.max_entries, 3) // 默认值
    })
  })

  it('单条 entry 缺字段被跳过，合法项保留', () => {
    withTempDir((dir) => {
      writeYaml(dir, `
triggers:
  - keywords: ['valid']
    knowledge: 'a.md'
  - keywords: []
    knowledge: 'b.md'       # 空 keywords 跳过
  - knowledge: 'c.md'        # 缺 keywords 跳过
  - keywords: ['x']           # 缺 knowledge 跳过
  - keywords: 'not-array'    # keywords 非数组跳过
    knowledge: 'd.md'
  - keywords: ['valid2']
    knowledge: 'e.md'
`.trim())
      const cfg = loadTriggers(dir)
      assert.ok(cfg)
      assert.equal(cfg.triggers.length, 2)
      assert.equal(cfg.triggers[0].knowledge, 'a.md')
      assert.equal(cfg.triggers[1].knowledge, 'e.md')
    })
  })

  it('全局选项 total_max_chars / max_entries 生效', () => {
    withTempDir((dir) => {
      writeYaml(dir, `
total_max_chars: 5000
max_entries: 5
triggers:
  - keywords: ['x']
    knowledge: 'a.md'
`.trim())
      const cfg = loadTriggers(dir)
      assert.ok(cfg)
      assert.equal(cfg.total_max_chars, 5000)
      assert.equal(cfg.max_entries, 5)
    })
  })

  it('非法全局选项回退默认值（不让坏配置生效）', () => {
    withTempDir((dir) => {
      writeYaml(dir, `
total_max_chars: -100
max_entries: "abc"
triggers:
  - keywords: ['x']
    knowledge: 'a.md'
`.trim())
      const cfg = loadTriggers(dir)
      assert.ok(cfg)
      assert.equal(cfg.total_max_chars, 2400)
      assert.equal(cfg.max_entries, 3)
    })
  })
})

describe('lorebook-trigger / matchTriggers', () => {
  function makeCfg(triggers: TriggersConfig['triggers']): TriggersConfig {
    return { triggers, total_max_chars: 2400, max_entries: 3 }
  }

  it('单关键词命中', () => {
    const cfg = makeCfg([{ keywords: ['铜铝'], knowledge: 'a.md' }])
    const matches = matchTriggers('我想了解铜铝对比', cfg)
    assert.equal(matches.length, 1)
    assert.deepEqual(matches[0].hits, ['铜铝'])
  })

  it('多关键词命中：同一 trigger 内任一即触发，hits 包含所有命中词', () => {
    const cfg = makeCfg([{ keywords: ['铜铝', '铝排', '铜母线'], knowledge: 'a.md' }])
    const matches = matchTriggers('铜铝和铝排都问', cfg)
    assert.equal(matches.length, 1)
    assert.deepEqual(matches[0].hits, ['铜铝', '铝排'])
  })

  it('英文大小写不敏感', () => {
    const cfg = makeCfg([{ keywords: ['BatteryESS'], knowledge: 'a.md' }])
    const matches = matchTriggers('询问 batteryess 参数', cfg)
    assert.equal(matches.length, 1)
  })

  it('无命中返回空数组', () => {
    const cfg = makeCfg([{ keywords: ['XYZ'], knowledge: 'a.md' }])
    assert.deepEqual(matchTriggers('完全不相关的消息', cfg), [])
  })

  it('空消息返回空数组', () => {
    const cfg = makeCfg([{ keywords: ['x'], knowledge: 'a.md' }])
    assert.deepEqual(matchTriggers('', cfg), [])
  })

  it('priority desc 排序', () => {
    const cfg = makeCfg([
      { keywords: ['x'], knowledge: 'low.md', priority: 1 },
      { keywords: ['x'], knowledge: 'high.md', priority: 10 },
      { keywords: ['x'], knowledge: 'mid.md', priority: 5 },
    ])
    const matches = matchTriggers('x', cfg)
    assert.equal(matches[0].trigger.knowledge, 'high.md')
    assert.equal(matches[1].trigger.knowledge, 'mid.md')
    assert.equal(matches[2].trigger.knowledge, 'low.md')
  })

  it('同 priority 时按 hitCount desc 排序', () => {
    const cfg = makeCfg([
      { keywords: ['a'], knowledge: '1hit.md', priority: 5 },
      { keywords: ['a', 'b', 'c'], knowledge: '3hit.md', priority: 5 },
      { keywords: ['a', 'b'], knowledge: '2hit.md', priority: 5 },
    ])
    const matches = matchTriggers('a b c', cfg)
    assert.equal(matches[0].trigger.knowledge, '3hit.md')
    assert.equal(matches[1].trigger.knowledge, '2hit.md')
    assert.equal(matches[2].trigger.knowledge, '1hit.md')
  })

  it('max_entries 截断', () => {
    const cfg: TriggersConfig = {
      triggers: [
        { keywords: ['x'], knowledge: 'a.md' },
        { keywords: ['x'], knowledge: 'b.md' },
        { keywords: ['x'], knowledge: 'c.md' },
        { keywords: ['x'], knowledge: 'd.md' },
      ],
      total_max_chars: 9999,
      max_entries: 2,
    }
    const matches = matchTriggers('x', cfg)
    assert.equal(matches.length, 2)
  })
})

describe('lorebook-trigger / buildTriggerInjection', () => {
  function stubRetriever(files: Record<string, string>): { readFile(rel: string): string } {
    return {
      readFile(rel: string): string {
        if (!(rel in files)) throw new Error(`ENOENT: ${rel}`)
        return files[rel]
      },
    }
  }

  it('空 matches 返回 empty injection', () => {
    const inj = buildTriggerInjection([], stubRetriever({}), 2400)
    assert.equal(inj.text, '')
    assert.equal(inj.charCount, 0)
    assert.equal(inj.entries.length, 0)
  })

  it('正常注入：含 header + 每个文件 + 命中关键词标识', () => {
    const matches = [{
      trigger: { keywords: ['铜铝'], knowledge: '电气/铜铝.md', max_chars: 1000 },
      hits: ['铜铝'],
      score: 0,
    }]
    const inj = buildTriggerInjection(matches, stubRetriever({ '电气/铜铝.md': '铜铝对比内容...' }), 2400)
    assert.ok(inj.text.includes('## 触发知识片段'))
    assert.ok(inj.text.includes('电气/铜铝.md'))
    assert.ok(inj.text.includes('铜铝对比内容'))
    assert.ok(inj.text.includes('命中：铜铝'))
    assert.equal(inj.entries.length, 1)
    assert.equal(inj.entries[0].truncated, false)
  })

  it('单条 max_chars 截断', () => {
    const longContent = 'X'.repeat(2000)
    const matches = [{
      trigger: { keywords: ['x'], knowledge: 'a.md', max_chars: 100 },
      hits: ['x'],
      score: 0,
    }]
    const inj = buildTriggerInjection(matches, stubRetriever({ 'a.md': longContent }), 2400)
    assert.equal(inj.entries[0].truncated, true)
    assert.ok(inj.text.includes('…[截断]'))
  })

  it('total_max_chars 全局上限：第三个文件因 budget 不够提前停', () => {
    const matches = [
      { trigger: { keywords: ['x'], knowledge: 'a.md', max_chars: 800 }, hits: ['x'], score: 0 },
      { trigger: { keywords: ['x'], knowledge: 'b.md', max_chars: 800 }, hits: ['x'], score: 0 },
      { trigger: { keywords: ['x'], knowledge: 'c.md', max_chars: 800 }, hits: ['x'], score: 0 },
    ]
    const inj = buildTriggerInjection(matches, stubRetriever({
      'a.md': 'A'.repeat(800),
      'b.md': 'B'.repeat(800),
      'c.md': 'C'.repeat(800),
    }), 1000) // 上限 1000，第三个进不来
    assert.ok(inj.entries.length <= 2)
  })

  it('单文件读不到时静默跳过，其他正常', () => {
    const matches = [
      { trigger: { keywords: ['x'], knowledge: 'missing.md' }, hits: ['x'], score: 0 },
      { trigger: { keywords: ['x'], knowledge: 'present.md' }, hits: ['x'], score: 0 },
    ]
    const inj = buildTriggerInjection(matches, stubRetriever({ 'present.md': '内容存在' }), 2400)
    assert.equal(inj.entries.length, 1)
    assert.equal(inj.entries[0].knowledge, 'present.md')
  })

  it('note 字段被注入到 injection 文本中', () => {
    const matches = [{
      trigger: { keywords: ['x'], knowledge: 'a.md', note: '用户提到 X 时常需要 Y 参数' },
      hits: ['x'],
      score: 0,
    }]
    const inj = buildTriggerInjection(matches, stubRetriever({ 'a.md': 'content' }), 2400)
    assert.ok(inj.text.includes('用户提到 X 时常需要 Y 参数'))
  })

  it('全部文件都读不到时返回 empty injection（避免只 emit header + 0 entry）', () => {
    const matches = [
      { trigger: { keywords: ['x'], knowledge: 'gone.md' }, hits: ['x'], score: 0 },
    ]
    const inj = buildTriggerInjection(matches, stubRetriever({}), 2400)
    assert.equal(inj.text, '')
    assert.equal(inj.entries.length, 0)
  })
})
