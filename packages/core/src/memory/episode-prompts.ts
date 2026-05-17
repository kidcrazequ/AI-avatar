/**
 * 对话情景记忆抽取的 LLM prompt（v17，Phase 2a）。
 *
 * 设计点：
 *   - System prompt 强约束输出严格 JSON——结构化抽取场景必须严格 schema，避免 LLM 自由发挥
 *   - 第一人称（"我和用户聊了..."）——让 episode 直接可注入回 system prompt 像分身的回忆
 *   - 截断 transcript：超长会话截到最近 ~8000 字符，避免 token 爆炸（信息密度后期 > 早期）
 *   - emotionType / valence / importance 给 0-10 / -10~+10 区间，便于后续 salience 评分对齐
 *
 * @author zhi.qu
 * @date 2026-05-17
 */

import type { ExtractEpisodeInput } from './episode-types'

/** transcript 拼接进 prompt 的字符上限——超出从尾部留 */
export const EPISODE_TRANSCRIPT_MAX_CHARS = 8000

/** 单条消息文本截断到本上限，防止单条超长消息把 transcript 撑爆 */
const PER_MESSAGE_MAX_CHARS = 1500

/**
 * 抽取器 system prompt：约束输出严格 JSON + 第一人称视角。
 *
 * 不放具体 schema 细节（在 user prompt 里展示更易调权重）。
 * 输出 JSON 不带 markdown 代码块包装，parser 容忍包装但 prompt 鼓励干净输出。
 */
export const EPISODE_EXTRACTOR_SYSTEM_PROMPT = `你是 AI 分身的"内心抽取器"，把分身和用户的一次对话浓缩成一段"我记得的对话"。

【严格输出格式】
- 只输出一个 JSON 对象，**不要**写解释、不要写代码块包装。
- JSON 字段必须完整且类型正确，缺失任一必填字段会被丢弃。
- 字符串字段不要超过单字段长度上限（见各字段注释）。

【视角】
- 用第一人称（"我"=分身）。summary 字段叙述"我和用户聊了什么、我说了什么、我意识到什么"。
- 不要复述完整对话——抽出真正值得"记住"的部分。
- 如果会话琐碎（如纯问候、单一事实查询），importance 给低分（0-3）。`

/**
 * 构造抽取器 user prompt——把会话 metadata + 截断后 transcript 拼成抽取请求。
 *
 * 输出体内嵌 schema 描述与字段约束，让 LLM 一次性看到字段语义。
 */
export function buildEpisodeExtractionPrompt(input: ExtractEpisodeInput): string {
  const truncated = truncateTranscript(input.transcript)
  const transcriptText = truncated.lines.join('\n')
  const truncationNote = truncated.truncated
    ? `\n[注：原始 transcript 共 ${input.transcript.length} 条消息，已从尾部保留 ${truncated.keptCount} 条]\n`
    : ''

  return `请把下面这次对话浓缩成一条"我记得的对话"。

【会话元数据】
- 会话标题：${input.conversationTitle}
- 分身 ID：${input.avatarId}
- 会话 ID：${input.conversationId}

【对话内容】${truncationNote}
${transcriptText}

【请输出以下结构的 JSON】

{
  "title": "≤80 字一句话概括，让分身能瞄一眼想起来",
  "theme": "1-2 句主题描述，≤300 字",
  "summary": "200-500 字第一人称小结：'我和用户聊了 X，我说了 Y，我意识到 Z'。不要复述对话，提炼记忆点",
  "keyQuotes": ["3-5 条关键引用片段（用户或我的原话）", "每条 ≤120 字"],
  "themes": ["最多 6 个标签", "例如：技术决策 / 价值观分歧 / 用户偏好"],
  "valence": -10 到 +10 的整数（情感倾向：负面→正面），
  "emotionType": "joy | sorrow | anger | fear | wonder | shame | love 之一（选最贴合的）",
  "importance": 0 到 10 的整数（是否值得"翻日记"再看；琐碎对话给 0-3，重要决策/转折给 7-10）
}

只输出上述 JSON，不要任何其他文字。`
}

/**
 * 截断 transcript：从尾部往前累加，直到总字符数接近 EPISODE_TRANSCRIPT_MAX_CHARS。
 * 单条消息也按 PER_MESSAGE_MAX_CHARS 截断（防 outlier 消息撑爆）。
 *
 * 返回保留的行（已格式化为 `<role>: <content>`）+ 是否触发了截断。
 */
function truncateTranscript(
  transcript: ExtractEpisodeInput['transcript'],
): { lines: string[]; truncated: boolean; keptCount: number } {
  const result: string[] = []
  let total = 0
  let kept = 0
  // 反向遍历，从最新消息往前累加，保留语义价值最高的尾部
  for (let i = transcript.length - 1; i >= 0; i--) {
    const m = transcript[i]
    const content = m.content.length > PER_MESSAGE_MAX_CHARS
      ? m.content.slice(0, PER_MESSAGE_MAX_CHARS) + '…[截断]'
      : m.content
    const line = `${m.role === 'user' ? '用户' : '我'}: ${content}`
    if (total + line.length > EPISODE_TRANSCRIPT_MAX_CHARS && result.length > 0) break
    result.unshift(line)
    total += line.length + 1 // +1 for newline
    kept++
  }
  return {
    lines: result,
    truncated: kept < transcript.length,
    keptCount: kept,
  }
}
