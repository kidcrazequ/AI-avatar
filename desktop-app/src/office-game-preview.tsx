import { createRoot } from 'react-dom/client'
import OfficeGameV2 from './components/office-game-v2/OfficeGameV2'

const avatars: Avatar[] = [
  {
    id: 'preview-pig',
    name: '小猪工程师',
    description: 'AI 分身',
    createdAt: Date.now(),
  },
  {
    id: 'preview-product',
    name: '产品小猪',
    description: 'AI 分身',
    createdAt: Date.now(),
  },
  {
    id: 'preview-data',
    name: '数据小猪',
    description: 'AI 分身',
    createdAt: Date.now(),
  },
  {
    id: 'preview-ops',
    name: '运营小猪',
    description: 'AI 分身',
    createdAt: Date.now(),
  },
]

function Preview() {
  return (
    <div className="preview-shell">
      <OfficeGameV2 avatars={avatars} activeAvatarId="preview-pig" onEnterAvatar={() => undefined} />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)

const style = document.createElement('style')
style.textContent = `
* { box-sizing: border-box; }
html, body, #root { width: 100%; height: 100%; margin: 0; background: #1d2430; overflow: hidden; }
.preview-shell { position: fixed; inset: 0; width: 100vw; height: 100vh; background: #1d2430; }
.office-game-v2-canvas { width: 100%; height: 100%; display: block; background: #1d2430; cursor: pointer; }
.office-game-shell { position: absolute; inset: 0; overflow: hidden; background: #1d2430; }
.office-game-svg { width: 100%; height: 100%; display: block; }
.office-game-npc { cursor: pointer; outline: none; pointer-events: auto; }
.office-game-npc-shadow { fill: rgba(0,0,0,0.23); opacity: 0.78; }
.office-game-sprite-wrap { pointer-events: none; }
.office-game-sprite-frame,
.office-game-sprite-frame image { image-rendering: pixelated; }
.office-game-sprite-frame { opacity: 0; animation-duration: 0.86s; animation-timing-function: step-end; animation-iteration-count: infinite; }
.office-game-sprite-frame--walk-cycle { animation-duration: 0.5s; }
.office-game-sprite-frame--0 { animation-name: office-game-sprite-frame-0; }
.office-game-sprite-frame--1 { animation-name: office-game-sprite-frame-1; }
.office-game-sprite-frame--2 { animation-name: office-game-sprite-frame-2; }
.office-game-sprite-frame--3 { animation-name: office-game-sprite-frame-3; }
.office-game-npc--walking .office-game-npc-shadow { opacity: 0.62; }
.office-game-foreground { pointer-events: none; }
.office-game-foreground image { image-rendering: pixelated; }
.office-game-npc-label { opacity: 0; transform: translateY(5px); transition: opacity 0.14s ease, transform 0.14s ease; pointer-events: none; }
.office-game-npc:hover .office-game-npc-label,
.office-game-npc:focus-visible .office-game-npc-label { opacity: 1; transform: translateY(0); }
.office-game-npc-label rect { fill: rgba(250,250,246,0.88); stroke: rgba(32,33,35,0.18); stroke-width: 1; }
.office-game-npc-label-name { font-size: 11px; font-weight: 800; fill: rgba(20,22,25,0.88); }
.office-game-npc-label-status { font-size: 8px; font-weight: 600; fill: rgba(72,76,82,0.72); }
@keyframes office-game-sprite-frame-0 { 0%, 24.9% { opacity: 1; } 25%, 100% { opacity: 0; } }
@keyframes office-game-sprite-frame-1 { 0%, 24.9% { opacity: 0; } 25%, 49.9% { opacity: 1; } 50%, 100% { opacity: 0; } }
@keyframes office-game-sprite-frame-2 { 0%, 49.9% { opacity: 0; } 50%, 74.9% { opacity: 1; } 75%, 100% { opacity: 0; } }
@keyframes office-game-sprite-frame-3 { 0%, 74.9% { opacity: 0; } 75%, 100% { opacity: 1; } }
`
document.head.append(style)
