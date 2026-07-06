/**
 * AvatarOffice: 「AI 分身办公室」全屏可视化页面。
 *
 * Soul 自有小猪分身的等距 3D 办公室：等距桌椅 + 空工位 + 独立小猪 agent
 * 按路线在办公室里行动 + 高清办公室素材底图 + 右侧任务面板。两段式：先「开启」引导页，
 * 点击开启进入正式办公室。
 *
 * 数据诚实声明：右侧面板的「对话明细」与计数全部来自真实会话数据（getConversations）。
 * Token 用量目前未在消息层落库统计，故面板用「对话数」作为真实可溯指标，不编造 token 数字。
 *
 * 设计取舍：
 * - 一个 Seat 单元复用真实空工位素材，再叠加状态屏幕和点击热区。
 * - 工位保持空椅；小猪只作为独立 agent 沿路线行动，避免座位上“有人”。
 * - 尊重 prefers-reduced-motion：减少动态偏好下全部动画暂停。
 *
 * @author Kian
 * @date 2026-06-24
 */

import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import Modal from './shared/Modal'
import OfficeGameV2 from './office-game-v2/OfficeGameV2'
import officeBackground from '../assets/office/pixel-office/soul-pixel-office-1080x780-prototype.png'
import pigIdle1 from '../assets/office/character/soul-pig/frames-prototype/soul-pig-idle-1-48-prototype.png'
import pigIdle2 from '../assets/office/character/soul-pig/frames-prototype/soul-pig-idle-2-48-prototype.png'
import pigIdle3 from '../assets/office/character/soul-pig/frames-prototype/soul-pig-idle-3-48-prototype.png'
import pigIdle4 from '../assets/office/character/soul-pig/frames-prototype/soul-pig-idle-4-48-prototype.png'
import pigCoffeeBreak1 from '../assets/office/character/soul-pig/frames-prototype/soul-pig-coffee-break-1-48-prototype.png'
import pigCoffeeBreak2 from '../assets/office/character/soul-pig/frames-prototype/soul-pig-coffee-break-2-48-prototype.png'
import pigCoffeeBreak3 from '../assets/office/character/soul-pig/frames-prototype/soul-pig-coffee-break-3-48-prototype.png'
import pigCoffeeBreak4 from '../assets/office/character/soul-pig/frames-prototype/soul-pig-coffee-break-4-48-prototype.png'
import pigFiling1 from '../assets/office/character/soul-pig/frames-prototype/soul-pig-filing-1-48-prototype.png'
import pigFiling2 from '../assets/office/character/soul-pig/frames-prototype/soul-pig-filing-2-48-prototype.png'
import pigFiling3 from '../assets/office/character/soul-pig/frames-prototype/soul-pig-filing-3-48-prototype.png'
import pigFiling4 from '../assets/office/character/soul-pig/frames-prototype/soul-pig-filing-4-48-prototype.png'
import pigMeeting1 from '../assets/office/character/soul-pig/frames-prototype/soul-pig-meeting-1-48-prototype.png'
import pigMeeting2 from '../assets/office/character/soul-pig/frames-prototype/soul-pig-meeting-2-48-prototype.png'
import pigMeeting3 from '../assets/office/character/soul-pig/frames-prototype/soul-pig-meeting-3-48-prototype.png'
import pigMeeting4 from '../assets/office/character/soul-pig/frames-prototype/soul-pig-meeting-4-48-prototype.png'
import pigResearching1 from '../assets/office/character/soul-pig/frames-prototype/soul-pig-researching-1-48-prototype.png'
import pigResearching2 from '../assets/office/character/soul-pig/frames-prototype/soul-pig-researching-2-48-prototype.png'
import pigResearching3 from '../assets/office/character/soul-pig/frames-prototype/soul-pig-researching-3-48-prototype.png'
import pigResearching4 from '../assets/office/character/soul-pig/frames-prototype/soul-pig-researching-4-48-prototype.png'
import pigWalk1 from '../assets/office/character/soul-pig/frames-prototype/soul-pig-walk-1-48-prototype.png'
import pigWalk2 from '../assets/office/character/soul-pig/frames-prototype/soul-pig-walk-2-48-prototype.png'
import pigWalk3 from '../assets/office/character/soul-pig/frames-prototype/soul-pig-walk-3-48-prototype.png'
import pigWalk4 from '../assets/office/character/soul-pig/frames-prototype/soul-pig-walk-4-48-prototype.png'

interface Props {
  avatars: Avatar[]
  /** 当前激活的分身 id（决定哪只小猪分身在「工作」） */
  activeAvatarId?: string
  /** 真实会话列表（来自 App 的 getConversations），驱动右侧任务面板。 */
  conversations: Conversation[]
  onClose: () => void
  /** 点击工位进入对应分身工作台 */
  onEnterAvatar: (avatarId: string) => void
}

/** 工位状态：working = 正在干活，idle = 待命，empty = 空工位 */
type SeatState = 'working' | 'idle' | 'empty'

/** 本地时区的「今天」判断（不走 UTC，避免跨时区漂移）。 */
function isToday(ts: number): boolean {
  const d = new Date(ts)
  const n = new Date()
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
}

/** 工位锚点（桌面中心）。 */
const OFFICE_ANCHORS: ReadonlyArray<{ x: number; y: number }> = [
  { x: 590, y: 146 },
  { x: 840, y: 146 },
  { x: 590, y: 392 },
  { x: 840, y: 392 },
  { x: 590, y: 627 },
  { x: 840, y: 627 },
]
const INTRO_ANCHORS: ReadonlyArray<{ x: number; y: number }> = [
  { x: 170, y: 170 },
  { x: 440, y: 170 },
  { x: 710, y: 170 },
  { x: 170, y: 370 },
  { x: 440, y: 370 },
  { x: 710, y: 370 },
]

type OfficeActionRoute = {
  id: OfficeActionId
  zone: OfficeZoneId
  home: OfficePoint
  path: string
  delay: string
  status: string
  duration: string
  scale: number
  pose: OfficeSpritePose
  shadow: {
    rx: number
    ry: number
    y: number
  }
}

type OfficeActionId = 'typing' | 'researching' | 'meeting' | 'filing' | 'thinking' | 'coffee_break'
type OfficeZoneId = 'workstation' | 'knowledge-wall' | 'meeting-table' | 'file-cabinet' | 'lounge' | 'water-bar'
type OfficeSpritePose = OfficeActionId | 'walk' | 'idle'

type OfficePoint = {
  x: number
  y: number
}

type OfficeMapPolygon = {
  id: string
  points: ReadonlyArray<OfficePoint>
}

