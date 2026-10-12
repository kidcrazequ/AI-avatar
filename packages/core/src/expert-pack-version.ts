/**
 * 专家包版本比较 / 更新检测（借鉴 Pi Coding Agent 的整包版本钉 + check-update）。
 *
 * 让一个 expert-pack 成为"可版本化、可钉、可更新"的分发单元：manifest 带 version，
 * 安装时记录 version + 来源（source/sourceRef）；之后比对"已安装版本"与"当前可得版本"
 * 即可判断是否有更新。本文件只放纯逻辑（语义化版本比较 + 更新判定），无 I/O，便于单测。
 *
 * @author zhi.qu
 * @date 2026-06-01
 */

/** 解析 "1.2.3" → [1,2,3]；缺位补 0；非数字段按 0 处理（容错，不抛）。 */
function parseVersionParts(version: string): number[] {
  return version
    .trim()
    .replace(/^v/i, '')
    .split('.')
    .map((seg) => {
      const n = parseInt(seg, 10)
      return Number.isNaN(n) ? 0 : n
    })
}

/**
 * 语义化版本比较：a<b 返回 -1，a==b 返回 0，a>b 返回 1。
 * 按段数值比较（1.10.0 > 1.9.9，不走字典序）；段数不齐时短的补 0。
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersionParts(a)
  const pb = parseVersionParts(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x < y) return -1
    if (x > y) return 1
  }
  return 0
}

export interface PackUpdateEvaluation {
  readonly hasUpdate: boolean
  readonly installedVersion: string
  readonly availableVersion: string
}

/**
 * 判断"可得版本"是否比"已安装版本"更新。仅当 available 严格大于 installed 时 hasUpdate=true
 * （相等或更旧都不是更新；后者多为用户手动降级，不主动提示升级）。
 */
export function evaluatePackUpdate(
  installedVersion: string,
  availableVersion: string,
): PackUpdateEvaluation {
  return {
    hasUpdate: compareVersions(availableVersion, installedVersion) > 0,
    installedVersion,
    availableVersion,
  }
}
