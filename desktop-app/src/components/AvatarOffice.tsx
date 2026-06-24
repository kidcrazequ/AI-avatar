/**
 * AvatarOffice: 「AI 分身办公室」全屏可视化页面。
 *
 * 灵感来自 Marvis 的等距办公室插画（marvis.qq.com）——把每个 AI 分身画成一只软 3D
 * 吉祥物，坐在自己的工位上：当前激活的分身在「工作」（屏幕亮起、敲键盘），其余分身
 * 「待命」（轻微呼吸起伏），空工位代表「还能再加分身」。左侧是档案管家 + 跑步机 +
 * 茶水台等氛围道具，纯 CSS/SVG 软 3D 渲染风，不依赖任何图片资源。
 *
 * 设计取舍：
 * - 用 SVG 渐变 + 模糊投影模拟 Marvis 那种柔和白色 3D 渲染质感，配合 scoped <style>
 *   里的 @keyframes 做动画（class 一律 office- 前缀，避免污染全局）。
 * - 尊重 prefers-reduced-motion：减少动态偏好下全部动画暂停。
 * - 点击有人的工位 = 进入该分身工作台（onEnterAvatar）。
 *
 * @author Kian
 * @date 2026-06-24
 */

import { useMemo } from 'react'
import Modal from './shared/Modal'
import PanelHeader from './shared/PanelHeader'

interface Props {
  avatars: Avatar[]
  /** 当前激活的分身 id（决定哪只吉祥物在「工作」） */
  activeAvatarId?: string
  onClose: () => void
  /** 点击工位进入对应分身工作台 */
  onEnterAvatar: (avatarId: string) => void
}

/** 工位状态：working = 正在干活，idle = 待命，empty = 空工位 */
type SeatState = 'working' | 'idle' | 'empty'

/** 从分身 id 派生一个稳定的主题色相，给每只吉祥物一条专属围巾 / 屏幕光。 */
function hueFromId(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360
  return h
}

/** 工位在画布上的锚点（桌面中心），2 列 × 3 行，对齐 Marvis 插画的右侧矩阵。 */
const SEAT_ANCHORS: ReadonlyArray<{ x: number; y: number }> = [
  { x: 660, y: 205 },
  { x: 905, y: 205 },
  { x: 660, y: 405 },
  { x: 905, y: 405 },
  { x: 660, y: 600 },
  { x: 905, y: 600 },
]

/**
 * 「阿猪」——本项目的签名吉祥物：一只软 3D 小猪（致敬 Marvis 的马，但我们是猪）。
 * 正面 3/4 视角探出屏幕：圆脑袋 + 两只软耳朵（粉内耳）+ 一对眼睛 + 粉色猪鼻（带鼻孔），
 * 深色软 3D 身体 + 专属色围巾，和用户给的图标气质一致。
 * state：working 时眼睛睁开盯屏幕；idle 时闭眼打盹 + 冒 zZ。
 */