type OfficeManualMove = {
  id: number
  from: OfficePoint
  to: OfficePoint
  path: string
  pathPoints: ReadonlyArray<OfficePoint>
  durationMs: number
  moving: boolean
  snapped: boolean
}

const OFFICE_NAV_MESH = {
  walkable: [
    { id: 'main-floor', points: [{ x: 236, y: 270 }, { x: 530, y: 156 }, { x: 972, y: 330 }, { x: 956, y: 522 }, { x: 704, y: 692 }, { x: 330, y: 700 }, { x: 94, y: 580 }, { x: 126, y: 402 }] },
    { id: 'left-workstation-aisle', points: [{ x: 214, y: 392 }, { x: 372, y: 432 }, { x: 438, y: 508 }, { x: 292, y: 552 }, { x: 174, y: 490 }] },
    { id: 'back-wall-aisle', points: [{ x: 350, y: 218 }, { x: 640, y: 230 }, { x: 724, y: 302 }, { x: 464, y: 362 }, { x: 274, y: 302 }] },
    { id: 'front-lounge-aisle', points: [{ x: 246, y: 550 }, { x: 558, y: 624 }, { x: 612, y: 716 }, { x: 284, y: 716 }, { x: 122, y: 626 }] },
  ],
  obstacles: [
    { id: 'left-workstation', points: [{ x: 144, y: 292 }, { x: 444, y: 386 }, { x: 442, y: 504 }, { x: 214, y: 456 }] },
    { id: 'conference-table', points: [{ x: 560, y: 388 }, { x: 742, y: 318 }, { x: 864, y: 392 }, { x: 668, y: 482 }] },
    { id: 'lounge-table-sofa', points: [{ x: 260, y: 548 }, { x: 536, y: 612 }, { x: 542, y: 716 }, { x: 258, y: 688 }] },
    { id: 'front-divider', points: [{ x: 610, y: 560 }, { x: 814, y: 488 }, { x: 824, y: 702 }, { x: 614, y: 754 }] },
    { id: 'right-cabinet', points: [{ x: 806, y: 420 }, { x: 972, y: 366 }, { x: 982, y: 566 }, { x: 820, y: 626 }] },
    { id: 'back-shelves', points: [{ x: 394, y: 86 }, { x: 640, y: 112 }, { x: 642, y: 260 }, { x: 384, y: 232 }] },
  ],
} as const satisfies {
  walkable: ReadonlyArray<OfficeMapPolygon>
  obstacles: ReadonlyArray<OfficeMapPolygon>
}

const OFFICE_PATH_WAYPOINTS: ReadonlyArray<OfficePoint> = [
  { x: 300, y: 510 },
  { x: 486, y: 548 },
  { x: 548, y: 506 },
  { x: 560, y: 590 },
  { x: 500, y: 308 },
  { x: 526, y: 288 },
]

type OfficeAgentActivity = {
  latest?: Conversation
  todayCount: number
  totalCount: number
}

type OfficeAgentPlan = {
  slot: number
  actionIndex: number
  occupant: Avatar
  activity?: OfficeAgentActivity
  action: OfficeActionRoute
}

const ACTION_ROUTES: ReadonlyArray<OfficeActionRoute> = [
  {
    id: 'typing',
    zone: 'workstation',
    home: { x: 332, y: 520 },
    path: 'M 410 585 L 332 520 L 410 585',
    delay: '0s',
    status: '主工位处理',
    duration: '16s',
    scale: 1.2,
    pose: 'typing',
    shadow: { rx: 22, ry: 6, y: -2 },
  },
  {
    id: 'researching',
    zone: 'knowledge-wall',
    home: { x: 560, y: 324 },
    path: 'M 650 430 L 560 324 L 650 430',
    delay: '0.8s',
    status: '书架查资料',
    duration: '15s',
    scale: 1.12,
    pose: 'researching',
    shadow: { rx: 20, ry: 5, y: -2 },
  },
  {
    id: 'meeting',
    zone: 'meeting-table',
    home: { x: 650, y: 522 },
    path: 'M 780 562 L 650 522 L 780 562',
    delay: '1.1s',
    status: '会议桌讨论',
    duration: '17s',
    scale: 1.2,
    pose: 'meeting',
    shadow: { rx: 21, ry: 6, y: -2 },
  },
  {
    id: 'filing',
    zone: 'file-cabinet',
    home: { x: 760, y: 582 },
    path: 'M 680 632 L 760 582 L 680 632',
    delay: '0.4s',
    status: '文件柜整理',
    duration: '14s',
    scale: 1.24,
    pose: 'filing',
    shadow: { rx: 21, ry: 6, y: -2 },
  },
  {
    id: 'thinking',
    zone: 'lounge',
    home: { x: 238, y: 625 },
    path: 'M 370 640 L 238 625 L 370 640',
    delay: '1.2s',
    status: '沙发区思考',
    duration: '18s',
    scale: 1.28,
    pose: 'idle',
    shadow: { rx: 22, ry: 6, y: -2 },
  },
  {
    id: 'coffee_break',
    zone: 'water-bar',
    home: { x: 852, y: 430 },
    path: 'M 780 520 L 852 430 L 780 520',
    delay: '0s',
    status: '水吧等候',
    duration: '16s',
    scale: 1.18,
    pose: 'coffee_break',
    shadow: { rx: 20, ry: 5, y: -2 },
  },
]

const OFFICE_ACTIONS = Object.fromEntries(ACTION_ROUTES.map((action) => [action.id, action])) as Record<OfficeActionId, OfficeActionRoute>
const DEFAULT_OFFICE_ACTIONS: ReadonlyArray<OfficeActionId> = ['typing', 'coffee_break', 'researching']

const PIG_IDLE_FRAMES = [pigIdle1, pigIdle2, pigIdle3, pigIdle4]
const PIG_WALK_FRAMES = [pigWalk1, pigWalk2, pigWalk3, pigWalk4]
const PIG_RESEARCHING_FRAMES = [pigResearching1, pigResearching2, pigResearching3, pigResearching4]
const PIG_MEETING_FRAMES = [pigMeeting1, pigMeeting2, pigMeeting3, pigMeeting4]
const PIG_FILING_FRAMES = [pigFiling1, pigFiling2, pigFiling3, pigFiling4]
const PIG_COFFEE_BREAK_FRAMES = [pigCoffeeBreak1, pigCoffeeBreak2, pigCoffeeBreak3, pigCoffeeBreak4]

