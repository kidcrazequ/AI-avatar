/**
 * @file palace-panel-logic.ts — 职场（Palace）面板的纯逻辑：智能默认 tab、首跑判定、承诺标题截取
 *
 * 拆出来的原因：这三个判断决定用户第一眼看到什么（UED 审计方案一/二），
 * 必须可以脱离 React 单测（tsx --test），不然回归只能靠手点。
 */

/** 面板可见的 4 个 tab（「我与公司」已并入「资料」置顶两项） */
export type PalaceTabId = 'rooms' | 'commitments' | 'inbox' | 'docs'

/**
 * 智能默认 tab：有待确认先看待确认（用户欠一个决定），
 * 否则有未关闭承诺看承诺（有事在追踪），
 * 否则落路线（首跑必然走这条，能看到三张种子路线卡而不是空表单）。
 */
export function pickDefaultPalaceTab(pendingInboxCount: number, openCommitmentCount: number): PalaceTabId {
  if (pendingInboxCount > 0) return 'inbox'
  if (openCommitmentCount > 0) return 'commitments'
  return 'rooms'
}

/**
 * profile.md / company.md 是否还是「空模板骨架」：
 * 初始模板只有标题（#/##）、引用说明（>）和空行，用户没写过一行正文。
 * 用于首跑引导卡的判定——只要用户填过任何正文，就不再算首跑。
 */
export function isPalaceProfileSkeleton(content: string): boolean {
  return content
    .split('\n')
    .map(line => line.trim())
    .every(line => line === '' || line.startsWith('#') || line.startsWith('>'))
}

/**
 * 首跑判定：承诺 0 条 + 待确认 0 条 + 两份底稿都还是空骨架。
 * 四个条件缺一不可——任何一处有真实数据都说明用户已经用起来了，不再打扰。
 */
export function isPalaceFirstRun(input: {
  commitmentCount: number
  pendingInboxCount: number
  profile: string
  company: string
}): boolean {
  return (
    input.commitmentCount === 0 &&
    input.pendingInboxCount === 0 &&
    isPalaceProfileSkeleton(input.profile) &&
    isPalaceProfileSkeleton(input.company)
  )
}

/**
 * 承诺表单「一句话输入」拆分：整句是承诺正文，标题取首句且 ≤ 30 字。
 * 表单减负的关键——用户只写「谁在什么时候交付什么」，不用再想两个字段怎么分工。
 * 空输入返回 null（调用方负责提示）。
 */
export function deriveCommitmentDraft(text: string): { title: string; promise: string } | null {
  const promise = text.trim()
  if (!promise) return null
  const firstSentence = promise.split(/[。！？!?；;\n]/)[0].trim() || promise
  const title = firstSentence.length > 30 ? `${firstSentence.slice(0, 29)}…` : firstSentence
  return { title, promise }
}
