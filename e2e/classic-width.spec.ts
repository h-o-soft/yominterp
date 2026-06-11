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
  await expect(page.locator('body')).toHaveClass(/classic/); // クラシックが既定
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
