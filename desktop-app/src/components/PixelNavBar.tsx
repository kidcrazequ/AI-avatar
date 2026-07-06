/**
 * @file PixelNavBar.tsx — 像素 RPG 风格顶栏导航标签组
 * @author zhi.qu
 * @date 2026-04-10
 */

import { useEffect, useRef, useState } from 'react'

interface NavItem {
  label: string
  icon: string
  key: string
  onClick: () => void
  active: boolean
  badge?: number | null
  /** 悬停提示：一句话说明这个入口是干什么的 */
  title?: string
}

interface PixelNavBarProps {
  items: NavItem[]
}

const PRIMARY_NAV_KEYS = new Set(['soul', 'skills', 'docs', 'mem', 'palace', 'life', 'user'])

export default function PixelNavBar({ items }: PixelNavBarProps) {
  const [isMoreOpen, setIsMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)
  const primaryItems = items.filter(item => PRIMARY_NAV_KEYS.has(item.key))
  const overflowItems = items.filter(item => !PRIMARY_NAV_KEYS.has(item.key))
  const moreActive = overflowItems.some(item => item.active)

  useEffect(() => {
    if (!isMoreOpen) return

    const handlePointerDown = (event: MouseEvent) => {
      if (!(event.target instanceof Node)) return
      if (!moreRef.current?.contains(event.target)) {
        setIsMoreOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
    }
  }, [isMoreOpen])

  return (
    <nav className="pixel-nav-bar" aria-label="分身工作区导航">
      <div className="pixel-nav-primary">
        {primaryItems.map(item => (
          <NavTab key={item.key} item={item} />
        ))}
      </div>

      {overflowItems.length > 0 && (
        <div ref={moreRef} className="pixel-nav-more">
          <span className="pixel-nav-sep" aria-hidden="true" />
          <button
            type="button"
            className={`pixel-nav-tab pixel-nav-more-trigger ${moreActive ? 'pixel-nav-tab--active' : ''}`}
            aria-haspopup="menu"
            aria-expanded={isMoreOpen}
            onClick={() => setIsMoreOpen(open => !open)}
          >
            {moreActive && (
              <span className="pixel-nav-cursor" aria-hidden="true">►</span>
            )}
            <span className="pixel-nav-icon" aria-hidden="true">▣</span>
            <span className="pixel-nav-label">更多</span>
          </button>
          {isMoreOpen && (
            <div className="pixel-nav-more-menu" role="menu">
              {overflowItems.map(item => (
                <button
                  key={item.key}
                  type="button"
                  role="menuitem"
                  title={item.title}
                  className={`pixel-nav-menu-item ${item.active ? 'pixel-nav-menu-item--active' : ''}`}
                  onClick={() => {
                    item.onClick()
                    setIsMoreOpen(false)
                  }}
                >
                  <span className="pixel-nav-icon" aria-hidden="true">{item.icon}</span>
                  <span className="pixel-nav-label">{item.label}</span>
                  {item.badge !== null && item.badge !== undefined && item.badge > 0 && (
                    <span className="pixel-nav-badge">{item.badge}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </nav>
  )
}

function NavTab({ item }: { item: NavItem }) {
  return (
    <button
      role="tab"
      aria-selected={item.active}
      onClick={item.onClick}
      className={`pixel-nav-tab ${item.active ? 'pixel-nav-tab--active' : ''}`}
      aria-label={item.label}
      title={item.title}
    >
      {item.active && (
        <span className="pixel-nav-cursor" aria-hidden="true">►</span>
      )}
      <span className="pixel-nav-icon" aria-hidden="true">{item.icon}</span>
      <span className="pixel-nav-label">{item.label}</span>
      {item.badge !== null && item.badge !== undefined && item.badge > 0 && (
        <span className="pixel-nav-badge">{item.badge}</span>
      )}
    </button>
  )
}
