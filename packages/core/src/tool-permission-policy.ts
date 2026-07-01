/**
 * P1 #7 Permission Mode：会话模式（Ask/Plan/Agent）与「灰名单」工具策略。
 * 纯函数、无 IPC，供主进程 execute-tool-call 门禁与渲染进程 todo_write 等旁路对齐。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

/** 与会话侧边栏 badge 对齐：{@link PLAN_MODE_BLOCKED_TOOL_NAMES} 在 plan 下禁止执行。 */
export type ConversationModeForTools = 'agent' | 'plan' | 'ask'

/** 「信任层」：`proxy` = P0+ HTTP / 未来 LangBot 等程序化入口；桌面 UI 同源为 `ui`。 */
export type ToolCallTrustTier = 'ui' | 'proxy'

export interface ToolPermissionDenied {
  denied: true
  message: string
}

export interface ToolPermissionAllowed {
  denied: false
}

export type ToolPermissionEval = ToolPermissionDenied | ToolPermissionAllowed

/**
 * Plan 模式下禁止注入 LLM 的工具集合（与历史 chatStore 列表逐字同源，以后仅改此处）。
 * 主进程必须依据此集合拒绝执行，防止仅依赖渲染侧过滤时被畸形 IPC 绕过。
 */
export const PLAN_MODE_BLOCKED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'write_file',
  'multi_edit',
  'str_replace_edit',
  'delete_file',
  'copy_files',
  'exec_shell',
  'exec_code',
  'kill_shell',
  'register_assets',
  'unregister_assets',
  'apply_tweaks',
  'save_as_html',
  'save_as_pdf',
  'export_pptx',
  'gen_pptx',
  'super_inline_html',
  'github_import_files',
  'task',
  'delegate_task',
  'generate_image',
  // Palace 写入会改变长期职业处境记忆；Plan 模式只允许查看/规划，不落盘。
  'add_palace_commitment',
  'update_palace_commitment',
  'add_palace_inbox_item',
  'update_palace_inbox_item',
  'write_palace_room',
])

/**
 * 灰名单：任意用户确认前不得静默执行；`trustTier === 'proxy'` 时一律拒绝。
 * 仅收录「破坏面大 / 任意代码或外部系统」类；读操作不在此列以免打断工作流。
 * 若增删名称，请对照 {@link import('./skill-reranker').ISS_DEFAULT_PINNED_TOOL_NAMES} 避免与 ISS 语义冲突。
 */
export const GREY_ZONE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'write_file',
  'multi_edit',
  'str_replace_edit',
  'delete_file',
  'copy_files',
  'exec_shell',
  'exec_code',
  'kill_shell',
  'call_mcp_tool',
  'delegate_task',
  'task',
  'github_import_files',
  'generate_image',
  'apply_tweaks',
  'register_assets',
  'unregister_assets',
  'fork_verifier_agent',
  'eval_js',
  'eval_js_user_view',
  'connect_github',
  'save_as_html',
  'save_as_pdf',
  'export_pptx',
  'gen_pptx',
  'super_inline_html',
  // Palace 写入虽不改工作区文件，但会持久改变分身的“职业处境记忆”。
  'add_palace_commitment',
  'update_palace_commitment',
  'write_palace_room',
])

const MODE_EXEMPT_TOOL_NAMES: ReadonlySet<string> = new Set(['switch_mode'])

/**
 * Ask / Plan / Agent 下是否允许执行该工具（不含灰名单弹窗与 proxy 拒绝逻辑）。
 */
export function evaluateConversationModeToolPolicy(
  mode: ConversationModeForTools | undefined,
  toolName: string,
): ToolPermissionEval {
  const m: ConversationModeForTools = mode ?? 'agent'
  if (MODE_EXEMPT_TOOL_NAMES.has(toolName)) {
    return { denied: false }
  }
  if (m === 'ask') {
    return {
      denied: true,
      message:
        '当前为 Ask（问答）模式，已禁用工具执行。请用界面切换为 Agent/Plan，或由模型调用 switch_mode。',
    }
  }
  if (m === 'plan' && PLAN_MODE_BLOCKED_TOOL_NAMES.has(toolName)) {
    return {
      denied: true,
      message: `Plan（方案）模式下禁止执行工具「${toolName}」。请切换到 Agent 模式再执行写入/终端/委派等操作。`,
    }
  }
  return { denied: false }
}

/**
 * 远程（Proxy 等）入口：灰名单工具一律拒绝。
 */
export function evaluateProxyTrustGreyDenial(
  trustTier: ToolCallTrustTier,
  toolName: string,
): ToolPermissionEval {
  if (trustTier !== 'proxy') {
    return { denied: false }
  }
  if (GREY_ZONE_TOOL_NAMES.has(toolName)) {
    return {
      denied: true,
      message: `远程（Proxy/API）请求禁止执行高风险工具「${toolName}」。请在 Soul 桌面端本地会话中操作。`,
    }
  }
  return { denied: false }
}

/** 桌面端是否应对灰名单工具弹出确认（主进程 dialog）。 */
export function shouldConfirmGreyZoneOnDesktop(toolName: string): boolean {
  if (MODE_EXEMPT_TOOL_NAMES.has(toolName)) return false
  return GREY_ZONE_TOOL_NAMES.has(toolName)
}

/**
 * BR-3：灰名单确认的「会话级始终允许」记忆（借鉴 Claude Agent SDK 的 allow_always / remember）。
 *
 * 语义要点（决定安全边界，务必保持）：
 *   - **会话级、内存态**：key = conversationId，value = 该会话已「始终允许」的工具名集合。
 *     不落盘、不跨会话、不跨重启——避免「一次批准 exec_shell 就永久放行」的安全隐患，
 *     只消除同一任务内的重复弹窗摩擦。
 *   - 未记住的工具仍每次弹窗；不同会话相互隔离（A 会话记住不影响 B 会话）。
 */
export type GreyZoneSessionMemory = Map<string, Set<string>>

/** 用户在本会话是否已对该工具选择「始终允许」（可跳过确认弹窗）。 */
export function isGreyZoneSessionAllowed(
  memory: GreyZoneSessionMemory,
  conversationId: string,
  toolName: string,
): boolean {
  return memory.get(conversationId)?.has(toolName) ?? false
}

/** 记住用户在本会话对该工具的「始终允许」选择。 */
export function rememberGreyZoneSessionAllow(
  memory: GreyZoneSessionMemory,
  conversationId: string,
  toolName: string,
): void {
  let set = memory.get(conversationId)
  if (!set) {
    set = new Set<string>()
    memory.set(conversationId, set)
  }
  set.add(toolName)
}

/** 会话结束 / 删除时清理其记忆，防内存无界增长。 */
export function clearGreyZoneSessionMemory(
  memory: GreyZoneSessionMemory,
  conversationId: string,
): void {
  memory.delete(conversationId)
}
