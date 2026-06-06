import { defineConfig } from '@playwright/test';

/**
 * ブラウザ煙テスト (LLM 不要、plan.md 段階2 §7)。
 * dist/ を vite preview で配信して検証する (Pages 配信と同形)。
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60000,
  use: {
    baseURL: 'http://127.0.0.1:4173',
  },
  webServer: {
    command: 'npx vite preview --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: true,
    timeout: 30000,
  },
});
