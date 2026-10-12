/**
 * macos_window starter component.
 *
 * @author zhi.qu
 * @date 2026-04-28
 */

function MacosWindow({ children }) {
  return (
    <div style={{ border: '1px solid #444', borderRadius: 12, overflow: 'hidden' }}>
      <div style={{ padding: 8, background: '#2b2b2b' }} />
      <div style={{ padding: 16 }}>{children}</div>
    </div>
  )
}

window.MacosWindow = MacosWindow

