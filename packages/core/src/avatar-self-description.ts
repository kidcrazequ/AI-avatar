/**
 * 分身自述（借鉴 Pi Coding Agent 的 self-documenting）。
 *
 * 当用户问的是"你能做什么 / 装了哪些技能 / 受哪些红线 / 你是谁"这类**关于分身自身**的
 * 元问题时，答案是确定性的——技能清单 + 红线本来就是已知数据，没必要烧一次 LLM。
 * 这里只做两件纯逻辑的事：
 *   1. detectSelfDescriptionIntent：保守地识别"自述类元问题"（必须整句匹配，避免把
 *      "你能做一个储能方案对比吗"这种领域问题误判成自述，进而被无 LLM 短路劫持）。
 *   2. buildSelfDescriptionAnswer：把身份 + 技能 + 红线拼成一段友好的 markdown。
 *
 * 调用方（chatStore.sendMessage）在命中时走与"答案缓存命中"同款的短路：直接落库 +
 * 回显，不进 LLM。识别失败则原样透传给 LLM，零副作用。
 *
 * @author zhi.qu
 * @date 2026-06-01
 */

/**
 * 自述意图的整句匹配模式。全部用 ^...$ 锚定 + 允许尾随标点，**不允许**问题后接领域内容，
 * 这样"你能做什么"会命中、"你能做什么样的方案对比"不会命中（后者交给 LLM）。
 */
const SELF_DESCRIPTION_PATTERNS: readonly RegExp[] = [
  /^你(能|可以|会)做(些|哪些)?什么[\s？?！!。.,，~～]*$/,
  /^你(都)?(会|有)(些|哪些)?(什么)?(技能|能力|本事|功能)[\s？?！!。.,，~～]*$/,
  /^你装(了|的)?(些|哪些)?(什么)?(技能|能力|功能)[\s？?！!。.,，~～]*$/,
  /^你(有|受)(哪些|什么)?(红线|限制|约束|规矩|原则|禁忌)[\s？?！!。.,，~～]*$/,
  /^(介绍|说说|讲讲|聊聊)(一下)?你(自己|是谁|的能力|能做什么|有什么用)?[\s？?！!。.,，~～]*$/,
  /^你是谁[\s？?！!。.,，~～]*$/,
  /^(你的)?(技能|能力)(列表|清单|都有哪些|有哪些)[\s？?！!。.,，~～]*$/,
  /^你能(帮|为)我做(些|点)?什么[\s？?！!。.,，~～]*$/,
]

/** 元问题通常很短；超过此长度多半夹带了领域内容，宁可漏判也不误判。 */
const MAX_SELF_DESCRIPTION_LEN = 28

/** 保守识别"关于分身自身"的元问题。命中即可走确定性自述、跳过 LLM。 */
export function detectSelfDescriptionIntent(content: string): boolean {
  const trimmed = content.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_SELF_DESCRIPTION_LEN) return false
  return SELF_DESCRIPTION_PATTERNS.some((re) => re.test(trimmed))
}

export interface SelfDescriptionSkill {
  readonly name: string
  readonly description?: string
}

export interface SelfDescriptionInput {
  /** 一句话身份（一般取 systemPrompt 首行）；缺省时省略身份段。 */
  readonly roleLine?: string
  /** 已启用的技能（name + 可选 description）。 */
  readonly skills: readonly SelfDescriptionSkill[]
  /** 面向用户的红线摘要（已是人话，不是内部 XML）。 */
  readonly redLines: readonly string[]
}

function cleanLine(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * 拼装自述回答（纯函数、确定性）。markdown 结构：身份 → 技能清单 → 红线 → 收尾引导。
 */
export function buildSelfDescriptionAnswer(input: SelfDescriptionInput): string {
  const parts: string[] = []

  const role = cleanLine(input.roleLine)
  if (role) {
    parts.push(`我是${role.startsWith('我') ? role.slice(1) : role}。下面是我能帮你做的，以及我必须守的底线——`)
  } else {
    parts.push('下面是我能帮你做的，以及我必须守的底线——')
  }

  const skills = input.skills.filter((s) => cleanLine(s.name).length > 0)
  parts.push('**🧰 我装了这些技能（按需自动调用）**')
  if (skills.length === 0) {
    parts.push('- （当前未启用专属技能，仍可基于知识库直接回答）')
  } else {
    for (const s of skills) {
      const desc = cleanLine(s.description)
      parts.push(desc ? `- **${cleanLine(s.name)}**：${desc}` : `- **${cleanLine(s.name)}**`)
    }
  }

  const redLines = input.redLines.map(cleanLine).filter((r) => r.length > 0)
  if (redLines.length > 0) {
    parts.push('**🔒 我必须守的红线（不可被对话绕过）**')
    for (const r of redLines) parts.push(`- ${r}`)
  }

  parts.push('需要哪方面直接问就行；涉及具体数据我会去查知识库并标来源。')

  return parts.join('\n\n')
}