const OFFICE_SLOT_ORDER = [0, 4, 5, 1, 2, 3] as const
const ACTION_AGENT_SLOTS = [0, 4, 5] as const
const ACTION_DEBUG_AGENT_SLOTS = [0, 4, 5, 1] as const
const ACTION_DEBUG_SEQUENCE: ReadonlyArray<OfficeActionId> = ['researching', 'meeting', 'filing', 'coffee_break']

function shortAgentName(name: string): string {
  return name.length > 7 ? name.slice(0, 7) + '…' : name
}

function shortTaskTitle(title: string): string {
  const value = title.trim() || '未命名对话'
  return value.length > 8 ? value.slice(0, 8) + '…' : value
}

function buildAgentActivities(conversations: Conversation[]): Map<string, OfficeAgentActivity> {
  const map = new Map<string, OfficeAgentActivity>()
  for (const c of conversations) {
    const current = map.get(c.avatar_id) ?? { todayCount: 0, totalCount: 0 }
    current.totalCount += 1
    if (isToday(c.created_at) || isToday(c.updated_at)) current.todayCount += 1
    if (!current.latest || c.updated_at > current.latest.updated_at) current.latest = c
    map.set(c.avatar_id, current)
  }
  return map
}

function agentStatus(route: OfficeActionRoute, activity?: OfficeAgentActivity): string {
  if (!activity?.latest) return route.status
  if (isToday(activity.latest.updated_at)) return `${route.status}：${shortTaskTitle(activity.latest.title)}`
  if (activity.todayCount > 0) return `今日处理 ${activity.todayCount} 次`
  return `最近任务：${shortTaskTitle(activity.latest.title)}`
}

function hasAnyKeyword(value: string, keywords: ReadonlyArray<string>): boolean {
  return keywords.some((keyword) => value.includes(keyword))
}

function chooseOfficeAction(activity: OfficeAgentActivity | undefined, actionIndex: number): OfficeActionRoute {
  const latest = activity?.latest
  if (!latest) return OFFICE_ACTIONS[DEFAULT_OFFICE_ACTIONS[actionIndex % DEFAULT_OFFICE_ACTIONS.length]]

  const title = latest.title.toLowerCase()
  const activeToday = isToday(latest.updated_at) || activity.todayCount > 0

  if (hasAnyKeyword(title, ['确认', '等待', '输入', '卡住', '休息', '咖啡', '水吧', '同步', '通知', 'handoff', 'approve', 'approval', 'waiting', 'sync'])) return OFFICE_ACTIONS.coffee_break
  if (hasAnyKeyword(title, ['会议', '讨论', '复盘', '评审', '协作', 'review', 'meeting'])) return OFFICE_ACTIONS.meeting
  if (hasAnyKeyword(title, ['导出', '归档', '整理', '文件', '文档', '打包', '上传', '下载', 'export', 'archive', 'file', 'document'])) return OFFICE_ACTIONS.filing
  if (hasAnyKeyword(title, ['知识', '资料', '搜索', '调研', '研究', '政策', '阅读', '检索', 'search', 'research', 'read'])) return OFFICE_ACTIONS.researching
  if (hasAnyKeyword(title, ['方案', '规划', '设计', '架构', '思考', '计划', 'plan', 'design'])) return OFFICE_ACTIONS.thinking
  if (!activeToday) return actionIndex % 2 === 0 ? OFFICE_ACTIONS.thinking : OFFICE_ACTIONS.coffee_break
  return OFFICE_ACTIONS.typing
}

function buildOfficeAgentPlans(seats: Array<Avatar | null>, activities: Map<string, OfficeAgentActivity>, actionDebug = false): OfficeAgentPlan[] {
  const slots = actionDebug ? ACTION_DEBUG_AGENT_SLOTS : ACTION_AGENT_SLOTS
  return slots.flatMap((slot, actionIndex) => {
    const occupant = seats[slot]
    if (!occupant) return []
    const activity = activities.get(occupant.id)
    const action = actionDebug
      ? OFFICE_ACTIONS[ACTION_DEBUG_SEQUENCE[actionIndex % ACTION_DEBUG_SEQUENCE.length]]
      : chooseOfficeAction(activity, actionIndex)
    return [{ slot, actionIndex, occupant, activity, action }]
  })
}

function OfficeWindowControls({ onClose }: { onClose: () => void }) {
  return (
    <div className="office-window-controls" aria-label="窗口控制">
      <button className="office-window-dot office-window-dot--red" onClick={onClose} aria-label="关闭办公室" />
      <span className="office-window-dot office-window-dot--yellow" />
      <span className="office-window-dot office-window-dot--green" />
    </div>
  )
}

function SpriteSequence({
  frames,
  width,
  height,
  scale,
  className,
}: {
  frames: string[]
  width: number
  height: number
  scale: number
  className: string
}) {
  return (
    <g transform={`scale(${scale})`}>
      <g transform={`translate(${-width / 2} ${-height})`}>
        {frames.map((src, i) => (
          <image key={src} href={src} width={width} height={height} className={`office-sprite-frame office-sprite-frame--${i} ${className}`} />
        ))}
      </g>
    </g>
  )
}

function SoulPigAgent({ pose, scale }: { pose: OfficeSpritePose; scale: number }) {
  if (pose === 'typing') {
    return <SpriteSequence frames={PIG_IDLE_FRAMES} width={48} height={64} scale={scale} className="office-typing-sequence" />
  }
  if (pose === 'researching') {
    return <SpriteSequence frames={PIG_RESEARCHING_FRAMES} width={48} height={64} scale={scale} className="office-researching-sequence" />
  }
  if (pose === 'meeting') {
    return <SpriteSequence frames={PIG_MEETING_FRAMES} width={48} height={64} scale={scale} className="office-meeting-sequence" />
  }
  if (pose === 'filing') {
    return <SpriteSequence frames={PIG_FILING_FRAMES} width={48} height={64} scale={scale} className="office-filing-sequence" />
  }
  if (pose === 'coffee_break') {
    return <SpriteSequence frames={PIG_COFFEE_BREAK_FRAMES} width={48} height={64} scale={scale} className="office-coffee-break-sequence" />
  }
  if (pose === 'walk') {
    return <SpriteSequence frames={PIG_WALK_FRAMES} width={48} height={64} scale={scale} className="office-walk-sequence" />
  }
  return <SpriteSequence frames={PIG_IDLE_FRAMES} width={48} height={64} scale={scale} className="office-idle-sequence" />
}

