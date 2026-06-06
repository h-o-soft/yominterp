/**
 * ghosts.z5 実データでのスナップショットテスト (refs/ 不在ならスキップ)。
 * 既知語・既知オブジェクト名が取れることを確認する。
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractDictionary } from '../src/core/zfile/dictionary.js';
import { objectNames } from '../src/core/zfile/objects.js';

const STORY = 'refs/ghosts_R14/ghosts.z5';

describe.skipIf(!existsSync(STORY))('zfile 抽出 (ghosts.z5)', () => {
  const memory = new Uint8Array(existsSync(STORY) ? readFileSync(STORY) : []);

  it('辞書アドレスは事前調査どおり 0x2e93 で、既知語が取れる', () => {
    const dict = extractDictionary(memory);
    expect(dict.addr).toBe(0x2e93);
    for (const w of ['take', 'lamp', 'rosie', 'worktops', 'xyzzy', 'north']) {
      expect(dict.words, `辞書に ${w} がない`).toContain(w);
    }
    // v5 辞書は 9 文字打ち切り
    expect(dict.words.every((w) => w.length <= 9)).toBe(true);
    expect(dict.entryCount).toBeGreaterThan(100);
  });

  it('既知オブジェクト名 (部屋・アイテム) が取れる', () => {
    const names = objectNames(memory);
    expect(names).toContain('Great Hall');
    expect(names.length).toBeGreaterThan(20);
  });
});
