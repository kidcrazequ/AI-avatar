export type GamePoint = {
  x: number
  y: number
}

export type GameDirection = 'nw' | 'ne' | 'sw' | 'se'

export type GamePose =
  | 'idle_front'
  | 'walk_nw'
  | 'walk_ne'
  | 'walk_sw'
  | 'walk_se'
  | 'sit_work'
  | 'stand_drink'
  | 'sit_sofa'
  | 'sit_meeting'
  | 'stand_research'

export type InteractionPointId = 'workstation' | 'water_bar' | 'sofa' | 'rest_table' | 'whiteboard'

export type InteractionPoint = {
  id: InteractionPointId
  kind: 'seat' | 'stand'
  label: string
  // Where pathing finishes before the NPC switches into the local interaction state.
  routePoint: GamePoint
  // Sprite anchor while the NPC is performing this interaction.
  actionPoint: GamePoint
  markerPoint?: GamePoint
  facing: GameDirection
  radius: number
  pose: GamePose
  actionMs: number
  status: string
}

export type GameRoute = {
  from: InteractionPointId
  to: InteractionPointId
  points: ReadonlyArray<GamePoint>
  durationMs: number
}

export type NpcPhase = 'acting' | 'walking'

export type NpcSnapshot = {
  avatar: Avatar
  npcId: string
  routePlanId: string
  index: number
  phase: NpcPhase
  from: InteractionPointId
  to: InteractionPointId
  point: GamePoint
  pose: GamePose
  status: string
  progress: number
  direction: GameDirection
}

type RoutePlan = {
  id: string
  points: ReadonlyArray<InteractionPointId>
  slots?: Partial<Record<InteractionPointId, GamePoint>>
  laneOffset?: GamePoint
}

type TimelineStep =
  | {
      kind: 'acting'
      at: InteractionPointId
      durationMs: number
    }
  | {
      kind: 'walking'
      from: InteractionPointId
      to: InteractionPointId
      durationMs: number
    }

export const OFFICE_GAME_WORLD = {
  width: 1080,
  height: 780,
} as const

export const INTERACTION_POINTS = {
  workstation: {
    id: 'workstation',
    kind: 'seat',
    label: '工位',
    routePoint: { x: 262, y: 454 },
    actionPoint: { x: 246, y: 410 },
    markerPoint: { x: 246, y: 386 },
    facing: 'nw',
    radius: 30,
    pose: 'sit_work',
    actionMs: 6200,
    status: '坐在电脑前工作',
  },
  water_bar: {
    id: 'water_bar',
    kind: 'stand',
    label: '水吧',
    routePoint: { x: 858, y: 414 },
    actionPoint: { x: 858, y: 414 },
    markerPoint: { x: 882, y: 342 },
    facing: 'ne',
    radius: 30,
    pose: 'stand_drink',
    actionMs: 4200,
    status: '在水吧喝水',
  },
  sofa: {
    id: 'sofa',
    kind: 'seat',
    label: '沙发',
    routePoint: { x: 306, y: 594 },
    actionPoint: { x: 306, y: 594 },
    markerPoint: { x: 318, y: 570 },
    facing: 'se',
    radius: 38,
    pose: 'sit_sofa',
    actionMs: 5200,
    status: '坐在沙发上思考',
  },
  rest_table: {
    id: 'rest_table',
    kind: 'seat',
    label: '休息桌',
    routePoint: { x: 662, y: 506 },
    actionPoint: { x: 662, y: 506 },
    markerPoint: { x: 706, y: 432 },
    facing: 'nw',
    radius: 30,
    pose: 'sit_meeting',
    actionMs: 5200,
    status: '坐在休息桌旁整理思路',
  },
  whiteboard: {
    id: 'whiteboard',
    kind: 'stand',
    label: '白板',
    routePoint: { x: 704, y: 350 },
    actionPoint: { x: 704, y: 350 },
    markerPoint: { x: 720, y: 188 },
    facing: 'nw',
    radius: 28,
    pose: 'stand_research',
    actionMs: 4600,
    status: '在白板前研究方案',
  },
} as const satisfies Record<InteractionPointId, InteractionPoint>

