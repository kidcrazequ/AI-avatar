import { getOfficeRoute, pointOnOfficeRoute, type OfficeWalkDirection } from './officeRoutes'
import { getOfficeSlot, OFFICE_SINGLE_NPC_SEQUENCE, type OfficeNpcPose, type OfficePoint, type OfficeSlot, type OfficeSlotId } from './officeSlots'

export type OfficeNpcPhase = 'walking' | 'acting'

export type OfficeNpcSnapshot = {
  avatar: Avatar
  phase: OfficeNpcPhase
  fromSlotId: OfficeSlotId
  toSlotId: OfficeSlotId
  slot: OfficeSlot
  position: OfficePoint
  pose: OfficeNpcPose
  status: string
  progress: number
}

type TimelineStep =
  | {
      kind: 'acting'
      fromSlotId: OfficeSlotId
      toSlotId: OfficeSlotId
      durationMs: number
    }
  | {
      kind: 'walking'
      fromSlotId: OfficeSlotId
      toSlotId: OfficeSlotId
      durationMs: number
    }

function walkPose(direction: OfficeWalkDirection): OfficeNpcPose {
  if (direction === 'nw') return 'walk_nw'
  if (direction === 'ne') return 'walk_ne'
  if (direction === 'sw') return 'walk_sw'
  return 'walk_se'
}

function walkStatus(fromSlotId: OfficeSlotId, toSlotId: OfficeSlotId): string {
  if (fromSlotId === 'workstation_chair' && toSlotId === 'water_bar_stand') return '起身前往水吧'
  if (fromSlotId === 'water_bar_stand' && toSlotId === 'sofa_left') return '前往沙发区'
  if (fromSlotId === 'sofa_left' && toSlotId === 'workstation_chair') return '回工位继续工作'
  return `前往${getOfficeSlot(toSlotId).label}`
}

function buildTimeline(): ReadonlyArray<TimelineStep> {
  const steps: TimelineStep[] = []
  for (let index = 0; index < OFFICE_SINGLE_NPC_SEQUENCE.length - 1; index += 1) {
    const current = OFFICE_SINGLE_NPC_SEQUENCE[index]
    const next = OFFICE_SINGLE_NPC_SEQUENCE[index + 1]
    steps.push({
      kind: 'acting',
      fromSlotId: current,
      toSlotId: current,
      durationMs: getOfficeSlot(current).actionMs,
    })
    steps.push({
      kind: 'walking',
      fromSlotId: current,
      toSlotId: next,
      durationMs: getOfficeRoute(current, next).durationMs,
    })
  }
  return steps
}

const SINGLE_NPC_TIMELINE = buildTimeline()
const SINGLE_NPC_CYCLE_MS = SINGLE_NPC_TIMELINE.reduce((sum, step) => sum + step.durationMs, 0)

export function selectOfficeNpcAvatar(avatars: Avatar[], activeAvatarId?: string): Avatar | null {
  return avatars.find((avatar) => avatar.id === activeAvatarId) ?? avatars[0] ?? null
}

export function getSingleOfficeNpcSnapshot(avatar: Avatar, elapsedMs: number): OfficeNpcSnapshot {
  const cycleTime = ((elapsedMs % SINGLE_NPC_CYCLE_MS) + SINGLE_NPC_CYCLE_MS) % SINGLE_NPC_CYCLE_MS
  let cursor = 0

  for (const step of SINGLE_NPC_TIMELINE) {
    const nextCursor = cursor + step.durationMs
    if (cycleTime <= nextCursor) {
      const progress = step.durationMs === 0 ? 1 : (cycleTime - cursor) / step.durationMs
      if (step.kind === 'acting') {
        const slot = getOfficeSlot(step.fromSlotId)
        return {
          avatar,
          phase: 'acting',
          fromSlotId: step.fromSlotId,
          toSlotId: step.toSlotId,
          slot,
          position: slot.point,
          pose: slot.pose,
          status: slot.status,
          progress,
        }
      }

      const route = getOfficeRoute(step.fromSlotId, step.toSlotId)
      const { point, direction } = pointOnOfficeRoute(route, progress)
      return {
        avatar,
        phase: 'walking',
        fromSlotId: step.fromSlotId,
        toSlotId: step.toSlotId,
        slot: getOfficeSlot(step.toSlotId),
        position: point,
        pose: walkPose(direction),
        status: walkStatus(step.fromSlotId, step.toSlotId),
        progress,
      }
    }
    cursor = nextCursor
  }

  const fallbackSlot = getOfficeSlot('workstation_chair')
  return {
    avatar,
    phase: 'acting',
    fromSlotId: 'workstation_chair',
    toSlotId: 'workstation_chair',
    slot: fallbackSlot,
    position: fallbackSlot.point,
    pose: fallbackSlot.pose,
    status: fallbackSlot.status,
    progress: 1,
  }
}
