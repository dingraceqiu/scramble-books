/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Noto Sans SC"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        serif: ['"Noto Serif SC"', 'Georgia', 'serif'],
      },
      colors: {
        paper: 'rgb(var(--paper) / <alpha-value>)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        'surface-2': 'rgb(var(--surface-2) / <alpha-value>)',
        ink: 'rgb(var(--ink) / <alpha-value>)',
        'ink-soft': 'rgb(var(--ink-soft) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
        accent: 'rgb(var(--accent) / <alpha-value>)',
        'accent-soft': 'rgb(var(--accent-soft) / <alpha-value>)',
        'cover-0': 'rgb(var(--cover-0) / <alpha-value>)',
        'cover-1': 'rgb(var(--cover-1) / <alpha-value>)',
        'cover-2': 'rgb(var(--cover-2) / <alpha-value>)',
      },
      boxShadow: {
        card: '0 1px 2px rgb(0 0 0 / 0.04), 0 8px 24px -12px rgb(60 40 20 / 0.18)',
        lift: '0 2px 4px rgb(0 0 0 / 0.05), 0 16px 40px -16px rgb(60 40 20 / 0.28)',
      },
    },
  },
  plugins: [],
};