function Mascot({ cx, cy, scale, hue, sleeping }: { cx: number; cy: number; scale: number; hue: number; sleeping?: boolean }) {
  const bodyId = `mb-${Math.round(cx)}-${Math.round(cy)}`
  // 外层只做定位（transform 属性），内层才挂 bob 动画——否则 CSS transform 动画会
  // 整个覆盖 SVG 的 translate 定位属性，把吉祥物甩到坐标原点。
  return (
    <g transform={`translate(${cx} ${cy}) scale(${scale})`}>
      <g className={sleeping ? 'office-mascot office-mascot--sleep' : 'office-mascot'}>
        <defs>
          <radialGradient id={bodyId} cx="40%" cy="28%" r="82%">
            <stop offset="0%" stopColor="#3a3f47" />
            <stop offset="55%" stopColor="#23262c" />
            <stop offset="100%" stopColor="#15171b" />
          </radialGradient>
        </defs>
        {/* 身体 / 肩膀（坐姿，多数被显示器挡住） */}
        <ellipse cx="0" cy="42" rx="42" ry="32" fill={`url(#${bodyId})`} />
        {/* 专属色围巾 */}
        <path d="M -28 34 Q 0 48 28 34 L 26 48 Q 0 60 -26 48 Z" fill={`hsl(${hue} 68% 58%)`} />
        {/* 两只软耳朵（先画，让脑袋压住耳根） */}
        <path d="M -26 -30 Q -42 -50 -31 -55 Q -16 -49 -13 -31 Z" fill={`url(#${bodyId})`} />
        <path d="M 26 -30 Q 42 -50 31 -55 Q 16 -49 13 -31 Z" fill={`url(#${bodyId})`} />
        <path d="M -24 -32 Q -34 -47 -28 -50 Q -19 -45 -17 -33 Z" fill="#cf8aa0" opacity="0.85" />
        <path d="M 24 -32 Q 34 -47 28 -50 Q 19 -45 17 -33 Z" fill="#cf8aa0" opacity="0.85" />
        {/* 圆脑袋 */}
        <circle cx="0" cy="-4" r="32" fill={`url(#${bodyId})`} />
        {/* 软 3D 高光 */}
        <ellipse cx="-11" cy="-15" rx="10" ry="13" fill="#ffffff" opacity="0.09" />
        {/* 眼睛：睁 / 闭 */}
        {sleeping ? (
          <g stroke="#cdd2da" strokeWidth="2.4" fill="none" strokeLinecap="round">
            <path d="M -17 -6 q 6 5 12 0" />
            <path d="M 5 -6 q 6 5 12 0" />
          </g>
        ) : (
          <g>
            <ellipse cx="-11" cy="-7" rx="4.2" ry="5" fill="#13151a" />
            <ellipse cx="11" cy="-7" rx="4.2" ry="5" fill="#13151a" />
            <circle cx="-9.5" cy="-9" r="1.5" fill="#ffffff" />
            <circle cx="12.5" cy="-9" r="1.5" fill="#ffffff" />
          </g>
        )}
        {/* 猪鼻 */}
        <ellipse cx="0" cy="9" rx="17" ry="12" fill="#e3a3b6" />
        <ellipse cx="0" cy="9" rx="17" ry="12" fill="none" stroke="#c98aa0" strokeWidth="1.2" opacity="0.6" />
        <ellipse cx="-6" cy="9" rx="3" ry="4.6" fill="#a86079" />
        <ellipse cx="6" cy="9" rx="3" ry="4.6" fill="#a86079" />
        {sleeping && (
          <g className="office-zzz" fill="#9aa1ac" fontFamily="monospace" fontWeight="700">
            <text x="36" y="-30" fontSize="14">z</text>
            <text x="48" y="-42" fontSize="18">Z</text>
          </g>
        )}
      </g>
    </g>
  )
}

/**
 * 一个完整工位：投影 + 桌子 + 显示器 + 椅背 + 吉祥物（若有人）。
 * occupant 为 null 时画成空工位（显示器熄屏、椅子空着）。
 */
