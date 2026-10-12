/**
 * skill-id.ts — 技能 ID 安全化（纯函数，浏览器安全）
 *
 * 把任意字符串收敛成可作文件系统 / URL 片段的技能 ID：仅保留 [A-Za-z0-9_-]，
 * 其余字符折叠为 '-'，再合并连续 '-' 并去首尾 '-'。无法产出有效字符时返回空串。
 *
 * 主进程安装（落盘目录名）与渲染端「已安装」判定共用此函数，保证两侧 ID 口径一致，
 * 避免含特殊字符的 skillId 在一侧被 sanitize、另一侧用原值比对而误判。
 */
export function safeSkillId(raw: string): string {
  if (typeof raw !== 'string') return ''
  return raw
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}