function getRoutePoint(id: InteractionPointId): GamePoint {
  return INTERACTION_POINTS[id].routePoint
}

function getActionPoint(id: InteractionPointId): GamePoint {
  return INTERACTION_POINTS[id].actionPoint
}

export const GAME_ROUTES: ReadonlyArray<GameRoute> = [
  {
    from: 'workstation',
    to: 'water_bar',
    points: [
      getRoutePoint('workstation'),
      { x: 292, y: 486 },
      { x: 560, y: 532 },
      { x: 750, y: 486 },
      getRoutePoint('water_bar'),
    ],
    durationMs: 5600,
  },
  {
    from: 'water_bar',
    to: 'sofa',
    points: [
      getRoutePoint('water_bar'),
      { x: 786, y: 488 },
      { x: 590, y: 588 },
      { x: 430, y: 620 },
      getRoutePoint('sofa'),
    ],
    durationMs: 6200,
  },
  {
    from: 'sofa',
    to: 'workstation',
    points: [
      getRoutePoint('sofa'),
      { x: 304, y: 566 },
      { x: 266, y: 486 },
      getRoutePoint('workstation'),
    ],
    durationMs: 3600,
  },
  {
    from: 'workstation',
    to: 'whiteboard',
    points: [
      getRoutePoint('workstation'),
      { x: 302, y: 486 },
      { x: 520, y: 470 },
      getRoutePoint('whiteboard'),
    ],
    durationMs: 4600,
  },
  {
    from: 'whiteboard',
    to: 'rest_table',
    points: [
      getRoutePoint('whiteboard'),
      { x: 660, y: 420 },
      getRoutePoint('rest_table'),
    ],
    durationMs: 3000,
  },
  {
    from: 'rest_table',
    to: 'water_bar',
    points: [
      getRoutePoint('rest_table'),
      { x: 748, y: 470 },
      getRoutePoint('water_bar'),
    ],
    durationMs: 3400,
  },
  {
    from: 'water_bar',
    to: 'whiteboard',
    points: [
      getRoutePoint('water_bar'),
      { x: 764, y: 392 },
      getRoutePoint('whiteboard'),
    ],
    durationMs: 3800,
  },
  {
    from: 'rest_table',
    to: 'workstation',
    points: [
      getRoutePoint('rest_table'),
      { x: 540, y: 528 },
      { x: 340, y: 510 },
      getRoutePoint('workstation'),
    ],
    durationMs: 5200,
  },
  {
    from: 'sofa',
    to: 'rest_table',
    points: [
      getRoutePoint('sofa'),
      { x: 438, y: 618 },
      { x: 592, y: 546 },
      getRoutePoint('rest_table'),
    ],
    durationMs: 4600,
  },
]

const LOOP: ReadonlyArray<InteractionPointId> = ['workstation', 'water_bar', 'sofa', 'workstation']
const ROUTE_PLANS: ReadonlyArray<RoutePlan> = [
  {
    id: 'focus-loop',
    points: ['workstation', 'water_bar', 'sofa', 'workstation'],
  },
  {
    id: 'research-loop',
    points: ['whiteboard', 'rest_table', 'water_bar', 'whiteboard'],
    slots: {
      whiteboard: { x: 682, y: 352 },
      rest_table: { x: 620, y: 504 },
      water_bar: { x: 836, y: 418 },
    },
    laneOffset: { x: -18, y: -10 },
  },
  {
    id: 'support-loop',
    points: ['rest_table', 'workstation', 'whiteboard', 'rest_table'],
    slots: {
      rest_table: { x: 704, y: 502 },
      workstation: { x: 258, y: 430 },
      whiteboard: { x: 732, y: 356 },
    },
    laneOffset: { x: 16, y: 8 },
  },
  {
    id: 'lounge-loop',
    points: ['sofa', 'rest_table', 'water_bar', 'sofa'],
    slots: {
      sofa: { x: 360, y: 604 },
      rest_table: { x: 734, y: 466 },
      water_bar: { x: 894, y: 424 },
    },
    laneOffset: { x: 28, y: 12 },
  },
]

function routeKey(from: InteractionPointId, to: InteractionPointId): string {
  return `${from}->${to}`
}

