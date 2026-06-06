/**
 * Z-machine 辞書テーブルの抽出 (spec §13)。
 * header 0x08 → 辞書アドレス。v4+ はエントリ先頭 6 バイト (Z-character 9 文字分) が単語。
 * v5 辞書は 9 文字で切り詰められる点に注意 (プロンプト側にも明記する)。
 *
 * このファイルは環境非依存 (Node API import 禁止)。
 */
import { decodeZString, makeZStringEnv, readByte, readWord, zsciiToUnicode } from './zscii.js';

export interface DictionaryInfo {
  addr: number;
  separators: string[];
  entryLength: number;
  entryCount: number;
  /** デコード済み単語リスト (辞書順) */
  words: string[];
}

export function extractDictionary(memory: Uint8Array): DictionaryInfo {
  const version = readByte(memory, 0);
  const addr = readWord(memory, 0x08);
  const env = makeZStringEnv(memory);

  let p = addr;
  const sepCount = readByte(memory, p);
  p += 1;
  const separators: string[] = [];
  for (let i = 0; i < sepCount; i++) {
    separators.push(zsciiToUnicode(readByte(memory, p + i)));
  }
  p += sepCount;
  const entryLength = readByte(memory, p);
  p += 1;
  const entryCount = readWord(memory, p);
  p += 2;

  const textWords = version >= 4 ? 3 : 2;
  const textBytes = textWords * 2;
  if (entryLength < textBytes) {
    throw new RangeError(`dictionary entry length ${entryLength} < text part ${textBytes}`);
  }
  if (p + entryCount * entryLength > memory.length) {
    throw new RangeError(`dictionary exceeds file size (count=${entryCount})`);
  }

  const words: string[] = [];
  for (let i = 0; i < entryCount; i++) {
    const { text } = decodeZString(env, p + i * entryLength, textWords);
    words.push(text);
  }
  return { addr, separators, entryLength, entryCount, words };
}
