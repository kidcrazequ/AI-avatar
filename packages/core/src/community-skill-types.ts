/**
 * community-skill-types.ts — 社区技能管理相关类型定义
 *
 * 定义社区技能源、已安装包、技能信息等数据结构，
 * 供主进程 CommunitySkillManager 和渲染端 UI 共用。
 *
 * @author zhi.qu
 * @date 2026-05-08
 */

/** 社区技能源（对应 sources.yaml 中的一项） */
export interface CommunitySkillSource {
  /** 本地目录名（小写 + 连字符） */
  name: string
  /** Git 仓库 HTTPS URL */
  repo: string
  /** tag / branch / commit hash */
  ref: string
  /** 仓库内技能目录（默认 skills/） */
  path?: string
  /** 单文件模式（与 path/skills 互斥） */
  file?: string
  /** 选择性安装的技能名列表（空 = 全部安装） */
  skills?: string[]
}

/** 已安装的社区技能包 */
export interface InstalledCommunityPack {
  /** 本地目录名 */
  name: string
  /** Git 仓库 URL */
  repo: string
  /** 声明的 ref（tag/branch） */
  ref: string
  /** 实际 commit hash */
  commit: string
  /** 同步时间（ISO 8601） */
  syncedAt: string
  /** 安装的技能文件数 */
  skillCount: number
  /** 已安装的技能详细信息 */
  skills: CommunitySkillInfo[]
}

/** 社区技能信息（从技能文件 frontmatter 提取） */
export interface CommunitySkillInfo {
  /** 技能名称 */
  name: string
  /** 技能文件相对路径 */
  file: string
  /** 技能描述 */
  description: string
  /** 技能所属领域 */
  domain: string
}

/** 技能来源分类 */
export type SkillSource = 'local' | 'shared' | 'community'

/** 同步进度事件 */
export interface CommunitySkillSyncProgress {
  /** 当前处理的源名称 */
  sourceName: string
  /** 进度阶段 */
  phase: 'cloning' | 'checking-out' | 'copying' | 'done' | 'error'
  /** 详情（错误信息或当前文件名） */
  detail?: string
  /** 总源数 */
  total: number
  /** 当前第几个 */
  current: number
}
