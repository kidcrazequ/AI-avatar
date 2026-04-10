/**
 * @file DefaultAvatars.tsx — 预置像素风 SVG 头像集（职场版）
 * @author zhi.qu
 * @date 2026-04-10
 *
 * 所有头像基于 16×16 像素网格，使用 Pixel Luxe 色板绘制。
 * 主题涵盖现代职场常见工种。
 */

import { ReactNode } from 'react'

// ── Pixel Luxe 色板 ──────────────────────────────────────────────────────────
const C = {
  bg:      '#13131B',
  sur:     '#1B1B26',
  ele:     '#232332',
  bdr:     '#353548',
  gold:    '#E8A830',
  goldD:   '#C08820',
  mint:    '#50D8A0',
  mintD:   '#38B880',
  text:    '#EAEAE8',
  textSec: '#A0A0AC',
  red:     '#E84848',
  blue:    '#5080E8',
  purple:  '#9050E8',
  skin:    '#F0B880',
  skinD:   '#D09060',
  brown:   '#805030',
  white:   '#EAEAE8',
  gray:    '#68687A',
} as const

/** 像素 rect 辅助函数：生成单个像素块 */
function px(x: number, y: number, color: string, w = 1, h = 1) {
  return <rect key={`${x}-${y}-${color}`} x={x} y={y} width={w} height={h} fill={color} />
}

// ── 12 个预置职场头像 SVG ─────────────────────────────────────────────────────

/** 程序员 — 灰色连帽衫 + 笔记本电脑 */
const DeveloperSvg = () => (
  <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" shapeRendering="crispEdges">
    <rect width="16" height="16" fill={C.bg} />
    {/* 头发 */}
    {px(6, 2, C.brown, 4, 1)}
    {px(5, 3, C.brown, 6, 1)}
    {px(4, 3, C.brown, 1, 2)}
    {/* 头部 */}
    {px(5, 4, C.skin, 6, 3)}
    {px(6, 5, C.bg)}{px(9, 5, C.bg)}
    {/* 连帽衫 */}
    {px(4, 7, C.ele, 8, 1)}
    {px(3, 8, C.ele, 10, 4)}
    {px(6, 7, C.bdr, 4, 1)}
    {/* 笔记本电脑 */}
    {px(1, 9, C.blue, 2, 2)}{px(1, 11, C.textSec, 2, 1)}
    {/* 牛仔裤 */}
    {px(4, 12, C.blue, 3, 3)}{px(9, 12, C.blue, 3, 3)}
    {/* 运动鞋 */}
    {px(3, 15, C.white, 4, 1)}{px(9, 15, C.white, 4, 1)}
  </svg>
)

/** 产品经理 — 蓝色 Polo 衫 + 便签墙 */
const ProductManagerSvg = () => (
  <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" shapeRendering="crispEdges">
    <rect width="16" height="16" fill={C.bg} />
    {/* 头发 */}
    {px(6, 2, C.brown, 4, 1)}
    {px(5, 3, C.brown, 6, 1)}
    {/* 头部 */}
    {px(5, 4, C.skin, 6, 3)}
    {px(6, 5, C.bg)}{px(9, 5, C.bg)}
    {/* Polo 衫 */}
    {px(4, 7, C.blue, 8, 1)}
    {px(3, 8, C.blue, 10, 4)}
    {px(6, 7, C.white, 4, 1)}
    {/* 便签墙 */}
    {px(13, 8, C.gold, 2, 2)}{px(13, 10, C.mint, 2, 2)}{px(13, 12, C.purple, 2, 1)}
    {/* 休闲裤 */}
    {px(4, 12, C.bdr, 3, 3)}{px(9, 12, C.bdr, 3, 3)}
    {/* 皮鞋 */}
    {px(3, 15, C.brown, 4, 1)}{px(9, 15, C.brown, 4, 1)}
  </svg>
)

