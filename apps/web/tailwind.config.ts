import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      colors: {
        ink: '#080b10',
        panel: '#0e131a',
        line: '#202934',
        acid: '#b6f04a',
        cyan: '#52d3f7',
      },
      boxShadow: {
        glow: '0 0 40px rgba(182, 240, 74, 0.10)',
      },
    },
  },
  plugins: [],
} satisfies Config;

