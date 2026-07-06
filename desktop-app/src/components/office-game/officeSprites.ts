import spriteMeta from '../../assets/office/character/soul-pig/soul-pig-office-standard-64.meta.json'
import spriteSheet from '../../assets/office/character/soul-pig/soul-pig-office-standard-64.png'
import type { OfficeNpcPose } from './officeSlots'

type OfficeSpriteAction = keyof typeof spriteMeta.actions

export type OfficeSpriteFrame = {
  x: number
  y: number
}

export type OfficeSpriteDefinition = {
  sheet: string
  sheetWidth: number
  sheetHeight: number
  frames: OfficeSpriteFrame[]
  width: number
  height: number
  frameClass: string
  anchorX: number
  anchorY: number
  offsetX?: number
  offsetY?: number
  crop?: {
    top: number
    height: number
  }
}

const POSE_TO_ACTION: Record<OfficeNpcPose, OfficeSpriteAction> = {
  idle_front: 'idle_front',
  walk_nw: 'walk_nw',
  walk_ne: 'walk_ne',
  walk_sw: 'walk_sw',
  walk_se: 'walk_se',
  sit_work: 'sit_work',
  stand_drink: 'stand_drink',
  sit_rest: 'sit_rest',
  sit_sofa: 'sit_sofa',
  sit_meeting: 'sit_meeting',
  stand_research: 'stand_research',
  stand_file: 'stand_file',
}

export function getOfficeSprite(pose: OfficeNpcPose): OfficeSpriteDefinition {
  const actionKey = POSE_TO_ACTION[pose]
  const action = spriteMeta.actions[actionKey]
  const width = spriteMeta.frameWidth
  const height = spriteMeta.frameHeight
  return {
    sheet: spriteSheet,
    sheetWidth: spriteMeta.columns * spriteMeta.frameWidth,
    sheetHeight: spriteMeta.rows * spriteMeta.frameHeight,
    frames: Array.from({ length: action.frames }, (_, index) => ({
      x: index * width,
      y: action.row * height,
    })),
    width,
    height,
    frameClass: action.frameClass,
    anchorX: action.anchorX,
    anchorY: action.anchorY,
  }
}
