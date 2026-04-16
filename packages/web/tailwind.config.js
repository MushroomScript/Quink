/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: 'rgb(var(--c-accent) / <alpha-value>)',
          light: 'rgb(var(--c-accent-light) / <alpha-value>)',
          dark: 'rgb(var(--c-accent-dark) / <alpha-value>)',
        },
        sidebar: {
          DEFAULT: 'rgb(var(--c-sidebar) / <alpha-value>)',
          light: 'rgb(var(--c-sidebar-light) / <alpha-value>)',
        },
        surface: {
          DEFAULT: '#f5f5f7',
        },
      },
    },
  },
  plugins: [],
};
