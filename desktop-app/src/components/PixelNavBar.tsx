/**
 * @file PixelNavBar.tsx — 像素 RPG 风格顶栏导航标签组
 * @author zhi.qu
 * @date 2026-04-10
 */

interface NavItem {
  label: string
  icon: string
  key: string
  onClick: () => void
  active: boolean
  badge?: number | null
}

interface PixelNavBarProps {
  items: NavItem[]
}

export default function PixelNavBar({ items }: PixelNavBarProps) {
  const mainItems = items.filter(i => i.key !== 'set')
  const utilItems = items.filter(i => i.key === 'set')

  return (
    <nav className="flex items-center" role="tablist">
      <div className="flex items-center">
        {mainItems.map(item => (
          <NavTab key={item.key} item={item} />
        ))}
      </div>

      {utilItems.length > 0 && (
        <>
          <span className="pixel-nav-sep" aria-hidden="true" />
          {utilItems.map(item => (
            <NavTab key={item.key} item={item} />
          ))}
        </>
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
    >
      {item.active && (
        <span className="pixel-nav-cursor" aria-hidden="true">►</span>
      )}
      <span className="pixel-nav-icon" aria-hidden="true">{item.icon}</span>
      <span className="pixel-nav-label">{item.label}</span>
      {item.badge != null && item.badge > 0 && (
        <span className="pixel-nav-badge">{item.badge}</span>
      )}
    </button>
  )
}