function Seat({
  anchor,
  occupant,
  state,
  onEnter,
}: {
  anchor: { x: number; y: number }
  occupant: Avatar | null
  state: SeatState
  onEnter: () => void
}) {
  const { x, y } = anchor
  const hue = occupant ? hueFromId(occupant.id) : 210
  const working = state === 'working'
  const screenGlow = working ? `hsl(${hue} 78% 62%)` : '#2b2f36'
  const clickable = Boolean(occupant)

  return (
    <g
      className={clickable ? 'office-seat office-seat--clickable' : 'office-seat'}
      onClick={clickable ? onEnter : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-label={occupant ? `进入「${occupant.name}」工作台` : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onEnter() } } : undefined}
    >
      {/* 地面软投影 */}
      <ellipse cx={x} cy={y + 70} rx="105" ry="26" fill="#000" opacity="0.07" filter="url(#officeSoftBlur)" />

      {/* 椅背（在吉祥物后面） */}
      <rect x={x - 34} y={y + 6} width="68" height="64" rx="20" fill="#e6e9ef" stroke="#d2d7df" />
      <rect x={x - 26} y={y + 60} width="52" height="20" rx="8" fill="#dfe3ea" />

      {/* 吉祥物：小猪探出屏幕上沿——整张猪脸（含猪鼻）露在屏幕顶上，身体被显示器挡住。 */}
      {occupant && <Mascot cx={x} cy={y - 76} scale={0.92} hue={hue} sleeping={state === 'idle'} />}

      {/* 桌面（朝向观者的轻透视梯形） */}
      <path
        d={`M ${x - 92} ${y + 44} L ${x + 92} ${y + 44} L ${x + 104} ${y + 70} L ${x - 104} ${y + 70} Z`}
        fill="#f3f5f8"
      />
      <path d={`M ${x - 104} ${y + 70} L ${x + 104} ${y + 70} L ${x + 104} ${y + 80} L ${x - 104} ${y + 80} Z`} fill="#dde2e9" />
      {/* 桌腿 */}
      <rect x={x - 96} y={y + 80} width="9" height="34" fill="#d3d8e0" />
      <rect x={x + 87} y={y + 80} width="9" height="34" fill="#cdd2da" />

      {/* 显示器（坐在桌面远端，吉祥物前方） */}
      <rect x={x - 52} y={y - 60} width="104" height="66" rx="7" fill="#1f2228" />
      <rect
        x={x - 45}
        y={y - 53}
        width="90"
        height="52"
        rx="4"
        fill={screenGlow}
        className={working ? 'office-screen office-screen--on' : 'office-screen'}
      />
      {working && (
        <g opacity="0.85">
          <rect x={x - 38} y={y - 46} width="46" height="4" rx="2" fill="#fff" opacity="0.85" />
          <rect x={x - 38} y={y - 38} width="62" height="4" rx="2" fill="#fff" opacity="0.6" />
          <rect x={x - 38} y={y - 30} width="34" height="4" rx="2" fill="#fff" opacity="0.7" />
          <rect x={x - 38} y={y - 22} width="52" height="4" rx="2" fill="#fff" opacity="0.5" />
          <rect x={x + 18} y={y - 22} width="8" height="4" className="office-cursor" fill="#fff" />
        </g>
      )}
      {/* 显示器支架 */}
      <rect x={x - 7} y={y + 6} width="14" height="10" fill="#2a2d33" />
      <rect x={x - 18} y={y + 16} width="36" height="6" rx="3" fill="#33363d" />

      {/* 工位铭牌 */}
      {occupant && (
        <g className="office-nameplate">
          <rect x={x - 70} y={y - 146} width="140" height="24" rx="12" fill="#ffffff" stroke="#e2e6ec" />
          <circle cx={x - 54} cy={y - 134} r="5" fill={working ? `hsl(${hue} 78% 55%)` : '#b9c0ca'} className={working ? 'office-status-dot' : ''} />
          <text x={x - 42} y={y - 130} fontSize="13" fontFamily="inherit" fill="#3a3f47" fontWeight="600">
            {occupant.name.length > 8 ? occupant.name.slice(0, 8) + '…' : occupant.name}
          </text>
        </g>
      )}
    </g>
  )
}

