import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeStory, extractBlorbExec } from '../src/web/storyfile.js';

/** 合成 Blorb (コミット可・ゲーム本文なし) */
function makeBlorb(execType: 'ZCOD' | 'GLUL', execData: Uint8Array): Uint8Array {
  const chunks: number[] = [];
  const pushStr = (s: string) => chunks.push(...[...s].map((c) => c.charCodeAt(0)));
  const pushU32 = (n: number) => chunks.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  // RIdx チャンク (最小)
  const ridx = [0, 0, 0, 0];
  pushStr('FORM');
  pushU32(0); // 後で埋める長さ (テストでは未検証)
  pushStr('IFRS');
  pushStr('RIdx');
  pushU32(ridx.length);
  chunks.push(...ridx);
  pushStr(execType);
  pushU32(execData.length);
  chunks.push(...execData);
  if (execData.length % 2 === 1) chunks.push(0);
  return new Uint8Array(chunks);
}

describe('analyzeStory (形式判定)', () => {
  it('Z-code 生ファイル (先頭バイト=version)', () => {
    const fake = new Uint8Array(64);
    fake[0] = 5;
    const info = analyzeStory(fake, 'x.z5');
    expect(info.format).toBe('zcode');
    expect(info.zVersion).toBe(5);
    expect(info.vocabError).toBeDefined(); // ヘッダ不備でも vocab 失敗は致命でない
  });

  it('Glulx 生ファイル (magic Glul)', () => {
    const fake = new Uint8Array([0x47, 0x6c, 0x75, 0x6c, 0, 0, 0, 0]);
    expect(analyzeStory(fake).format).toBe('glulx');
  });

  it('Blorb から ZCOD Exec を取り出す', () => {
    const exec = new Uint8Array(32);
    exec[0] = 8;
    const blorb = makeBlorb('ZCOD', exec);
    const found = extractBlorbExec(blorb);
    expect(found?.type).toBe('ZCOD');
    const info = analyzeStory(blorb, 'x.zblorb');
    expect(info.format).toBe('zcode');
    expect(info.zVersion).toBe(8);
    expect(info.data).toBe(blorb); // VM へは Blorb 全体を渡す
  });

  it('GLUL Blorb は glulx', () => {
    expect(analyzeStory(makeBlorb('GLUL', new Uint8Array(16))).format).toBe('glulx');
  });

  it('不明形式は例外', () => {
    expect(() => analyzeStory(new Uint8Array([0x99, 1, 2, 3]), 'x.bin')).toThrow(/対応していない/);
  });
});

describe.skipIf(!existsSync('refs/anchorhead/anchor.z8'))('実ファイル (refs)', () => {
  it('anchor.z8 (v8): 辞書/オブジェクトのスナップショット', () => {
    const info = analyzeStory(new Uint8Array(readFileSync('refs/anchorhead/anchor.z8')));
    expect(info.format).toBe('zcode');
    expect(info.zVersion).toBe(8);
    expect(info.vocab.dictWords.length).toBe(2257);
    expect(info.vocab.objectNames.length).toBe(714);
    expect(info.vocab.dictWords).toContain('michael');
  });

  it.skipIf(!existsSync('refs/anchorhead/AnchorheadDemo.gblorb'))(
    'AnchorheadDemo.gblorb は glulx (vocab は 2b まで空)',
    () => {
      const info = analyzeStory(new Uint8Array(readFileSync('refs/anchorhead/AnchorheadDemo.gblorb')));
      expect(info.format).toBe('glulx');
      expect(info.vocab.dictWords).toEqual([]);
    },
  );

  it.skipIf(!existsSync('refs/darkzil/darkpit.z3'))('darkpit.z3 (v3)', () => {
    const info = analyzeStory(new Uint8Array(readFileSync('refs/darkzil/darkpit.z3')));
    expect(info.zVersion).toBe(3);
    expect(info.vocab.dictWords).toContain('kill');
  });
});
