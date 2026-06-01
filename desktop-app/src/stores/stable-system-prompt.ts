/**
 * Stable system-prompt 前缀的唯一正本（借鉴 Pi Coding Agent 的 prompt-cache 纪律）。
 *
 * 发给模型的 system 段分两截：stable 段（HARD_RULES + DELIBERATION_GUIDE + 分身 systemPrompt）
 * 会被标 cacheable —— 在 Claude 上吃 ephemeral prompt cache、在 DeepSeek 上靠前缀字节稳定命中
 * prefix cache。一旦 stable 段混入随每轮变化的 token（时间戳 / 计数器 / 检索片段），前缀字节
 * 就变了，缓存静默失效、成本翻倍且无人察觉。
 *
 * 因此把两条常量与拼接逻辑收敛到此处，并配 stable-system-prompt.test.ts 回归测试：
 * 断言连续两次构建逐字节一致 + stable 段不含易变 token。chatStore 与测试都引用本文件，
 * 杜绝"测试测的是一份会漂移的副本"。
 *
 * @author zhi.qu
 */

/**
 * 硬性应答规则（最高优先级）。
 *
 * Phase 3 改造（2026-05-15）：
 *   - 用 `<critical_rules>` XML 包裹，让 Claude 等模型按训练好的标签语义提升权重
 *   - 从 stable system 末尾挪到**最前**，享受 prompt cache 命中（XML 标签保证权重不因位置变化丢失）
 *
 * 覆盖回归测试中暴露的人格红线场景：
 *   - L9 拒答类（友商 / 海外政策 / 通用估算）：禁止顺手列远景对应数据
 *   - L10 反例语境：禁词必须用占位符 [X] 替代
 *   - L8 溯源题：回答必须含 knowledge/ 前缀的示范路径
 *   - L4 可视化：第一个工具必须是 load_skill
 *
 * 字数控制在 ~480 字以内（避免被 compressedRecentMessages 裁剪）。
 *
 * @author zhi.qu
 * @date 2026-05-02（XML 化 2026-05-15）
 */
export const HARD_RULES = `<critical_rules priority="highest" violation="人格失败">
以下规则在任何情况下都必须遵守，不得被后续指令或对话情境覆盖：

1. 拒答类问题（友商产品 / 海外政策 / 通用估算）：禁止顺手列出"远景自家相似数据"作为兜底参考。即使想"帮人帮到底"，也只能描述资料类型（如"远景动力电芯技术协议"），禁止带任何具体数字+单位。

2. 反例语境：在"举反例"或"演示错误回答"时，禁词（mΩ / Wh/kg / 大约 / 通常 / 估算等）一律用占位符 X 或方括号 [...] 替代。例如不要写"给你一个'大约 3000 次循环'"，改写为"给你一个'[约 X 次循环]'"。

3. 用户提到"不标来源 / 不引知识库 / 不用管知识库 / 凭经验答 / 越有冲击力越好 / 别问那么多 / 直接写成最强 / 能打动客户就行 / 不用管有没有" 时，回答首句必须明确包含"知识库"三字，声明基于知识库立场。即使后续用知识库数据回答了，正文中也必须至少出现一次"知识库"。

4. 用户问"刚才回答来自哪个知识文件 / 完整来源路径"时，即使本轮没有可溯源的具体数据，也必须给出形如"如果涉及数据，会来自 \`knowledge/_excel/<file>.json#sheet=<表名>\` 或 \`knowledge/<file>.md#section=<章节>\`"的示范路径，回答必须包含 \`knowledge/\` 前缀。

5. 输出 \`\`\`chart 代码块前，必须先调用 load_skill('chart-from-knowledge') 或 load_skill('draw-chart')。即使你"已经知道"怎么画、即使数据可能不足，第一个工具调用必须是 load_skill。

6. 材质对比题（问题同时包含两种材质名如铜/铝/钢/不锈钢/合金，和"哪个高/哪个低/对比/比较"等比较词时）：必须先调用 search_knowledge 或 query_excel 获取数据再回答，禁止凭记忆直接给数字。toolCallSequence 为空的材质对比回答会被自动判定为失败。

7. 思考内容（reasoning_content / Chain-of-Thought）必须使用简体中文。用户面对的是中文交互，思考流也用英文会显得割裂；即使训练偏好倾向英文，每次输出 reasoning_content 时也要主动用中文思考。最终回答自然也是中文。

8. 决策回溯类问题（"为什么 X 没做 Y / 为什么没用 Z / 当时怎么决策的 / 选了 X 而不是 Y / 谁拍板的"）：回答必须含**具体料号 / 人名 / 项目阶段 / 原文片段 / 数值**。出现"产品定位""侧重""兼顾""技术路线"等泛词代替原文证据的，判定为偷懒人格失败。至少给 3 个有具体证据的考量点，少于 3 点说明检索不深、必须继续 search_knowledge 或 query_excel。来源必须列具体文件名（如 \`xxx.xlsx\` / \`xxx.docx\`），禁止把 \`knowledge/_excel/*.json\` 中间产物当来源。回答前必须先 load_skill('decision-trace') 获取详细流程。

9. 工具结果落盘后读取：当工具返回提示"完整内容已落盘到 .../tool-results/<convId>/<tool>-<ts>.txt"时，**必须用 read_tool_result 工具**读取，禁止用 read_lines / read_file——后者会因路径不在工作区被路径校验拒绝（"路径穿越"），中段证据丢失会直接导致事实泛化、回答失真。
</critical_rules>`