const ROUTE_MAP = new Map(GAME_ROUTES.map((route) => [routeKey(route.from, route.to), route]))

function getRoute(from: InteractionPointId, to: InteractionPointId): GameRoute {
  const route = ROUTE_MAP.get(routeKey(from, to))
  if (route) return route

  return {
    from,
    to,
    points: [getRoutePoint(from), getRoutePoint(to)],
    durationMs: 4200,
  }
}

function getPlanRoutePoint(plan: RoutePlan | undefined, id: InteractionPointId): GamePoint {
  return plan?.slots?.[id] ?? getRoutePoint(id)
}

function getPlanActionPoint(plan: RoutePlan | undefined, id: InteractionPointId): GamePoint {
  return plan?.slots?.[id] ?? getActionPoint(id)
}

function getPlanRoute(plan: RoutePlan | undefined, from: InteractionPointId, to: InteractionPointId): GameRoute {
  const route = getRoute(from, to)
  const offset = plan?.laneOffset ?? { x: 0, y: 0 }
  return {
    ...route,
    points: route.points.map((point, index) => {
      if (index === 0) return getPlanRoutePoint(plan, from)
      if (index === route.points.length - 1) return getPlanRoutePoint(plan, to)
      return {
        x: point.x + offset.x,
        y: point.y + offset.y,
      }
    }),
  }
}

