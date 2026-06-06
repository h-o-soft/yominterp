import { describe, expect, it } from 'vitest';
import {
  DEFAULT_A0,
  decodeZString,
  makeZStringEnv,
  zsciiToUnicode,
} from '../src/core/zfile/zscii.js';
import { extractDictionary } from '../src/core/zfile/dictionary.js';
import { extractObjects } from '../src/core/zfile/objects.js';

// ---- 仕様ベースの手作り最小バイナリ fixture (自作・コミット可) ----

/** 小文字英字と空白のみの簡易 Z-character エンコーダ (テスト用) */
function encodeZchars(s: string): number[] {
  const z: number[] = [];
  for (const ch of s) {
    if (ch === ' ') z.push(0);
    else {
      const idx = DEFAULT_A0.indexOf(ch);
      if (idx < 0) throw new Error(`unsupported char for test encoder: ${ch}`);
      z.push(6 + idx);
    }
  }
  return z;
}

/** z-chars を 2 バイトワード列にパック (5 でパディング・最終ワードに end bit) */
function packZchars(zchars: number[], padToWords?: number): number[] {
  const z = [...zchars];
  while (z.length % 3 !== 0 || (padToWords !== undefined && z.length / 3 < padToWords)) {
    z.push(5);
  }
  const bytes: number[] = [];
  for (let i = 0; i < z.length; i += 3) {
    let w = (z[i]! << 10) | (z[i + 1]! << 5) | z[i + 2]!;
    if (i + 3 >= z.length) w |= 0x8000;
    bytes.push(w >> 8, w & 0xff);
  }
  return bytes;
}

function writeBytes(mem: Uint8Array, addr: number, bytes: number[]): void {
  mem.set(bytes, addr);
}

function writeWord(mem: Uint8Array, addr: number, value: number): void {
  mem[addr] = value >> 8;
  mem[addr + 1] = value & 0xff;
}

const ABBREV_TABLE = 0x80;
const ABBREV_STR = 0xc0;
const TEST_STR = 0xe0;
const DICT = 0x100;
const OBJ_TABLE = 0x200;

function buildFixture(): Uint8Array {
  const mem = new Uint8Array(0x400);
  mem[0] = 5; // version 5
  writeWord(mem, 0x08, DICT);
  writeWord(mem, 0x0a, OBJ_TABLE);
  writeWord(mem, 0x18, ABBREV_TABLE);
  writeWord(mem, 0x34, 0); // 既定 alphabet

  // abbreviation 0 → "the "
  writeWord(mem, ABBREV_TABLE, ABBREV_STR / 2);
  writeBytes(mem, ABBREV_STR, packZchars(encodeZchars('the ')));

  // テスト文字列: abbrev(1,0) + "lamp" → "the lamp"
  writeBytes(mem, TEST_STR, packZchars([1, 0, ...encodeZchars('lamp')]));

  // 辞書: separators ". ,", entryLength 9, 2 エントリ (take / lamp)
  let p = DICT;
  mem[p++] = 2;
  mem[p++] = 46; // '.'
  mem[p++] = 44; // ','
  mem[p++] = 9; // entry length (6 text + 3 data)
  writeWord(mem, p, 2); // entry count
  p += 2;
  for (const word of ['lamp', 'take']) {
    writeBytes(mem, p, packZchars(encodeZchars(word), 3));
    p += 9;
  }

  // オブジェクトテーブル: defaults 63 ワード + entry 14 バイト × 2
  const firstEntry = OBJ_TABLE + 63 * 2; // 0x27e
  const prop1 = firstEntry + 14 * 2; // 最初の prop table = 境界
  const prop2 = prop1 + 16;
  writeWord(mem, firstEntry + 12, prop1);
  writeWord(mem, firstEntry + 14 + 12, prop2);
  // prop1: "lamp" (2 ワード)
  mem[prop1] = 2;
  writeBytes(mem, prop1 + 1, packZchars(encodeZchars('lamp'), 2));
  // prop2: "brass key" (9 z-chars = 3 ワード)
  mem[prop2] = 3;
  writeBytes(mem, prop2 + 1, packZchars(encodeZchars('brass key'), 3));
  return mem;
}

describe('zscii デコーダ (fixture)', () => {
  const mem = buildFixture();
  const env = makeZStringEnv(mem);

  it('abbreviation を展開する', () => {
    expect(decodeZString(env, TEST_STR).text).toBe('the lamp');
  });

  it('shift で大文字・記号を出せる', () => {
    const local = new Uint8Array(0x40);
    // 単独メモリ上で [4,'a'相当] = "A"、[5,8] = "0"
    writeBytes(local, 0, packZchars([4, 6, 5, 8]));
    const localEnv = { ...env, memory: local, abbrevTableAddr: 0 };
    expect(decodeZString(localEnv, 0).text).toBe('A0');
  });

  it('10-bit ZSCII escape をデコードする', () => {
    const local = new Uint8Array(0x40);
    // 'x' = 120 = (3 << 5) | 24
    writeBytes(local, 0, packZchars([5, 6, 3, 24]));
    const localEnv = { ...env, memory: local, abbrevTableAddr: 0 };
    expect(decodeZString(localEnv, 0).text).toBe('x');
  });

  it('範囲外読み取りは例外', () => {
    expect(() => decodeZString(env, 0x3ff)).toThrow(RangeError);
  });

  it('zsciiToUnicode: 既定 extra characters', () => {
    expect(zsciiToUnicode(155)).toBe('ä');
    expect(zsciiToUnicode(220)).toBe('œ');
  });
});

describe('辞書抽出 (fixture)', () => {
  it('separators / entry / 単語をデコードする', () => {
    const dict = extractDictionary(buildFixture());
    expect(dict.addr).toBe(DICT);
    expect(dict.separators).toEqual(['.', ',']);
    expect(dict.entryLength).toBe(9);
    expect(dict.words).toEqual(['lamp', 'take']);
  });
});

describe('オブジェクト抽出 (fixture)', () => {
  it('境界推定 (最小 prop アドレス到達で打ち切り) で 2 個取れる', () => {
    const objs = extractObjects(buildFixture());
    expect(objs.map((o) => o.name)).toEqual(['lamp', 'brass key']);
    expect(objs.map((o) => o.id)).toEqual([1, 2]);
  });
});