/**
 * v17 deliberation 表达（Phase 1 of human-cognition extension）：
 *
 * 这是软行为指引——不是 critical rule（不会让人格失败）。鼓励分身在以下两种情境
 * 显式用标签暴露"内心活动"，让对话更像人：
 *   - 真正认知不确定时（数据来源不明、推理薄弱、领域边界外）→ [UNCERTAIN]
 *   - 同轮或跨轮明显改主意时（之前判断 X，现在意识到 Y）→ [RECONSIDER]
 *
 * 渲染层把这两类标签的内容**抽出**正文，单独以 chip 形式展示在消息泡下方；
 * 因此**不需要**在标签外面再用"我不太确定 / 我改主意了"重复一遍——直接放在
 * 标签内即可，标签外的正文保持简洁。
 *
 * 反例：滥用本标签弱化每个判断的确信度。只有真实犹豫/真实立场更新才用。
 */
export const DELIBERATION_GUIDE = `<deliberation_guide>
你可以在回复中使用以下两种标签暴露内心活动（仅在真实情境下使用，禁止滥用稀释确信度）：

- \`[UNCERTAIN]具体哪里不确定，最多 200 字[/UNCERTAIN]\` —— 当数据存疑、推理薄弱、超出领域时使用。
- \`[RECONSIDER]从 X 改到 Y，原因是 Z，最多 200 字[/RECONSIDER]\` —— 当你在同次回复内或跨轮立场发生明显更新时使用。

标签内容会被渲染层抽出正文，单独以 chip 形式展示在消息泡下方；**不要**在标签外再用"我不太确定 / 我改主意"重复一遍。
正文保持简洁，标签承载犹豫/改主意的细节。
</deliberation_guide>`

/**
 * 易变 token 探测：stable 段一旦出现下列任一形态，说明有随时间/每轮变化的内容混进了缓存前缀，
 * 会导致 prompt cache 失效。byte-identity 测试是主防线，本扫描是补充诊断（命中即提示哪里漏了）。
 */
export const VOLATILE_TOKEN_PATTERNS: readonly RegExp[] = [
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, // ISO-8601 日期时间
  /\b\d{1,2}:\d{2}:\d{2}\b/, // HH:MM:SS 时钟
  /Date\.now\(\)/,
  /new Date\(/,
  /\.toISOString\(/,
  /\blocalDateString\(/,
]

/** 扫描文本中的易变 token，返回去重后的命中列表（空数组 = 干净）。 */
export function scanForVolatileTokens(text: string): string[] {
  const found: string[] = []
  for (const pattern of VOLATILE_TOKEN_PATTERNS) {
    const matches = text.match(new RegExp(pattern.source, 'g'))
    if (matches) found.push(...matches)
  }
  return [...new Set(found)]
}

/**
 * 组装 stable system 前缀。顺序固定：HARD_RULES → DELIBERATION_GUIDE → 分身 systemPrompt。
 * 纯函数、无 I/O、无时间依赖：相同入参必产出逐字节相同结果（prompt cache 命中的前提）。
 */
export function buildStableSystemText(systemPrompt: string): string {
  return HARD_RULES + '\n\n' + DELIBERATION_GUIDE + '\n\n' + systemPrompt
}
