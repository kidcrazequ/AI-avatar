import spriteMeta from '../../assets/office/character/soul-pig/soul-pig-office-standard-64.meta.json'
import spriteSheetUrl from '../../assets/office/character/soul-pig/soul-pig-office-standard-64.png'
import type { GamePose } from './officeGameV2Model'

type SpriteAction = keyof typeof spriteMeta.actions

export type SpriteFrame = {
  sx: number
  sy: number
  sw: number
  sh: number
}

export type SpriteDefinition = {
  imageUrl: string
  sheetWidth: number
  sheetHeight: number
  frameWidth: number
  frameHeight: number
  anchorX: number
  anchorY: number
  frames: SpriteFrame[]
}

const POSE_TO_ACTION: Record<GamePose, SpriteAction> = {
  idle_front: 'idle_front',
  walk_nw: 'walk_nw',
  walk_ne: 'walk_ne',
  walk_sw: 'walk_sw',
  walk_se: 'walk_se',
  sit_work: 'sit_work',
  stand_drink: 'stand_drink',
  sit_sofa: 'sit_sofa',
  sit_meeting: 'sit_meeting',
  stand_research: 'stand_research',
}

export function getSpriteDefinition(pose: GamePose): SpriteDefinition {
  const action = spriteMeta.actions[POSE_TO_ACTION[pose]]
  const frameWidth = spriteMeta.frameWidth
  const frameHeight = spriteMeta.frameHeight

  return {
    imageUrl: spriteSheetUrl,
    sheetWidth: spriteMeta.columns * frameWidth,
    sheetHeight: spriteMeta.rows * frameHeight,
    frameWidth,
    frameHeight,
    anchorX: action.anchorX,
    anchorY: action.anchorY,
    frames: Array.from({ length: action.frames }, (_, index) => ({
      sx: index * frameWidth,
      sy: action.row * frameHeight,
      sw: frameWidth,
      sh: frameHeight,
    })),
  }
}
