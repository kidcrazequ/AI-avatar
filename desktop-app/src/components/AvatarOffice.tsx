/**
 * AvatarOffice: 「AI 分身办公室」全屏可视化页面。
 *
 * 复刻 Marvis 的等距 3D 办公室（marvis.qq.com）：等距桌椅 + Marvis 马（吉祥物）坐在办公椅里
 * 对着彩色屏幕办公（背面视角）+ 柔和落地投影 + 右侧 Token/任务面板。两段式：先「开启」引导页
 * （图三/图四），点击开启进入正式办公室（图二）。纯 SVG/CSS，不依赖图片资源。
 *
 * 数据诚实声明：右侧面板的「对话明细」与计数全部来自真实会话数据（getConversations）。
 * Token 用量目前未在消息层落库统计，故面板用「对话数」作为真实可溯指标，不编造 token 数字。
 *
 * 设计取舍：
 * - 一个 Seat 单元（等距桌 + 椅 + 显示器 + 小猪）在原点画好，再 translate 到网格各点。
 * - 桌前 Marvis 取背面视角（贴合参考图）：扇形鬃毛 + 上扬鬃角 + 彩色围巾；
 *   档案管家用正面侧脸（一睁一眨 + 红围巾），让用户看到完整吉祥物。
 * - 尊重 prefers-reduced-motion：减少动态偏好下全部动画暂停。
 *
 * @author Kian
 * @date 2026-06-24
 */

import { useMemo, useState } from 'react'
import Modal from './shared/Modal'
import PanelHeader from './shared/PanelHeader'

interface Props {
  avatars: Avatar[]
  /** 当前激活的分身 id（决定哪只 Marvis 在「工作」） */
  activeAvatarId?: string
  /** 真实会话列表（来自 App 的 getConversations），驱动右侧任务面板。 */
  conversations: Conversation[]
  onClose: () => void
  /** 点击工位进入对应分身工作台 */
  onEnterAvatar: (avatarId: string) => void
}

/** 工位状态：working = 正在干活，idle = 待命，empty = 空工位 */
type SeatState = 'working' | 'idle' | 'empty'

/** 从分身 id 派生一个稳定的主题色相，给每只小猪一条专属围巾 / 屏幕光。 */
function hueFromId(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360
  return h
}

/** 本地时区的「今天」判断（不走 UTC，避免跨时区漂移）。 */
function isToday(ts: number): boolean {
  const d = new Date(ts)
  const n = new Date()
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
}