export default function AvatarOffice({ avatars, activeAvatarId, onClose, onEnterAvatar }: Props) {
  // 把激活的分身排到第一个工位，其余按原顺序铺开；最多展示 6 个工位。
  const seated = useMemo(() => {
    const sorted = [...avatars].sort((a, b) => {
      if (a.id === activeAvatarId) return -1
      if (b.id === activeAvatarId) return 1
      return 0
    })
    return sorted.slice(0, SEAT_ANCHORS.length)
  }, [avatars, activeAvatarId])

  const hiddenCount = Math.max(0, avatars.length - SEAT_ANCHORS.length)
  const officeTitle = (() => {
    const active = avatars.find((a) => a.id === activeAvatarId)
    const name = active?.name ?? 'SOUL'
    const short = name.length > 6 ? name.slice(0, 6) : name
    return `${short} 的办公室`
  })()

  const handleEnter = (id: string) => {
    onEnterAvatar(id)
    onClose()
  }

  return (
    <Modal isOpen onClose={onClose} size="xl">
      <PanelHeader
        title="AI 分身办公室"
        subtitle={`在岗 ${seated.length}${hiddenCount > 0 ? ` · 另有 ${hiddenCount} 位未上墙` : ''} · 点击工位进入对应分身`}
        onClose={onClose}
      />

      <div className="office-stage flex-1 min-h-0 overflow-hidden">
        <style>{officeStyles}</style>
        <svg viewBox="0 0 1080 720" className="office-svg" preserveAspectRatio="xMidYMid meet" role="img" aria-label={officeTitle}>
          <defs>
            <radialGradient id="officeFloor" cx="58%" cy="42%" r="75%">
              <stop offset="0%" stopColor="#fbfcfe" />
              <stop offset="70%" stopColor="#eef0f4" />
              <stop offset="100%" stopColor="#e4e7ec" />
            </radialGradient>
            <linearGradient id="officeCounter" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#fdfeff" />
              <stop offset="100%" stopColor="#e7eaef" />
            </linearGradient>
            <filter id="officeSoftBlur" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="7" />
            </filter>
          </defs>

          {/* 地板 */}
          <rect x="0" y="0" width="1080" height="720" fill="url(#officeFloor)" />
          <rect x="20" y="20" width="1040" height="680" rx="26" fill="none" stroke="#dfe3e9" strokeWidth="2" />

          {/* 标题 */}
          <text x="1040" y="48" textAnchor="end" fontSize="24" fontWeight="700" fill="#2f343b" className="office-title">
            {officeTitle}
          </text>

          {/* ── 左侧氛围道具 ── */}
          {/* 茶水台 + 绿植 + 咖啡机 */}
          <g>
            <ellipse cx="200" cy="190" rx="150" ry="30" fill="#000" opacity="0.05" filter="url(#officeSoftBlur)" />
            <rect x="70" y="120" width="280" height="46" rx="10" fill="url(#officeCounter)" stroke="#dfe3e9" />
            <rect x="78" y="150" width="264" height="34" rx="6" fill="#e2e6ec" />
            {[110, 150, 190, 230].map((px, i) => (
              <g key={px} className="office-plant" style={{ animationDelay: `${i * 0.4}s` }}>
                <rect x={px - 9} y="104" width="18" height="18" rx="4" fill="#cdd2da" />
                <circle cx={px} cy="100" r="13" fill={`hsl(${130 + i * 8} 34% ${52 - i * 3}%)`} />
                <circle cx={px - 6} cy="106" r="8" fill={`hsl(${132 + i * 8} 36% ${48 - i * 3}%)`} />
              </g>
            ))}
            {/* 咖啡机 + 热气 */}
            <rect x="280" y="92" width="50" height="40" rx="6" fill="#2b2f36" />
            <rect x="292" y="110" width="26" height="14" rx="3" fill="#4a4f58" />
            <g className="office-steam" stroke="#c7ccd4" strokeWidth="3" fill="none" strokeLinecap="round" opacity="0.7">
              <path d="M 298 92 q 6 -8 0 -16" />
              <path d="M 312 92 q -6 -8 0 -16" />
            </g>
          </g>

          {/* 跑步机 */}
          <g>
            <ellipse cx="195" cy="400" rx="135" ry="28" fill="#000" opacity="0.05" filter="url(#officeSoftBlur)" />
            <path d="M 90 388 L 300 388 L 285 420 L 105 420 Z" fill="#eef1f5" stroke="#dde2e9" />
            <g className="office-belt">
              {[0, 1, 2, 3, 4].map((i) => (
                <line key={i} x1={120 + i * 36} y1="392" x2={114 + i * 36} y2="416" stroke="#cfd4dc" strokeWidth="3" />
              ))}
            </g>
            <rect x="278" y="318" width="12" height="76" rx="4" fill="#d3d8e0" />
            <rect x="252" y="312" width="48" height="16" rx="5" fill="#2b2f36" />
          </g>

          {/* 档案管家（File Agent 致敬：对应知识库 / 文件系统） */}
          <g>
            <ellipse cx="195" cy="612" rx="150" ry="30" fill="#000" opacity="0.06" filter="url(#officeSoftBlur)" />
            {/* 档案架 */}
            <rect x="78" y="500" width="120" height="104" rx="6" fill="#eef1f5" stroke="#dde2e9" />
            {[0, 1, 2].map((r) => (
              <g key={r}>
                <rect x="86" y={510 + r * 32} width="104" height="24" rx="3" fill="#e3e7ed" />
                {[0, 1, 2, 3, 4].map((c) => (
                  <rect key={c} x={90 + c * 20} y={512 + r * 32} width="14" height="20" rx="2" fill={`hsl(${(r * 5 + c) * 24} 46% 64%)`} />
                ))}
              </g>
            ))}
            <Mascot cx={258} cy={566} scale={0.92} hue={278} />
            <g className="office-nameplate">
              <rect x="200" y="478" width="116" height="24" rx="12" fill="#ffffff" stroke="#e2e6ec" />
              <circle cx="216" cy="490" r="5" fill="#9a6cff" />
              <text x="228" y="494" fontSize="13" fontFamily="inherit" fill="#3a3f47" fontWeight="600">档案管家</text>
            </g>
          </g>

          {/* ── 右侧工位矩阵 ── */}
          {SEAT_ANCHORS.map((anchor, i) => {
            const occupant = seated[i] ?? null
            const state: SeatState = !occupant ? 'empty' : occupant.id === activeAvatarId || (i === 0 && !activeAvatarId) ? 'working' : 'idle'
            return (
              <Seat
                key={i}
                anchor={anchor}
                occupant={occupant}
                state={state}
                onEnter={() => occupant && handleEnter(occupant.id)}
              />
            )
          })}
        </svg>

        {avatars.length === 0 && (
          <div className="office-empty font-game">
            办公室还空着 — 先去首页创建一个分身，TA 就会出现在工位上。
          </div>
        )}
      </div>
    </Modal>
  )
}

