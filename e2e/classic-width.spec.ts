/**
 * クラシック端末の幅校正テスト (実描画)。
 * コンテナ幅が ch 単位 (ASCII「0」基準) だと、全角が半角 2 桁にならないフォント
 * 環境 (mac: SF Mono 0.602em + ヒラギノ 1em) で全角 40 文字行の右に死に余白が
 * できていた回帰の防止。実測校正 (calibrateClassicMetrics) 後は
 * 「半角 80 桁 = 全角 40 文字 = コンテナ内容幅」が実レンダリングで一致する。
 */
import { expect, test } from '@playwright/test';

test('クラシック: 半角80桁・全角40文字・コンテナ内容幅が一致する (右余白解消)', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '閉じる' }).click();
  const r = await page.evaluate(() => {
    const t = document.getElementById('terminal')!;
    const probe = (s: string): number => {
      const el = document.createElement('span');
      el.style.cssText = 'position:absolute; visibility:hidden; white-space:pre;';
      el.textContent = s;
      t.appendChild(el);
      const w = el.getBoundingClientRect().width;
      el.remove();
      return w;
    };
    const cs = getComputedStyle(t);
    const contentW = t.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    return {
      ascii80: probe('0'.repeat(80)),
      cjk40: probe('あ'.repeat(40)),
      mixed: probe('You take a deep breath. ' + 'あ'.repeat(28)), // 混在 80 桁 (半角24 + 全角28×2)
      contentW,
      termWidthVar: getComputedStyle(document.documentElement).getPropertyValue('--term-width'),
    };
  });
  // 実測校正済み: --term-width が設定されている
  expect(r.termWidthVar).toMatch(/px$/);
  // 「全角 = 半角×2」が実描画でほぼ成立 (半角 80 桁 ≈ 全角 40 文字)。
  // size-adjust 後の advance はブラウザが量子化するため数 px の残差は許容 —
  // 修正前の死に余白 ~122px の回帰だけを確実に防ぐ
  expect(Math.abs(r.ascii80 - r.cjk40)).toBeLessThanOrEqual(4);
  // 混在 80 桁行もほぼ同幅 (wrapToLines の桁計算と実描画の一致)
  expect(Math.abs(r.mixed - r.cjk40)).toBeLessThanOrEqual(4);
  // コンテナ内容幅とも一致 (大きい方に合わせてある) = 右の死に余白がない
  expect(r.contentW).toBeGreaterThanOrEqual(Math.max(r.ascii80, r.cjk40) - 1);
  expect(r.contentW).toBeLessThanOrEqual(Math.max(r.ascii80, r.cjk40) + 4);
});

test('同梱フォント PlemolJP HS が読み込まれ、半角:全角=1:2 がネイティブに成立する', async ({
  page,
}) => {
  // フォント同梱の主旨: 環境のシステムフォントに依存せず「全角=半角×2」を設計保証する。
  // 読込確認 + アクセント付きラテン (仏西独葡) も半角格子に乗ることを実描画で固定。
  await page.goto('/');
  await page.getByRole('button', { name: '閉じる' }).click();
  await page.evaluate(() => document.fonts.ready);
  const r = await page.evaluate(() => {
    const t = document.getElementById('terminal')!;
    const probe = (s: string): number => {
      const el = document.createElement('span');
      el.style.cssText = 'position:absolute; visibility:hidden; white-space:pre;';
      el.textContent = s;
      t.appendChild(el);
      const w = el.getBoundingClientRect().width;
      el.remove();
      return w;
    };
    return {
      loaded: document.fonts.check('15px "PlemolJP HS"'),
      calibrated: document.body.classList.contains('font-calibrated'),
      ascii80: probe('0'.repeat(80)),
      cjk40: probe('あ'.repeat(40)),
      accent80: probe('éñüçãàêßõ!'.repeat(8)), // 仏西独葡のアクセント付き 80 字 (Latin-1)
      ideographicSpace40: probe('　'.repeat(40)), // U+3000 全角スペース (HS でも幅 1em 維持)
    };
  });
  expect(r.loaded).toBe(true);
  // ネイティブ 1:2 が成立しているので size-adjust 校正は発動していない
  expect(r.calibrated).toBe(false);
  expect(Math.abs(r.ascii80 - r.cjk40)).toBeLessThanOrEqual(1);
  // アクセント付きラテンも半角 advance (Noto Mono CJK 不採用の決め手だった点)
  expect(Math.abs(r.accent80 - r.ascii80)).toBeLessThanOrEqual(1);
  // HS 版でも全角スペースの advance は全角のまま (空白演出の桁が崩れない)
  expect(Math.abs(r.ideographicSpace40 - r.cjk40)).toBeLessThanOrEqual(1);
});

test('クラシック: 縦スクロールバーが本文を隠さず、横スクロールバーは出ない (実描画)', async ({
  page,
}) => {
  // 常時表示スクロールバー環境で、縦バーが 80 桁の内側から幅を奪って右端の文字を
  // 隠し、押し出された本文が横スクロールバーを出していた回帰の防止。
  // ::-webkit-scrollbar 指定によりバーは常にクラシック型 (幅 10px) なので、
  // この検証は環境のバー設定に依らず決定的に再現する。
  await page.goto('/');
  await page.getByRole('button', { name: '閉じる' }).click();
  await page.evaluate(() => document.fonts.ready);
  const r = await page.evaluate(() => {
    const t = document.getElementById('terminal')!;
    t.classList.remove('welcoming');
    t.innerHTML = '';
    // 80 桁の行 × 60 = 縦スクロールが発生する量
    for (let i = 0; i < 60; i++) {
      const p = document.createElement('p');
      p.textContent = '0123456789'.repeat(8);
      t.appendChild(p);
    }
    const cs = getComputedStyle(t);
    const range = document.createRange();
    range.selectNodeContents(t.querySelector('p')!);
    const res = {
      overflowX: cs.overflowX,
      scrollbarGutter: cs.scrollbarGutter,
      gutterPx: t.offsetWidth - t.clientWidth,
      vScrollable: t.scrollHeight > t.clientHeight + 1,
      hOverflow: t.scrollWidth > t.clientWidth + 1,
      // 本文 (80 桁行のグリフ右端) が client 領域 (= バー/溝の左側) に収まる
      textRight: range.getBoundingClientRect().right,
      clientRight: t.getBoundingClientRect().left + t.clientLeft + t.clientWidth,
    };
    t.innerHTML = '';
    return res;
  });
  expect(r.overflowX).toBe('hidden'); // 横スクロールバーは構造的に出ない
  expect(r.scrollbarGutter).toContain('stable');
  expect(r.gutterPx).toBeGreaterThanOrEqual(10); // 自前テーマのクラシック型バー (溝あり)
  expect(r.vScrollable).toBe(true); // 縦スクロール状態での検証
  expect(r.hOverflow).toBe(false); // 横溢れなし
  // 右端の文字がスクロールバーに隠れない (バーは client 領域の外)
  expect(r.textRight).toBeLessThanOrEqual(r.clientRight + 0.5);
});

test('クラシック: 全角40文字の行が横にはみ出さない (実描画)', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '閉じる' }).click();
  const overflow = await page.evaluate(() => {
    const t = document.getElementById('terminal')!;
    const p = document.createElement('p');
    p.textContent = 'あ'.repeat(40);
    t.appendChild(p);
    const over = t.scrollWidth > t.clientWidth + 1;
    p.remove();
    return over;
  });
  expect(overflow).toBe(false);
});