/** 设计师 — 贝雷帽 + 调色板 */
const DesignerSvg = () => (
  <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" shapeRendering="crispEdges">
    <rect width="16" height="16" fill={C.bg} />
    {/* 贝雷帽 */}
    {px(5, 1, C.purple, 6, 1)}
    {px(4, 2, C.purple, 8, 1)}
    {px(3, 3, C.purple, 9, 1)}
    {/* 头部 */}
    {px(5, 3, C.skin, 6, 1)}
    {px(5, 4, C.skin, 6, 3)}
    {px(6, 5, C.bg)}{px(9, 5, C.bg)}
    {/* 黑色高领衫 */}
    {px(4, 7, C.ele, 8, 1)}
    {px(3, 8, C.ele, 10, 4)}
    {px(6, 7, C.bdr, 4, 2)}
    {/* 调色板 */}
    {px(1, 9, C.skinD, 2, 3)}
    {px(1, 9, C.red)}{px(2, 9, C.blue)}
    {px(1, 11, C.gold)}{px(2, 11, C.mint)}
    {/* 裤子 */}
    {px(4, 12, C.ele, 3, 3)}{px(9, 12, C.ele, 3, 3)}
    {/* 鞋 */}
    {px(3, 15, C.bdr, 4, 1)}{px(9, 15, C.bdr, 4, 1)}
  </svg>
)

/** 数据分析师 — 眼镜 + 柱状图 */
const DataAnalystSvg = () => (
  <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" shapeRendering="crispEdges">
    <rect width="16" height="16" fill={C.bg} />
    {/* 头发 */}
    {px(6, 2, C.brown, 4, 1)}
    {px(5, 3, C.brown, 6, 1)}
    {/* 头部 */}
    {px(5, 4, C.skin, 6, 3)}
    {/* 眼镜 */}
    {px(5, 5, C.blue, 2, 1)}{px(9, 5, C.blue, 2, 1)}{px(7, 5, C.gray)}
    {/* 薄荷绿毛衫 */}
    {px(4, 7, C.mint, 8, 1)}
    {px(3, 8, C.mint, 10, 4)}
    {/* 柱状图 */}
    {px(13, 11, C.blue, 1, 2)}{px(14, 10, C.gold, 1, 3)}{px(15, 9, C.mint, 1, 4)}
    {/* 裤子 */}
    {px(4, 12, C.bdr, 3, 3)}{px(9, 12, C.bdr, 3, 3)}
    {/* 鞋 */}
    {px(4, 15, C.brown, 3, 1)}{px(9, 15, C.brown, 3, 1)}
  </svg>
)

/** 项目经理 — 灰色西装 + 蓝色领带 */
const ProjectManagerSvg = () => (
  <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" shapeRendering="crispEdges">
    <rect width="16" height="16" fill={C.bg} />
    {/* 头发 */}
    {px(6, 2, C.brown, 4, 1)}
    {px(5, 3, C.brown, 6, 1)}
    {/* 头部 */}
    {px(5, 4, C.skin, 6, 3)}
    {px(6, 5, C.bg)}{px(9, 5, C.bg)}
    {/* 西装 */}
    {px(4, 7, C.bdr, 8, 1)}
    {px(3, 8, C.bdr, 10, 4)}
    {/* 衬衫 + 领带 */}
    {px(6, 7, C.white, 4, 2)}
    {px(7, 7, C.blue, 2, 5)}
    {/* 西裤 */}
    {px(4, 12, C.bdr, 3, 3)}{px(9, 12, C.bdr, 3, 3)}
    {/* 皮鞋 */}
    {px(3, 15, C.brown, 4, 1)}{px(9, 15, C.brown, 4, 1)}
  </svg>
)

/** 市场营销 — 暖金色休闲西装 + 扩音器 */
const MarketerSvg = () => (
  <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" shapeRendering="crispEdges">
    <rect width="16" height="16" fill={C.bg} />
    {/* 时尚发型 */}
    {px(5, 1, C.brown, 6, 1)}
    {px(5, 2, C.brown, 7, 1)}
    {px(5, 3, C.brown, 6, 1)}
    {/* 头部 */}
    {px(5, 4, C.skin, 6, 3)}
    {px(6, 5, C.bg)}{px(9, 5, C.bg)}
    {/* 暖金色休闲西装 */}
    {px(4, 7, C.gold, 8, 1)}
    {px(3, 8, C.gold, 10, 4)}
    {px(6, 7, C.white, 4, 2)}
    {/* 扩音器 */}
    {px(13, 8, C.textSec)}{px(14, 7, C.textSec, 1, 3)}{px(15, 6, C.textSec, 1, 5)}
    {/* 裤子 */}
    {px(4, 12, C.ele, 3, 3)}{px(9, 12, C.ele, 3, 3)}
    {/* 鞋 */}
    {px(3, 15, C.brown, 4, 1)}{px(9, 15, C.brown, 4, 1)}
  </svg>
)

