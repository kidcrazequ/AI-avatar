/**
 * SubAgentManager: 子代理委派管理器。
 *
 * 支持主 AI 将子任务委派给独立的子代理并行执行。
 * 每个子代理使用独立的对话上下文，共享知识库但不共享会话历史。
 * 子代理执行完成后将结果返回给主代理继续处理。
 *
 * @author zhi.qu
 * @date 2026-04-09
 */

/** 子代理任务状态 */
export type SubAgentStatus = 'pending' | 'running' | 'done' | 'error'

/** 子代理任务定义 */
export interface SubAgentTask {
  id: string
  task: string
  status: SubAgentStatus
  result?: string
  error?: string
  startedAt?: number
  finishedAt?: number
}

/** LLM 调用函数类型 */
type LLMCallFn = (systemPrompt: string, userPrompt: string, maxTokens?: number) => Promise<string>

/**
 * SubAgentManager 管理子代理任务的生命周期。
 * 每次 delegate 调用启动一个独立的 LLM 会话，结果异步返回。
 */
export class SubAgentManager {
  private tasks = new Map<string, SubAgentTask>()
  private cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private destroyed = false
  /** 任务完成通知：taskId → resolve 回调列表 */
  private completionWaiters = new Map<string, Array<(task: SubAgentTask) => void>>()

  /**
   * 委派任务给子代理。
   *
   * @param task - 任务描述
   * @param systemPrompt - 子代理的 system prompt（通常共享主代理的知识和 soul）
   * @param callLLM - LLM 调用函数
   * @returns 子代理任务，含 id 供后续查询
   */
  async delegate(
    task: string,
    systemPrompt: string,
    callLLM: LLMCallFn
  ): Promise<SubAgentTask> {
    if (this.destroyed) {
      throw new Error('SubAgentManager 已销毁，无法委派新任务')
    }
    const id = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const agentTask: SubAgentTask = {
      id,
      task,
      status: 'running',
      startedAt: Date.now(),
    }
    this.tasks.set(id, agentTask)

    this.runTask(id, task, systemPrompt, callLLM).catch((err) => {
      console.error(`[SubAgentManager] 子代理任务异常退出 (${id}):`, err instanceof Error ? err.message : String(err))
    })

    return { ...agentTask }
  }

  /** 获取任务状态（供轮询），返回副本防止外部篡改 */
  getTask(id: string): SubAgentTask | undefined {
    const task = this.tasks.get(id)
    return task ? { ...task } : undefined
  }

  /** 获取所有任务（返回副本） */
  getAllTasks(): SubAgentTask[] {
    return Array.from(this.tasks.values()).map(t => ({ ...t }))
  }

  /**
   * 等待任务完成（基于事件通知，无轮询）。
   * 返回完成/失败的任务副本，超时则返回当前状态。
   */
  waitForTask(id: string, timeoutMs: number): Promise<SubAgentTask | undefined> {
    const task = this.tasks.get(id)
    if (!task) return Promise.resolve(undefined)
    if (task.status === 'done' || task.status === 'error') {
      return Promise.resolve({ ...task })
    }
    return new Promise<SubAgentTask | undefined>((resolve) => {
      const timer = setTimeout(() => {
        // 超时：移除 waiter，返回当前状态
        const waiters = this.completionWaiters.get(id)
        if (waiters) {
          const idx = waiters.indexOf(onDone)
          if (idx >= 0) waiters.splice(idx, 1)
          if (waiters.length === 0) this.completionWaiters.delete(id)
        }
        resolve(this.getTask(id))
      }, timeoutMs)

      const onDone = (t: SubAgentTask) => {
        clearTimeout(timer)
        resolve({ ...t })
      }

      if (!this.completionWaiters.has(id)) {
        this.completionWaiters.set(id, [])
      }
      this.completionWaiters.get(id)!.push(onDone)
    })
  }

  /** 通知等待者任务已完成 */
  private notifyCompletion(id: string, task: SubAgentTask): void {
    const waiters = this.completionWaiters.get(id)
    if (waiters) {
      for (const waiter of waiters) waiter(task)
      this.completionWaiters.delete(id)
    }
  }

  /** 清除已完成的任务 */
  clearDone(): void {
    for (const [id, task] of this.tasks.entries()) {
      if (task.status === 'done' || task.status === 'error') {
        this.tasks.delete(id)
        const timer = this.cleanupTimers.get(id)
        if (timer) {
          clearTimeout(timer)
          this.cleanupTimers.delete(id)
        }
      }
    }
  }

  /** 销毁管理器，清除所有定时器，后续 runTask 的 finally 不再注册新定时器 */
  destroy(): void {
    this.destroyed = true
    for (const timer of this.cleanupTimers.values()) {
      clearTimeout(timer)
    }
    this.cleanupTimers.clear()
    this.completionWaiters.clear()
    this.tasks.clear()
  }

  /** 子代理 LLM 调用超时（2 分钟） */
  private static readonly LLM_TIMEOUT_MS = 120_000

  private async runTask(
    id: string,
    task: string,
    systemPrompt: string,
    callLLM: LLMCallFn
  ): Promise<void> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    try {
      const llmPromise = callLLM(
        systemPrompt,
        `请独立完成以下子任务，只输出结果，不需要解释你的思考过程：\n\n${task}`,
        2000
      )
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error('子代理 LLM 调用超时')), SubAgentManager.LLM_TIMEOUT_MS)
      })
      const result = await Promise.race([llmPromise, timeoutPromise])
      const agentTask = this.tasks.get(id)
      if (agentTask) {
        agentTask.status = 'done'
        agentTask.result = result
        agentTask.finishedAt = Date.now()
        this.notifyCompletion(id, agentTask)
      }
    } catch (error) {
      const agentTask = this.tasks.get(id)
      if (agentTask) {
        agentTask.status = 'error'
        agentTask.error = error instanceof Error ? error.message : String(error)
        agentTask.finishedAt = Date.now()
        this.notifyCompletion(id, agentTask)
      }
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      if (this.destroyed) return
      const timer = setTimeout(() => {
        this.tasks.delete(id)
        this.cleanupTimers.delete(id)
      }, 5 * 60 * 1000)
      this.cleanupTimers.set(id, timer)
    }
  }
}
