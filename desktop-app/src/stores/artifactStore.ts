/**
 * Artifact 副面板 store：跨组件传递 artifact 列表 + tab 状态。
 *
 * 完整版能力：
 *   - 多 artifact list + activeIndex（tab 切换）
 *   - 自动检测大制品（按字符阈值；store 维护已自动打开过的 key 防重复）
 *   - 持久化宽度（localStorage）
 *
 * @author zhi.qu
 * @date 2026-05-19
 */

import { create } from 'zustand'

export type ArtifactKind = 'chart' | 'mermaid' | 'infographic'

export interface ArtifactItem {
  /** 同源去重 key：kind + rawHash */
  key: string
  kind: ArtifactKind
  raw: string
  /** 来源消息 id（可选，用于"返回原消息"，本期不接） */
  fromMessageId?: string
  openedAt: number
}

interface ArtifactState {
  open: boolean
  items: ArtifactItem[]
  activeIndex: number
  /** 副面板宽度（vw 百分比，30-80） */
  widthPercent: number
  /** 自动打开的阈值（字符数，超过即自动打开）；0 = 禁用 */
  autoOpenThreshold: number
  /** 已自动打开过的 key 集合（防止流式更新时反复打开） */
  autoOpenedKeys: Set<string>

  /** 打开（同源已存在则切换到该 tab；否则追加） */
  openArtifact: (item: Omit<ArtifactItem, 'openedAt' | 'key'>) => void
  /** 标记某 key 已被自动打开（防止重复） */
  markAutoOpened: (key: string) => void
  /** 当前 tab 切换 */
  setActiveIndex: (i: number) => void
  /** 关闭单个 tab */
  closeTab: (index: number) => void
  /** 关闭全部 / 隐藏面板 */
  closeArtifact: () => void
  /** 调整宽度（持久化到 localStorage） */
  setWidthPercent: (n: number) => void
  /** 调整自动打开阈值（持久化） */
  setAutoOpenThreshold: (n: number) => void
}

/**
 * 简易 hash：用于同源去重；不要求加密，只要稳定。
 * 导出供 MessageBubble.ArtifactSlot 复用，确保「key 计算」单源一致。
 */
export function hashRaw(kind: ArtifactKind, raw: string): string {
  let h = 0
  for (let i = 0; i < raw.length; i++) h = ((h << 5) - h + raw.charCodeAt(i)) | 0
  return `${kind}:${h}`
}

const WIDTH_KEY = 'soul.artifact.widthPercent'
const AUTO_KEY = 'soul.artifact.autoOpenThreshold'
const loadNum = (k: string, fallback: number): number => {
  try {
    const v = localStorage.getItem(k)
    if (v) {
      const n = Number(v)
      if (Number.isFinite(n)) return n
    }
  } catch { /* ignore */ }
  return fallback
}

export const useArtifactStore = create<ArtifactState>((set, get) => ({
  open: false,
  items: [],
  activeIndex: 0,
  widthPercent: loadNum(WIDTH_KEY, 50),
  autoOpenThreshold: loadNum(AUTO_KEY, 1200),
  autoOpenedKeys: new Set<string>(),

  openArtifact: (item) => {
    const key = hashRaw(item.kind, item.raw)
    const items = get().items
    const existingIdx = items.findIndex(it => it.key === key)
    if (existingIdx >= 0) {
      set({ open: true, activeIndex: existingIdx })
      return
    }
    const next: ArtifactItem = { ...item, key, openedAt: Date.now() }
    set({
      open: true,
      items: [...items, next],
      activeIndex: items.length,
    })
  },

  markAutoOpened: (key) => {
    const cur = get().autoOpenedKeys
    if (cur.has(key)) return
    const nextSet = new Set(cur)
    nextSet.add(key)
    set({ autoOpenedKeys: nextSet })
  },

  setActiveIndex: (i) => {
    const items = get().items
    if (i < 0 || i >= items.length) return
    set({ activeIndex: i })
  },

  closeTab: (index) => {
    const { items, activeIndex } = get()
    if (index < 0 || index >= items.length) return
    const next = items.filter((_, i) => i !== index)
    if (next.length === 0) {
      set({ open: false, items: [], activeIndex: 0 })
      return
    }
    const newActive = index < activeIndex
      ? activeIndex - 1
      : index === activeIndex
        ? Math.min(activeIndex, next.length - 1)
        : activeIndex
    set({ items: next, activeIndex: newActive })
  },

  closeArtifact: () => set({ open: false }),

  setWidthPercent: (n) => {
    const clamped = Math.max(30, Math.min(80, n))
    try { localStorage.setItem(WIDTH_KEY, String(clamped)) } catch { /* ignore */ }
    set({ widthPercent: clamped })
  },

  setAutoOpenThreshold: (n) => {
    const clamped = Math.max(0, Math.min(20000, Math.floor(n)))
    try { localStorage.setItem(AUTO_KEY, String(clamped)) } catch { /* ignore */ }
    set({ autoOpenThreshold: clamped })
  },
}))

/** 工具：算 artifact 的去重 key（外部需要时复用） */
export function artifactKey(kind: ArtifactKind, raw: string): string {
  return hashRaw(kind, raw)
}
