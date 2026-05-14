/**
 * PermissionEnforcer：DENY / ASK / ALLOW 三态。
 *
 * 与旧 tool-permission-policy 并存：旧路径走二态 allow/deny；
 * 新路径走本模块，ASK 通过 NotificationAdapter 弹给用户决定。
 *
 * 借鉴 PAP `pap/governance/permission_enforcer.py`。
 */

import type { Permission, PermissionMode } from '../blueprint'

export interface PermissionContext {
  toolName: string
  args: Record<string, unknown>
  /** 调用上下文（agent id / session id）— 用于通知归属 */
  agentId?: string
  sessionId?: string
}

export type AskDecision = 'allow_once' | 'allow_always' | 'deny'

/**
 * 通知适配器：ASK 模式下询问用户。
 * 桌面端注入 ElectronNotificationAdapter（走 IPC 弹 toast），
 * CLI 注入 stdin prompt，测试注入预设答案。
 */
export interface NotificationAdapter {
  askPermission(ctx: PermissionContext): Promise<AskDecision>
}

/** 测试用：预设答复 */
export class StaticNotificationAdapter implements NotificationAdapter {
  constructor(private decision: AskDecision) {}
  async askPermission(): Promise<AskDecision> {
    return this.decision
  }
}

export interface EnforcerOptions {
  permission: Permission
  notifier?: NotificationAdapter
  /** 用户对工具的「记住选择」覆盖（来自之前的 allow_always） */
  remembered?: Map<string, PermissionMode>
}

export class PermissionEnforcer {
  private permission: Permission
  private notifier?: NotificationAdapter
  private remembered: Map<string, PermissionMode>

  constructor(opts: EnforcerOptions) {
    this.permission = opts.permission
    this.notifier = opts.notifier
    this.remembered = opts.remembered ?? new Map()
  }

  /**
   * 判定该次工具调用的权限。
   *   - 优先查 remembered（用户「记住选择」）
   *   - 再查 permission.tools 精确覆盖
   *   - 兜底 permission.defaultMode
   *   - mode === 'ask' 时走 notifier；notifier 缺失时降级为 deny
   *
   * 返回 'allow' / 'deny'，外加 ask 时的具体决定。
   */
  async check(ctx: PermissionContext): Promise<{ effective: 'allow' | 'deny'; mode: PermissionMode; reason?: string }> {
    const remembered = this.remembered.get(ctx.toolName)
    if (remembered === 'allow') return { effective: 'allow', mode: 'allow' }
    if (remembered === 'deny') return { effective: 'deny', mode: 'deny', reason: '用户已选择禁止' }

    const explicit = this.permission.tools[ctx.toolName]
    const mode: PermissionMode = explicit ?? this.permission.defaultMode

    if (mode === 'allow') return { effective: 'allow', mode }
    if (mode === 'deny') return { effective: 'deny', mode, reason: `策略禁止 ${ctx.toolName}` }

    // ask
    if (!this.notifier) {
      return { effective: 'deny', mode, reason: `工具 ${ctx.toolName} 需要确认，但未配置 notifier` }
    }
    const decision = await this.notifier.askPermission(ctx)
    if (decision === 'allow_once') return { effective: 'allow', mode }
    if (decision === 'allow_always') {
      this.remembered.set(ctx.toolName, 'allow')
      return { effective: 'allow', mode }
    }
    return { effective: 'deny', mode, reason: '用户拒绝' }
  }

  /** 更新 remembered（持久化层应调用此方法同步） */
  remember(toolName: string, mode: PermissionMode): void {
    this.remembered.set(toolName, mode)
  }

  getRemembered(): Map<string, PermissionMode> {
    return new Map(this.remembered)
  }
}
