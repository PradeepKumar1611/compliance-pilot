/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Obsidian & Champagne
        obsidian: '#0C0B10',
        surface: '#16151C',
        surface2: '#1F1D26',
        line: '#2A2833',
        champagne: {
          DEFAULT: '#CBA45A',
          bright: '#E6C988',
        },
        bronze: '#8A6E3B',
        ivory: {
          DEFAULT: '#EDE7DA',
          dim: '#A39C8E',
        },
        approved: '#6FA98C',
        review: '#D6A95A',
        flag: '#B0584E',

        // Semantic aliases so any leftover token usage resolves to the new palette
        background: '#0C0B10',
        foreground: '#EDE7DA',
        card: '#16151C',
        'card-foreground': '#EDE7DA',
        border: '#2A2833',
        input: '#1F1D26',
        ring: '#CBA45A',
        primary: { DEFAULT: '#CBA45A', foreground: '#0C0B10' },
        secondary: { DEFAULT: '#16151C', foreground: '#EDE7DA' },
        destructive: { DEFAULT: '#B0584E', foreground: '#EDE7DA' },
        muted: { DEFAULT: '#16151C', foreground: '#A39C8E' },
        accent: { DEFAULT: '#1F1D26', foreground: '#EDE7DA' },
        success: '#6FA98C',
        warning: '#D6A95A',
        danger: '#B0584E',
      },
      fontFamily: {
        display: ['Fraunces', 'Georgia', 'serif'],
        sans: ['"Hanken Grotesk"', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        lg: '0.75rem',
        md: '0.625rem',
        sm: '0.375rem',
      },
      boxShadow: {
        lux: '0 1px 0 0 rgba(203,164,90,0.04), 0 24px 60px -28px rgba(0,0,0,0.75)',
        seal: '0 0 0 1px rgba(203,164,90,0.35), 0 8px 30px -10px rgba(203,164,90,0.25)',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in-right': {
          from: { transform: 'translateX(100%)' },
          to: { transform: 'translateX(0)' },
        },
        'draw-line': {
          from: { transform: 'scaleX(0)' },
          to: { transform: 'scaleX(1)' },
        },
        'seal-in': {
          from: { opacity: '0', transform: 'scale(0.92) rotate(-6deg)' },
          to: { opacity: '1', transform: 'scale(1) rotate(0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.5s cubic-bezier(0.22,1,0.36,1)',
        'slide-in-right': 'slide-in-right 0.35s cubic-bezier(0.22,1,0.36,1)',
        'draw-line': 'draw-line 0.9s cubic-bezier(0.22,1,0.36,1) 0.2s both',
        'seal-in': 'seal-in 0.6s cubic-bezier(0.22,1,0.36,1) both',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
}
