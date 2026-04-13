/**
 * echarts-pixel-theme.ts — 为 ECharts 构建 Pixel LED 主题。
 *
 * 色值直接来自 desktop-app/tailwind.config.js 的 px 色板（keep in sync）。
 * 该文件是 single source of truth，如果 tailwind.config.js 变更，这里必须同步。
 *
 * 设计风格：粉色点阵 LED × void-black
 *   - 调色板 5 色，粉色主色调
 *   - 暗底透明背景
 *   - 折线图渐变面积填充
 *   - 柱状图圆角顶部
 *   - 毛玻璃 tooltip
 *   - aria decal 色盲友好
 */

import * as echarts from 'echarts/core'

// ─── 与 tailwind.config.js 同步的 px 色板（keep in sync!）──
const PIXEL_COLORS = {
  bg: '#0A0A0F',
  surface: '#12121A',
  elevated: '#1A1A25',
  border: '#2A2A3A',
  text: '#E8E8EC',
  textSec: '#9898A8',
  textDim: '#5A5A6E',
  primary: '#FFB0C8',    // LED 粉
  primaryDim: '#D890A8',
  accent: '#50D8A0',     // 薄荷绿
  accentDim: '#38B880',
  success: '#50D888',
  warning: '#F0C060',
  danger: '#E85858',
} as const

/**
 * 主题 palette（5 色）：
 *   - primary (LED 粉)  主序列
 *   - accent (薄荷绿)   对比序列
 *   - #7EB8E8 (柔蓝)   第三序列
 *   - #F0C060 (暖黄)   第四序列
 *   - #B89AE8 (淡紫)   第五序列
 */
const SERIES_PALETTE = [
  PIXEL_COLORS.primary,
  PIXEL_COLORS.accent,
  '#7EB8E8',
  PIXEL_COLORS.warning,
  '#B89AE8',
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
      fontFamily: '"Inter", system-ui, sans-serif',
      fontWeight: 'bold' as const,
      fontSize: 15,
    },
    subtextStyle: {
      color: PIXEL_COLORS.textDim,
      fontFamily: '"Inter", system-ui, sans-serif',
      fontSize: 11,
    },
    left: 16,
    top: 12,
  },

  legend: {
    textStyle: {
      color: PIXEL_COLORS.textSec,
      fontSize: 11,
    },
    itemWidth: 16,
    itemHeight: 10,
    itemGap: 16,
    icon: 'roundRect',
    top: 12,
    right: 16,
  },

  grid: {
    left: 56,
    right: 24,
    top: 72,
    bottom: 40,
    containLabel: true,
  },

  xAxis: {
    axisLine: { lineStyle: { color: PIXEL_COLORS.border, width: 1 } },
    axisTick: { show: false },
    axisLabel: { color: PIXEL_COLORS.textSec, fontSize: 11, margin: 12 },
    splitLine: { show: false },
  },

  yAxis: {
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: PIXEL_COLORS.textSec, fontSize: 11, margin: 12 },
    splitLine: {
      lineStyle: {
        color: PIXEL_COLORS.border,
        type: [4, 4] as unknown as string,
        opacity: 0.4,
      },
    },
    nameTextStyle: {
      color: PIXEL_COLORS.textDim,
      fontSize: 11,
      padding: [0, 0, 8, 0],
    },
  },

  // 毛玻璃 tooltip
  tooltip: {
    backgroundColor: 'rgba(18, 18, 26, 0.88)',
    borderColor: 'rgba(255, 176, 200, 0.15)',
    borderWidth: 1,
    textStyle: { color: PIXEL_COLORS.text, fontSize: 12 },
    padding: [10, 14],
    extraCssText: [
      'backdrop-filter: blur(12px)',
      '-webkit-backdrop-filter: blur(12px)',
      'border-radius: 8px',
      'box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4), 0 0 1px rgba(255, 176, 200, 0.1)',
    ].join(';'),
  },

  aria: {
    enabled: true,
    decal: { show: true },
  },

  // ─── 图表类型默认样式 ───

  line: {
    smooth: true,
    symbol: 'circle',
    symbolSize: 6,
    showSymbol: false,
    lineStyle: { width: 2.5 },
    emphasis: {
      lineStyle: { width: 3.5 },
      itemStyle: { borderWidth: 2 },
    },
    areaStyle: {
      opacity: 1,
      color: {
        type: 'linear',
        x: 0, y: 0, x2: 0, y2: 1,
        colorStops: [
          { offset: 0, color: 'rgba(255, 176, 200, 0.25)' },
          { offset: 1, color: 'rgba(255, 176, 200, 0.02)' },
        ],
      },
    },
  },

  bar: {
    itemStyle: {
      borderRadius: [4, 4, 0, 0],
    },
    barMaxWidth: 40,
    barGap: '30%',
    emphasis: {
      itemStyle: {
        shadowBlur: 8,
        shadowColor: 'rgba(255, 176, 200, 0.3)',
      },
    },
  },

  pie: {
    itemStyle: {
      borderColor: PIXEL_COLORS.bg,
      borderWidth: 3,
      borderRadius: 4,
    },
    label: {
      color: PIXEL_COLORS.text,
      fontSize: 12,
    },
    emphasis: {
      scaleSize: 6,
    },
  },

  scatter: {
    symbol: 'circle',
    symbolSize: 10,
    itemStyle: {
      opacity: 0.8,
    },
    emphasis: {
      itemStyle: {
        opacity: 1,
        shadowBlur: 10,
        shadowColor: 'rgba(255, 176, 200, 0.4)',
      },
    },
  },

  radar: {
    lineStyle: { width: 2 },
    symbol: 'circle',
    symbolSize: 4,
    areaStyle: { opacity: 0.15 },
  },
}

let _registered = false

export function registerPixelTheme(): void {
  if (_registered) return
  echarts.registerTheme('pixel', PIXEL_THEME)
  _registered = true
}

export const PIXEL_THEME_NAME = 'pixel'
