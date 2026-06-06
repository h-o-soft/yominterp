/**
 * Z-machine オブジェクトテーブルから短縮名 (short name) を抽出する (spec §12)。
 *
 * v5 のオブジェクトテーブルにはオブジェクト数が明示されないため、
 * 「最小のプロパティテーブルアドレスに最初に到達した時点で打ち切る」
 * 標準的な境界推定 (infodump と同手法) を用いる。
 *
 * このファイルは環境非依存 (Node API import 禁止)。
 */
import { decodeZString, makeZStringEnv, readByte, readWord } from './zscii.js';

export interface ZObject {
  /** オブジェクト番号 (1 始まり) */
  id: number;
  /** プロパティヘッダの short name (空のこともある) */
  name: string;
  propAddr: number;
}

export function extractObjects(memory: Uint8Array): ZObject[] {
  const version = readByte(memory, 0);
  const tableAddr = readWord(memory, 0x0a);
  const env = makeZStringEnv(memory);

  const defaultsBytes = (version >= 4 ? 63 : 31) * 2;
  const entrySize = version >= 4 ? 14 : 9;
  let addr = tableAddr + defaultsBytes;

  const objects: ZObject[] = [];
  let minPropAddr = Number.POSITIVE_INFINITY;
  let id = 1;
  // 仕様上 v4+ は最大 65535 個だが、暴走防止に上限を置く
  const HARD_LIMIT = 0xffff;

  while (addr + entrySize <= memory.length && addr < minPropAddr && id <= HARD_LIMIT) {
    const propAddr = readWord(memory, addr + entrySize - 2);
    if (propAddr === 0 || propAddr >= memory.length) break; // 異常値で打ち切り
    if (propAddr < minPropAddr) minPropAddr = propAddr;

    const textWords = readByte(memory, propAddr);
    let name = '';
    if (textWords > 0) {
      name = decodeZString(env, propAddr + 1, textWords).text;
    }
    objects.push({ id, name, propAddr });
    id++;
    addr += entrySize;
  }
  return objects;
}

/** 空名・重複を除いた short name 一覧 (プロンプト素材用) */
export function objectNames(memory: Uint8Array): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const obj of extractObjects(memory)) {
    const name = obj.name.trim();
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}
