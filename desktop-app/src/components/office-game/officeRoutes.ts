import { getOfficeSlot, type OfficePoint, type OfficeSlotId } from './officeSlots'

export type OfficeWalkDirection = 'nw' | 'ne' | 'sw' | 'se'

export type OfficeRoute = {
  fromSlotId: OfficeSlotId
  toSlotId: OfficeSlotId
  waypoints: ReadonlyArray<OfficePoint>
  durationMs: number
}

type RouteKey = `${OfficeSlotId}->${OfficeSlotId}`

const ROUTES: Partial<Record<RouteKey, OfficeRoute>> = {
  'workstation_chair->water_bar_stand': {
    fromSlotId: 'workstation_chair',
    toSlotId: 'water_bar_stand',
    waypoints: [
      getOfficeSlot('workstation_chair').point,
      { x: 432, y: 534 },
      { x: 704, y: 536 },
      getOfficeSlot('water_bar_stand').point,
    ],
    durationMs: 5200,
  },
  'water_bar_stand->water_bar_seat': {
    fromSlotId: 'water_bar_stand',
    toSlotId: 'water_bar_seat',
    waypoints: [
      getOfficeSlot('water_bar_stand').point,
      { x: 836, y: 492 },
      getOfficeSlot('water_bar_seat').point,
    ],
    durationMs: 1800,
  },
  'water_bar_stand->sofa_left': {
    fromSlotId: 'water_bar_stand',
    toSlotId: 'sofa_left',
    waypoints: [
      getOfficeSlot('water_bar_stand').point,
      { x: 812, y: 506 },
      { x: 648, y: 584 },
      { x: 456, y: 616 },
      getOfficeSlot('sofa_left').point,
    ],
    durationMs: 5600,
  },
  'water_bar_seat->sofa_left': {
    fromSlotId: 'water_bar_seat',
    toSlotId: 'sofa_left',
    waypoints: [
      getOfficeSlot('water_bar_seat').point,
      { x: 724, y: 580 },
      { x: 526, y: 624 },
      getOfficeSlot('sofa_left').point,
    ],
    durationMs: 5600,
  },
  'sofa_left->meeting_chair': {
    fromSlotId: 'sofa_left',
    toSlotId: 'meeting_chair',
    waypoints: [
      getOfficeSlot('sofa_left').point,
      { x: 408, y: 628 },
      { x: 548, y: 596 },
      getOfficeSlot('meeting_chair').point,
    ],
    durationMs: 3600,
  },
  'sofa_left->workstation_chair': {
    fromSlotId: 'sofa_left',
    toSlotId: 'workstation_chair',
    waypoints: [
      getOfficeSlot('sofa_left').point,
      { x: 318, y: 572 },
      { x: 360, y: 520 },
      getOfficeSlot('workstation_chair').point,
    ],
    durationMs: 3400,
  },
  'meeting_chair->file_cabinet': {
    fromSlotId: 'meeting_chair',
    toSlotId: 'file_cabinet',
    waypoints: [
      getOfficeSlot('meeting_chair').point,
      { x: 704, y: 526 },
      { x: 770, y: 506 },
      getOfficeSlot('file_cabinet').point,
    ],
    durationMs: 2600,
  },
  'file_cabinet->knowledge_wall': {
    fromSlotId: 'file_cabinet',
    toSlotId: 'knowledge_wall',
    waypoints: [
      getOfficeSlot('file_cabinet').point,
      { x: 748, y: 458 },
      { x: 638, y: 388 },
      getOfficeSlot('knowledge_wall').point,
    ],
    durationMs: 4800,
  },
  'knowledge_wall->workstation_chair': {
    fromSlotId: 'knowledge_wall',
    toSlotId: 'workstation_chair',
    waypoints: [
      getOfficeSlot('knowledge_wall').point,
      { x: 500, y: 402 },
      { x: 418, y: 474 },
      getOfficeSlot('workstation_chair').point,
    ],
    durationMs: 4600,
  },
}

function routeKey(fromSlotId: OfficeSlotId, toSlotId: OfficeSlotId): RouteKey {
  return `${fromSlotId}->${toSlotId}`
}

function reverseRoute(route: OfficeRoute, fromSlotId: OfficeSlotId, toSlotId: OfficeSlotId): OfficeRoute {
  return {
    fromSlotId,
    toSlotId,
    waypoints: [...route.waypoints].reverse(),
    durationMs: route.durationMs,
  }
}

export function getOfficeRoute(fromSlotId: OfficeSlotId, toSlotId: OfficeSlotId): OfficeRoute {
  const direct = ROUTES[routeKey(fromSlotId, toSlotId)]
  if (direct) return direct

  const reverse = ROUTES[routeKey(toSlotId, fromSlotId)]
  if (reverse) return reverseRoute(reverse, fromSlotId, toSlotId)

  return {
    fromSlotId,
    toSlotId,
    waypoints: [getOfficeSlot(fromSlotId).point, getOfficeSlot(toSlotId).point],
    durationMs: 4200,
  }
}

function distance(a: OfficePoint, b: OfficePoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function directionForSegment(from: OfficePoint, to: OfficePoint): OfficeWalkDirection {
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (dx >= 0 && dy >= 0) return 'se'
  if (dx >= 0 && dy < 0) return 'ne'
  if (dx < 0 && dy >= 0) return 'sw'
  return 'nw'
}

export function pointOnOfficeRoute(route: OfficeRoute, progress: number): { point: OfficePoint; direction: OfficeWalkDirection } {
  const waypoints = route.waypoints
  if (waypoints.length < 2) return { point: waypoints[0] ?? { x: 0, y: 0 }, direction: 'se' }

  const clamped = Math.min(1, Math.max(0, progress))
  const lengths = waypoints.slice(1).map((point, index) => distance(waypoints[index], point))
  const total = lengths.reduce((sum, value) => sum + value, 0)
  let remaining = total * clamped

  for (let index = 0; index < lengths.length; index += 1) {
    const segmentLength = lengths[index]
    const from = waypoints[index]
    const to = waypoints[index + 1]
    if (remaining <= segmentLength || index === lengths.length - 1) {
      const t = segmentLength === 0 ? 1 : remaining / segmentLength
      return {
        point: {
          x: from.x + (to.x - from.x) * t,
          y: from.y + (to.y - from.y) * t,
        },
        direction: directionForSegment(from, to),
      }
    }
    remaining -= segmentLength
  }

  return {
    point: waypoints[waypoints.length - 1],
    direction: directionForSegment(waypoints[waypoints.length - 2], waypoints[waypoints.length - 1]),
  }
}
