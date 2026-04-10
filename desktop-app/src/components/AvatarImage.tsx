/**
 * @file AvatarImage.tsx — 分身头像统一展示组件
 * @author zhi.qu
 * @date 2026-04-10
 *
 * 处理三种头像来源：
 * - "default:<key>"  → 渲染内置预置 SVG
 * - data URL         → 渲染 <img> 并启用像素渲染
 * - undefined/空     → 回退为首字符方块（向后兼容）
 */

import { memo } from 'react'
import { getDefaultAvatarSvg } from './DefaultAvatars'

type AvatarSize = 'sm' | 'md' | 'lg'

interface Props {
  /** 头像值：data URL、"default:<key>" 或 undefined */
  avatarImage?: string
  /** 分身名称，用于首字符回退 */
  name: string
  /** 展示尺寸 */
  size: AvatarSize
  /** 额外 CSS 类名 */
  className?: string
}

/** 各尺寸对应的像素大小 */
const SIZE_PX: Record<AvatarSize, number> = {
  sm: 28,
  md: 40,
  lg: 64,
}

/** 各尺寸对应的字体大小（首字符回退用） */
const FONT_SIZE: Record<AvatarSize, string> = {
  sm: 'text-[11px]',
  md: 'text-[14px]',
  lg: 'text-[22px]',
}

const AvatarImage = memo(function AvatarImage({ avatarImage, name, size, className = '' }: Props) {
  const px = SIZE_PX[size]
  const initials = name?.charAt(0)?.toUpperCase() || '?'

  const baseStyle: React.CSSProperties = { width: px, height: px, flexShrink: 0 }

  // 预置 SVG 头像
  if (avatarImage?.startsWith('default:')) {
    const key = avatarImage.slice(8)
    const svg = getDefaultAvatarSvg(key)
    if (svg) {
      return (
        <div
          style={baseStyle}
          className={`border-2 border-px-border bg-px-bg overflow-hidden ${className}`}
          aria-label={name}
          role="img"
        >
          <div style={{ width: px, height: px, imageRendering: 'pixelated' }}>
            {svg}
          </div>
        </div>
      )
    }
  }

  // 自定义上传图片（data URL）
  if (avatarImage && avatarImage.startsWith('data:')) {
    return (
      <img
        src={avatarImage}
        alt={name}
        style={{ ...baseStyle, imageRendering: 'pixelated' }}
        className={`border-2 border-px-border object-cover ${className}`}
      />
    )
  }

  // 回退：首字符方块
  return (
    <div
      style={baseStyle}
      className={`bg-px-primary flex items-center justify-center font-game ${FONT_SIZE[size]} text-white ${className}`}
      aria-label={name}
      role="img"
    >
      {initials}
    </div>
  )
})

export default AvatarImage