/** 财务 — 马甲衬衫 + 计算器 */
const AccountantSvg = () => (
  <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" shapeRendering="crispEdges">
    <rect width="16" height="16" fill={C.bg} />
    {/* 头发 */}
    {px(6, 2, C.brown, 4, 1)}
    {px(5, 3, C.brown, 6, 1)}
    {/* 头部 */}
    {px(5, 4, C.skin, 6, 3)}
    {/* 眼镜 */}
    {px(5, 5, C.gray, 2, 1)}{px(9, 5, C.gray, 2, 1)}{px(7, 5, C.gray)}
    {/* 白衬衫 + 马甲 */}
    {px(4, 7, C.white, 8, 1)}
    {px(3, 8, C.white, 10, 4)}
    {px(4, 8, C.bdr, 3, 4)}{px(9, 8, C.bdr, 3, 4)}
    {/* 计算器 */}
    {px(13, 8, C.textSec, 2, 4)}{px(13, 9, C.mint)}{px(14, 9, C.red)}
    {/* 西裤 */}
    {px(4, 12, C.bdr, 3, 3)}{px(9, 12, C.bdr, 3, 3)}
    {/* 皮鞋 */}
    {px(3, 15, C.brown, 4, 1)}{px(9, 15, C.brown, 4, 1)}
  </svg>
)

/** 人力资源 — 知性职业装 + 简历文档 */
const HRSvg = () => (
  <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" shapeRendering="crispEdges">
    <rect width="16" height="16" fill={C.bg} />
    {/* 长发 */}
    {px(6, 2, C.brown, 4, 1)}
    {px(5, 3, C.brown, 6, 1)}
    {px(4, 4, C.brown, 1, 4)}{px(11, 4, C.brown, 1, 4)}
    {/* 头部 */}
    {px(5, 4, C.skin, 6, 3)}
    {px(6, 5, C.bg)}{px(9, 5, C.bg)}
    {/* 薄荷绿西装 */}
    {px(4, 7, C.mintD, 8, 1)}
    {px(3, 8, C.mintD, 10, 4)}
    {px(6, 7, C.white, 4, 2)}
    {/* 简历文档 */}
    {px(1, 9, C.white, 2, 4)}{px(1, 10, C.gray, 1, 2)}
    {/* 裤子 */}
    {px(4, 12, C.bdr, 3, 3)}{px(9, 12, C.bdr, 3, 3)}
    {/* 鞋 */}
    {px(4, 15, C.brown, 3, 1)}{px(9, 15, C.brown, 3, 1)}
  </svg>
)

/** 法务 — 深色正装 + 红色领带 + 法律书 */
const LegalSvg = () => (
  <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" shapeRendering="crispEdges">
    <rect width="16" height="16" fill={C.bg} />
    {/* 头发 */}
    {px(6, 2, C.gray, 4, 1)}
    {px(5, 3, C.gray, 6, 1)}
    {/* 头部 */}
    {px(5, 4, C.skin, 6, 3)}
    {px(6, 5, C.bg)}{px(9, 5, C.bg)}
    {/* 深色西装 */}
    {px(4, 7, C.ele, 8, 1)}
    {px(3, 8, C.ele, 10, 4)}
    {/* 衬衫 + 红色领带 */}
    {px(6, 7, C.white, 4, 2)}
    {px(7, 7, C.red, 2, 5)}
    {/* 法律书籍 */}
    {px(1, 8, C.goldD, 2, 5)}{px(1, 8, C.gold, 1, 5)}
    {/* 西裤 */}
    {px(4, 12, C.ele, 3, 3)}{px(9, 12, C.ele, 3, 3)}
    {/* 皮鞋 */}
    {px(3, 15, C.brown, 4, 1)}{px(9, 15, C.brown, 4, 1)}
  </svg>
)

