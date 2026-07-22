/**
 * LLM 调用前的拦截/增补 stage 集合（AstrBot 借鉴 · 阶段 1b）。
 *
 * 把原先内联在 chatStore.sendMessage 里的拦截器逐个迁到这里，成为独立、可测、可开关的
 * stage。每个 stage 的内部逻辑保持与迁移前**逐行等价**（KISS / inline-first），只是从
 * 巨函数里搬出来，由 runPreMessageStages 按序编排。
 *
 * 迁移进度：
 *   - [x] palace 路线卡召回（增补 systemBlocks）
 *   - [ ] 边界护栏（短路 canned-answer）
 *   - [ ] 澄清闸门（短路 clarify）
 *   - [ ] memory nudge（改写 content）
 */

import type { MessageStage } from './message-pipeline'

/**
 * 职场路线卡确定性召回（问题1·B）。命中触发级路线卡时，把"任务前上下文包"增补进
 * ctx.systemBlocks，让分身按该路线的必读文件/读法/雷区作答。
 *
 * best-effort：未命中/出错静默跳过；带附件跳过（原逻辑：图片消息不召回）。
 * isStale 由调用方注入——await 召回期间用户可能切走会话，切走则不注入（防跨会话污染）。
 */
export function palaceRecallStage(deps: { isStale: () => boolean }): MessageStage {
  return {
    name: 'palace-recall',
    run: async (ctx) => {
      if (ctx.hasAttachments) return
      try {
        const recalled = await window.electronAPI.palace.recallForMessage(ctx.avatarId, ctx.content)
        if (recalled && !deps.isStale()) {
          ctx.systemBlocks.push({
            text:
              `\n\n[职场·路线卡预载 · ${recalled.roomName}]\n` +
              `本轮任务命中职场路线卡，已预载"任务前上下文包"。请据此按该路线的必读文件 / 读法顺序 / ` +
              `雷区提示作答；如需更多素材再调用相应工具。\n\n${recalled.card}`,
          })
          window.electronAPI.logEvent(
            'info',
            'palace-recall-fired',
            `conv=${ctx.conversationId} room=${recalled.roomId} score=${recalled.score}`,
          )
        }
      } catch (palaceErr) {
        window.electronAPI.logEvent(
          'warn',
          'palace-recall-failed',
          palaceErr instanceof Error ? palaceErr.message : String(palaceErr),
        )
      }
    },
  }
}
