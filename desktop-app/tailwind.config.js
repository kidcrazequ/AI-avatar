/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      /** Terminal Luxe 设计 Token */
      colors: {
        px: {
          black:   '#0A0A0A',
          white:   '#FAFAFA',
          warm:    '#F0F0F0',
          border:  '#D4D4D4',
          muted:   '#737373',
          subtle:  '#A3A3A3',
          dark:    '#1A1A1A',
          mid:     '#262626',
          line:    '#333333',
          danger:  '#DC2626',
          success: '#16A34A',
        }
      },
      fontFamily: {
        pixel: ['"Press Start 2P"', 'monospace'],
        mono:  ['"JetBrains Mono"', '"Courier New"', 'monospace'],
      },
      fontSize: {
        'px-xs':   ['10px', { lineHeight: '16px' }],
        'px-sm':   ['12px', { lineHeight: '20px' }],
        'px-base': ['14px', { lineHeight: '24px' }],
        'px-lg':   ['16px', { lineHeight: '24px' }],
        'px-xl':   ['20px', { lineHeight: '32px' }],
      },
      boxShadow: {
        'pixel-sm':  '2px 2px 0 0 #0A0A0A',
        'pixel':     '3px 3px 0 0 #0A0A0A',
        'pixel-lg':  '4px 4px 0 0 #0A0A0A',
        'pixel-xl':  '8px 8px 0 0 #0A0A0A',
        'pixel-white': '3px 3px 0 0 rgba(250,250,250,0.2)',
        'pixel-gray':  '3px 3px 0 0 #D4D4D4',
      },
      animation: {
        'blink':       'blink 1s step-end infinite',
        'pixel-in':    'pixelSlideIn 0.15s steps(3) forwards',
        'pixel-expand':'pixelExpand 0.2s steps(4) forwards',
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
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
}
