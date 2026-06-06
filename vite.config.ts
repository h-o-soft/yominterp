/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages のプロジェクトサイト (https://h-o-soft.github.io/yominterp/)
  base: '/yominterp/',
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
  test: {
    // e2e/ は Playwright 専用 (npm run e2e)
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
  },
});