function SpriteGroundShadow({ shadow, scale }: { shadow: OfficeActionRoute['shadow']; scale: number }) {
  const { rx, ry, y } = shadow
  return (
    <g className="office-agent-shadow" transform={`scale(${scale})`}>
      <path d={`M ${-rx} ${y} L 0 ${y - ry} L ${rx} ${y} L 0 ${y + ry} Z`} />
      <path className="office-agent-shadow-core" d={`M ${-rx * 0.58} ${y} L 0 ${y - ry * 0.55} L ${rx * 0.58} ${y} L 0 ${y + ry * 0.55} Z`} />
    </g>
  )
}

function isOfficeNavDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const params = new URLSearchParams(window.location.search)
    return params.get('officeNavDebug') === '1' || window.localStorage.getItem('soul:office-nav-debug') === '1'
  } catch {
    return false
  }
}

function isOfficeActionDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const params = new URLSearchParams(window.location.search)
    return params.get('officeActionDebug') === '1' || window.localStorage.getItem('soul:office-action-debug') === '1'
  } catch {
    return false
  }
}

function svgPointFromClient(svg: SVGSVGElement, clientX: number, clientY: number): OfficePoint | null {
  const ctm = svg.getScreenCTM()
  if (!ctm) return null
  const point = svg.createSVGPoint()
  point.x = clientX
  point.y = clientY
  const mapped = point.matrixTransform(ctm.inverse())
  return { x: mapped.x, y: mapped.y }
}

function polygonPoints(points: ReadonlyArray<OfficePoint>): string {
  return points.map(({ x, y }) => `${x},${y}`).join(' ')
}

function distance(a: OfficePoint, b: OfficePoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function pointInPolygon(point: OfficePoint, polygon: ReadonlyArray<OfficePoint>): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i]
    const pj = polygon[j]
    const crosses = (pi.y > point.y) !== (pj.y > point.y)
    if (crosses && point.x < ((pj.x - pi.x) * (point.y - pi.y)) / (pj.y - pi.y) + pi.x) inside = !inside
  }
  return inside
}

function pointInAnyPolygon(point: OfficePoint, polygons: ReadonlyArray<OfficeMapPolygon>): boolean {
  return polygons.some((polygon) => pointInPolygon(point, polygon.points))
}

function isWalkableOfficePoint(point: OfficePoint): boolean {
  return pointInAnyPolygon(point, OFFICE_NAV_MESH.walkable) && !pointInAnyPolygon(point, OFFICE_NAV_MESH.obstacles)
}

function isWalkableSegment(from: OfficePoint, to: OfficePoint): boolean {
  const samples = 18
  for (let i = 0; i <= samples; i += 1) {
    const t = i / samples
    if (!isWalkableOfficePoint({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t })) return false
  }
  return true
}

function pathLength(points: ReadonlyArray<OfficePoint>): number {
  return points.reduce((sum, point, i) => sum + (i === 0 ? 0 : distance(points[i - 1], point)), 0)
}

function officePointsPath(points: ReadonlyArray<OfficePoint>): string {
  return points.map((point, i) => `${i === 0 ? 'M' : 'L'} ${Math.round(point.x)} ${Math.round(point.y)}`).join(' ')
}

function snapOfficePointToWalkable(point: OfficePoint): { point: OfficePoint; snapped: boolean } {
  if (isWalkableOfficePoint(point)) return { point, snapped: false }

  let best: OfficePoint | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (let ring = 1; ring <= 24; ring += 1) {
    const radius = ring * 12
    for (let i = 0; i < 24; i += 1) {
      const angle = (Math.PI * 2 * i) / 24
      const candidate = { x: point.x + Math.cos(angle) * radius, y: point.y + Math.sin(angle) * radius }
      if (!isWalkableOfficePoint(candidate)) continue
      const d = distance(point, candidate)
      if (d < bestDistance) {
        best = candidate
        bestDistance = d
      }
    }
    if (best) return { point: best, snapped: true }
  }

  for (const area of OFFICE_NAV_MESH.walkable) {
    for (const candidate of area.points) {
      if (!isWalkableOfficePoint(candidate)) continue
      const d = distance(point, candidate)
      if (d < bestDistance) {
        best = candidate
        bestDistance = d
      }
    }
  }
  return { point: best ?? OFFICE_ACTIONS.typing.home, snapped: true }
}

function buildOfficeWalkPath(from: OfficePoint, to: OfficePoint): ReadonlyArray<OfficePoint> {
  if (isWalkableSegment(from, to)) return [from, to]
  for (const waypoint of OFFICE_PATH_WAYPOINTS) {
    if (isWalkableSegment(from, waypoint) && isWalkableSegment(waypoint, to)) return [from, waypoint, to]
  }
  for (const first of OFFICE_PATH_WAYPOINTS) {
    if (!isWalkableSegment(from, first)) continue
    for (const second of OFFICE_PATH_WAYPOINTS) {
      if (isWalkableSegment(first, second) && isWalkableSegment(second, to)) return [from, first, second, to]
    }
  }
  return [from, to]
}

function OfficeNavMeshDebugLayer() {
  return (
    <g className="office-nav-debug-layer" aria-hidden="true">
      {OFFICE_NAV_MESH.walkable.map((area) => (
        <polygon key={area.id} className="office-nav-debug-walkable" points={polygonPoints(area.points)} />
      ))}
      {OFFICE_NAV_MESH.obstacles.map((area) => (
        <polygon key={area.id} className="office-nav-debug-obstacle" points={polygonPoints(area.points)} />
      ))}
    </g>
  )
}

function OfficeManualPathOverlay({ move }: { move: OfficeManualMove | null }) {
  if (!move) return null
  return (
    <g className="office-manual-path-layer" aria-hidden="true">
      <path className="office-manual-path-line" d={move.path} />
      <g className={move.snapped ? 'office-manual-target office-manual-target--snapped' : 'office-manual-target'} transform={`translate(${move.to.x} ${move.to.y})`}>
        <path d="M 0 -12 L 12 0 L 0 12 L -12 0 Z" />
        <path d="M 0 -5 L 5 0 L 0 5 L -5 0 Z" />
      </g>
    </g>
  )
}

