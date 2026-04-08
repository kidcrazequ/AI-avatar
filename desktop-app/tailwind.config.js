/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      /**
       * Pixel Luxe 设计 Token
       * 暖金琥珀 × 深邃暗底 —— 经典像素游戏质感
       */
      colors: {
        px: {
          // ── 背景层次（4 层暖灰梯度）──
          bg:       '#13131B',   // Layer 0: 最深底板
          surface:  '#1B1B26',   // Layer 1: 面板/卡片
          elevated: '#232332',   // Layer 2: 工具栏/浮层
          hover:    '#2C2C3E',   // Layer 3: 悬停/选中

          // ── 边框 ──
          border:     '#353548',
          'border-dim': '#2A2A3C',

          // ── 文字 ──
          text:       '#EAEAE8',  // 主文字（暖白）
          'text-sec':  '#A0A0AC', // 次要
          'text-dim':  '#68687A', // 弱化

          // ── 主色：暖金琥珀（经典像素游戏 UI 色）──
          primary:       '#E8A830',
          'primary-hover': '#F0B840',
          'primary-dim':   '#C08820',

          // ── 辅色：柔和薄荷绿 ──
          accent:      '#50D8A0',
          'accent-dim': '#38B880',

          // ── 功能色 ──
          success:  '#50D888',
          warning:  '#E8A830',
          danger:   '#E84848',

          // ── 兼容旧名 ──
          black:   '#13131B',
          white:   '#EAEAE8',
          warm:    '#F0ECE6',
          muted:   '#68687A',
          subtle:  '#A0A0AC',
          dark:    '#1B1B26',
          mid:     '#232332',
          line:    '#353548',
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
        'pixel-sm':    '2px 2px 0 0 #13131B',
        'pixel':       '3px 3px 0 0 #13131B',
        'pixel-lg':    '4px 4px 0 0 #13131B',
        'pixel-xl':    '6px 6px 0 0 #13131B',
        'pixel-brand': '3px 3px 0 0 #C08820',
        'pixel-white': '3px 3px 0 0 rgba(234,234,232,0.15)',
        'pixel-glow':  '0 0 20px rgba(232,168,48,0.12)',
        'glow-sm':     '0 0 8px rgba(232,168,48,0.10)',
      },
      animation: {
        'blink':        'blink 1s step-end infinite',
        'pixel-in':     'pixelSlideIn 0.15s steps(3) forwards',
        'pixel-expand': 'pixelExpand 0.2s steps(4) forwards',
        'pulse-glow':   'pulseGlow 2s ease-in-out infinite',
        'fade-in':      'fadeIn 0.15s ease-out forwards',
        'slide-up':     'slideUp 0.2s steps(4) forwards',
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
          '0%, 100%': { boxShadow: '0 0 8px rgba(232,168,48,0.08)' },
          '50%':      { boxShadow: '0 0 16px rgba(232,168,48,0.20)' },
        },
        fadeIn: {
          from: { opacity: '0' },
          to:   { opacity: '1' },
        },
        slideUp: {
          from: { transform: 'translateY(8px)', opacity: '0' },
          to:   { transform: 'translateY(0)',    opacity: '1' },
        },
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
}
