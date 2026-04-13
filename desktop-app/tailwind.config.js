/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      /**
       * Pixel LED 设计 Token
       * 粉色点阵 × void-black —— CRT 显示屏 / LED 点阵质感
       */
      colors: {
        px: {
          // ── 背景层次（4 层 void-black 梯度）──
          bg:       '#0A0A0F',   // Layer 0: void-black 底板
          surface:  '#12121A',   // Layer 1: 面板/卡片
          elevated: '#1A1A25',   // Layer 2: 工具栏/浮层
          hover:    '#222230',   // Layer 3: 悬停/选中

          // ── 边框 ──
          border:     '#2A2A3A',
          'border-dim': '#1E1E2C',

          // ── 文字 ──
          text:       '#E8E8EC',  // 主文字（LED 白）
          'text-sec':  '#9898A8', // 次要
          'text-dim':  '#5A5A6E', // 弱化

          // ── 主色：LED 粉（点阵显示屏粉色）──
          primary:       '#FFB0C8',
          'primary-hover': '#FFC0D4',
          'primary-dim':   '#D890A8',

          // ── 辅色：柔和薄荷绿 ──
          accent:      '#50D8A0',
          'accent-dim': '#38B880',

          // ── 功能色 ──
          success:  '#50D888',
          warning:  '#F0C060',
          danger:   '#E85858',

          // ── 兼容旧名 ──
          black:   '#0A0A0F',
          white:   '#E8E8EC',
          warm:    '#FFB0C8',
          muted:   '#5A5A6E',
          subtle:  '#9898A8',
          dark:    '#12121A',
          mid:     '#1A1A25',
          line:    '#2A2A3A',
        }
      },
      fontFamily: {
        game:  ['"Fusion Pixel"', '"Press Start 2P"', 'monospace'],
        pixel: ['"Press Start 2P"', 'monospace'],
        mono:  ['"JetBrains Mono"', '"Courier New"', 'monospace'],
        body:  ['"Inter"', 'system-ui', '-apple-system', '"PingFang SC"', '"Microsoft YaHei"', '"Noto Sans SC"', 'sans-serif'],
      },
      fontSize: {
        'px-2xs':  ['10px', { lineHeight: '18px' }],
        'px-xs':   ['11px', { lineHeight: '20px' }],
        'px-sm':   ['12px', { lineHeight: '20px' }],
        'px-base': ['14px', { lineHeight: '24px' }],
        'px-lg':   ['16px', { lineHeight: '26px' }],
        'px-xl':   ['20px', { lineHeight: '32px' }],
      },
      boxShadow: {
        'pixel-sm':    '2px 2px 0 0 #0A0A0F',
        'pixel':       '3px 3px 0 0 #0A0A0F',
        'pixel-lg':    '4px 4px 0 0 #0A0A0F',
        'pixel-xl':    '6px 6px 0 0 #0A0A0F',
        'pixel-brand': '3px 3px 0 0 #D890A8',
        'pixel-white': '3px 3px 0 0 rgba(232,232,236,0.10)',
        'pixel-glow':  '0 0 20px rgba(255,176,200,0.15)',
        'glow-sm':     '0 0 8px rgba(255,176,200,0.12)',
        'glow-pink':   '0 0 12px rgba(255,176,200,0.20)',
      },
      animation: {
        'blink':        'blink 1s step-end infinite',
        'pixel-in':     'pixelSlideIn 0.15s steps(3) forwards',
        'pixel-expand': 'pixelExpand 0.2s steps(4) forwards',
        'pulse-glow':   'pulseGlow 2s ease-in-out infinite',
        'fade-in':      'fadeIn 0.15s ease-out forwards',
        'slide-up':     'slideUp 0.2s steps(4) forwards',
        'scanline':     'scanline 8s linear infinite',
      },
      keyframes: {
        blink: {
          '0%, 100%': { opacity: '1' },
          '50%':       { opacity: '0' },
        },
        pixelSlideIn: {
          from: { transform: 'translateX(-8px)', opacity: '0' },
          to:   { transform: 'translateX(0)',    opacity: '1' },
        },
        pixelExpand: {
          '0%':   { transform: 'scale(0.9)', opacity: '0' },
          '50%':  { transform: 'scale(1.02)', opacity: '1' },
          '100%': { transform: 'scale(1)',    opacity: '1' },
        },
        pulseGlow: {
          '0%, 100%': { boxShadow: '0 0 8px rgba(255,176,200,0.08)' },
          '50%':      { boxShadow: '0 0 20px rgba(255,176,200,0.25)' },
        },
        fadeIn: {
          from: { opacity: '0' },
          to:   { opacity: '1' },
        },
        slideUp: {
          from: { transform: 'translateY(8px)', opacity: '0' },
          to:   { transform: 'translateY(0)',    opacity: '1' },
        },
        scanline: {
          '0%':   { backgroundPosition: '0 0' },
          '100%': { backgroundPosition: '0 100%' },
        },
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
}
