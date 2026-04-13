/**
 * echarts-pixel-theme.ts — 为 ECharts 构建 Pixel Luxe 主题。
 *
 * 色值直接来自 desktop-app/tailwind.config.js 的 px 色板（keep in sync）。
 * 该文件是 single source of truth，如果 tailwind.config.js 变更，这里必须同步。
 *
 * 设计遵循 /Users/cnlm007398/.cursor/agents/ued-expert.md：
 *   - 调色板最多 5 种主色（60-30-10 规则）
 *   - 暗底透明背景，让像素卡片边框透出
 *   - 轴线 / 网格使用弱化文字色
 *   - aria decal 色盲友好
 *
 * @author zhi.qu
 * @date 2026-04-13
 */

import * as echarts from 'echarts/core'

// ─── 与 tailwind.config.js 同步的 px 色板（keep in sync!）──
const PIXEL_COLORS = {
  bg: '#13131B',
  surface: '#1B1B26',
  elevated: '#232332',
  border: '#353548',
  text: '#EAEAE8',
  textSec: '#A0A0AC',
  textDim: '#68687A',
  primary: '#E8A830', // 暖金琥珀
  primaryDim: '#C08820',
  accent: '#50D8A0', // 柔和薄荷绿
  accentDim: '#38B880',
  success: '#50D888',
  warning: '#E8A830',
  danger: '#E84848',
} as const

/**
 * 主题 palette（5 色 60-30-10 分布）：
 *   - primary (暖金)  主序列，60%
 *   - accent (薄荷)   对比序列，30%
 *   - success (绿)    成功/上升
 *   - warning (金)    警告/平
 *   - danger (红)     下降/错误
 */
const SERIES_PALETTE = [
  PIXEL_COLORS.primary,
  PIXEL_COLORS.accent,
  PIXEL_COLORS.success,
  PIXEL_COLORS.danger,
  PIXEL_COLORS.textSec,
]

const PIXEL_THEME = {
  color: SERIES_PALETTE,
  backgroundColor: 'transparent',

  textStyle: {
    color: PIXEL_COLORS.text,
    fontFamily: '"Inter", system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
    fontSize: 12,
  },

  title: {
    textStyle: {
      color: PIXEL_COLORS.text,
      fontFamily: '"Fusion Pixel", "Press Start 2P", monospace',
      fontWeight: 'bold',
      fontSize: 14,
    },
    subtextStyle: {
      color: PIXEL_COLORS.textSec,
      fontFamily: '"Inter", system-ui, sans-serif',
      fontSize: 11,
    },
    left: 12,
    top: 8,
  },

  legend: {
    textStyle: {
      color: PIXEL_COLORS.textSec,
      fontSize: 11,
    },
    itemWidth: 12,
    itemHeight: 8,
    icon: 'rect', // 像素风格用方块
    top: 8,
    right: 12,
  },

  grid: {
    left: 48,
    right: 24,
    top: 56,
    bottom: 40,
    containLabel: true,
  },

  xAxis: {
    axisLine: { lineStyle: { color: PIXEL_COLORS.border, width: 2 } },
    axisTick: { lineStyle: { color: PIXEL_COLORS.border } },
    axisLabel: { color: PIXEL_COLORS.textSec, fontSize: 11 },
    splitLine: { show: false },
  },

  yAxis: {
    axisLine: { lineStyle: { color: PIXEL_COLORS.border, width: 2 } },
    axisTick: { lineStyle: { color: PIXEL_COLORS.border } },
    axisLabel: { color: PIXEL_COLORS.textSec, fontSize: 11 },
    splitLine: { lineStyle: { color: PIXEL_COLORS.border, type: 'dashed', opacity: 0.5 } },
  },

  tooltip: {
    backgroundColor: PIXEL_COLORS.elevated,
    borderColor: PIXEL_COLORS.primary,
    borderWidth: 2,
    textStyle: { color: PIXEL_COLORS.text, fontSize: 12 },
    padding: [8, 12],
    extraCssText: 'box-shadow: 3px 3px 0 0 rgba(0,0,0,0.5); border-radius: 0;',
  },

  // 色盲友好：自动叠加图案
  aria: {
    enabled: true,
    decal: { show: true },
  },

  // 每种图表类型的默认样式
  line: {
    smooth: false, // 像素风不用平滑曲线
    symbol: 'rect',
    symbolSize: 8,
    lineStyle: { width: 2 },
    emphasis: { lineStyle: { width: 3 } },
  },
  bar: {
    itemStyle: {
      borderColor: PIXEL_COLORS.bg,
      borderWidth: 1,
    },
    barMaxWidth: 48,
  },
  pie: {
    itemStyle: {
      borderColor: PIXEL_COLORS.bg,
      borderWidth: 2,
    },
    label: { color: PIXEL_COLORS.text },
  },
  scatter: {
    symbol: 'rect',
    symbolSize: 10,
  },
  radar: {
    lineStyle: { width: 2 },
  },
}

let _registered = false

/**
 * 在第一次渲染前调用一次。幂等。
 */
export function registerPixelTheme(): void {
  if (_registered) return
  echarts.registerTheme('pixel', PIXEL_THEME)
  _registered = true
}

export const PIXEL_THEME_NAME = 'pixel'
