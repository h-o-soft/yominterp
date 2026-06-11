/**
 * ページャ実描画回帰テスト (LLM 不要・refs/anchorhead がある環境のみ)。
 * 「計算した物理行数 = 実際の表示行数」を実レンダリングで検証する。
 *
 * anchorhead 冒頭プロローグは 34 表示行 (80 桁 wrap 後) の char query 1 画面で、
 * かつてページャをバイパス (paged=false) して縦に溢れ、キー待ち時点で冒頭
 * (November, 1997.) がスクロールアウトしていた。char 画面もページングし、
 * ページ使用行数を実 DOM 計測することで「画面いっぱいの手前で [More] →
 * 冒頭が画面内に残る」ことを実描画で固定する。
 */
import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const ANCHOR = 'refs/anchorhead/anchor.z8';

/** 端末ペインの実描画状態 (溢れ判定用) */
function paneMetrics() {
  const t = document.getElementById('terminal')!;
  return {
    scrollHeight: t.scrollHeight,
    clientHeight: t.clientHeight,
    scrollTop: t.scrollTop,
  };
}

test('anchorhead 冒頭: 画面いっぱいの手前で [More] になり冒頭行が画面内に残る (実描画)', async ({
  page,
}) => {
  test.skip(!existsSync(ANCHOR), `${ANCHOR} なし (ローカル専用テスト素材)`);
  test.setTimeout(120000);
  await page.goto('/');
  await page.locator('#set-baseurl').fill('http://127.0.0.1:1/v1'); // LLM 不通 → 原文フォールバック
  await page.locator('#set-model').fill('dummy');
  await page.locator('#file-input').setInputFiles(ANCHOR);

  // タイトル画面 (char query): キー待ちバーが出る。8 行なので [More] は出ない
  await expect(page.locator('#terminal')).toContainText('A N C H O R H E A D', { timeout: 60000 });
  await expect(page.locator('.more-bar')).toBeVisible();

  // 任意キーでプロローグへ ('R' は restore なので避ける)
  await page.keyboard.press('Space');

  // プロローグ 1 ページ目: 冒頭行が表示され、ページ末尾に [More] バーが出る
  await expect(page.locator('#terminal')).toContainText('November, 1997', { timeout: 60000 });
  // バーは [More] (ページ送り・ローカル消費) とキー待ち (VM へ送る) の 2 種 —
  // テキストで区別する (どちらも .more-bar)
  const moreBar = page.locator('.more-bar', { hasText: '[More]' });
  const keyWaitBar = page.locator('.more-bar', { hasText: 'キーを押して続行' });
  await expect(moreBar).toBeVisible({ timeout: 60000 });
  // 34 表示行のプロローグが分割されている (末尾はまだ出ていない)
  await expect(page.locator('#terminal')).not.toContainText('Welcome to Anchorhead');

  // 溢れ判定 (実描画): ペインは縦スクロールしておらず、全コンテンツが枠内
  const p1 = await page.evaluate(paneMetrics);
  expect(p1.scrollTop).toBe(0);
  expect(p1.scrollHeight).toBeLessThanOrEqual(p1.clientHeight + 1);
  // 冒頭行の段落がビューポート内に見えている (スクロールアウトしていない)
  await expect(
    page.locator('#terminal p', { hasText: 'November, 1997' }),
  ).toBeInViewport();

  // [More] でプロローグ末尾 (キー待ちバー) まで送る。ページ数は翻訳エラー行の
  // 折返し数など環境に依存するため、毎ページ溢れの無さを検証しつつ進める
  for (let i = 0; i < 8; i++) {
    const m = await page.evaluate(paneMetrics);
    expect(m.scrollTop).toBe(0);
    expect(m.scrollHeight).toBeLessThanOrEqual(m.clientHeight + 1);
    await expect(moreBar.or(keyWaitBar)).toBeVisible({ timeout: 60000 });
    if (await keyWaitBar.isVisible()) break; // プロローグ末尾に到達
    await moreBar.click();
    await page.waitForTimeout(300);
  }
  await expect(page.locator('#terminal')).toContainText('Welcome to Anchorhead', {
    timeout: 60000,
  });
  await expect(keyWaitBar).toBeVisible();
  const p2 = await page.evaluate(paneMetrics);
  expect(p2.scrollTop).toBe(0);
  expect(p2.scrollHeight).toBeLessThanOrEqual(p2.clientHeight + 1);

  // キーで先へ: 引用画面 (THE FIRST DAY) → さらにキーで本編 1 ターン目
  // (キー待ちバーが出てから押す — バー出現前のキーはリスナー不在で失われる)
  await page.keyboard.press('Space');
  await expect(page.locator('#terminal')).toContainText('THE FIRST DAY', { timeout: 60000 });
  await expect(keyWaitBar).toBeVisible({ timeout: 60000 });
  await page.keyboard.press('Space');
  await expect(page.locator('#terminal')).toContainText('Outside the Real Estate Office', {
    timeout: 30000,
  });
  await expect(page.locator('#input')).toBeEnabled();
  // 本編 1 画面 (14 表示行) も溢れていない
  const p3 = await page.evaluate(paneMetrics);
  expect(p3.scrollHeight).toBeLessThanOrEqual(p3.clientHeight + 1);
});

