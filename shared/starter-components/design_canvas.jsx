/**
 * design_canvas starter component.
 *
 * @author zhi.qu
 * @date 2026-04-28
 */

function DesignCanvas({ children }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, padding: 24 }}>{children}</div>
}

window.DesignCanvas = DesignCanvas