function OfficeManualAgent({
  occupant,
  action,
  activity,
  highlighted,
  move,
}: {
  occupant: Avatar
  action: OfficeActionRoute
  activity?: OfficeAgentActivity
  highlighted: boolean
  move: OfficeManualMove
}) {
  const labelNameY = -70
  const labelStatusY = labelNameY + 14
  const duration = `${(move.durationMs / 1000).toFixed(2)}s`
  return (
    <g key={`${occupant.id}-${move.id}`} className={`office-action-agent office-action-agent--manual${highlighted ? ' office-action-agent--focus' : ''}`}>
      <animateMotion key={move.id} path={move.path} dur={duration} fill="freeze" />
      <g className="office-action-label">
        <text className="office-action-label-name" x="0" y={labelNameY} textAnchor="middle" fontSize="14" fontWeight="700">{shortAgentName(occupant.name)}</text>
        <text className="office-action-label-status" x="0" y={labelStatusY} textAnchor="middle" fontSize="8">{move.moving ? '调试移动中' : agentStatus(action, activity)}</text>
      </g>
      <SpriteGroundShadow shadow={action.shadow} scale={action.scale} />
      <SoulPigAgent pose={move.moving ? 'walk' : 'idle'} scale={action.scale} />
    </g>
  )
}

function OfficeAutoAgent({ plan, highlighted }: { plan: OfficeAgentPlan; highlighted: boolean }) {
  const { occupant, activity, action } = plan
  const labelNameY = -70
  const labelStatusY = labelNameY + 14
  return (
    <g
      key={`${occupant.id}-${action.id}`}
      className={`office-action-agent office-action-agent--auto office-action-agent--${action.id}${highlighted ? ' office-action-agent--focus' : ''}`}
      style={{ animationDuration: action.duration, animationDelay: action.delay }}
    >
      <g className="office-action-label">
        <text className="office-action-label-name" x="0" y={labelNameY} textAnchor="middle" fontSize="14" fontWeight="700">{shortAgentName(occupant.name)}</text>
        <text className="office-action-label-status" x="0" y={labelStatusY} textAnchor="middle" fontSize="8">{agentStatus(action, activity)}</text>
      </g>
      <SpriteGroundShadow shadow={action.shadow} scale={action.scale} />
      <g className="office-action-pose office-action-pose--walk" style={{ animationDuration: action.duration, animationDelay: action.delay }}>
        <SoulPigAgent pose="walk" scale={action.scale} />
      </g>
      <g className="office-action-pose office-action-pose--work" style={{ animationDuration: action.duration, animationDelay: action.delay }}>
        <SoulPigAgent pose={action.pose} scale={action.scale} />
      </g>
    </g>
  )
}

function OfficeActionRoutes({
  plans,
  highlightedAvatarId,
}: {
  plans: ReadonlyArray<OfficeAgentPlan>
  highlightedAvatarId: string | null
}) {
  return (
    <g className="office-action-routes" aria-hidden="true">
      {plans.map((plan) => (
        <path key={plan.occupant.id} className={`office-route-line${highlightedAvatarId === plan.occupant.id ? ' office-route-line--focus' : ''}`} d={plan.action.path} />
      ))}
    </g>
  )
}

function OfficeActionAgents({
  plans,
  highlightedAvatarId,
  manualMove,
}: {
  plans: ReadonlyArray<OfficeAgentPlan>
  highlightedAvatarId: string | null
  manualMove: OfficeManualMove | null
}) {
  return (
    <g className="office-action-agents" aria-hidden="true">
      {plans.map((plan) => {
        const { occupant, activity, action, actionIndex } = plan
        const highlighted = highlightedAvatarId === occupant.id
        if (actionIndex === 0 && manualMove) {
          return <OfficeManualAgent key={occupant.id} occupant={occupant} action={action} activity={activity} highlighted={highlighted} move={manualMove} />
        }
        return <OfficeAutoAgent key={occupant.id} plan={plan} highlighted={highlighted} />
      })}
    </g>
  )
}

/**
 * 一个等距 3D 工位：落地投影 + 等距桌（桌面斜角 + 厚度 + 桌腿）+ 显示器 + 空椅。
 * 参考图里的座位保持空椅，agent 作为独立角色在场景里移动，不坐在工位上。
 */
