/**
 * Phase 4 验证：PermissionEnforcer 三态 + Plan Mode
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  PermissionEnforcer,
  StaticNotificationAdapter,
  PlanModeController,
  PermissionSchema,
} from '../agent-runtime'

describe('Phase 4 — PermissionEnforcer 三态', () => {
  it('defaultMode=allow 时直接放行', async () => {
    const e = new PermissionEnforcer({
      permission: PermissionSchema.parse({ defaultMode: 'allow' }),
    })
    const r = await e.check({ toolName: 'read_file', args: {} })
    assert.equal(r.effective, 'allow')
  })

  it('defaultMode=deny 时拒绝', async () => {
    const e = new PermissionEnforcer({
      permission: PermissionSchema.parse({ defaultMode: 'deny' }),
    })
    const r = await e.check({ toolName: 'read_file', args: {} })
    assert.equal(r.effective, 'deny')
  })

  it('explicit tool override 优先于 default', async () => {
    const e = new PermissionEnforcer({
      permission: PermissionSchema.parse({
        defaultMode: 'allow',
        tools: { write_file: 'deny' },
      }),
    })
    const r1 = await e.check({ toolName: 'write_file', args: {} })
    const r2 = await e.check({ toolName: 'read_file', args: {} })
    assert.equal(r1.effective, 'deny')
    assert.equal(r2.effective, 'allow')
  })

  it('ASK 模式：notifier 返回 allow_once', async () => {
    const e = new PermissionEnforcer({
      permission: PermissionSchema.parse({
        defaultMode: 'ask',
      }),
      notifier: new StaticNotificationAdapter('allow_once'),
    })
    const r = await e.check({ toolName: 'export_excel', args: {} })
    assert.equal(r.effective, 'allow')
    // allow_once 不应该 remember
    assert.equal(e.getRemembered().get('export_excel'), undefined)
  })

  it('ASK 模式：allow_always 会写入 remembered', async () => {
    const e = new PermissionEnforcer({
      permission: PermissionSchema.parse({ defaultMode: 'ask' }),
      notifier: new StaticNotificationAdapter('allow_always'),
    })
    await e.check({ toolName: 'export_excel', args: {} })
    assert.equal(e.getRemembered().get('export_excel'), 'allow')
    // 再次调用走 remembered，notifier 不会再被询问（用一个总是 deny 的 notifier 验证）
    const e2 = new PermissionEnforcer({
      permission: PermissionSchema.parse({ defaultMode: 'ask' }),
      notifier: new StaticNotificationAdapter('deny'),
      remembered: e.getRemembered(),
    })
    const r = await e2.check({ toolName: 'export_excel', args: {} })
    assert.equal(r.effective, 'allow')
  })

  it('ASK 模式无 notifier 时降级为 deny（防御默认）', async () => {
    const e = new PermissionEnforcer({
      permission: PermissionSchema.parse({ defaultMode: 'ask' }),
    })
    const r = await e.check({ toolName: 'x', args: {} })
    assert.equal(r.effective, 'deny')
  })
})

describe('Phase 4 — Plan Mode', () => {
  it('未进入 Plan Mode 时不改 permission', () => {
    const pm = new PlanModeController()
    const base = PermissionSchema.parse({ defaultMode: 'allow' })
    const applied = pm.applyTo(base)
    assert.equal(applied, base) // 同一引用
  })

  it('进入 Plan Mode 后写工具被 deny', () => {
    const pm = new PlanModeController()
    pm.enter()
    const base = PermissionSchema.parse({ defaultMode: 'allow' })
    const applied = pm.applyTo(base)
    assert.equal(applied.tools.write_file, 'deny')
    assert.equal(applied.tools.edit_file, 'deny')
    assert.equal(applied.tools.execute_bash, 'deny')
  })

  it('Plan Mode + Enforcer：写工具被拒，读工具通过', async () => {
    const pm = new PlanModeController()
    pm.enter()
    const base = PermissionSchema.parse({ defaultMode: 'allow' })
    const e = new PermissionEnforcer({ permission: pm.applyTo(base) })
    const write = await e.check({ toolName: 'write_file', args: {} })
    const read = await e.check({ toolName: 'read_file', args: {} })
    assert.equal(write.effective, 'deny')
    assert.equal(read.effective, 'allow')
  })

  it('退出 Plan Mode 后恢复', () => {
    let entered = 0
    let exited = 0
    const pm = new PlanModeController({
      onEnter: () => entered++,
      onExit: () => exited++,
    })
    pm.enter()
    assert.equal(pm.isActive(), true)
    pm.exit()
    assert.equal(pm.isActive(), false)
    assert.equal(entered, 1)
    assert.equal(exited, 1)
  })

  it('重复 enter/exit 幂等', () => {
    let entered = 0
    const pm = new PlanModeController({ onEnter: () => entered++ })
    pm.enter()
    pm.enter()
    assert.equal(entered, 1)
  })
})
