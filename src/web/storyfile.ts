/**
 * BYO ゲームファイルの形式判定と vocab 抽出 (plan.md 段階2 §4)。
 * - magic bytes: 'FORM'+'IFRS' = Blorb (Exec chunk を取り出す) / 先頭 1-8 = Z-code /
 *   'Glul' = 素の Glulx
 * - vocab: Z-code → 既存 zfile (v3-v8)。Glulx は 2b (今は辞書なし扱い)
 */
import { extractDictionary } from '../core/zfile/dictionary.js';
import { objectNames } from '../core/zfile/objects.js';

export type StoryFormat = 'zcode' | 'glulx';

export interface StoryInfo {
  format: StoryFormat;
  /** VM へ渡す実行イメージ (Blorb はそのまま渡す — emglken が解釈する) */
  data: Uint8Array;
  /** vocab 抽出用の実行チャンク (Blorb の場合は Exec、それ以外は data と同一) */
  exec: Uint8Array;
  zVersion?: number;
  vocab: { dictWords: string[]; objectNames: string[] };
  vocabError?: string;
}

function ascii(bytes: Uint8Array, offset: number, len: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + len));
}

function readU32(b: Uint8Array, off: number): number {
  return ((b[off]! << 24) | (b[off + 1]! << 16) | (b[off + 2]! << 8) | b[off + 3]!) >>> 0;
}

/** Blorb (IFF FORM/IFRS) から Exec チャンク (ZCOD/GLUL) を取り出す */
export function extractBlorbExec(data: Uint8Array): { type: 'ZCOD' | 'GLUL'; chunk: Uint8Array } | undefined {
  if (ascii(data, 0, 4) !== 'FORM' || ascii(data, 8, 4) !== 'IFRS') return undefined;
  let off = 12;
  while (off + 8 <= data.length) {
    const id = ascii(data, off, 4);
    const len = readU32(data, off + 4);
    if (id === 'ZCOD' || id === 'GLUL') {
      return { type: id, chunk: data.subarray(off + 8, off + 8 + len) };
    }
    off += 8 + len + (len % 2); // チャンクは偶数境界
  }
  return undefined;
}

/** ファイル内容から形式を判定し、vocab を抽出する */
export function analyzeStory(data: Uint8Array, filename = ''): StoryInfo {
  let format: StoryFormat;
  let exec = data;

  if (ascii(data, 0, 4) === 'FORM' && ascii(data, 8, 4) === 'IFRS') {
    const found = extractBlorbExec(data);
    if (found === undefined) throw new Error('Blorb に実行チャンク (ZCOD/GLUL) がありません');
    format = found.type === 'ZCOD' ? 'zcode' : 'glulx';
    exec = found.chunk;
  } else if (ascii(data, 0, 4) === 'Glul') {
    format = 'glulx';
  } else if (data[0]! >= 1 && data[0]! <= 8) {
    format = 'zcode';
  } else {
    throw new Error(`対応していないファイル形式です: ${filename || '(不明)'}`);
  }

  const info: StoryInfo = {
    format,
    data,
    exec,
    vocab: { dictWords: [], objectNames: [] },
  };
  if (format === 'zcode') {
    info.zVersion = exec[0]!;
    try {
      info.vocab = {
        dictWords: extractDictionary(exec).words,
        objectNames: objectNames(exec),
      };
    } catch (err) {
      // vocab 抽出失敗は致命ではない (辞書なしで続行 — フィルタは候補素通しで機能)
      info.vocabError = String(err);
    }
  }
  // Glulx の語彙抽出は 2b (ヒューリスティック辞書) — 今は辞書なしモード
  return info;
}

/** SaveStore のキー等に使うゲーム識別子 (SHA-256 + 形式) */
export async function storyId(info: StoryInfo): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', info.data.slice().buffer as ArrayBuffer);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${info.format}-${hex.slice(0, 16)}`;
}
