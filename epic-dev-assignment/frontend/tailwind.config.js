import colors from 'tailwindcss/colors'

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Focus Flow wordmark colors, sampled from the logo artwork
        brand: {
          navy: '#0F0B59',   // "Focus"
          teal: '#01BCA9',   // "Flow"
          slate: '#4B4F5F',  // tagline
        },

        // Theme-adaptive colors via CSS variables
        accent: {
          cyan: 'var(--accent-cyan)',
          lime: 'var(--accent-lime)',
          pink: 'var(--accent-pink)',
          purple: 'var(--accent-purple)',
        },
        success: { DEFAULT: '#059669', muted: 'rgba(5, 150, 105, 0.12)' },
        warning: { DEFAULT: '#B45309', muted: 'rgba(180, 83, 9, 0.12)' },
        danger: { DEFAULT: '#DC2626', muted: 'rgba(220, 38, 38, 0.12)' },
        info: { DEFAULT: 'var(--accent-cyan)', muted: 'rgba(14, 165, 176, 0.12)' },

        // Full Tailwind color scales
        blue: { ...colors.blue, DEFAULT: '#2563EB' },
        green: { ...colors.green, DEFAULT: '#059669' },
        red: { ...colors.red, DEFAULT: '#DC2626' },
        yellow: colors.yellow,
        purple: { ...colors.purple, DEFAULT: '#7C3AED' },
        orange: { ...colors.orange, DEFAULT: '#EA580C' },
        amber: { ...colors.amber, DEFAULT: '#D97706' },
        indigo: { ...colors.indigo, DEFAULT: '#4F46E5' },
        gray: colors.gray,
        cyan: { ...colors.cyan, DEFAULT: 'var(--accent-cyan)' },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      borderRadius: {
        'xl': '12px',
        '2xl': '16px',
        '3xl': '20px',
      },
      backdropBlur: {
        'xs': '2px',
        '2xl': '24px',
      },
      animation: {
        'spin': 'spin 1s linear infinite',
      },
    },
  },
  plugins: [],
}
