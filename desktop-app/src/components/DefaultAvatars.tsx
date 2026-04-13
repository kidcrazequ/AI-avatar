/**
 * @file DefaultAvatars.tsx — 预置像素风 SVG 头像集（职场版 · 大头贴）
 * @author zhi.qu
 * @date 2026-04-10
 *
 * 16×16 网格，头部占画面主体（类似圆角方块内只露头肩），每人一种底色。
 * 色板：Pixel Luxe。
 */

/* eslint-disable react-refresh/only-export-components -- 该文件是头像资源集合，
   导出 DEFAULT_AVATARS 配置数组和 getDefaultAvatarSvg 工厂函数，local 的
   *Svg 组件仅供内部使用，不拆分文件 */

import { ReactNode } from 'react'

// ── Pixel Luxe 色板 ──────────────────────────────────────────────────────────
const C = {
  bg:      '#13131B',
  sur:     '#1B1B26',
  ele:     '#232332',
  bdr:     '#353548',
  out:     '#2A2A38',
  gold:    '#E8A830',
  goldD:   '#C08820',
  mint:    '#50D8A0',
  mintD:   '#38B880',
  text:    '#EAEAE8',
  textSec: '#A0A0AC',
  red:     '#E84848',
  blue:    '#5080E8',
  blueD:   '#3048A8',
  purple:  '#9050E8',
  skin:    '#F0B880',
  skinD:   '#D09060',
  brown:   '#805030',
  white:   '#EAEAE8',
  gray:    '#68687A',
  black:   '#181820',
} as const

/** 像素 rect */
function px(x: number, y: number, color: string, w = 1, h = 1) {
  return <rect key={`${x}-${y}-${w}-${h}-${color}`} x={x} y={y} width={w} height={h} fill={color} />
}

// ── 各职业底色（大头贴圆角方块感：整格铺色）──────────────────────────────────

/** 程序员 — 琥珀底 · 大眼镜头戴耳机感 */
const DeveloperSvg = () => (
  <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" shapeRendering="crispEdges">
    <rect width="16" height="16" fill={C.goldD} />
    {px(4, 2, C.out, 8, 1)}
    {px(3, 3, C.out, 10, 9)}
    {px(4, 3, C.ele, 8, 2)}
    {px(5, 4, C.gray, 6, 1)}
    {px(5, 5, C.skin, 6, 5)}
    {px(4, 5, C.skinD)}{px(11, 5, C.skinD)}
    {px(6, 6, C.black)}{px(9, 6, C.black)}
    {px(5, 7, C.blue, 2, 1)}{px(9, 7, C.blue, 2, 1)}{px(7, 7, C.blue)}
    {px(7, 9, C.brown, 2, 1)}
    {px(5, 10, C.skinD, 6, 1)}
    {px(6, 11, C.ele, 4, 1)}
    {px(5, 12, C.out, 6, 2)}
    {px(6, 12, C.white, 4, 1)}
  </svg>
)

/** 产品经理 — 紫底 · 短发干练 */
const ProductManagerSvg = () => (
  <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" shapeRendering="crispEdges">
    <rect width="16" height="16" fill="#7040B0" />
    {px(4, 2, C.out, 8, 1)}
    {px(3, 3, C.out, 10, 8)}
    {px(4, 3, C.brown, 8, 2)}
    {px(5, 5, C.skin, 6, 5)}
    {px(6, 6, C.black)}{px(9, 6, C.black)}
    {px(7, 8, C.brown, 2, 1)}
    {px(5, 10, C.skinD, 6, 1)}
    {px(6, 11, C.blue, 4, 1)}
    {px(5, 12, C.out, 6, 2)}
    {px(6, 12, C.white, 4, 1)}
  </svg>
)

/** 设计师 — 玫粉底 · 贝雷帽 */
const DesignerSvg = () => (
  <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" shapeRendering="crispEdges">
    <rect width="16" height="16" fill="#B84878" />
    {px(3, 1, C.out, 10, 1)}
    {px(2, 2, C.out, 12, 2)}
    {px(3, 2, C.purple, 10, 2)}
    {px(3, 4, C.out, 10, 8)}
    {px(4, 4, C.skin, 8, 5)}
    {px(6, 5, C.black)}{px(9, 5, C.black)}
    {px(5, 6, C.purple, 2, 1)}{px(9, 6, C.mint, 2, 1)}
    {px(7, 8, C.red, 2, 1)}
    {px(5, 9, C.skinD, 6, 1)}
    {px(6, 10, C.ele, 4, 1)}
    {px(5, 11, C.out, 6, 2)}
  </svg>
)

