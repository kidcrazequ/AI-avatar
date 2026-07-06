import mapBackUrl from '../../assets/office/pixel-office/soul-pixel-office-1080x780-prototype.png'
import mapFrontUrl from '../../assets/office/pixel-office/soul-pixel-office-1080x780-front-layer.png'
import { GAME_ROUTES, INTERACTION_POINTS, OFFICE_GAME_WORLD } from './officeGameV2Model'

export const OFFICE_GAME_MAP = {
  world: OFFICE_GAME_WORLD,
  layers: {
    back: mapBackUrl,
    front: mapFrontUrl,
  },
  interactionPoints: INTERACTION_POINTS,
  routes: GAME_ROUTES,
  walkableZones: [
    {
      id: 'main_floor',
      polygon: [
        { x: 198, y: 354 },
        { x: 900, y: 350 },
        { x: 966, y: 588 },
        { x: 656, y: 724 },
        { x: 198, y: 642 },
        { x: 120, y: 520 },
      ],
    },
    {
      id: 'lounge_floor',
      polygon: [
        { x: 174, y: 552 },
        { x: 438, y: 552 },
        { x: 504, y: 664 },
        { x: 250, y: 720 },
        { x: 112, y: 634 },
      ],
    },
    {
      id: 'water_bar_floor',
      polygon: [
        { x: 742, y: 382 },
        { x: 962, y: 382 },
        { x: 998, y: 528 },
        { x: 828, y: 574 },
        { x: 704, y: 508 },
      ],
    },
  ],
  collisionZones: [
    {
      id: 'workstation_desk',
      polygon: [
        { x: 124, y: 360 },
        { x: 438, y: 356 },
        { x: 480, y: 492 },
        { x: 104, y: 500 },
      ],
    },
    {
      id: 'meeting_table',
      polygon: [
        { x: 560, y: 414 },
        { x: 816, y: 414 },
        { x: 852, y: 538 },
        { x: 526, y: 548 },
      ],
    },
    {
      id: 'water_bar_counter',
      polygon: [
        { x: 830, y: 302 },
        { x: 1010, y: 328 },
        { x: 990, y: 460 },
        { x: 816, y: 438 },
      ],
    },
    {
      id: 'sofa_and_lounge_table',
      polygon: [
        { x: 196, y: 570 },
        { x: 472, y: 582 },
        { x: 512, y: 660 },
        { x: 184, y: 674 },
      ],
    },
  ],
  frontOccluders: [
    {
      id: 'sofa_front',
      polygon: [
        { x: 216, y: 592 },
        { x: 438, y: 592 },
        { x: 468, y: 650 },
        { x: 184, y: 650 },
      ],
    },
    {
      id: 'meeting_table_front',
      polygon: [
        { x: 552, y: 500 },
        { x: 798, y: 500 },
        { x: 826, y: 560 },
        { x: 520, y: 560 },
      ],
    },
    {
      id: 'foreground_divider',
      polygon: [
        { x: 606, y: 606 },
        { x: 842, y: 548 },
        { x: 904, y: 594 },
        { x: 672, y: 668 },
      ],
    },
  ],
} as const
