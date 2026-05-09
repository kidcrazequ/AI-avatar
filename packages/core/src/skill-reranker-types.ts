/**
 * ISS 重排器可见的最小工具形状（与桌面端 {@link LLMTool} 对齐字段子集）。
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

export interface ToolForRerank {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}