/** 数据分析师 — 绿底 · 粗框眼镜 */
const DataAnalystSvg = () => (
  <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" shapeRendering="crispEdges">
    <rect width="16" height="16" fill={C.mintD} />
    {px(4, 2, C.out, 8, 1)}
    {px(3, 3, C.out, 10, 9)}
    {px(4, 3, C.brown, 8, 2)}
    {px(5, 5, C.skin, 6, 5)}
    {px(5, 6, C.blueD, 2, 2)}{px(9, 6, C.blueD, 2, 2)}{px(7, 6, C.blueD)}
    {px(6, 7, C.white)}{px(9, 7, C.white)}
    {px(6, 9, C.brown, 4, 1)}
    {px(12, 7, C.blue)}{px(13, 5, C.blue, 1, 4)}{px(14, 6, C.gold, 1, 2)}
    {px(5, 11, C.ele, 6, 1)}
    {px(4, 12, C.out, 8, 2)}
  </svg>
)

/** 项目经理 — 深蓝底 · 正装领 */
const ProjectManagerSvg = () => (
  <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" shapeRendering="crispEdges">
    <rect width="16" height="16" fill={C.blueD} />
    {px(4, 2, C.out, 8, 1)}
    {px(3, 3, C.out, 10, 8)}
    {px(4, 3, C.brown, 8, 2)}
    {px(5, 5, C.skin, 6, 5)}
    {px(6, 6, C.black)}{px(9, 6, C.black)}
    {px(7, 8, C.brown, 2, 1)}
    {px(5, 10, C.white, 6, 1)}
    {px(7, 10, C.blue, 2, 2)}
    {px(4, 11, C.bdr, 8, 2)}
    {px(5, 12, C.bdr, 6, 1)}
  </svg>
)

/** 市场营销 — 橙底 · 开朗表情 */
const MarketerSvg = () => (
  <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" shapeRendering="crispEdges">
    <rect width="16" height="16" fill="#D07030" />
    {px(4, 1, C.out, 8, 1)}
    {px(3, 2, C.out, 10, 9)}
    {px(4, 2, C.brown, 8, 2)}
    {px(5, 4, C.skin, 6, 5)}
    {px(6, 5, C.black)}{px(9, 5, C.black)}
    {px(6, 7, C.white, 4, 2)}
    {px(5, 9, C.skinD, 6, 1)}
    {px(11, 6, C.textSec, 1, 3)}{px(12, 5, C.textSec, 1, 5)}
    {px(5, 10, C.gold, 6, 1)}
    {px(5, 11, C.out, 6, 2)}
  </svg>
)

/** 财务 — 灰蓝底 · 圆眼镜 */
const AccountantSvg = () => (
  <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" shapeRendering="crispEdges">
    <rect width="16" height="16" fill="#485870" />
    {px(4, 2, C.out, 8, 1)}
    {px(3, 3, C.out, 10, 8)}
    {px(4, 3, C.gray, 8, 2)}
    {px(5, 5, C.skin, 6, 5)}
    {px(5, 6, C.white, 2, 2)}{px(9, 6, C.white, 2, 2)}{px(7, 6, C.gray)}
    {px(6, 7, C.black)}{px(9, 7, C.black)}
    {px(7, 9, C.brown, 2, 1)}
    {px(5, 10, C.white, 6, 1)}
    {px(4, 11, C.bdr, 8, 2)}
    {px(6, 11, C.bdr, 4, 2)}
  </svg>
)

/** 人力资源 — 粉底 · 长发框脸 */
const HRSvg = () => (
  <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" shapeRendering="crispEdges">
    <rect width="16" height="16" fill="#C86080" />
    {px(3, 1, C.out, 10, 1)}
    {px(2, 2, C.out, 12, 10)}
    {px(2, 2, C.brown, 3, 8)}
    {px(11, 2, C.brown, 3, 8)}
    {px(5, 2, C.brown, 6, 2)}
    {px(5, 4, C.skin, 6, 5)}
    {px(6, 5, C.black)}{px(9, 5, C.black)}
    {px(7, 7, C.red, 2, 1)}
    {px(5, 9, C.skinD, 6, 1)}
    {px(6, 10, C.mintD, 4, 1)}
    {px(5, 11, C.out, 6, 2)}
  </svg>
)

/** 法务 — 深紫底 · 严肃眉 */
const LegalSvg = () => (
  <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" shapeRendering="crispEdges">
    <rect width="16" height="16" fill="#503070" />
    {px(4, 2, C.out, 8, 1)}
    {px(3, 3, C.out, 10, 8)}
    {px(4, 3, C.gray, 8, 2)}
    {px(5, 5, C.skin, 6, 5)}
    {px(5, 6, C.black, 2, 1)}{px(9, 6, C.black, 2, 1)}
    {px(6, 7, C.black, 4, 1)}
    {px(7, 9, C.brown, 2, 1)}
    {px(5, 10, C.white, 6, 1)}
    {px(7, 10, C.red, 2, 2)}
    {px(4, 11, C.ele, 8, 2)}
  </svg>
)

