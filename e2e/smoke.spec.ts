/**
 * ブラウザ煙テスト (LLM 不要・plan.md 段階2 §7)。
 * WASM ロード・asset パス・IndexedDB・localStorage・接続エラー表示など、
 * Node 結合テストでは壊れても検出できない層を対象にする。
 */
import { expect, test } from '@playwright/test';

test('ページが起動し、未設定なら設定ダイアログが開く', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/yominterp/);
  await expect(page.locator('#settings-dialog')).toHaveAttribute('open', '');
  await page.getByRole('button', { name: '閉じる' }).click();
  await expect(page.locator('#terminal')).toContainText('日本語で遊ぶ');
});

test('設定が localStorage に永続される (apiKey は既定で永続しない)', async ({ page }) => {
  await page.goto('/');
  await page.locator('#set-baseurl').fill('http://127.0.0.1:9999/v1');
  await page.locator('#set-model').fill('test-model');
  await page.locator('#set-apikey').fill('sk-secret');
  await page.getByRole('button', { name: '閉じる' }).click();
  await page.reload();
  const stored = await page.evaluate(() => localStorage.getItem('yominterp-settings') ?? '');
  expect(stored).toContain('test-model');
  expect(stored).not.toContain('sk-secret');
  expect(await page.evaluate(() => localStorage.getItem('yominterp-apikey'))).toBeNull();
});

test('サンプル (darkpit) が WASM で起動しイントロが表示される (LLM なし→原文フォールバック)', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('#set-baseurl').fill('http://127.0.0.1:1/v1'); // 到達不能 endpoint
  await page.locator('#set-model').fill('dummy');
  await page.getByRole('button', { name: 'サンプル: Dark Pit (MIT)' }).click();
  // LLM 不通の警告 → 原文で起動
  await expect(page.locator('#terminal')).toContainText('Dungeon Cell', { timeout: 45000 });
  await expect(page.locator('#terminal')).toContainText('old man');
  await expect(page.locator('#input')).toBeEnabled();
});

test('接続テストは到達不能 endpoint でエラーを表示する', async ({ page }) => {
  await page.goto('/');
  await page.locator('#set-baseurl').fill('http://127.0.0.1:1/v1');
  await page.locator('#set-model').fill('dummy');
  await page.getByRole('button', { name: '接続テスト' }).click();
  await expect(page.locator('#test-result')).toHaveClass('ng', { timeout: 30000 });
  await expect(page.locator('#test-result')).not.toHaveText('');
});
