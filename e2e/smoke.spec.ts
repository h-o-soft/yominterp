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

test('ウェルカム画面・上部バーはステータス専用・☰メニューは下部入力バー', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '閉じる' }).click();
  await expect(page.locator('.welcome .logo')).toHaveText('yominterp');
  await expect(page.locator('.welcome .subtitle')).toContainText('日本語で遊ぶ');
  // 上部バーに操作ボタンはない (ステータスライン専用 — 右寄せ情報を隠さない)
  await expect(page.locator('#topbar button')).toHaveCount(0);
  // ☰ は下部の入力バーにある
  await expect(page.locator('#inputbar #btn-menu')).toBeVisible();
  // ☰ メニューを開くと操作項目が並ぶ
  await expect(page.locator('#topbar-menu')).toBeHidden();
  await page.locator('#btn-menu').click();
  await expect(page.locator('#topbar-menu')).toBeVisible();
  await expect(page.locator('#topbar-menu #btn-open-top')).toBeVisible();
  await expect(page.locator('#topbar-menu #btn-settings')).toBeVisible();
  // 削除されたデスクトップ説明文が出ていない
  await expect(page.locator('#terminal')).not.toContainText('proxy 設定は不要');
});

test('ステータスラインは左=場所名 / 右=右寄せ情報の 2 要素 (右寄せレイアウト)', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '閉じる' }).click();
  // 左右 2 要素が存在し、flex で左右に振り分けられている
  await expect(page.locator('#status-line #status-left')).toHaveCount(1);
  await expect(page.locator('#status-line #status-right')).toHaveCount(1);
  const display = await page
    .locator('#status-line')
    .evaluate((el) => getComputedStyle(el).display);
  expect(display).toBe('flex');
  const justify = await page
    .locator('#status-line')
    .evaluate((el) => getComputedStyle(el).justifyContent);
  expect(justify).toBe('space-between');
});

test('クラシックモードの空行 (空 <p>) は実描画で 1 行ぶんの高さを持つ', async ({ page }) => {
  // ゲーム由来の空行が margin:0 で高さ 0 になり視覚的に消えていた回帰の防止。
  // データモデルの行数ではなく「実際に描画された高さ」で確認する。
  await page.goto('/');
  await page.getByRole('button', { name: '閉じる' }).click();
  await expect(page.locator('body')).toHaveClass(/classic/); // クラシックが既定
  const rendered = await page.evaluate(() => {
    const t = document.getElementById('terminal')!;
    const p = document.createElement('p'); // 空段落 = 空行
    t.appendChild(p);
    const h = p.getBoundingClientRect().height;
    p.remove();
    return h;
  });
  expect(rendered).toBeGreaterThan(10); // 0 ではなく 1 行ぶん (≈23px) の高さ
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

test('設定に言語セレクタ (5言語・既定ja) と実験的注意書きがある', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '閉じる' }).click();
  await page.locator('#btn-menu').click();
  await page.locator('#topbar-menu #btn-settings').click();
  const opts = page.locator('#set-language option');
  await expect(opts).toHaveCount(5);
  await expect(page.locator('#set-language')).toHaveValue('ja'); // 既定
  await expect(page.locator('#lang-note')).toContainText('実験的');
});

test('原文ビューの本文段落 (p.raw) はクラシックでも折り返す (white-space: pre-wrap)', async ({
  page,
}) => {
  // 原文トグル表示が wrap せず横はみ出していた回帰の防止。実描画の white-space と
  // はみ出しで確認する (要素数でなく実レンダリング)。
  await page.goto('/');
  await page.getByRole('button', { name: '閉じる' }).click();
  await expect(page.locator('body')).toHaveClass(/classic/); // クラシック既定
  const result = await page.evaluate(() => {
    const t = document.getElementById('terminal')!;
    const p = document.createElement('p');
    p.className = 'raw';
    p.textContent = 'word '.repeat(80); // 枠幅を超える長い 1 行 (単語区切り = pre-wrap が折れる)
    t.appendChild(p);
    const ws = getComputedStyle(p).whiteSpace;
    const overflow = p.scrollWidth > p.getBoundingClientRect().width + 2;
    const multiline = p.getBoundingClientRect().height > 30; // 折り返して複数行
    p.remove();
    return { ws, overflow, multiline };
  });
  expect(result.ws).toBe('pre-wrap'); // クラシックの p{pre} を上書きできている
  expect(result.overflow).toBe(false); // 横にはみ出さない
  expect(result.multiline).toBe(true); // 折り返して複数行になる
});

test('「>」プレフィックスで英語コマンドを入口翻訳せず直接送れる (LLM 不要・決定論の回復手段)', async ({
  page,
}) => {
  test.skip(!existsSync(DARKPIT), `${DARKPIT} なし (ローカル専用テスト素材)`);
  await page.addInitScript(() => {
    localStorage.setItem('yominterp-settings', JSON.stringify({ classicMode: false }));
  });
  await page.goto('/');
  await page.locator('#set-baseurl').fill('http://127.0.0.1:1/v1'); // 到達不能 = 入口LLMは使えない
  await page.locator('#set-model').fill('dummy');
  await page.locator('#file-input').setInputFiles(DARKPIT);
  await expect(page.locator('#terminal')).toContainText('Dungeon Cell', { timeout: 45000 });
  await expect(page.locator('#input')).toBeEnabled();
  // 入口 LLM は到達不能だが、「> look」は翻訳をバイパスして直接ゲームへ届く
  await page.locator('#input').fill('> look');
  await page.locator('#input').press('Enter');
  // 直接送ったコマンドがエコーされ、ゲームの応答 (Dungeon Cell) が再度出る
  await expect(page.locator('#terminal p.cmd').filter({ hasText: '> look' })).toHaveCount(1, {
    timeout: 20000,
  });
});
