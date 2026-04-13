/**
 * echarts-pixel-theme.ts — 为 ECharts 构建 Pixel Luxe 主题。
 *
 * 色值直接来自 desktop-app/tailwind.config.js 的 px 色板（keep in sync）。
 * 该文件是 single source of truth，如果 tailwind.config.js 变更，这里必须同步。
 *
 * 设计融合 UED 数据可视化规范（ued-agent/knowledge/design-practice/）：
 *   - 调色板 5 色（60-30-10 规则），去饱和 + 提亮适配暗底
 *   - 暗底透明背景，让像素卡片边框透出
 *   - 折线图默认渐变面积填充（areaStyle gradient）
 *   - 柱状图圆角顶部（borderRadius: [4,4,0,0]）
 *   - 毛玻璃 tooltip（backdrop-filter blur + 圆角 8px）
 *   - 网格弱化虚线，极简风
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
 * 主题 palette（5 色，去饱和 + 提亮适配暗底）：
 *   - primary (暖金)   主序列
 *   - accent (薄荷)    对比序列
 *   - #5E9FD6 (柔蓝)  第三序列（UED 推荐暗底数据蓝）
 *   - danger (红)      下降/错误
 *   - #B89AE8 (淡紫)  第五序列（补充冷暖平衡）
 */
const SERIES_PALETTE = [
  PIXEL_COLORS.primary,
  PIXEL_COLORS.accent,
  '#5E9FD6',
  PIXEL_COLORS.danger,
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

  // 毛玻璃 tooltip（UED visual-craft §4.2 glassmorphism）
  tooltip: {
    backgroundColor: 'rgba(27, 27, 38, 0.85)',
    borderColor: 'rgba(255, 255, 255, 0.08)',
    borderWidth: 1,
    textStyle: { color: PIXEL_COLORS.text, fontSize: 12 },
    padding: [10, 14],
    extraCssText: [
      'backdrop-filter: blur(12px)',
      '-webkit-backdrop-filter: blur(12px)',
      'border-radius: 8px',
      'box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3), 0 0 1px rgba(255, 255, 255, 0.1)',
    ].join(';'),
  },

  // 色盲友好：自动叠加图案
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
    // 默认渐变面积填充（UED data-visualization §5.1）
    areaStyle: {
      opacity: 1,
      color: {
        type: 'linear',
        x: 0, y: 0, x2: 0, y2: 1,
        colorStops: [
          { offset: 0, color: 'rgba(232, 168, 48, 0.25)' },
          { offset: 1, color: 'rgba(232, 168, 48, 0.02)' },
        ],
      },
    },
  },

  bar: {
    itemStyle: {
      // 圆角顶部（UED data-visualization §5.2）
      borderRadius: [4, 4, 0, 0],
    },
    barMaxWidth: 40,
    barGap: '30%',
    emphasis: {
      itemStyle: {
        // hover 时微微提亮
        shadowBlur: 8,
        shadowColor: 'rgba(232, 168, 48, 0.3)',
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
        shadowColor: 'rgba(232, 168, 48, 0.4)',
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

/**
 * 在第一次渲染前调用一次。幂等。
 */
export function registerPixelTheme(): void {
  if (_registered) return
  echarts.registerTheme('pixel', PIXEL_THEME)
  _registered = true
}

export const PIXEL_THEME_NAME = 'pixel'
