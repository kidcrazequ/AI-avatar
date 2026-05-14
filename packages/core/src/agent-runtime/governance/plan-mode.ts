/**
 * Plan Mode：在 plan 态下所有「写」类工具临时 DENY，对应 Claude Code 的
 * EnterPlanMode / ExitPlanMode。
 *
 * 用法：
 *   const pm = new PlanModeController()
 *   pm.enter()
 *   const decoratedPermission = pm.applyTo(blueprint.permission)
 *   // ... 进入 plan 阶段，所有写工具调用会被拒绝
 *   pm.exit()
 *
 * 与 PermissionEnforcer 配合：把 applyTo 返回的 Permission 喂给 enforcer。
 */

import type { Permission, PermissionMode } from '../blueprint'

/** 默认写工具集合 — 可被构造参数覆盖 */
const DEFAULT_WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'apply_patch',
  'str_replace',
  'create_file',
  'delete_file',
  'execute_bash',
  'run_shell',
  'export_excel',
  'generate_document',
])

export interface PlanModeOptions {
  writeTools?: Iterable<string>
  /** 进入/退出 Plan Mode 的回调（用于 UI 提示 / hook 触发） */
  onEnter?: () => void
  onExit?: () => void
}

export class PlanModeController {
  private active = false
  private writeTools: Set<string>
  private onEnter?: () => void
  private onExit?: () => void

  constructor(opts: PlanModeOptions = {}) {
    this.writeTools = new Set(opts.writeTools ?? DEFAULT_WRITE_TOOLS)
    this.onEnter = opts.onEnter
    this.onExit = opts.onExit
  }

  isActive(): boolean {
    return this.active
  }

  enter(): void {
    if (this.active) return
    this.active = true
    this.onEnter?.()
  }

  exit(): void {
    if (!this.active) return
    this.active = false
    this.onExit?.()
  }

  /**
   * 把 Plan Mode 覆盖应用到 Permission：所有写工具置为 deny。
   * 非 plan 态返回原 permission（按引用）。
   */
  applyTo(base: Permission): Permission {
    if (!this.active) return base
    const tools: Record<string, PermissionMode> = { ...base.tools }
    for (const tool of this.writeTools) {
      tools[tool] = 'deny'
    }
    return { ...base, tools }
  }

  /** 工具是否被 Plan Mode 拦截 */
  isBlocked(toolName: string): boolean {
    return this.active && this.writeTools.has(toolName)
  }
}