/** 医生 — 浅蓝底 · 听诊器颈圈 + 十字帽 */
const DoctorSvg = () => (
  <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" shapeRendering="crispEdges">
    <rect width="16" height="16" fill="#6090C8" />
    {px(4, 1, C.out, 8, 1)}
    {px(4, 1, C.white, 8, 1)}
    {px(7, 1, C.red, 2, 1)}
    {px(3, 2, C.out, 10, 9)}
    {px(4, 2, C.white, 8, 2)}
    {px(5, 4, C.skin, 6, 5)}
    {px(6, 5, C.black)}{px(9, 5, C.black)}
    {px(7, 7, C.skinD, 2, 1)}
    {px(5, 8, C.blue)}{px(10, 8, C.blue)}
    {px(6, 9, C.blue, 4, 1)}
    {px(5, 10, C.white, 6, 2)}
    {px(4, 11, C.out, 8, 2)}
  </svg>
)

/** 教师 — 棕底 · 眼镜 + 中分 */
const TeacherSvg = () => (
  <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" shapeRendering="crispEdges">
    <rect width="16" height="16" fill="#886040" />
    {px(4, 2, C.out, 8, 1)}
    {px(3, 3, C.out, 10, 9)}
    {px(4, 3, C.brown, 8, 2)}
    {px(7, 4, C.skin, 2, 1)}
    {px(5, 5, C.skin, 6, 5)}
    {px(5, 6, C.gray, 2, 1)}{px(9, 6, C.gray, 2, 1)}{px(7, 6, C.gray)}
    {px(6, 7, C.black)}{px(9, 7, C.black)}
    {px(7, 9, C.white, 2, 1)}
    {px(5, 10, C.brown, 6, 1)}
    {px(5, 11, C.out, 6, 2)}
  </svg>
)

/** 工程师 — 金黄底 · 安全帽占上半脸 */
const EngineerSvg = () => (
  <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" shapeRendering="crispEdges">
    <rect width="16" height="16" fill={C.gold} />
    {px(3, 0, C.out, 10, 1)}
    {px(2, 1, C.out, 12, 4)}
    {px(3, 1, C.goldD, 10, 3)}
    {px(4, 2, C.gold, 8, 2)}
    {px(3, 4, C.out, 10, 1)}
    {px(3, 5, C.out, 10, 7)}
    {px(4, 5, C.skin, 8, 4)}
    {px(6, 6, C.black)}{px(9, 6, C.black)}
    {px(5, 7, C.skinD, 6, 1)}
    {px(7, 9, C.brown, 2, 1)}
    {px(5, 10, C.blue, 6, 2)}
    {px(4, 11, C.out, 8, 2)}
    {px(5, 12, C.blueD, 6, 1)}
  </svg>
)

// ── 预置头像配置表 ────────────────────────────────────────────────────────────

export interface DefaultAvatar {
  key: string
  label: string
  svg: ReactNode
}

export const DEFAULT_AVATARS: DefaultAvatar[] = [
  { key: 'developer',       label: '程序员',     svg: <DeveloperSvg /> },
  { key: 'product-manager', label: '产品经理',   svg: <ProductManagerSvg /> },
  { key: 'designer',        label: '设计师',     svg: <DesignerSvg /> },
  { key: 'data-analyst',    label: '数据分析师', svg: <DataAnalystSvg /> },
  { key: 'project-manager', label: '项目经理',   svg: <ProjectManagerSvg /> },
  { key: 'marketer',        label: '市场营销',   svg: <MarketerSvg /> },
  { key: 'accountant',      label: '财务',       svg: <AccountantSvg /> },
  { key: 'hr',              label: '人力资源',   svg: <HRSvg /> },
  { key: 'legal',           label: '法务',       svg: <LegalSvg /> },
  { key: 'doctor',          label: '医生',       svg: <DoctorSvg /> },
  { key: 'teacher',         label: '教师',       svg: <TeacherSvg /> },
  { key: 'engineer',        label: '工程师',     svg: <EngineerSvg /> },
]

/** 根据 key 获取预置头像 SVG，未找到返回 null */
export function getDefaultAvatarSvg(key: string): ReactNode | null {
  const found = DEFAULT_AVATARS.find(a => a.key === key)
  return found?.svg ?? null
}
