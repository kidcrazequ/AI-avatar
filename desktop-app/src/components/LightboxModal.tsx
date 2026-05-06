/**
 * LightboxModal.tsx — 图表/图片放大查看弹窗。
 *
 * 在聊天气泡里 Mermaid / ECharts / Infographic / 用户上传图片渲染太小看不清时，
 * 用此弹窗以接近全屏（95vw × 95vh）的尺寸展示，支持滚动查看大图、按 ESC 关闭、
 * 点遮罩关闭。
 *
 * 数据流：
 *   Renderer / MessageBubble 维护 open 状态
 *   → 传 children（SVG 节点 / <img> / 任意 ReactNode）
 *   → 本组件用 createPortal 把 shared/Modal 挂到 document.body
 *   → 在 PanelHeader 的 actions 槽展示「下载 PNG / 复制」等操作（由调用方传入）
 *
 * 为什么必须 createPortal 到 body：
 *   消息气泡渲染在 react-virtuoso 内部，Virtuoso 用 CSS transform 实现虚拟化
 *   位移（translateY）。CSS 规范规定：transform 祖先元素会成为 position: fixed
 *   后代的"包含块"，导致 `fixed inset-0` 只覆盖 Virtuoso 可视区，而不是整个
 *   视口。createPortal(..., document.body) 让弹窗 DOM 直接挂到 body 下，
 *   逃出 Virtuoso 的 transform 上下文，恢复全屏覆盖。
 *
 * 为什么不自己实现 Modal 主体：
 *   shared/Modal.tsx 已经处理了 ESC、focus trap、滚动锁定、动画，复用即可，
 *   避免在两处维护两套关闭/聚焦逻辑。
 *
 * @author zhi.qu
 * @date 2026-05-05
 */

import type { ReactElement, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import Modal from './shared/Modal'
import PanelHeader from './shared/PanelHeader'

interface LightboxModalProps {
  /** 弹窗是否打开 */
  isOpen: boolean
  /** 关闭回调 */
  onClose: () => void
  /** 标题（建议大写英文，配项目像素游戏感，例如 "MERMAID DIAGRAM"） */
  title?: string
  /** 副标题（可选，例如图表标题文本） */
  subtitle?: string
  /** 主内容区（SVG 节点 / <img> / 任意 ReactNode） */
  children: ReactNode
  /** PanelHeader 右侧 actions 槽（一般放下载/复制按钮） */
  actions?: ReactNode
}

export default function LightboxModal({
  isOpen,
  onClose,
  title = 'VIEW LARGE',
  subtitle,
  children,
  actions,
}: LightboxModalProps): ReactElement | null {
  // !isOpen 时也要渲染（占位 null）才能在 portal 关闭时正确清理 DOM
  if (!isOpen) return null

  // SSR-safe：document 在浏览器环境一定存在，desktop-app 是 Electron 渲染进程，无 SSR
  return createPortal(
    <Modal isOpen={isOpen} onClose={onClose} size="xl">
      <PanelHeader
        title={title}
        subtitle={subtitle}
        onClose={onClose}
        actions={actions}
      />
      <div
        className="flex-1 overflow-auto bg-px-bg p-6 flex items-center justify-center"
        // 内容比窗口大时由内置 overflow-auto 提供滚动条；比窗口小时居中展示
      >
        <div className="max-w-full">{children}</div>
      </div>
    </Modal>,
    document.body,
  )
}
