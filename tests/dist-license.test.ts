/**
 * 配布物のライセンス検査 (plan.md 段階2 §6):
 * dist/ に GPL 系エンジン (tads/scare) の wasm/js が混入していないことを保証する。
 * (emglken の index import 経由で全エンジンがバンドルされる事故の防止 — 実際に起きた)
 * dist/ が無い場合 (ビルド前) はスキップ。
 */
import { existsSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const DIST = 'dist/assets';

describe.skipIf(!existsSync(DIST))('dist ライセンス検査', () => {
  it('GPL エンジン (tads/scare) のアセットが混入していない', () => {
    const assets = readdirSync(DIST);
    const offending = assets.filter((f) => /^(tads|scare)-/i.test(f));
    expect(offending, `GPL アセットが混入: ${offending.join(', ')}`).toEqual([]);
  });

  it('必要な MIT エンジン (bocfel) の wasm が含まれている', () => {
    const assets = readdirSync(DIST);
    expect(assets.some((f) => /^bocfel-.*\.wasm$/.test(f))).toBe(true);
  });

  it('同梱フォント (PlemolJP HS, OFL) はライセンス全文と一緒に配布される', () => {
    // OFL-1.1 はフォント再配布時のライセンス文の同梱を要求する。woff2 だけが
    // dist に乗って OFL.txt が落ちる事故を防ぐ (public/ ごとコピーされる前提を固定)
    const fonts = readdirSync('dist/fonts');
    expect(fonts).toContain('PlemolJPHS-Regular.woff2');
    expect(fonts).toContain('PlemolJPHS-Bold.woff2');
    expect(fonts).toContain('OFL-PlemolJP.txt');
  });
});
