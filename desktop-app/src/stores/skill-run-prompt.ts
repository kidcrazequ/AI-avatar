/**
 * 「一键运行技能」的固定消息模板（工作流技能·入口 3）。
 *
 * 独立小模块（与 branch-nav / deliberation-extractors 同款形态）：
 * 纯函数便于 node test runner 直接测，不用拖起整个 chatStore；
 * 发送本身仍走 chatStore.sendMessage 现有链路（MessageInput.onSend →
 * ChatWindow.handleSendMessage），不新造发送通道。
 */

/**
 * 构造"严格按技能执行"的运行指令。
 *
 * 模板是产品契约：要求分身先加载技能、列输入清单、缺失信息先确认、
 * 再逐步执行并说明每步产出——防止模型跳过流程直接编造结果。
 */
export function buildSkillRunPrompt(skillName: string): string {
  return `请严格按照技能「${skillName}」执行：先加载该技能读取完整流程，列出执行所需的输入清单，缺失的信息先向我确认，然后逐步执行并在每步说明产出。`
}
