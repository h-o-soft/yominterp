/**
 * 実機検証 (日本語翻訳あり): anchorhead 冒頭のページャ挙動をスクリーンショットで確認する。
 * - LM Studio (プロキシ経由) で実際に日本語化した状態で、
 *   「画面いっぱいの手前で [More] になり、冒頭 (1997年11月) が画面内に残る」を実描画検証。
 * - スクショは reports/pager-fix/ (gitignore 済み) に保存。
 * - 永続プロファイルで IndexedDB 翻訳キャッシュを保持 (2 回目以降は高速・完全日本語)。
 * 前提: vite preview (4173) と npm run proxy が起動済み。
 *   使い方: npx tsx scripts/verify-pager-ja.mts <baseUrl>
 */
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE_URL = process.argv[2] ?? 'http://127.0.0.1:1234/v1';
const OUT = 'reports/pager-fix';
mkdirSync(OUT, { recursive: true });

const ctx = await chromium.launchPersistentContext(`${OUT}/.profile`, {
  viewport: { width: 1280, height: 720 },
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.setDefaultTimeout(540000);

await page.goto('http://127.0.0.1:4173/');
// 設定済みプロファイルでは設定ダイアログが自動で開かない → ☰ から開く
if (!(await page.locator('#settings-dialog').evaluate((d) => (d as HTMLDialogElement).open))) {
  await page.locator('#btn-menu').click();
  await page.locator('#topbar-menu #btn-settings').click();
}
await page.locator('#set-baseurl').fill(BASE_URL);
await page.locator('#set-model').fill('gemma-4-e4b-it-ud-japanese-imatrix');
await page.locator('#file-input').setInputFiles('refs/anchorhead/anchor.z8');

// タイトル画面 (char query): キー待ちバーが出るまで (用語集生成で数分かかりうる)
await page.locator('.more-bar').waitFor();
await page.screenshot({ path: `${OUT}/01-title.png` });

// 任意キーでプロローグへ
await page.keyboard.press('Space');
// ページ末尾の [More] バーを待つ (翻訳が段落ごとに進む)
await page.locator('.more-bar', { hasText: '[More]' }).waitFor();
const metrics = await page.evaluate(() => {
  const t = document.getElementById('terminal')!;
  const first = [...t.querySelectorAll('p')].find((p) => (p.textContent ?? '').includes('1997'));
  const tr = t.getBoundingClientRect();
  const fr = first?.getBoundingClientRect();
  return {
    scrollTop: t.scrollTop,
    scrollHeight: t.scrollHeight,
    clientHeight: t.clientHeight,
    firstParaVisible:
      fr !== undefined && fr.top >= tr.top - 1 && fr.bottom <= tr.bottom + 1,
    firstParaText: first?.textContent?.slice(0, 40) ?? '(not found)',
  };
});
console.log('prologue page1 metrics:', JSON.stringify(metrics, null, 2));
await page.screenshot({ path: `${OUT}/02-prologue-page1-more.png` });
if (metrics.scrollTop !== 0 || metrics.scrollHeight > metrics.clientHeight + 1 || !metrics.firstParaVisible) {
  console.error('NG: 溢れ または 冒頭行が画面外');
  process.exitCode = 1;
} else {
  console.log('OK: 冒頭行が画面内・溢れなし・[More] が正しいタイミングで出ている');
}

// [More] で続き → プロローグ末尾 (キー待ち)
await page.locator('.more-bar').click();
await page.locator('.more-bar', { hasText: 'キーを押して続行' }).waitFor();
const m2 = await page.evaluate(() => {
  const t = document.getElementById('terminal')!;
  return { scrollTop: t.scrollTop, scrollHeight: t.scrollHeight, clientHeight: t.clientHeight };
});
console.log('prologue page2 metrics:', JSON.stringify(m2));
await page.screenshot({ path: `${OUT}/03-prologue-page2-keywait.png` });
if (m2.scrollTop !== 0 || m2.scrollHeight > m2.clientHeight + 1) {
  console.error('NG: 2 ページ目で溢れ');
  process.exitCode = 1;
}

await ctx.close();
console.log(`screenshots: ${OUT}/`);
