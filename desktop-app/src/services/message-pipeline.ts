/**
 * 消息管线原语（AstrBot 借鉴 · 阶段 1a）。
 *
 * 背景：chatStore.sendMessage 是一个 ~3000 行的巨函数，把边界护栏 / 澄清闸门 /
 * palace 召回 / memory nudge / 图表强制等 LLM 调用前的关注点全部内联焊死，每加一个
 * 行为都要"找缝插针"。本模块抄 AstrBot pipeline 的**有序 stage + 短路**语义，把这些
 * 拦截/增补动作解耦成独立、可开关、可单测的 stage。
 *
 * 本文件只提供原语（类型 + runner），不改动发送链路；拦截器的实际迁移在后续 slice（1b）。
 *
 * 设计取舍（对齐 AstrBot AGENTS.md 的 KISS / inline-first）：只在"接缝处"解耦，stage
 * 内部逻辑保持内联；runner 只做编排，不做 try/catch（增益类失败不应中断发送——由各
 * stage 自身兜底，与现有 palace 召回 / memory 复盘的写法一致）。
 */

import type { SystemBlock } from './llm-service'

/**
 * 短路结果：某个 stage 决定不进 LLM 时置于 ctx.outcome，由调用方按类型处理。
 * - canned-answer：边界护栏——直接回一段定式答案。
 * - clarify：澄清闸门——弹一张澄清卡片，等用户选定后合并重发。
 */
export type PipelineOutcome =
  | { kind: 'canned-answer'; text: string; sourceType?: string }
  | { kind: 'clarify'; question: string; options: string[]; original: string }

/**
 * 随消息流动、被各 stage 读写的上下文（对应 AstrBot 的 AstrMessageEvent）。
 * conversationId / avatarId / hasAttachments 为只读输入；content / systemBlocks
 * 可被增益类 stage 修改；outcome 由短路类 stage 置位。
 */
export interface MessageContext {
  readonly conversationId: string
  readonly avatarId: string
  /** 用户消息文本，stage 可改写（如 memory nudge 在末尾追加提示） */
  content: string
  /** 系统提示块，stage 可增补（如 palace 命中路线卡时注入上下文卡） */
  systemBlocks: SystemBlock[]
  /** 本条消息是否带图片/附件（部分 stage 据此跳过，避免丢附件） */
  readonly hasAttachments: boolean
  /** 非空即短路：不再进 LLM，由调用方按 outcome 类型处理 */
  outcome: PipelineOutcome | null
}

/** 一个 LLM 调用前的拦截/增补步骤。 */
export interface MessageStage {
  readonly name: string
  run(ctx: MessageContext): void | Promise<void>
}

/**
 * 按序执行 LLM 调用前的 stage。任一 stage 置 ctx.outcome 即短路，后续 stage 不再执行
 * ——以此保证优先级（如边界护栏先于澄清闸门；短路后不再跑 palace 等增益 stage）。
 *
 * @returns 同一个 ctx（就地修改），便于调用方读取 outcome / content / systemBlocks。
 */
export async function runPreMessageStages(
  ctx: MessageContext,
  stages: readonly MessageStage[],
): Promise<MessageContext> {
  for (const stage of stages) {
    if (ctx.outcome) break
    await stage.run(ctx)
  }
  return ctx
}

/**
 * LLM 回复完成后的后处理上下文（记忆复盘 / 情景抽取等 fire-and-forget 副作用）。
 * 这些副作用围绕会话本身（经 IPC 操作），只需 conversationId / avatarId。
 */
export interface PostMessageContext {
  readonly conversationId: string
  readonly avatarId: string
}

/** 一个 LLM 回复后的后处理步骤。 */
export interface PostMessageStage {
  readonly name: string
  run(ctx: PostMessageContext): void | Promise<void>
}

/**
 * fire-and-forget 执行后处理 stage：回复已送达用户，后处理绝不阻塞或中断彼此，也不阻塞
 * 调用方。每个 stage 立即启动、独立运行；stage 自身负责 try/catch 与日志（与迁移前的
 * `void (async () => {})()` 块一致），runner 只做防御性兜底吞掉未捕获的 rejection。
 *
 * 与 pre-message 的区别：post 无短路语义——所有 stage 都各跑各的。
 */
export function runPostMessageStages(
  ctx: PostMessageContext,
  stages: readonly PostMessageStage[],
): void {
  for (const stage of stages) {
    try {
      const maybe = stage.run(ctx)
      if (maybe instanceof Promise) void maybe.catch(() => { /* stage 自身已兜底；防御性吞掉 */ })
    } catch { /* 同步抛出的防御性兜底 */ }
  }
}