/** 格式化成「HH:mm MM/DD」（本地时区，手工拼接避免 UTC 漂移）。 */
function shortTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())} ${p(d.getMonth() + 1)}/${p(d.getDate())}`
}

/** 工位锚点（桌面中心）。 */
const OFFICE_ANCHORS: ReadonlyArray<{ x: number; y: number }> = [
  { x: 620, y: 215 },
  { x: 880, y: 215 },
  { x: 620, y: 430 },
  { x: 880, y: 430 },
  { x: 620, y: 645 },
  { x: 880, y: 645 },
]
const INTRO_ANCHORS: ReadonlyArray<{ x: number; y: number }> = [
  { x: 170, y: 170 },
  { x: 440, y: 170 },
  { x: 710, y: 170 },
  { x: 170, y: 370 },
  { x: 440, y: 370 },
  { x: 710, y: 370 },
]

const MARVIS_BLACK = '#141414'

/** 生成扇形鬃毛（一组三角刺，从 (hcx,hcy) 沿各角度向外辐射）。 */
function maneSpikes(
  hcx: number,
  hcy: number,
  R: number,
  defs: ReadonlyArray<{ a: number; l: number; w: number }>,
  fill: string,
) {
  return defs.map((d, i) => {
    const r = (d.a * Math.PI) / 180
    const ux = Math.cos(r)
    const uy = Math.sin(r)
    const px = -uy
    const py = ux
    const bx = hcx + R * ux
    const by = hcy + R * uy
    const tx = hcx + (R + d.l) * ux
    const ty = hcy + (R + d.l) * uy
    return (
      <path key={i} d={`M ${bx + px * d.w} ${by + py * d.w} L ${tx} ${ty} L ${bx - px * d.w} ${by - py * d.w} Z`} fill={fill} />
    )
  })
}

/** 鬃毛扇形定义（角度 deg，l 长度，w 半宽）。 */
const PROFILE_MANE = [
  { a: -72, l: 40, w: 14 }, { a: -54, l: 44, w: 15 }, { a: -34, l: 46, w: 16 }, { a: -14, l: 44, w: 15 },
  { a: 6, l: 42, w: 14 }, { a: 24, l: 38, w: 13 }, { a: 40, l: 32, w: 12 },
] as const
const BACK_MANE = [
  { a: -118, l: 30, w: 12 }, { a: -96, l: 34, w: 13 }, { a: -72, l: 37, w: 14 }, { a: -48, l: 36, w: 13 },
  { a: -24, l: 31, w: 12 }, { a: 0, l: 26, w: 11 }, { a: 22, l: 22, w: 10 },
] as const

/**
 * Marvis 马（背面视角，坐在办公椅里对着屏幕）：圆后脑勺 + 扇形鬃毛 + 上翘鬃角。
 * 复刻 marvis.qq.com 吉祥物。头顶探出椅背 / 屏幕下沿；身体被椅背挡住，无脸。
 */
function MarvisBack({ cx, cy, scale, sleeping }: { cx: number; cy: number; scale: number; sleeping?: boolean }) {
  return (
    <g transform={`translate(${cx} ${cy}) scale(${scale})`}>
      <g className={sleeping ? 'office-mascot office-mascot--sleep' : 'office-mascot'}>
        {/* 扇形鬃毛（在脑袋后面） */}
        {maneSpikes(0, -2, 22, BACK_MANE, MARVIS_BLACK)}
        {/* 上翘鬃角 */}
        <path d="M -16 -14 Q -34 -34 -40 -20" stroke={MARVIS_BLACK} strokeWidth="11" fill="none" strokeLinecap="round" />
        {/* 后脑勺 */}
        <circle cx="0" cy="-2" r="25" fill={MARVIS_BLACK} />
        <ellipse cx="8" cy="-11" rx="6" ry="9" fill="#ffffff" opacity="0.06" />
        {sleeping && (
          <g className="office-zzz" fill="#9aa1ac" fontFamily="monospace" fontWeight="700">
            <text x="28" y="-26" fontSize="13">z</text>
            <text x="39" y="-37" fontSize="17">Z</text>
          </g>
        )}
      </g>
    </g>
  )
}

/**
 * Marvis 马（正面侧脸，朝左）：忠实复刻 marvis.qq.com 吉祥物——方头马脸 + 上扬鬃角
 * + 扇形鬃毛 + 一睁一眨的大眼 + 红围巾 + 方块手臂。给档案管家「门面」用。
 * 局部画布约 0..240 × 0..230，视觉中心约 (118,116)，故内部反向平移让中心落在 (cx,cy)。
 */
function MarvisProfile({ cx, cy, scale }: { cx: number; cy: number; scale: number }) {
  return (
    <g transform={`translate(${cx} ${cy}) scale(${scale}) translate(-118 -116)`}>
      <g className="office-mascot">
        {maneSpikes(104, 98, 46, PROFILE_MANE, MARVIS_BLACK)}
        {/* 脖子 / 身体 */}
        <path d="M 90 150 L 168 150 L 168 230 L 90 230 Z" fill={MARVIS_BLACK} />
        {/* 弯折方块手臂 */}
        <path d="M 94 170 L 94 206 Q 94 220 78 220 L 42 220 Q 30 220 30 208 L 30 190 Q 30 180 42 180 L 70 180 L 70 170 Z" fill={MARVIS_BLACK} />
        {/* 马头 + 方块口鼻（单条干净路径） */}
        <path
          d="M 22 86 C 18 76 24 70 34 68 L 70 58 L 104 46 L 118 44 C 152 50 172 78 170 110 C 169 134 148 150 118 153 L 92 154 C 74 152 64 140 58 128 L 44 114 L 22 114 Z"
          fill={MARVIS_BLACK}
        />
        {/* 上扬鬃角（粗笔触） */}
        <path d="M 104 48 Q 60 20 52 40" stroke={MARVIS_BLACK} strokeWidth="19" fill="none" strokeLinecap="round" />
        {/* 红围巾：横带 + 竖摆 */}
        <path d="M 68 150 L 230 138 L 230 172 L 68 184 Z" fill="#e8201c" />
        <path d="M 100 178 L 140 175 L 136 224 L 106 226 Z" fill="#e8201c" />
        {/* 双眼：一睁一眨 */}
        <ellipse cx="90" cy="94" rx="18" ry="24" fill="#ffffff" />
        <ellipse cx="134" cy="92" rx="16" ry="22" fill="#ffffff" />
        <circle cx="86" cy="102" r="8.5" fill={MARVIS_BLACK} />
        <path d="M 122 94 Q 134 105 146 92" stroke={MARVIS_BLACK} strokeWidth="4.5" fill="none" strokeLinecap="round" />
      </g>
    </g>
  )
}

/**
 * 一个等距 3D 工位：落地投影 + 等距桌（桌面斜角 + 厚度 + 桌腿）+ 显示器（彩色亮屏）
 * + 办公椅（椅背朝我们）+ 背面 Marvis（头探出椅背）+ 工位铭牌。
 * occupant 为 null = 空工位（熄屏、空椅）。
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
  const screenColor = state === 'empty' ? '#23262c' : working ? `hsl(${hue} 80% 64%)` : `hsl(${hue} 32% 56%)`
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
      {/* 落地软投影 */}
      <ellipse cx={x + 14} cy={y + 96} rx="118" ry="30" fill="#000" opacity="0.08" filter="url(#officeSoftBlur)" />

      {/* ── 等距桌 ── */}
      {/* 桌面（平行四边形，向右后方退） */}
      <path d={`M ${x - 95} ${y + 52} L ${x + 95} ${y + 52} L ${x + 134} ${y + 14} L ${x - 56} ${y + 14} Z`} fill="#f6f8fb" />
      {/* 前厚度 */}
      <path d={`M ${x - 95} ${y + 52} L ${x + 95} ${y + 52} L ${x + 95} ${y + 64} L ${x - 95} ${y + 64} Z`} fill="#dde2e9" />
      {/* 右厚度 */}
      <path d={`M ${x + 95} ${y + 52} L ${x + 134} ${y + 14} L ${x + 134} ${y + 26} L ${x + 95} ${y + 64} Z`} fill="#ccd2db" />
      {/* 桌腿 */}
      <rect x={x - 92} y={y + 64} width="8" height="42" fill="#d2d7df" />
      <rect x={x + 86} y={y + 64} width="8" height="42" fill="#c6ccd5" />
      <path d={`M ${x + 126} ${y + 26} l 0 42 l 6 0 l 0 -42 Z`} fill="#c6ccd5" />

      {/* ── 显示器（坐桌面后沿，彩色屏朝向我们） ── */}
      <rect x={x - 6} y={y + 16} width="12" height="14" fill="#2a2d33" />
      <rect x={x - 22} y={y + 28} width="44" height="6" rx="3" fill="#33363d" />
      <rect x={x - 54} y={y - 64} width="108" height="80" rx="8" fill="#1f2228" />
      <rect
        x={x - 46}
        y={y - 56}
        width="92"
        height="64"
        rx="4"
        fill={screenColor}
        className={working ? 'office-screen office-screen--on' : 'office-screen'}
      />
      {state !== 'empty' && (
        <g opacity={working ? '0.9' : '0.5'}>
          <rect x={x - 40} y={y - 50} width="20" height="52" rx="3" fill="#ffffff" opacity="0.22" />
          <rect x={x - 14} y={y - 50} width="52" height="5" rx="2.5" fill="#ffffff" opacity="0.85" />
          <rect x={x - 14} y={y - 40} width="40" height="5" rx="2.5" fill="#ffffff" opacity="0.6" />
          <rect x={x - 14} y={y - 30} width="48" height="5" rx="2.5" fill="#ffffff" opacity="0.7" />
          <rect x={x - 14} y={y - 20} width="30" height="5" rx="2.5" fill="#ffffff" opacity="0.5" />
          {working && <rect x={x + 20} y={y - 20} width="8" height="5" className="office-cursor" fill="#fff" />}
        </g>
      )}

      {/* ── Marvis 马（坐在椅子里，头探出椅背） ── */}
      {occupant && <MarvisBack cx={x} cy={y - 16} scale={1.02} sleeping={state === 'idle'} />}

      {/* ── 办公椅（椅背朝我们，挡住小猪身体） ── */}
      <path d={`M ${x - 36} ${y + 18} q 0 -26 36 -26 q 36 0 36 26 l 0 30 q -36 12 -72 0 Z`} fill="#e7eaef" stroke="#d4d9e1" />
      {/* 颈部专属色围巾 */}
      {occupant && <rect x={x - 22} y={y + 8} width="44" height="9" rx="4" fill={working ? `hsl(${hue} 72% 56%)` : `hsl(${hue} 30% 60%)`} />}
      {/* 椅子立柱 + 五星脚 + 滚轮 */}
      <rect x={x - 4} y={y + 48} width="8" height="22" fill="#cdd2da" />
      <ellipse cx={x} cy={y + 76} rx="34" ry="9" fill="#dfe3ea" />
      <circle cx={x - 28} cy={y + 78} r="5" fill="#c6ccd5" />
      <circle cx={x + 28} cy={y + 78} r="5" fill="#c6ccd5" />
      <circle cx={x} cy={y + 82} r="5" fill="#c6ccd5" />

      {/* ── 工位铭牌 ── */}
      {occupant && (
        <g className="office-nameplate">
          <rect x={x - 70} y={y - 100} width="140" height="24" rx="12" fill="#ffffff" stroke="#e2e6ec" />
          <circle cx={x - 54} cy={y - 88} r="5" fill={working ? `hsl(${hue} 78% 55%)` : '#b9c0ca'} className={working ? 'office-status-dot' : ''} />
          <text x={x - 42} y={y - 84} fontSize="13" fontFamily="inherit" fill="#3a3f47" fontWeight="600">
            {occupant.name.length > 8 ? occupant.name.slice(0, 8) + '…' : occupant.name}
          </text>
        </g>
      )}
    </g>
  )
}

/** 共享的舞台 svg：地板 + 工位网格（+ 可选左侧氛围道具）。 */
function Scene({
  seats,
  anchors,
  withProps,
  title,
  viewBox = '0 0 1080 780',
  onEnter,
}: {
  seats: Array<Avatar | null>
  anchors: ReadonlyArray<{ x: number; y: number }>
  withProps: boolean
  title?: string
  viewBox?: string
  onEnter: (id: string) => void
}) {
  const [, , vbW, vbH] = viewBox.split(' ').map(Number)
  return (
    <svg viewBox={viewBox} className="office-svg" preserveAspectRatio="xMidYMid meet" role="img" aria-label={title ?? '分身办公室'}>
      <defs>
        <radialGradient id="officeFloor" cx="56%" cy="40%" r="78%">
          <stop offset="0%" stopColor="#fcfdff" />
          <stop offset="70%" stopColor="#eef0f4" />
          <stop offset="100%" stopColor="#e3e6eb" />
        </radialGradient>
        <linearGradient id="officeCounter" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#fdfeff" />
          <stop offset="100%" stopColor="#e7eaef" />
        </linearGradient>
        <filter id="officeSoftBlur" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="7" />
        </filter>
      </defs>

      <rect x="0" y="0" width={vbW} height={vbH} fill="url(#officeFloor)" />

      {title && (
        <text x={vbW / 2} y="46" textAnchor="middle" fontSize="22" fontWeight="700" fill="#2f343b" className="office-title">
          {title}
        </text>
      )}

      {withProps && (
        <>
          {/* 茶水台 + 绿植 + 咖啡机 */}
          <g>
            <ellipse cx="195" cy="190" rx="150" ry="30" fill="#000" opacity="0.05" filter="url(#officeSoftBlur)" />
            <rect x="64" y="120" width="270" height="46" rx="10" fill="url(#officeCounter)" stroke="#dfe3e9" />
            <rect x="72" y="150" width="254" height="34" rx="6" fill="#e2e6ec" />
            {[104, 144, 184, 224].map((px, i) => (
              <g key={px} className="office-plant" style={{ animationDelay: `${i * 0.4}s` }}>
                <rect x={px - 9} y="104" width="18" height="18" rx="4" fill="#cdd2da" />
                <circle cx={px} cy="100" r="13" fill={`hsl(${130 + i * 8} 34% ${52 - i * 3}%)`} />
                <circle cx={px - 6} cy="106" r="8" fill={`hsl(${132 + i * 8} 36% ${48 - i * 3}%)`} />
              </g>
            ))}
            <rect x="276" y="92" width="50" height="40" rx="6" fill="#2b2f36" />
            <rect x="288" y="110" width="26" height="14" rx="3" fill="#4a4f58" />
            <g className="office-steam" stroke="#c7ccd4" strokeWidth="3" fill="none" strokeLinecap="round" opacity="0.7">
              <path d="M 294 92 q 6 -8 0 -16" />
              <path d="M 308 92 q -6 -8 0 -16" />
            </g>
          </g>

          {/* 跑步机 */}
          <g>
            <ellipse cx="190" cy="410" rx="135" ry="28" fill="#000" opacity="0.05" filter="url(#officeSoftBlur)" />
            <path d="M 84 398 L 296 398 L 281 430 L 99 430 Z" fill="#eef1f5" stroke="#dde2e9" />
            <g className="office-belt">
              {[0, 1, 2, 3, 4].map((i) => (
                <line key={i} x1={114 + i * 36} y1="402" x2={108 + i * 36} y2="426" stroke="#cfd4dc" strokeWidth="3" />
              ))}
            </g>
            <rect x="272" y="328" width="12" height="76" rx="4" fill="#d3d8e0" />
            <rect x="246" y="322" width="48" height="16" rx="5" fill="#2b2f36" />
          </g>

          {/* 档案管家（正面 Marvis 侧脸 + 彩色档案架） */}
          <g>
            <ellipse cx="190" cy="628" rx="150" ry="30" fill="#000" opacity="0.06" filter="url(#officeSoftBlur)" />
            <rect x="72" y="516" width="120" height="104" rx="6" fill="#eef1f5" stroke="#dde2e9" />
            {[0, 1, 2].map((r) => (
              <g key={r}>
                <rect x="80" y={526 + r * 32} width="104" height="24" rx="3" fill="#e3e7ed" />
                {[0, 1, 2, 3, 4].map((c) => (
                  <rect key={c} x={84 + c * 20} y={528 + r * 32} width="14" height="20" rx="2" fill={`hsl(${(r * 5 + c) * 24} 46% 64%)`} />
                ))}
              </g>
            ))}
            <MarvisProfile cx={236} cy={576} scale={0.78} />
            <g className="office-nameplate">
              <rect x="194" y="494" width="116" height="24" rx="12" fill="#ffffff" stroke="#e2e6ec" />
              <circle cx="210" cy="506" r="5" fill="#9a6cff" />
              <text x="222" y="510" fontSize="13" fontFamily="inherit" fill="#3a3f47" fontWeight="600">档案管家</text>
            </g>
          </g>
        </>
      )}

      {anchors.map((anchor, i) => {
        const occupant = seats[i] ?? null
        const state: SeatState = !occupant ? 'empty' : i === 0 ? 'working' : 'idle'
        return (
          <Seat
            key={i}
            anchor={anchor}
            occupant={occupant}
            state={state}
            onEnter={() => occupant && onEnter(occupant.id)}
          />
        )
      })}
    </svg>
  )
}

/** 右侧任务面板（图二复刻）——全部真实会话数据，不编造 token。 */
function TaskPanel({ conversations }: { conversations: Conversation[] }) {
  const [tab, setTab] = useState<'all' | 'today'>('all')
  const total = conversations.length
  const todayCount = conversations.filter((c) => isToday(c.created_at)).length
  const list = useMemo(() => {
    const sorted = [...conversations].sort((a, b) => b.updated_at - a.updated_at)
    return tab === 'today' ? sorted.filter((c) => isToday(c.created_at)) : sorted
  }, [conversations, tab])

  return (
    <aside className="office-panel font-game">
      <div className="office-panel-stats">
        <div>
          <div className="office-panel-statlabel">今日对话</div>
          <div className="office-panel-statnum">{todayCount}</div>
        </div>
        <div className="text-right">
          <div className="office-panel-statlabel">累计对话</div>
          <div className="office-panel-statnum office-panel-statnum--dim">{total}</div>
        </div>
      </div>
      <div className="office-panel-bar">
        <span style={{ width: `${total > 0 ? Math.round((todayCount / total) * 100) : 0}%` }} />
      </div>

      <div className="office-panel-head">
        <span>对话明细</span>
        <div className="office-panel-tabs">
          <button className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>全部</button>
          <button className={tab === 'today' ? 'on' : ''} onClick={() => setTab('today')}>今日</button>
        </div>
      </div>

      <div className="office-panel-list">
        {list.length === 0 ? (
          <div className="office-panel-empty">暂无对话记录</div>
        ) : (
          list.map((c) => (
            <div key={c.id} className="office-panel-item">
              <div className="office-panel-item-title">{c.title || '未命名对话'}</div>
              <div className="office-panel-item-meta">
                <span className={isToday(c.updated_at) ? 'office-tag office-tag--live' : 'office-tag'}>
                  {isToday(c.updated_at) ? '今日活跃' : '已归档'}
                </span>
                <span className="office-panel-item-time">{shortTime(c.updated_at)}</span>
              </div>
            </div>
          ))
        )}
      </div>
      <div className="office-panel-foot">Token 用量尚未接入逐条统计，本面板以真实对话数为准</div>
    </aside>
  )
}

export default function AvatarOffice({ avatars, activeAvatarId, conversations, onClose, onEnterAvatar }: Props) {
  const [phase, setPhase] = useState<'intro' | 'office'>('intro')

  // 把激活的分身排到第一个工位（working），其余按原顺序铺开；最多 6 个工位。
  const seated = useMemo<Array<Avatar | null>>(() => {
    const sorted = [...avatars].sort((a, b) => {
      if (a.id === activeAvatarId) return -1
      if (b.id === activeAvatarId) return 1
      return 0
    })
    const filled: Array<Avatar | null> = sorted.slice(0, OFFICE_ANCHORS.length)
    while (filled.length < OFFICE_ANCHORS.length) filled.push(null)
    return filled
  }, [avatars, activeAvatarId])

  const hiddenCount = Math.max(0, avatars.length - OFFICE_ANCHORS.length)
  const officeTitle = (() => {
    const active = avatars.find((a) => a.id === activeAvatarId)
    const name = active?.name ?? 'SOUL'
    return `${name.length > 6 ? name.slice(0, 6) : name} 的办公室`
  })()

  const handleEnter = (id: string) => {
    onEnterAvatar(id)
    onClose()
  }

  return (
    <Modal isOpen onClose={onClose} size="xl">
      <PanelHeader
        title="AI 分身办公室"
        subtitle={phase === 'office' ? `在岗 ${seated.filter(Boolean).length}${hiddenCount > 0 ? ` · 另有 ${hiddenCount} 位未上墙` : ''} · 点击工位进入对应分身` : '团队待命中'}
        onClose={onClose}
      />

      <div className="office-stage flex-1 min-h-0 overflow-hidden">
        <style>{officeStyles}</style>

        {phase === 'intro' ? (
          <div className="office-intro">
            <div className="office-intro-card">
              <div className="office-intro-title font-game">好了，要正式上班了！</div>
              <div className="office-intro-sub font-game">有问题 24 小时随时吩咐我们。</div>
              <div className="office-intro-scene">
                <Scene seats={seated} anchors={INTRO_ANCHORS} withProps={false} viewBox="0 0 900 520" onEnter={handleEnter} />
              </div>
              <button className="office-start-btn font-game" onClick={() => setPhase('office')}>
                开启办公室
              </button>
            </div>
          </div>
        ) : (
          <div className="office-room">
            <div className="office-room-scene">
              <Scene seats={seated} anchors={OFFICE_ANCHORS} withProps title={officeTitle} onEnter={handleEnter} />
            </div>
            <TaskPanel conversations={conversations} />
          </div>
        )}

        {phase === 'office' && avatars.length === 0 && (
          <div className="office-empty font-game">办公室还空着 — 先去首页创建一个分身，TA 就会出现在工位上。</div>
        )}
      </div>
    </Modal>
  )
}

/** scoped 动画 + 布局样式：所有 class 以 office- 前缀，避免污染全局。 */
const officeStyles = `
.office-stage { position: relative; background: radial-gradient(circle at 58% 38%, #ffffff 0%, #eef0f4 72%, #e6e9ee 100%); }
.office-svg { width: 100%; height: 100%; display: block; }
.office-title { font-family: inherit; letter-spacing: 1px; opacity: 0.85; }

.office-seat { transform-box: fill-box; }
.office-seat--clickable { cursor: pointer; outline: none; }
.office-seat--clickable .office-nameplate rect { transition: stroke 0.15s; }
.office-seat--clickable:hover .office-nameplate rect,
.office-seat--clickable:focus-visible .office-nameplate rect { stroke: #9aa1ac; }
.office-seat--clickable:hover { filter: drop-shadow(0 5px 12px rgba(0,0,0,0.13)); }

.office-mascot { animation: office-bob 3.4s ease-in-out infinite; }
.office-mascot--sleep { animation: office-bob 4.6s ease-in-out infinite; }
.office-zzz { animation: office-zzz 3s ease-in-out infinite; }
.office-screen--on { animation: office-flicker 5s ease-in-out infinite; }
.office-cursor { animation: office-blink 1.1s step-end infinite; }
.office-status-dot { animation: office-pulse 1.8s ease-in-out infinite; transform-origin: center; transform-box: fill-box; }
.office-belt line { animation: office-belt 1.6s linear infinite; }
.office-steam { animation: office-steam 2.6s ease-in-out infinite; }
.office-plant { transform-box: fill-box; transform-origin: bottom center; animation: office-sway 4s ease-in-out infinite; }

/* 引导页 */
.office-intro { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; padding: 24px; }
.office-intro-card { width: min(760px, 92%); background: #ffffff; border-radius: 22px; box-shadow: 0 18px 50px rgba(31,41,60,0.10); padding: 36px 28px 30px; text-align: center; animation: office-rise 0.5s ease-out both; }
.office-intro-title { font-size: 20px; font-weight: 700; color: #2f343b; letter-spacing: 1px; }
.office-intro-sub { font-size: 14px; color: #7b828d; margin-top: 10px; }
.office-intro-scene { height: 360px; margin: 14px 0 22px; }
.office-start-btn { background: #1f2228; color: #fff; border: none; border-radius: 999px; padding: 12px 40px; font-size: 15px; letter-spacing: 2px; cursor: pointer; transition: transform 0.12s, background 0.12s; }
.office-start-btn:hover { background: #000; transform: translateY(-1px); }

/* 正式办公室：左场景 + 右面板 */
.office-room { display: flex; width: 100%; height: 100%; min-height: 0; }
.office-room-scene { flex: 1 1 auto; min-width: 0; animation: office-rise 0.5s ease-out both; }

.office-panel { flex: 0 0 340px; max-width: 340px; height: 100%; overflow-y: auto; background: rgba(255,255,255,0.82); backdrop-filter: blur(6px); border-left: 1px solid #e3e6ec; padding: 22px 20px; }
.office-panel-stats { display: flex; justify-content: space-between; align-items: flex-start; }
.office-panel-statlabel { font-size: 12px; color: #8b919b; }
.office-panel-statnum { font-size: 30px; font-weight: 700; color: #2f343b; line-height: 1.1; margin-top: 4px; }
.office-panel-statnum--dim { color: #b3b9c2; }
.office-panel-bar { height: 6px; border-radius: 4px; background: #eceef2; margin: 14px 0 22px; overflow: hidden; }
.office-panel-bar span { display: block; height: 100%; border-radius: 4px; background: linear-gradient(90deg, #f5b73c, #f59e3c); transition: width 0.4s; }
.office-panel-head { display: flex; justify-content: space-between; align-items: center; font-size: 13px; color: #3a3f47; font-weight: 600; margin-bottom: 12px; }
.office-panel-tabs button { border: none; background: none; font: inherit; font-size: 12px; color: #9aa1ac; cursor: pointer; padding: 2px 8px; border-radius: 6px; }
.office-panel-tabs button.on { background: #f0f1f4; color: #2f343b; }
.office-panel-list { display: flex; flex-direction: column; gap: 2px; }
.office-panel-item { padding: 12px 4px; border-bottom: 1px solid #eef0f3; }
.office-panel-item-title { font-size: 13px; color: #2f343b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.office-panel-item-meta { display: flex; justify-content: space-between; align-items: center; margin-top: 7px; }
.office-tag { font-size: 11px; color: #9aa1ac; background: #f1f2f5; border-radius: 6px; padding: 2px 8px; }
.office-tag--live { color: #2f8f5b; background: #e6f4ec; }
.office-panel-item-time { font-size: 11px; color: #aab0b9; font-variant-numeric: tabular-nums; }
.office-panel-empty { font-size: 13px; color: #9aa1ac; text-align: center; padding: 40px 0; }
.office-panel-foot { margin-top: 16px; font-size: 11px; color: #b3b9c2; line-height: 1.5; }

.office-empty { position: absolute; left: 38%; bottom: 24px; transform: translateX(-50%); font-size: 13px; color: #6b7280; background: rgba(255,255,255,0.88); border: 1px solid #e2e6ec; border-radius: 999px; padding: 8px 18px; white-space: nowrap; }

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
  .office-status-dot, .office-belt line, .office-steam, .office-plant,
  .office-intro-card, .office-room-scene { animation: none !important; }
}
`
