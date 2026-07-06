export type OfficePoint = {
  x: number
  y: number
}

export type OfficeSlotId =
  | 'workstation_chair'
  | 'water_bar_stand'
  | 'water_bar_seat'
  | 'sofa_left'
  | 'meeting_chair'
  | 'knowledge_wall'
  | 'file_cabinet'

export type OfficeNpcPose =
  | 'idle_front'
  | 'walk_nw'
  | 'walk_ne'
  | 'walk_sw'
  | 'walk_se'
  | 'sit_work'
  | 'stand_drink'
  | 'sit_rest'
  | 'sit_sofa'
  | 'sit_meeting'
  | 'stand_research'
  | 'stand_file'

export type OfficeSlot = {
  id: OfficeSlotId
  zone: 'workstation' | 'water_bar' | 'lounge' | 'meeting' | 'knowledge' | 'file'
  label: string
  point: OfficePoint
  pose: OfficeNpcPose
  scale: number
  actionMs: number
  status: string
}

export const OFFICE_SLOTS = {
  workstation_chair: {
    id: 'workstation_chair',
    zone: 'workstation',
    label: '工位',
    point: { x: 236, y: 456 },
    pose: 'sit_work',
    scale: 1.28,
    actionMs: 6200,
    status: '坐在工位处理任务',
  },
  water_bar_stand: {
    id: 'water_bar_stand',
    zone: 'water_bar',
    label: '水吧',
    point: { x: 872, y: 452 },
    pose: 'stand_drink',
    scale: 1.28,
    actionMs: 4200,
    status: '在水吧喝水等候',
  },
  water_bar_seat: {
    id: 'water_bar_seat',
    zone: 'water_bar',
    label: '水吧座位',
    point: { x: 794, y: 526 },
    pose: 'sit_rest',
    scale: 1.28,
    actionMs: 4200,
    status: '坐在水吧旁休息',
  },
  sofa_left: {
    id: 'sofa_left',
    zone: 'lounge',
    label: '沙发',
    point: { x: 330, y: 606 },
    pose: 'sit_sofa',
    scale: 1.28,
    actionMs: 5200,
    status: '坐在沙发上思考',
  },
  meeting_chair: {
    id: 'meeting_chair',
    zone: 'meeting',
    label: '会议桌',
    point: { x: 656, y: 532 },
    pose: 'sit_meeting',
    scale: 1.28,
    actionMs: 5200,
    status: '坐在会议桌边讨论',
  },
  knowledge_wall: {
    id: 'knowledge_wall',
    zone: 'knowledge',
    label: '书架白板',
    point: { x: 560, y: 326 },
    pose: 'stand_research',
    scale: 1.28,
    actionMs: 5000,
    status: '站在书架前查资料',
  },
  file_cabinet: {
    id: 'file_cabinet',
    zone: 'file',
    label: '文件柜',
    point: { x: 820, y: 498 },
    pose: 'stand_file',
    scale: 1.28,
    actionMs: 4600,
    status: '站在文件柜前整理',
  },
} as const satisfies Record<OfficeSlotId, OfficeSlot>

export const OFFICE_SINGLE_NPC_SEQUENCE: ReadonlyArray<OfficeSlotId> = [
  'workstation_chair',
  'water_bar_stand',
  'sofa_left',
  'workstation_chair',
]

export function getOfficeSlot(id: OfficeSlotId): OfficeSlot {
  return OFFICE_SLOTS[id]
}