function Seat({
  anchor,
  occupant,
  state,
  index,
  showScreen,
  onEnter,
}: {
  anchor: { x: number; y: number }
  occupant: Avatar | null
  state: SeatState
  index: number
  showScreen: boolean
  onEnter: () => void
}) {
  const { x, y } = anchor
  const working = showScreen && state === 'working' && index === 0
  const screenColor = '#1f9dff'
  const clickable = Boolean(occupant)
  const deskW = 260
  const deskH = 219
  const deskX = x - deskW / 2
  const deskY = y - 110
  const screenW = 71
  const screenH = 34
  const screenX = x - 44
  const screenY = y - 84

  return (
    <g
      className={clickable ? 'office-seat office-seat--clickable' : 'office-seat'}
      onClick={clickable ? onEnter : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-label={occupant ? `进入「${occupant.name}」工作台` : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onEnter() } } : undefined}
    >
      <rect x={deskX} y={deskY} width={deskW} height={deskH} fill="transparent" />
      <rect
        x={screenX}
        y={screenY}
        width={screenW}
        height={screenH}
        rx="2"
        fill={screenColor}
        className={working ? 'office-screen office-screen--on' : 'office-screen'}
        opacity={working ? '0.92' : '0'}
      />
      {working && (
        <g opacity="0.38">
          <rect x={screenX + 9} y={screenY + 7} width="52" height="2" rx="1" fill="#fff" />
          <rect x={screenX + 9} y={screenY + 13} width="34" height="2" rx="1" fill="#fff" />
          <rect x={screenX + 9} y={screenY + 19} width="44" height="2" rx="1" fill="#fff" />
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
  activities,
  highlightedAvatarId,
  manualMove,
  viewBox = '0 0 1080 780',
  onEnter,
  onOfficePointClick,
}: {
  seats: Array<Avatar | null>
  anchors: ReadonlyArray<{ x: number; y: number }>
  withProps: boolean
  title?: string
  activities: Map<string, OfficeAgentActivity>
  highlightedAvatarId: string | null
  manualMove?: OfficeManualMove | null
  viewBox?: string
  onEnter: (id: string) => void
  onOfficePointClick?: (point: OfficePoint) => void
}) {
  const [, , vbW, vbH] = viewBox.split(' ').map(Number)
  const showNavDebug = withProps && isOfficeNavDebugEnabled()
  const showActionDebug = withProps && isOfficeActionDebugEnabled()
  const officePlans = buildOfficeAgentPlans(seats, activities, showActionDebug)
  const handleSvgClick = (event: MouseEvent<SVGSVGElement>) => {
    if (!withProps || !onOfficePointClick) return
    const target = event.target instanceof Element ? event.target : null
    if (target?.closest('.office-seat--clickable')) return
    const point = svgPointFromClient(event.currentTarget, event.clientX, event.clientY)
    if (point) onOfficePointClick(point)
  }
  return (
    <svg
      viewBox={viewBox}
      className={`office-svg${withProps && onOfficePointClick ? ' office-svg--navigable' : ''}${showActionDebug ? ' office-svg--action-debug' : ''}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={title ?? '分身办公室'}
      onClick={handleSvgClick}
    >
      <defs>
        <radialGradient id="officeFloor" cx="56%" cy="40%" r="78%">
          <stop offset="0%" stopColor="var(--office-surface)" />
          <stop offset="70%" stopColor="var(--office-bg)" />
          <stop offset="100%" stopColor="var(--office-elevated)" />
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
        <image href={officeBackground} x="0" y="0" width={vbW} height={vbH} preserveAspectRatio="xMidYMid meet" />
      )}

      {withProps && <OfficeActionRoutes plans={officePlans} highlightedAvatarId={highlightedAvatarId} />}

      {withProps && <OfficeManualPathOverlay move={manualMove ?? null} />}

      {anchors.map((anchor, i) => {
        const occupant = seats[i] ?? null
        const activity = occupant ? activities.get(occupant.id) : undefined
        const state: SeatState = !occupant ? 'empty' : activity?.todayCount ? 'working' : i === 0 ? 'working' : 'idle'
        return (
          <Seat
            key={i}
            anchor={anchor}
            occupant={occupant}
            state={state}
            index={i}
            showScreen={!withProps}
            onEnter={() => occupant && onEnter(occupant.id)}
          />
        )
      })}

      {withProps && <OfficeActionAgents plans={officePlans} highlightedAvatarId={highlightedAvatarId} manualMove={manualMove ?? null} />}

      {showNavDebug && <OfficeNavMeshDebugLayer />}
    </svg>
  )
}

export default function AvatarOffice({ avatars, activeAvatarId, conversations, onClose, onEnterAvatar }: Props) {
  const [phase, setPhase] = useState<'intro' | 'office'>('office')
  const [manualMove, setManualMove] = useState<OfficeManualMove | null>(null)

  // 把激活的分身排到第一个工位（working），其余按原顺序铺开；最多 6 个工位。
  const seated = useMemo<Array<Avatar | null>>(() => {
    const sorted = [...avatars].sort((a, b) => {
      if (a.id === activeAvatarId) return -1
      if (b.id === activeAvatarId) return 1
      return 0
    })
    const filled: Array<Avatar | null> = Array.from({ length: OFFICE_ANCHORS.length }, () => null)
    sorted.slice(0, OFFICE_ANCHORS.length).forEach((avatar, i) => {
      filled[OFFICE_SLOT_ORDER[i]] = avatar
    })
    return filled
  }, [avatars, activeAvatarId])

  const agentActivities = useMemo(() => buildAgentActivities(conversations), [conversations])
  const focusedAvatarId = activeAvatarId ?? null
  const officeNavDebug = isOfficeNavDebugEnabled()

  useEffect(() => {
    const scanlineRoot = document.querySelector<HTMLElement>('.crt-scanlines')
    if (!scanlineRoot) return
    const previous = scanlineRoot.style.getPropertyValue('--px-scanline')
    scanlineRoot.style.setProperty('--px-scanline', 'transparent')
    return () => {
      if (previous) scanlineRoot.style.setProperty('--px-scanline', previous)
      else scanlineRoot.style.removeProperty('--px-scanline')
    }
  }, [])

  useEffect(() => {
    if (!manualMove?.moving) return
    const timer = window.setTimeout(() => {
      setManualMove((current) => current?.id === manualMove.id ? { ...current, moving: false } : current)
    }, manualMove.durationMs)
    return () => window.clearTimeout(timer)
  }, [manualMove?.durationMs, manualMove?.id, manualMove?.moving])

  const handleEnter = (id: string) => {
    onEnterAvatar(id)
    onClose()
  }

  const handleOfficePointClick = (point: OfficePoint) => {
    if (!seated[ACTION_AGENT_SLOTS[0]]) return
    const snapped = snapOfficePointToWalkable(point)
    const from = manualMove?.to ?? OFFICE_ACTIONS.typing.home
    const pathPoints = buildOfficeWalkPath(from, snapped.point)
    const durationMs = Math.min(1800, Math.max(650, Math.round(pathLength(pathPoints) * 2.1)))
    setManualMove({
      id: Date.now(),
      from,
      to: snapped.point,
      path: officePointsPath(pathPoints),
      pathPoints,
      durationMs,
      moving: true,
      snapped: snapped.snapped,
    })
  }

  return (
    <Modal isOpen onClose={onClose} size="xl">
      <div className={`office-shell office-shell--${phase}`}>
        <style>{officeStyles}</style>

        {phase === 'intro' ? (
          <div className="office-intro">
            <OfficeWindowControls onClose={onClose} />
            <div className="office-intro-card">
              <div className="office-intro-title font-game">好了，要正式上班了！</div>
              <div className="office-intro-sub font-game">有问题 24 小时随时吩咐我们。</div>
              <div className="office-intro-scene">
                <Scene
                  seats={seated}
                  anchors={INTRO_ANCHORS}
                  withProps={false}
                  activities={agentActivities}
                  highlightedAvatarId={focusedAvatarId}
                  manualMove={officeNavDebug ? manualMove : null}
                  viewBox="0 0 900 520"
                  onEnter={handleEnter}
                  onOfficePointClick={officeNavDebug ? handleOfficePointClick : undefined}
                />
              </div>
              <button className="office-start-btn font-game" onClick={() => setPhase('office')}>
                开启办公室
              </button>
            </div>
          </div>
        ) : (
          <div className="office-room">
            <div className="office-room-scene">
              <OfficeGameV2 avatars={avatars} activeAvatarId={activeAvatarId} onEnterAvatar={handleEnter} />
            </div>
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
.office-shell {
  --office-bg: color-mix(in srgb, var(--px-bg, #f7f7f8) 4%, #fbfbfb);
  --office-surface: color-mix(in srgb, var(--px-surface, #ffffff) 3%, #ffffff);
  --office-elevated: color-mix(in srgb, var(--px-elevated, #f1f1f2) 5%, #f2f2f3);
  --office-border: color-mix(in srgb, var(--px-border, #e6e6e7) 35%, #e6e6e7);
  --office-text: color-mix(in srgb, var(--px-text, #101114) 18%, #101114);
  --office-text-sec: color-mix(in srgb, var(--px-text-sec, #8a8a8f) 45%, #8a8a8f);
  --office-primary: color-mix(in srgb, var(--px-primary, #111111) 32%, #111111);
  --office-glow: color-mix(in srgb, var(--px-primary, #101114) 12%, transparent);
  --office-glow-strong: color-mix(in srgb, var(--px-primary, #101114) 26%, transparent);
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
  display: block;
  overflow: hidden;
  background: var(--office-bg);
  color: var(--office-text);
  border-radius: 0;
  font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.office-shell,
.office-shell .font-game { font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important; }
.office-shell * { box-sizing: border-box; letter-spacing: 0; }
.office-shell--intro { display: block; background: var(--office-bg); }
.office-window-controls { position: absolute; top: 24px; left: 24px; z-index: 6; display: flex; gap: 10px; align-items: center; }
.office-window-dot { width: 14px; height: 14px; border-radius: 999px; display: block; border: none; padding: 0; box-shadow: inset 0 -1px 1px rgba(0,0,0,0.12); }
button.office-window-dot { cursor: pointer; }
.office-window-dot--red { background: #ff5f57; }
.office-window-dot--yellow { background: #ffbd2e; }
.office-window-dot--green { background: #28c840; }

.office-sidebar {
  position: relative;
  flex: 0 0 272px;
  width: 272px;
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 62px 18px 22px;
  background: rgba(255,255,255,0.72);
  border-right: 1px solid rgba(0,0,0,0.04);
  box-shadow: inset -1px 0 0 rgba(255,255,255,0.7);
}
.office-sidebar .office-window-controls { position: absolute; top: 20px; left: 18px; }
.office-sidebar-brand { margin: 0 8px 24px; font-size: 30px; font-weight: 800; line-height: 1; color: #111; }
.office-sidebar-search {
  margin: 0 2px 24px;
  height: 46px;
  border: 1px solid #dedfe3;
  border-radius: 11px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 14px;
  color: #b0b2b8;
  background: rgba(255,255,255,0.7);
}
.office-sidebar-search input {
  min-width: 0;
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font: inherit;
  font-size: 13px;
  color: #2c2d31;
}
.office-sidebar-search input::placeholder { color: #b7b8bd; }
.office-sidebar-nav { flex: 1; min-height: 0; overflow: hidden; }
.office-sidebar-section { margin-bottom: 28px; }
.office-sidebar-title { margin: 0 12px 12px; font-size: 12px; color: #777b82; }
.office-sidebar-item {
  width: 100%;
  height: 46px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 12px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: #202226;
  font: inherit;
  font-size: 15px;
  text-align: left;
  cursor: default;
}
.office-sidebar-item--active { background: #eeeeef; font-weight: 700; }
.office-sidebar-item span:last-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.office-sidebar-icon {
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #050505;
  font-size: 16px;
  font-weight: 800;
}
.office-sidebar-footer { border-top: 1px solid #ebecef; padding: 16px 0 0; }
.office-sidebar-status { display: flex; justify-content: space-between; gap: 8px; margin: 0 10px 12px; color: #92959b; font-size: 11px; white-space: nowrap; }
.office-sidebar-user { display: flex; align-items: center; gap: 10px; padding: 4px 10px; color: #202226; font-size: 14px; }
.office-sidebar-user > span:nth-child(2) { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.office-sidebar-avatar { width: 24px; height: 24px; border-radius: 999px; display: inline-flex; align-items: center; justify-content: center; background: #222; color: #fff; font-size: 12px; font-weight: 800; }

.office-svg { width: 100%; height: 100%; display: block; }
.office-svg--navigable { cursor: crosshair; }
.office-title { font-family: inherit; letter-spacing: 0; opacity: 1; fill: #0f1013; }

.office-seat { transform-box: fill-box; }
.office-seat--clickable { cursor: pointer; outline: none; }
.office-seat--clickable:hover { filter: drop-shadow(0 5px 12px rgba(0,0,0,0.13)); }

.office-action-routes,
.office-action-agents { pointer-events: none; }
.office-route-line { fill: none; stroke: rgba(17,17,17,0.46); stroke-width: 1.25; stroke-linecap: square; stroke-dasharray: 3 12; opacity: 0; animation: office-route-dash 12s linear infinite; }
.office-route-line--focus { opacity: 0.12; }
.office-action-agent { transform-box: view-box; transform-origin: 0 0; animation-timing-function: linear; animation-iteration-count: infinite; will-change: transform; }
.office-action-agent--typing { animation-name: office-agent-route-typing; }
.office-action-agent--researching { animation-name: office-agent-route-researching; }
.office-action-agent--meeting { animation-name: office-agent-route-meeting; }
.office-action-agent--filing { animation-name: office-agent-route-filing; }
.office-action-agent--thinking { animation-name: office-agent-route-thinking; }
.office-action-agent--coffee_break { animation-name: office-agent-route-coffee-break; }
.office-action-agent--manual { animation: none; }
.office-agent-shadow { fill: rgba(0,0,0,0.2); opacity: 0.58; }
.office-agent-shadow-core { fill: rgba(0,0,0,0.18); opacity: 0.74; }
.office-manual-path-layer { pointer-events: none; }
.office-manual-path-line { fill: none; stroke: rgba(17,17,17,0.42); stroke-width: 2; stroke-linecap: square; stroke-linejoin: miter; stroke-dasharray: 5 9; vector-effect: non-scaling-stroke; animation: office-route-dash 12s linear infinite; }
.office-manual-target path:first-child { fill: rgba(255,255,255,0.72); stroke: rgba(17,17,17,0.58); stroke-width: 2; vector-effect: non-scaling-stroke; }
.office-manual-target path:last-child { fill: rgba(17,17,17,0.54); }
.office-manual-target--snapped path:first-child { fill: rgba(255,237,186,0.78); }
.office-nav-debug-layer { pointer-events: none; mix-blend-mode: multiply; }
.office-nav-debug-walkable,
.office-nav-debug-obstacle { shape-rendering: crispEdges; stroke-width: 2; vector-effect: non-scaling-stroke; }
.office-nav-debug-walkable { fill: rgba(61,169,107,0.22); stroke: rgba(25,116,72,0.72); }
.office-nav-debug-obstacle { fill: rgba(221,75,75,0.26); stroke: rgba(166,42,42,0.78); }
.office-action-label { opacity: 0; transform: translateY(4px); transition: opacity 0.12s ease, transform 0.12s ease; }
.office-action-label-name { fill: rgba(16,17,20,0.82); stroke: rgba(251,251,251,0.82); stroke-width: 3; paint-order: stroke; }
.office-action-label-status { fill: rgba(55,58,64,0.68); stroke: rgba(251,251,251,0.78); stroke-width: 2.5; paint-order: stroke; opacity: 0; }
.office-action-agent--focus .office-action-label { opacity: 0.96; transform: translateY(0); }
.office-action-agent--focus .office-action-label-status { opacity: 1; }
.office-action-agent--focus .office-sprite-image,
.office-action-agent--focus .office-sprite-frame { filter: drop-shadow(0 4px 12px var(--office-glow-strong)); }
.office-action-pose { opacity: 0; animation-duration: 16s; animation-iteration-count: infinite; animation-timing-function: step-end; }
.office-action-pose--walk { animation-name: office-action-pose-walk; }
.office-action-pose--work { animation-name: office-action-pose-work; }
.office-sprite-image { image-rendering: pixelated; }
.office-sprite-frame { image-rendering: pixelated; opacity: 0; animation-duration: 0.8s; animation-timing-function: step-end; animation-iteration-count: infinite; }
.office-sprite-frame--0 { animation-name: office-sprite-frame-0; }
.office-sprite-frame--1 { animation-name: office-sprite-frame-1; }
.office-sprite-frame--2 { animation-name: office-sprite-frame-2; }
.office-sprite-frame--3 { animation-name: office-sprite-frame-3; }

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
.office-intro { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; padding: 54px 24px 34px; background: #fff; }
.office-intro-card { width: min(840px, 92%); padding: 20px 28px 30px; text-align: center; animation: office-rise 0.5s ease-out both; }
.office-intro-title { font-size: 22px; font-weight: 700; color: #111; line-height: 1.45; }
.office-intro-sub { font-size: 18px; color: #111; line-height: 1.45; margin-top: 2px; }
.office-intro-scene { height: min(420px, 48vh); margin: 24px 0 28px; }
.office-start-btn { background: #111; color: #fff; border: none; border-radius: 999px; min-width: 208px; height: 58px; padding: 0 42px; font-size: 19px; font-weight: 700; cursor: pointer; transition: transform 0.12s, background 0.12s; }
.office-start-btn:hover { background: #000; transform: translateY(-1px); }

/* 正式办公室：全屏舞台 */
.office-room { position: absolute; inset: 0; width: 100%; height: 100%; min-height: 0; overflow: hidden; background: #1d2430; }
.office-room-scene { position: absolute; inset: 0; min-width: 0; padding: 0; animation: office-rise 0.5s ease-out both; }
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
.office-game-sprite--walk_ne,
.office-game-sprite--walk_nw { filter: saturate(0.95) brightness(0.92); }
.office-game-sprite--walk_se,
.office-game-sprite--walk_sw { filter: saturate(1.05) brightness(1.02); }
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
.office-game-npc:focus-visible .office-game-sprite-frame { filter: drop-shadow(0 4px 12px rgba(255,255,255,0.45)); }
.office-game-npc-label rect { fill: rgba(250,250,246,0.88); stroke: rgba(32,33,35,0.18); stroke-width: 1; }
.office-game-npc-label-name { font-size: 11px; font-weight: 800; fill: rgba(20,22,25,0.88); }
.office-game-npc-label-status { font-size: 8px; font-weight: 600; fill: rgba(72,76,82,0.72); }

.office-empty { position: absolute; left: 52%; bottom: 24px; transform: translateX(-50%); font-size: 13px; color: var(--office-text-sec); background: var(--office-surface); border: 1px solid var(--office-border); border-radius: 999px; padding: 8px 18px; white-space: nowrap; box-shadow: 0 8px 24px var(--office-glow); }

@media (max-width: 1180px) {
  .office-sidebar { flex-basis: 232px; width: 232px; }
  .office-sidebar-brand { font-size: 26px; }
}

@keyframes office-rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
@keyframes office-route-dash { from { stroke-dashoffset: 0; } to { stroke-dashoffset: -36; } }
@keyframes office-agent-route-typing {
  0%, 100% { transform: translate(410px,585px); }
  28%, 74% { transform: translate(332px,520px); }
}
@keyframes office-agent-route-researching {
  0%, 100% { transform: translate(650px,430px); }
  28%, 74% { transform: translate(560px,324px); }
}
@keyframes office-agent-route-meeting {
  0%, 100% { transform: translate(780px,562px); }
  28%, 74% { transform: translate(650px,522px); }
}
@keyframes office-agent-route-filing {
  0%, 100% { transform: translate(680px,632px); }
  28%, 74% { transform: translate(760px,582px); }
}
@keyframes office-agent-route-thinking {
  0%, 100% { transform: translate(370px,640px); }
  28%, 74% { transform: translate(238px,625px); }
}
@keyframes office-agent-route-coffee-break {
  0%, 100% { transform: translate(780px,520px); }
  28%, 74% { transform: translate(852px,430px); }
}
@keyframes office-action-pose-walk {
  0%, 27.99% { opacity: 1; }
  28%, 73.99% { opacity: 0; }
  74%, 100% { opacity: 1; }
}
@keyframes office-action-pose-work {
  0%, 27.99% { opacity: 0; }
  28%, 73.99% { opacity: 1; }
  74%, 100% { opacity: 0; }
}
@keyframes office-sprite-frame-0 { 0%, 24.9% { opacity: 1; } 25%, 100% { opacity: 0; } }
@keyframes office-sprite-frame-1 { 0%, 24.9% { opacity: 0; } 25%, 49.9% { opacity: 1; } 50%, 100% { opacity: 0; } }
@keyframes office-sprite-frame-2 { 0%, 49.9% { opacity: 0; } 50%, 74.9% { opacity: 1; } 75%, 100% { opacity: 0; } }
@keyframes office-sprite-frame-3 { 0%, 74.9% { opacity: 0; } 75%, 100% { opacity: 1; } }
@keyframes office-game-sprite-frame-0 { 0%, 24.9% { opacity: 1; } 25%, 100% { opacity: 0; } }
@keyframes office-game-sprite-frame-1 { 0%, 24.9% { opacity: 0; } 25%, 49.9% { opacity: 1; } 50%, 100% { opacity: 0; } }
@keyframes office-game-sprite-frame-2 { 0%, 49.9% { opacity: 0; } 50%, 74.9% { opacity: 1; } 75%, 100% { opacity: 0; } }
@keyframes office-game-sprite-frame-3 { 0%, 74.9% { opacity: 0; } 75%, 100% { opacity: 1; } }
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
  .office-intro-card, .office-room-scene, .office-route-line, .office-action-agent,
  .office-manual-path-line, .office-sprite-frame, .office-game-sprite-frame { animation: none !important; }
  .office-sprite-frame, .office-game-sprite-frame { opacity: 0 !important; }
  .office-sprite-frame--0, .office-game-sprite-frame--0 { opacity: 1 !important; }
}
`
