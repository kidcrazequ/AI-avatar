/**
 * browser_window starter component.
 *
 * @author zhi.qu
 * @date 2026-04-28
 */

function BrowserWindowFrame({ children }) {
  return (
    <div style={{ border: '1px solid #444', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: 8, background: '#f2f2f2', borderBottom: '1px solid #ddd' }}>https://example.com</div>
      <div style={{ padding: 16 }}>{children}</div>
    </div>
  )
}

window.BrowserWindowFrame = BrowserWindowFrame

