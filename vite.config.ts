/// <reference types="vitest" />

import { defineConfig } from 'vite'

// https://vitejs.dev/config/
export default defineConfig({
  clearScreen: false,
  test: {
    globals: true,
    environment: 'jsdom',
    includeSource: ['src/**/*.{js,jsx,ts,tsx}'],
  },
  define: {
    'import.meta.vitest': 'undefined',
  },
})
