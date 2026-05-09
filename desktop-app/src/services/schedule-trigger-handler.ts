/**
 * 渲染端 Scheduled Tasks 触发处理器（#11 Scheduled Tasks · 子任务 4）。
 *
 * 监听主进程 `schedule:trigger` IPC 事件 → 调 chatStore.sendMessage 注入消息 →
 * 通过 onProxyComplete 闭环回调 `schedule:record-run-finish`，使 schedule_runs.status
 * 从 'running' 翻到 'success' / 'failed'。
 *
 * 设计要点：
 *  - 借用 #1 Proxy API Server 同款 proxyJobId 路径，让 sendMessage 自动获取 trustTier='proxy'
 *    （继承 #7 Plan/Permission Mode 的灰名单拦截语义），无需引入第三种 trustTier。
 *  - conversationId 为 null 时自动新建对话，命名 `[Schedule] <scheduleName> @ YYYY-MM-DD HH:MM`
 *    （用户可见这是 schedule 跑出来的，而不是手动开的会话）。
 *  - 失败时尽量让 record-run-finish 走通 'failed' 路径，避免 running 行永远悬空。
 *  - 不引入额外的去重逻辑：UNIQUE(schedule_id, fired_at_utc) 在主进程已保证幂等。
 *
 * 依赖：window.electronAPI（preload 暴露），useChatStore（zustand getState 注入式调用）。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

import { useChatStore } from '../stores/chatStore'

/** 主进程 schedule:trigger 事件 payload（与 main.ts fireScheduleCallback 保持同字段） */
export interface ScheduleTriggerPayload {
  runId: number
  scheduleId: string
  firedAtUtc: number
  avatarId: string
  projectId: string
  conversationId: string | null
  promptText: string
  manual: boolean
  scheduleName: string
}

/**
 * 给新建对话拼一个易识别的标题，让用户在侧栏一眼能区分这是 schedule 跑出来的。
 *
 * 不依赖 @soul/core 的 localDateString —— payload.firedAtUtc 已是绝对时刻，
 * 直接用 toLocaleString 格式化即可（这里是 UI 层显示，对时区敏感）。
 */
function buildScheduleConversationTitle(scheduleName: string, firedAtUtc: number): string {
  const dt = new Date(firedAtUtc)
  const yyyy = dt.getFullYear()
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  const dd = String(dt.getDate()).padStart(2, '0')
  const hh = String(dt.getHours()).padStart(2, '0')
  const min = String(dt.getMinutes()).padStart(2, '0')
  return `[Schedule] ${scheduleName} @ ${yyyy}-${mm}-${dd} ${hh}:${min}`
}

/**
 * 处理一次 schedule 触发：
 *  1. 解析 conversation：payload.conversationId 非空且仍存在 → 复用；否则新建
 *  2. 调 chatStore.sendMessage 注入 promptText，trustTier 借 proxyJobId 自动置 'proxy'
 *  3. onProxyComplete → 调 record-run-finish 闭环 status
 *
 * 失败时走 record-run-finish 'failed' 路径，避免 running 行悬空。
 */
export async function handleScheduleTrigger(payload: ScheduleTriggerPayload): Promise<void> {
  const startedAt = Date.now()
  let conversationId = payload.conversationId
  try {
    // ① 解析 / 新建 conversation
    if (conversationId) {
      const existing = await window.electronAPI.getConversation(conversationId)
      if (!existing) {
        conversationId = null // 旧对话已删除，降级新建
      }
    }
    if (!conversationId) {
      conversationId = await window.electronAPI.createConversation(
        buildScheduleConversationTitle(payload.scheduleName, payload.firedAtUtc),
        payload.avatarId,
        payload.projectId,
      )
    }

    // ② 调 sendMessage 注入 prompt
    const sendMessage = useChatStore.getState().sendMessage
    let proxyResultRecorded = false
    await sendMessage(
      payload.promptText,
      conversationId,
      payload.avatarId,
      undefined, // images
      undefined, // visionModel
      undefined, // attachments
      undefined, // inlineFiles
      {
        proxyJobId: `schedule:${payload.scheduleId}:${payload.firedAtUtc}`,
        onProxyComplete: async (r) => {
          proxyResultRecorded = true
          if (r.ok) {
            await window.electronAPI.scheduleRecordRunFinish(payload.runId, 'success', {
              conversationId,
              durationMs: Date.now() - startedAt,
            })
          } else {
            await window.electronAPI.scheduleRecordRunFinish(payload.runId, 'failed', {
              conversationId,
              durationMs: Date.now() - startedAt,
              errorMessage: r.error,
            })
            try {
              await window.electronAPI.logEvent('error', 'schedule-trigger', `${payload.scheduleId} failed: ${r.error}`)
            } catch (logErr) {
              console.warn('[schedule-trigger-handler] logEvent 失败:', logErr)
            }
          }
        },
      },
    )

    // 兜底：sendMessage 完成但没回调 onProxyComplete（理论上不会发生，仅做防御）
    if (!proxyResultRecorded) {
      await window.electronAPI.scheduleRecordRunFinish(payload.runId, 'success', {
        conversationId,
        durationMs: Date.now() - startedAt,
      })
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    try {
      await window.electronAPI.scheduleRecordRunFinish(payload.runId, 'failed', {
        conversationId,
        durationMs: Date.now() - startedAt,
        errorMessage,
      })
    } catch (recordErr) {
      console.warn('[schedule-trigger-handler] record-run-finish 失败:', recordErr)
    }
    try {
      await window.electronAPI.logEvent('error', 'schedule-trigger', `${payload.scheduleId} threw: ${errorMessage}`)
    } catch (logErr) {
      console.warn('[schedule-trigger-handler] logEvent 失败:', logErr)
    }
  }
}

/**
 * 注册主进程 schedule:trigger 事件监听器（应在 App 顶层 useEffect([], …) 调用一次）。
 *
 * @returns 反注册函数，组件卸载时调用以避免泄漏
 */
export function registerScheduleTriggerListener(): () => void {
  return window.electronAPI.onScheduleTrigger((raw) => {
    const payload = raw as ScheduleTriggerPayload
    // 不 await：每次触发独立任务，串行 await 会导致后续触发排队
    void handleScheduleTrigger(payload)
  })
}
