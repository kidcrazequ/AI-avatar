/**
 * 13 个 Hook 切入点，对齐 PAP `pap/hooks/` 与 Claude Code Hook 体系。
 *
 * 命名约定：动词在前（PRE/POST/ON）+ 主语。PRE 可拒绝/改写；POST 用于审计/缓存；
 * ON_* 是事件通知（spawn / handoff / compaction / stop / error）。
 */

export enum HookPoint {
  /** LLM 调用前；可改写消息或拒绝 */
  PRE_LLM_CALL = 'pre_llm_call',
  /** LLM 调用后；可记录、做后处理 */
  POST_LLM_CALL = 'post_llm_call',
  /** 工具调用前；可改写参数或拒绝 */
  PRE_TOOL_USE = 'pre_tool_use',
  /** 工具调用后；可记录结果 */
  POST_TOOL_USE = 'post_tool_use',
  /** 子代理 spawn 前；SpawnGuard 在此校验能力降级 */
  ON_SPAWN = 'on_spawn',
  /** 子代理结果回流主代理 */
  ON_HANDOFF = 'on_handoff',
  /** 上下文压缩触发；Phase 9 */
  ON_COMPACTION = 'on_compaction',
  /** 用户输入提交时；可改写或拒绝 */
  ON_USER_PROMPT_SUBMIT = 'on_user_prompt_submit',
  /** 单轮对话结束 */
  ON_STOP = 'on_stop',
  /** 检测到错误（LLM 报错 / 工具异常 / 预算耗尽） */
  ON_ERROR = 'on_error',
  /** 进入 Plan Mode（Phase 4） */
  ON_PLAN_MODE_ENTER = 'on_plan_mode_enter',
  /** 退出 Plan Mode */
  ON_PLAN_MODE_EXIT = 'on_plan_mode_exit',
  /** 预算检查（每轮循环开始） */
  ON_BUDGET_CHECK = 'on_budget_check',
}

export const ALL_HOOK_POINTS = Object.values(HookPoint)