function distance(a: GamePoint, b: GamePoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function direction(from: GamePoint, to: GamePoint): GameDirection {
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (dx >= 0 && dy >= 0) return 'se'
  if (dx >= 0 && dy < 0) return 'ne'
  if (dx < 0 && dy >= 0) return 'sw'
  return 'nw'
}

function walkPose(value: GameDirection): GamePose {
  if (value === 'nw') return 'walk_nw'
  if (value === 'ne') return 'walk_ne'
  if (value === 'sw') return 'walk_sw'
  return 'walk_se'
}

function pointOnRoute(route: GameRoute, progress: number): { point: GamePoint; direction: GameDirection } {
  const points = route.points
  if (points.length < 2) return { point: points[0] ?? { x: 0, y: 0 }, direction: 'se' }

  const clamped = Math.min(1, Math.max(0, progress))
  const lengths = points.slice(1).map((point, index) => distance(points[index], point))
  const total = lengths.reduce((sum, value) => sum + value, 0)
  let remaining = total * clamped

  for (let index = 0; index < lengths.length; index += 1) {
    const segment = lengths[index]
    const from = points[index]
    const to = points[index + 1]
    if (remaining <= segment || index === lengths.length - 1) {
      const t = segment === 0 ? 1 : remaining / segment
      return {
        point: {
          x: from.x + (to.x - from.x) * t,
          y: from.y + (to.y - from.y) * t,
        },
        direction: direction(from, to),
      }
    }
    remaining -= segment
  }

  return {
    point: points[points.length - 1],
    direction: direction(points[points.length - 2], points[points.length - 1]),
  }
}

function buildTimeline(): ReadonlyArray<TimelineStep> {
  return buildTimelineForPlan({ id: 'legacy-loop', points: LOOP })
}

function buildTimelineForPlan(plan: RoutePlan): ReadonlyArray<TimelineStep> {
  const steps: TimelineStep[] = []
  for (let index = 0; index < plan.points.length - 1; index += 1) {
    const at = plan.points[index]
    const to = plan.points[index + 1]
    steps.push({ kind: 'acting', at, durationMs: INTERACTION_POINTS[at].actionMs })
    steps.push({ kind: 'walking', from: at, to, durationMs: getRoute(at, to).durationMs })
  }
  return steps
}

const TIMELINE = buildTimeline()
const CYCLE_MS = TIMELINE.reduce((sum, step) => sum + step.durationMs, 0)
const PLAN_TIMELINES = new Map(
  ROUTE_PLANS.map((plan) => {
    const timeline = buildTimelineForPlan(plan)
    return [
      plan.id,
      {
        plan,
        timeline,
        cycleMs: timeline.reduce((sum, step) => sum + step.durationMs, 0),
      },
    ] as const
  }),
)

export function selectGameAvatar(avatars: Avatar[], activeAvatarId?: string): Avatar | null {
  return avatars.find((avatar) => avatar.id === activeAvatarId) ?? avatars[0] ?? null
}

export function getNpcSnapshot(avatar: Avatar, elapsedMs: number): NpcSnapshot {
  return getNpcSnapshotFromTimeline({
    avatar,
    elapsedMs,
    index: 0,
    routePlanId: 'legacy-loop',
    timeline: TIMELINE,
    cycleMs: CYCLE_MS,
  })
}

export function getStaticNpcSnapshot(avatar: Avatar, at: InteractionPointId = 'workstation'): NpcSnapshot {
  const interactionPoint = INTERACTION_POINTS[at]
  return {
    avatar,
    npcId: avatar.id,
    routePlanId: 'static-calibration',
    index: 0,
    phase: 'acting',
    from: at,
    to: at,
    point: getActionPoint(at),
    pose: interactionPoint.pose,
    status: interactionPoint.status,
    progress: 1,
    direction: interactionPoint.facing,
  }
}

export function getNpcSnapshots(avatars: Avatar[], activeAvatarId: string | undefined, elapsedMs: number): NpcSnapshot[] {
  const activeIndex = activeAvatarId ? avatars.findIndex((avatar) => avatar.id === activeAvatarId) : -1
  const ordered = activeIndex > 0
    ? [avatars[activeIndex], ...avatars.slice(0, activeIndex), ...avatars.slice(activeIndex + 1)]
    : avatars

  return ordered.slice(0, 4).map((avatar, index) => {
    const plan = ROUTE_PLANS[index % ROUTE_PLANS.length]
    const timeline = PLAN_TIMELINES.get(plan.id)
    const cycleMs = timeline?.cycleMs ?? CYCLE_MS
    return getNpcSnapshotFromTimeline({
      avatar,
      elapsedMs: elapsedMs + stableNpcOffsetMs(avatar.id, index, cycleMs),
      index,
      routePlanId: plan.id,
      plan,
      timeline: timeline?.timeline ?? TIMELINE,
      cycleMs,
    })
  })
}

function getNpcSnapshotFromTimeline({
  avatar,
  elapsedMs,
  index,
  routePlanId,
  plan,
  timeline,
  cycleMs,
}: {
  avatar: Avatar
  elapsedMs: number
  index: number
  routePlanId: string
  plan?: RoutePlan
  timeline: ReadonlyArray<TimelineStep>
  cycleMs: number
}): NpcSnapshot {
  const cycleTime = ((elapsedMs % cycleMs) + cycleMs) % cycleMs
  let cursor = 0

  for (const step of timeline) {
    const nextCursor = cursor + step.durationMs
    if (cycleTime <= nextCursor) {
      const progress = step.durationMs === 0 ? 1 : (cycleTime - cursor) / step.durationMs
      if (step.kind === 'acting') {
        const point = INTERACTION_POINTS[step.at]
        const planPoint = getPlanActionPoint(plan, step.at)
        return {
          avatar,
          npcId: avatar.id,
          routePlanId,
          index,
          phase: 'acting',
          from: step.at,
          to: step.at,
          point: planPoint,
          pose: point.pose,
          status: point.status,
          progress,
          direction: point.facing,
        }
      }

      const route = getPlanRoute(plan, step.from, step.to)
      const walk = pointOnRoute(route, progress)
      return {
        avatar,
        npcId: avatar.id,
        routePlanId,
        index,
        phase: 'walking',
        from: step.from,
        to: step.to,
        point: walk.point,
        pose: walkPose(walk.direction),
        status: `前往${INTERACTION_POINTS[step.to].label}`,
        progress,
        direction: walk.direction,
      }
    }
    cursor = nextCursor
  }

  return getNpcSnapshotFromTimeline({ avatar, elapsedMs: 0, index, routePlanId, plan, timeline, cycleMs })
}

function stableNpcOffsetMs(avatarId: string, index: number, cycleMs: number): number {
  let hash = 0
  for (let i = 0; i < avatarId.length; i += 1) {
    hash = (hash * 31 + avatarId.charCodeAt(i)) >>> 0
  }
  return (hash + index * 6800) % Math.max(1, cycleMs)
}
