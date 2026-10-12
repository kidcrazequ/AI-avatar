/**
 * 文档生成 HTML 渲染的 CSS 模板加载器
 *
 * 设计动机：每个分身可以在 `<avatarRoot>/document-templates/<name>.css` 提供
 * 自己的渲染模板（页眉页脚、品牌色、表格风格等），无模板时回退为 default。
 *
 * 安全约束：
 *   - templateName 必须经 assertSafeSegment 校验（防止路径穿越）
 *   - 真正读盘的路径必须 resolveUnderRoot，不允许逃出 document-templates 目录
 *   - 文件不存在或读失败时返回空字符串而非抛错（让上层渲染降级到内置基础样式）
 *
 * @author zhi.qu
 * @date 2026-05-08
 */

import fs from 'fs'
import path from 'path'
import { assertSafeSegment, resolveUnderRoot } from '../../utils/path-security'

const TEMPLATE_DIR_NAME = 'document-templates'
const TEMPLATE_FILE_EXT = '.css'

/**
 * 从分身根目录加载指定名称的 CSS 模板。
 *
 * @param avatarRoot 分身根目录绝对路径
 * @param name       模板名（不含 .css 后缀），缺省 'default'
 * @returns          CSS 文本；不存在或失败时返回空串
 */
export function loadTemplateCss(avatarRoot: string, name = 'default'): string {
  if (!avatarRoot) return ''
  try {
    assertSafeSegment(name, '文档模板名')
  } catch {
    return ''
  }

  let absPath: string
  try {
    const dir = resolveUnderRoot(avatarRoot, TEMPLATE_DIR_NAME)
    absPath = resolveUnderRoot(dir, name + TEMPLATE_FILE_EXT)
  } catch {
    return ''
  }

  try {
    if (!fs.existsSync(absPath)) return ''
    const stat = fs.statSync(absPath)
    if (!stat.isFile()) return ''
    return fs.readFileSync(absPath, 'utf-8')
  } catch {
    return ''
  }
}

/**
 * 计算模板文件的绝对路径，用于错误提示与日志。
 * 不读盘。无效输入抛错（路径穿越 / 非法 name 由 path-security 抛）。
 */
export function resolveTemplatePath(avatarRoot: string, name = 'default'): string {
  assertSafeSegment(name, '文档模板名')
  const dir = resolveUnderRoot(avatarRoot, TEMPLATE_DIR_NAME)
  return path.join(dir, name + TEMPLATE_FILE_EXT)
}
