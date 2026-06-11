/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

// base の出し分け:
// - Web (GitHub Pages のプロジェクトサイト https://h-o-soft.github.io/yominterp/)
//   はサブパス配信なので '/yominterp/'。
// - Tauri は dist を tauri://localhost の「ルート直下」から読むため、サブパス
//   base だと全アセットが /yominterp/... を指して 404 になり白画面になる
//   (tauri build の .app で実際に発生)。Tauri CLI は beforeBuildCommand /
//   beforeDevCommand 実行時に TAURI_ENV_* を設定するので、それを見て
//   相対 base に切り替える。
const isTauri = process.env.TAURI_ENV_PLATFORM !== undefined;

export default defineConfig({
  base: isTauri ? './' : '/yominterp/',
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
  test: {
    // e2e/ は Playwright 専用 (npm run e2e)
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
  },
});