/** 医生 — 白大褂 + 听诊器 */
const DoctorSvg = () => (
  <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" shapeRendering="crispEdges">
    <rect width="16" height="16" fill={C.bg} />
    {/* 头发 */}
    {px(5, 2, C.brown, 6, 1)}
    {px(4, 3, C.brown, 1, 2)}{px(11, 3, C.brown, 1, 2)}
    {/* 头部 */}
    {px(5, 3, C.skin, 6, 4)}
    {px(6, 4, C.bg)}{px(9, 4, C.bg)}
    {/* 白大褂 */}
    {px(4, 7, C.white, 8, 1)}
    {px(3, 8, C.white, 10, 5)}
    {/* 听诊器 */}
    {px(5, 8, C.blue)}{px(10, 8, C.blue)}
    {px(6, 9, C.blue, 4, 1)}{px(7, 10, C.blue, 2, 1)}
    {/* 口袋 + 笔 */}
    {px(10, 9, C.bdr, 2, 2)}{px(11, 8, C.red)}
    {/* 裤子 */}
    {px(4, 13, C.blue, 3, 2)}{px(9, 13, C.blue, 3, 2)}
    {/* 白鞋 */}
    {px(4, 15, C.white, 3, 1)}{px(9, 15, C.white, 3, 1)}
  </svg>
)

/** 教师 — 眼镜 + 教鞭 + 书本 */
const TeacherSvg = () => (
  <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" shapeRendering="crispEdges">
    <rect width="16" height="16" fill={C.bg} />
    {/* 头发 */}
    {px(6, 2, C.brown, 4, 1)}
    {px(5, 3, C.brown, 6, 1)}
    {/* 头部 */}
    {px(5, 4, C.skin, 6, 3)}
    {/* 眼镜 */}
    {px(5, 5, C.gray, 2, 1)}{px(9, 5, C.gray, 2, 1)}{px(7, 5, C.gray)}
    {/* 棕色休闲西装 */}
    {px(4, 7, C.brown, 8, 1)}
    {px(3, 8, C.brown, 10, 4)}
    {px(6, 7, C.white, 4, 2)}
    {/* 教鞭 */}
    {px(14, 5, C.goldD, 1, 8)}
    {/* 书本 */}
    {px(1, 9, C.blue, 2, 4)}{px(1, 9, C.gold)}
    {/* 裤子 */}
    {px(4, 12, C.bdr, 3, 3)}{px(9, 12, C.bdr, 3, 3)}
    {/* 皮鞋 */}
    {px(3, 15, C.brown, 4, 1)}{px(9, 15, C.brown, 4, 1)}
  </svg>
)

/** 工程师 — 安全帽 + 蓝色工装 + 图纸 */
const EngineerSvg = () => (
  <svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" shapeRendering="crispEdges">
    <rect width="16" height="16" fill={C.bg} />
    {/* 安全帽 */}
    {px(5, 1, C.gold, 6, 1)}
    {px(4, 2, C.gold, 8, 2)}
    {px(3, 4, C.gold, 10, 1)}
    {/* 头部 */}
    {px(5, 5, C.skin, 6, 3)}
    {px(6, 6, C.bg)}{px(9, 6, C.bg)}
    {/* 蓝色工装 */}
    {px(4, 8, C.blue, 8, 1)}
    {px(3, 9, C.blue, 10, 4)}
    {/* 反光条 */}
    {px(3, 10, C.gold, 10, 1)}
    {/* 图纸 */}
    {px(1, 8, C.white, 2, 5)}{px(1, 8, C.blue, 2, 1)}
    {/* 工装裤 */}
    {px(4, 13, C.blue, 3, 2)}{px(9, 13, C.blue, 3, 2)}
    {/* 工靴 */}
    {px(3, 15, C.brown, 4, 1)}{px(9, 15, C.brown, 4, 1)}
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
