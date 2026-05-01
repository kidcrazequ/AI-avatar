/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      /**
       * 主题化设计 Token —— 所有颜色通过 CSS 变量实现运行时切换
       * 默认主题: Pixel LED（粉色点阵 × void-black CRT）
       * 主题定义在 src/index.css 的 :root / [data-theme] 中
       */
      colors: {
        px: {
          // ── 背景层次（4 层梯度）──
          bg:       'var(--px-bg)',
          surface:  'var(--px-surface)',
          elevated: 'var(--px-elevated)',
          hover:    'var(--px-hover)',

          // ── 边框 ──
          border:     'var(--px-border)',
          'border-dim': 'var(--px-border-dim)',

          // ── 文字 ──
          text:       'var(--px-text)',
          'text-sec':  'var(--px-text-sec)',
          'text-dim':  'var(--px-text-dim)',

          // ── 主色 ──
          primary:       'var(--px-primary)',
          'primary-hover': 'var(--px-primary-hover)',
          'primary-dim':   'var(--px-primary-dim)',

          // ── 辅色 ──
          accent:      'var(--px-accent)',
          'accent-dim': 'var(--px-accent-dim)',

          // ── 功能色 ──
          success:  'var(--px-success)',
          warning:  'var(--px-warning)',
          danger:   'var(--px-danger)',

          // ── 兼容旧名 ──
          black:   'var(--px-bg)',
          white:   'var(--px-text)',
          warm:    'var(--px-primary)',
          muted:   'var(--px-text-dim)',
          subtle:  'var(--px-text-sec)',
          dark:    'var(--px-surface)',
          mid:     'var(--px-elevated)',
          line:    'var(--px-border)',
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
        'pixel-sm':    '2px 2px 0 0 var(--px-bg)',
        'pixel':       '3px 3px 0 0 var(--px-bg)',
        'pixel-lg':    '4px 4px 0 0 var(--px-bg)',
        'pixel-xl':    '6px 6px 0 0 var(--px-bg)',
        'pixel-brand': '3px 3px 0 0 var(--px-primary-dim)',
        'pixel-white': '3px 3px 0 0 rgba(232,232,236,0.10)',
        'pixel-glow':  '0 0 20px var(--px-glow)',
        'glow-sm':     '0 0 8px var(--px-glow)',
        'glow-pink':   '0 0 12px var(--px-glow-strong)',
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
          '0%, 100%': { boxShadow: '0 0 8px var(--px-glow)' },
          '50%':      { boxShadow: '0 0 20px var(--px-glow-strong)' },
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