/** scoped 动画样式：所有 class 以 office- 前缀，避免污染全局。 */
const officeStyles = `
.office-stage { position: relative; background: radial-gradient(circle at 60% 38%, #ffffff 0%, #eef0f4 72%, #e6e9ee 100%); }
.office-svg { width: 100%; height: 100%; display: block; animation: office-rise 0.6s ease-out both; }
.office-title { font-family: inherit; letter-spacing: 1px; opacity: 0.85; }

.office-seat { transform-box: fill-box; }
.office-seat--clickable { cursor: pointer; outline: none; }
.office-seat--clickable .office-nameplate rect { transition: stroke 0.15s, fill 0.15s; }
.office-seat--clickable:hover .office-nameplate rect,
.office-seat--clickable:focus-visible .office-nameplate rect { stroke: #9aa1ac; }
.office-seat--clickable:hover { filter: drop-shadow(0 4px 10px rgba(0,0,0,0.12)); }

.office-mascot { animation: office-bob 3.4s ease-in-out infinite; transform-origin: center; }
.office-mascot--sleep { animation: office-bob 4.6s ease-in-out infinite; }
.office-zzz { animation: office-zzz 3s ease-in-out infinite; }

.office-screen--on { animation: office-flicker 5s ease-in-out infinite; }
.office-cursor { animation: office-blink 1.1s step-end infinite; }
.office-status-dot { animation: office-pulse 1.8s ease-in-out infinite; transform-origin: center; transform-box: fill-box; }

.office-belt line { animation: office-belt 1.6s linear infinite; }
.office-steam { animation: office-steam 2.6s ease-in-out infinite; }
.office-plant { transform-box: fill-box; transform-origin: bottom center; animation: office-sway 4s ease-in-out infinite; }

.office-empty {
  position: absolute; left: 50%; bottom: 28px; transform: translateX(-50%);
  font-size: 13px; color: #6b7280; background: rgba(255,255,255,0.86);
  border: 1px solid #e2e6ec; border-radius: 999px; padding: 8px 18px; white-space: nowrap;
}

@keyframes office-rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
@keyframes office-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
@keyframes office-zzz { 0% { opacity: 0; transform: translateY(4px); } 30% { opacity: 0.9; } 100% { opacity: 0; transform: translateY(-12px); } }
@keyframes office-flicker { 0%, 100% { opacity: 1; } 48% { opacity: 0.94; } 52% { opacity: 0.88; } 56% { opacity: 0.97; } }
@keyframes office-blink { 0%, 50% { opacity: 1; } 51%, 100% { opacity: 0; } }
@keyframes office-pulse { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.5); opacity: 0.5; } }
@keyframes office-belt { from { transform: translateX(0); } to { transform: translateX(-36px); } }
@keyframes office-steam { 0% { opacity: 0; transform: translateY(2px); } 40% { opacity: 0.7; } 100% { opacity: 0; transform: translateY(-8px); } }
@keyframes office-sway { 0%, 100% { transform: rotate(-2deg); } 50% { transform: rotate(2deg); } }

@media (prefers-reduced-motion: reduce) {
  .office-svg, .office-mascot, .office-zzz, .office-screen--on, .office-cursor,
  .office-status-dot, .office-belt line, .office-steam, .office-plant { animation: none !important; }
}
`
