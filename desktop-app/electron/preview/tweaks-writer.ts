/**
 * Tweaks 协议回写器：把页面中 EDITMODE-BEGIN/END 块中的 JSON 配置原子替换为新值。
 *
 * 协议约定（写在 LLM 生成的 HTML 文件里）：
 *
 *   <!-- EDITMODE-BEGIN id="hero-config" -->
 *   <script type="application/json" id="hero-config">
 *   { "title": "Hello", "color": "#3b82f6" }
 *   </script>
 *   <!-- EDITMODE-END -->
 *
 * 用户在预览里调整 Tweaks UI 之后，preview-preload 通过
 * postMessage(__edit_mode_save, values) 把新值送回主进程，主进程调
 * applyTweaks 写回原文件。下一次 LLM 重新读取时即可看到新配置。
 *
 * @author zhi.qu
 * @date 2026-04-28
 */

import fs from 'fs'
import path from 'path'

export interface ApplyTweaksOptions {
  /** 源 HTML 绝对路径 */
  htmlAbsPath: string
  /** EDITMODE 块的 id（与 <!-- EDITMODE-BEGIN id="..." --> 保持一致） */
  blockId: string
  /** 完整新 JSON 对象 */
  newValues: Record<string, unknown>
  /** 是否做备份（默认 true，写到 .htmlAbsPath.bak） */
  backup?: boolean
}

export interface ApplyTweaksResult {
  /** 修改后的字节数 */
  bytes: number
  /** 是否真有修改（false 表示 newValues 和原值字符串相同，跳过写盘） */
  changed: boolean
  /** 备份文件路径（如果开启了 backup） */
  backupPath?: string
}

/**
 * 用三段式正则定位 EDITMODE 块：
 *   - 起始注释  <!-- EDITMODE-BEGIN id="<blockId>" -->
 *   - JSON body（任意内容，懒匹配）
 *   - 结束注释  <!-- EDITMODE-END -->
 * blockId 经 regex escape，避免 ID 包含 . * 等元字符时误匹配。
 */
function buildBlockRegex(blockId: string): RegExp {
  const escaped = blockId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(
    `(<!--\\s*EDITMODE-BEGIN\\s+id="${escaped}"\\s*-->)([\\s\\S]*?)(<!--\\s*EDITMODE-END\\s*-->)`,
    'm',
  )
}

/**
 * 原子替换：先校验 newValues 可以被序列化，再用临时文件 + rename 完成写入。
 * 若没找到匹配的 EDITMODE 块，抛出错误（避免静默写不进去）。
 */
export function applyTweaks(options: ApplyTweaksOptions): ApplyTweaksResult {
  const abs = path.resolve(options.htmlAbsPath)
  if (!fs.existsSync(abs)) {
    throw new Error(`tweaks 源文件不存在: ${abs}`)
  }
  const content = fs.readFileSync(abs, 'utf-8')
  const regex = buildBlockRegex(options.blockId)
  const match = content.match(regex)
  if (!match) {
    throw new Error(`未找到 EDITMODE 块 id="${options.blockId}"`)
  }

  const newJsonText = JSON.stringify(options.newValues, null, 2)
  // 保留外层 <script type="application/json" id="..."> 包装，仅替换 JSON 文本
  const innerNew = `\n<script type="application/json" id="${options.blockId}">\n${newJsonText}\n</script>\n`
  const replaced = content.replace(regex, `$1${innerNew}$3`)

  if (replaced === content) {
    return { bytes: content.length, changed: false }
  }

  let backupPath: string | undefined
  if (options.backup !== false) {
    backupPath = abs + '.bak'
    fs.writeFileSync(backupPath, content, 'utf-8')
  }

  // 原子写：tmp + rename
  const tmp = abs + `.tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  fs.writeFileSync(tmp, replaced, 'utf-8')
  fs.renameSync(tmp, abs)

  return {
    bytes: replaced.length,
    changed: true,
    backupPath,
  }
}
