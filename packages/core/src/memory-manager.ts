/**
 * MemoryManager: 记忆容量管理工具。
 *
 * 提供记忆容量检测、统计信息计算和 LLM 驱动的记忆整理能力。
 * 当 MEMORY.md 接近 2200 字符上限时，通过 LLM 合并重复条目、删除过时信息，
 * 保留关键纠偏和决策记录，保证记忆容量可控。
 *
 * @author zhi.qu
 * @date 2026-04-09
 */

/** 记忆文件字符上限 */
export const MEMORY_CHAR_LIMIT = 2200

/** 超过此比例时发出警告（黄色提示） */
export const MEMORY_WARN_THRESHOLD = 0.85

/** 超过此比例时触发自动整理 */
export const MEMORY_CONSOLIDATE_THRESHOLD = 1.0

/**
 * 记忆整理 Prompt。
 * 指导 LLM 将冗长的记忆文件压缩到关键信息，保持 Markdown 格式。
 */
export const CONSOLIDATION_PROMPT = `你是一个记忆整理助手，负责精简 AI 分身的长期记忆文件。

整理规则：
1. **合并重复**：将相同主题的多条记录合并为一条
2. **删除过时**：删除已被更新信息覆盖的旧条目
3. **保留纠偏**：用户的纠正记录（错误认知的修正）必须完整保留
4. **保留决策**：项目级别的关键决策必须保留
5. **简化措辞**：在不损失信息的前提下，用更简洁的语言表达
6. **保持结构**：保留原有的 Markdown 标题结构（## 偏好记录、## 纠偏记录 等）
7. **目标长度**：整理后控制在 ${Math.round(MEMORY_CHAR_LIMIT * 0.7)} 字符以内

重要：只输出整理后的 Markdown 内容，不要添加任何说明或注释。`

/** 记忆统计信息 */
export interface MemoryStats {
  /** 当前字符数 */
  chars: number
  /** 占上限的比例（0-1） */
  ratio: number
  /** 估算条目数（通过 HTML 注释计数） */
  entries: number
}

/**
 * 计算记忆文件的统计信息。
 *
 * @param content - MEMORY.md 的完整文本
 * @returns 字符数、占比、条目数
 */
export function getMemoryStats(content: string): MemoryStats {
  const chars = content.length
  const ratio = chars / MEMORY_CHAR_LIMIT
  // 通过 <!-- 日期 --> 注释计数估算条目数
  const entries = (content.match(/<!--[^>]+-->/g) ?? []).length
  return { chars, ratio, entries }
}

/**
 * 判断是否需要整理记忆（超过上限）。
 *
 * @param content - MEMORY.md 的完整文本
 * @returns 是否需要整理
 */
export function shouldConsolidate(content: string): boolean {
  return content.length >= MEMORY_CHAR_LIMIT * MEMORY_CONSOLIDATE_THRESHOLD
}

/**
 * 判断是否需要发出容量警告（超过警告阈值）。
 *
 * @param content - MEMORY.md 的完整文本
 * @returns 是否需要警告
 */
export function shouldWarnMemory(content: string): boolean {
  return content.length >= MEMORY_CHAR_LIMIT * MEMORY_WARN_THRESHOLD
}

/**
 * 调用 LLM 整理记忆内容，压缩到关键信息。
 *
 * @param content - 当前完整的 MEMORY.md 内容
 * @param callLLM - LLM 调用函数（与 LLMCallFn 兼容）
 * @returns 整理后的精简内容
 */
export async function consolidateMemory(
  content: string,
  callLLM: (system: string, user: string, maxTokens?: number) => Promise<string>
): Promise<string> {
  if (!content.trim() || content.length < 100) return content
  try {
    const result = await callLLM(
      CONSOLIDATION_PROMPT,
      `请整理以下记忆文件：\n\n${content}`,
      800
    )
    const trimmed = result.trim()
    if (!trimmed) return content
    // 整理结果不应比原文短太多（<30%），说明 LLM 输出异常或截断
    if (trimmed.length < content.length * 0.3) {
      console.warn(`[MemoryManager] LLM 整理结果过短 (${trimmed.length}/${content.length})，保留原内容`)
      return content
    }
    return trimmed
  } catch (error) {
    console.error('[MemoryManager] LLM 整理失败，返回原内容:', error instanceof Error ? error.message : String(error))
    return content
  }
}
