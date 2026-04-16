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
    // v0.6.3: legend 移到底部居中。之前 top-right 会和长标题/副标题撞车
    // （215 机型截图实测：标题 "215机型设备侧效率趋势图（2025年7月-12月）"
    // 长达 28 字符，挤进 legend 区域）。底部 legend 是更稳的默认，长标题/
    // 多 series 都不会冲突。
    bottom: 12,
    left: 'center',
  },

  grid: {
    left: 56,
    // v0.6.16: 64 → 96，给 markLine 末端标签（"平均: 90.23"）留出完整空间
    // 实测 215 机型截图：markLine label "平均: 90." 被截断
    right: 96,
    // v0.6.16: 64 → 100，给 title (15px) + 适当 padding + yAxis name + 图例 留出空间
    // 之前 64 太挤，实测 215 机型截图：yAxis name "设备侧效率（%）" 和图例叠在标题正下方
    top: 100,
    bottom: 56,  // v0.6.3: 40 → 56，给底部 legend 留出空间
    containLabel: true,
  },

  xAxis: {
    axisLine: { lineStyle: { color: PIXEL_COLORS.border, width: 1 } },
    axisTick: { show: false },
    axisLabel: { color: PIXEL_COLORS.textSec, fontSize: 11, margin: 12 },
    splitLine: { show: false },
  },

  yAxis: {
    // v0.6.16: 默认开 scale，让 Y 轴自适应数据范围（不强制含 0）。
    // 否则效率 / SOH / 温度 / 价格 这类非零基线指标的折线会被压扁到中间，
    // 实测 215 机型截图：数据 87-90% 但 Y 轴 0-100，趋势完全看不出来。
    // LLM 想要含 0 时显式设 yAxis.min: 0 即可。
    scale: true,
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: PIXEL_COLORS.textSec, fontSize: 11, margin: 12 },
    splitLine: {
      lineStyle: {
        color: PIXEL_COLORS.border,
        type: 'dashed' as const,
        width: 0.6,
        opacity: 0.35,
      },
    },
    nameTextStyle: {
      color: PIXEL_COLORS.textDim,
      fontSize: 11,
      padding: [0, 0, 12, 0],
    },
    // v0.6.16: nameGap 16 → 给 yAxis name 和顶部刻度之间留视觉间距
    nameGap: 16,
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
    // v0.6.3: 保留 aria 给屏幕阅读器，但关闭视觉 decal pattern。
    // 之前 decal: { show: true } 会在每个 series 上叠加密集的紫红色 dot pattern，
    // 视觉非常 noisy（实测 215 机型截图：整张图 80% 被紫红色 dots 盖住）。
    // 色盲友好可以靠 5 色 palette 本身的对比度，不必强制 decal。
    enabled: true,
    decal: { show: false },
  },

  // ─── 图表类型默认样式 ───

  line: {
    smooth: true,
    symbol: 'circle',
    symbolSize: 6,
    showSymbol: false,
    // v0.6.16: 加 LED 粉发光 shadow，提升"高级感"
    lineStyle: {
      width: 2.5,
      shadowColor: 'rgba(255, 176, 200, 0.45)',
      shadowBlur: 12,
      shadowOffsetY: 2,
    },
    emphasis: {
      focus: 'series' as const,
      lineStyle: { width: 3.5 },
      itemStyle: { borderWidth: 2, shadowBlur: 18 },
    },
    // v0.6.3: 移除默认 areaStyle。之前 line.areaStyle 默认 ON 时多 series
    // 折线图会叠加多层粉色渐变，视觉变浑浊（实测 215 机型截图：2 条 series
    // 的渐变重叠成一片紫红色块）。单 series 折线图想要渐变的话，让 LLM
    // 在 series[].areaStyle 显式开启即可。

    // v0.6.5: markLine / markPoint 默认样式 —— 防止 LLM 用裸配置时出现
    // 不协调的默认蓝色/红色/绿色标注。
    markLine: {
      lineStyle: {
        color: PIXEL_COLORS.warning,
        type: [6, 4] as unknown as string,
        width: 1.5,
        opacity: 0.7,
      },
      label: {
        color: PIXEL_COLORS.warning,
        fontSize: 11,
        backgroundColor: 'rgba(10, 10, 15, 0.75)',
        padding: [3, 6],
        borderRadius: 3,
      },
      symbol: ['none', 'none'],
    },
    markPoint: {
      // v0.6.16: 把"水滴"风格换成更克制的小圆点 + 边框 glow
      symbol: 'circle',
      symbolSize: 12,
      itemStyle: {
        color: PIXEL_COLORS.primary,
        borderColor: '#FFFFFF',
        borderWidth: 1.5,
        shadowColor: 'rgba(255, 176, 200, 0.6)',
        shadowBlur: 10,
      },
      label: {
        color: PIXEL_COLORS.text,
        fontSize: 11,
        position: 'top' as const,
        offset: [0, -6],
        backgroundColor: 'rgba(10, 10, 15, 0.85)',
        padding: [3, 6],
        borderRadius: 3,
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