const NINETENTHS = 'refs/ninetenths.z5';

test('ninetenths HELP: N/P 操作で [More] が混入しない (char メニュー回帰防止)', async ({
  page,
}) => {
  // かつて char メニューの再描画ごとに加算カウンタが累積し、HELP の N/P 操作に
  // [More] が混入した (7226efb ②)。その対策の paged=false は撤廃したので、
  // 「実測ページャなら grid 置換が正しく反映され [More] は出ない」ことを固定する。
  test.skip(!existsSync(NINETENTHS), `${NINETENTHS} なし (ローカル専用テスト素材)`);
  test.setTimeout(120000);
  await page.goto('/');
  await page.locator('#set-baseurl').fill('http://127.0.0.1:1/v1'); // LLM 不通 → 原文フォールバック
  await page.locator('#set-model').fill('dummy');
  await page.locator('#file-input').setInputFiles(NINETENTHS);

  // タイトル画面 (char query) → キー待ちバーが出てからキーで本編へ
  // (バー出現前のキーはリスナー不在で失われる — 人間の操作と同じ順序で待つ)
  await expect(page.locator('#terminal')).toContainText('Nine-Tenths of the Law', {
    timeout: 60000,
  });
  await expect(page.locator('.more-bar')).toContainText('キーを押して続行', { timeout: 60000 });
  await page.keyboard.press('Space');
  await expect(page.locator('#terminal')).toContainText('The Hilltop', { timeout: 60000 });
  await expect(page.locator('#input')).toBeEnabled({ timeout: 60000 });

  // HELP (char メニュー) へ。「>」プレフィックスで LLM を介さず直接送る
  await page.locator('#input').fill('> help');
  await page.locator('#input').press('Enter');
  await expect(page.locator('#terminal')).toContainText('next subject', { timeout: 60000 });

  // N/P 操作: 画面は置換更新され、[More] バーは一度も出ない (キー待ちバーのみ)
  for (const key of ['n', 'n', 'p']) {
    await page.keyboard.press(key);
    await page.waitForTimeout(800); // 再描画 (LLM 不通の翻訳エラー行含む) を待つ
    await expect(page.locator('.more-bar')).not.toContainText('[More]');
    await expect(page.locator('#terminal .gridbox')).toHaveCount(1); // 置換 = 残留しない
  }
  // Q で本編へ戻れる (メニューに閉じ込められない)
  await page.keyboard.press('q');
  await expect(page.locator('#terminal')).toContainText('The Hilltop', { timeout: 60000 });
});

test('クラシックの [More]/キー待ちバーは正確に 1 行高 (実描画)', async ({ page }) => {
  // バーが約 2.3 行分の高さを持ち、classicPageLines の「バー = 1 行」予約を超えて
  // ページ先頭を押し出していた回帰の防止。実レンダリングの高さで固定する。
  await page.goto('/');
  await page.getByRole('button', { name: '閉じる' }).click();
  const { barH, lineH } = await page.evaluate(() => {
    const t = document.getElementById('terminal')!;
    const bar = document.createElement('button');
    bar.className = 'more-bar';
    bar.textContent = '—— [More] ——';
    t.appendChild(bar);
    const barH = bar.getBoundingClientRect().height;
    const lineH = parseFloat(getComputedStyle(t).lineHeight);
    bar.remove();
    return { barH, lineH };
  });
  expect(Math.abs(barH - lineH)).toBeLessThanOrEqual(0.5);
});

test('クラシックの quote box (gridbox) は行格子に整列する (実描画)', async ({ page }) => {
  // gridbox の margin/padding (約 1.5 行分) が行数計算に乗らず溢れていた回帰の防止。
  await page.goto('/');
  await page.getByRole('button', { name: '閉じる' }).click();
  const { boxH, lineH } = await page.evaluate(() => {
    const t = document.getElementById('terminal')!;
    const box = document.createElement('div');
    box.className = 'gridbox';
    box.textContent = 'line one\nline two\nline three';
    t.appendChild(box);
    const r = box.getBoundingClientRect();
    const cs = getComputedStyle(box);
    const outer =
      r.height + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom);
    const lineH = parseFloat(getComputedStyle(t).lineHeight);
    box.remove();
    return { boxH: outer, lineH };
  });
  expect(Math.abs(boxH - 3 * lineH)).toBeLessThanOrEqual(0.5); // 3 行ぶんちょうど
});

test('クラシックの cmd/system 行も 1 表示行 = 行格子 1 マス (実描画)', async ({ page }) => {
  // cmd 行 (font-size 0.85rem) の行高が縮み、実測行数と格子がズレる回帰の防止。
  await page.goto('/');
  await page.getByRole('button', { name: '閉じる' }).click();
  const { cmdH, lineH } = await page.evaluate(() => {
    const t = document.getElementById('terminal')!;
    const p = document.createElement('p');
    p.className = 'cmd';
    p.textContent = '> look';
    t.appendChild(p);
    const cmdH = p.getBoundingClientRect().height;
    const lineH = parseFloat(getComputedStyle(t).lineHeight);
    p.remove();
    return { cmdH, lineH };
  });
  expect(Math.abs(cmdH - lineH)).toBeLessThanOrEqual(0.5);
});
