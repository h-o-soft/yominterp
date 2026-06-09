/**
 * ブラウザ煙テスト (LLM 不要・plan.md 段階2 §7)。
 * WASM ロード・asset パス・IndexedDB・localStorage・接続エラー表示など、
 * Node 結合テストでは壊れても検出できない層を対象にする。
 */
import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// ゲーム本体は同梱しない (サンプルなし方針)。WASM 起動の煙テストは
// ローカル専用のテスト素材 refs/darkzil/darkpit.z3 がある環境でのみ実行する。
const DARKPIT = 'refs/darkzil/darkpit.z3';

test('ページが起動し、未設定なら設定ダイアログが開く', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/yominterp/);
  await expect(page.locator('#settings-dialog')).toHaveAttribute('open', '');
  await page.getByRole('button', { name: '閉じる' }).click();
  await expect(page.locator('#terminal')).toContainText('日本語で遊ぶ');
});

test('ウェルカム画面のロゴ/サブタイトルとトップレベルの「開く」ボタン', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '閉じる' }).click();
  await expect(page.locator('.welcome .logo')).toHaveText('yominterp');
  await expect(page.locator('.welcome .subtitle')).toContainText('日本語で遊ぶ');
  // 「開く」がトップバーの一番左
  const firstBtn = page.locator('#topbar button').first();
  await expect(firstBtn).toHaveAttribute('id', 'btn-open-top');
  // 削除されたデスクトップ説明文が出ていない
  await expect(page.locator('#terminal')).not.toContainText('proxy 設定は不要');
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

test('ローカルファイルが WASM で起動しイントロが表示される (LLM なし→原文フォールバック)', async ({
  page,
}) => {
  test.skip(!existsSync(DARKPIT), `${DARKPIT} なし (ローカル専用テスト素材)`);
  // WASM 起動確認が主旨なので、ページ送り ([More]) のないモダンモードで実行する
  await page.addInitScript(() => {
    localStorage.setItem('yominterp-settings', JSON.stringify({ classicMode: false }));
  });
  await page.goto('/');
  await page.locator('#set-baseurl').fill('http://127.0.0.1:1/v1'); // 到達不能 endpoint
  await page.locator('#set-model').fill('dummy');
  await page.locator('#file-input').setInputFiles(DARKPIT);
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
