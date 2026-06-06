/**
 * Z-machine インタプリタ抽象。
 * 段階1 では dfrotz 子プロセス (src/cli/dfrotz.ts) が実装し、
 * 段階2 では ifvms.js/emglken 実装に差し替える。
 *
 * このファイルは環境非依存 (Node API import 禁止)。
 */

export type OutputKind = 'turn' | 'query' | 'gameover';

export interface EngineOutput {
  /** 受信した生テキスト (プロンプト記号含む) */
  raw: string;
  /** ステータス行・プロンプト記号を除いた本文 */
  body: string;
  /** 検出できたステータス行 (部屋名/Score/Moves)。最後に観測したもの */
  statusLine?: string;
  /** 通常ターン / yes-no 等の中間入力待ち / ゲーム終了 */
  kind: OutputKind;
  /**
   * 入力要求の種別 (分かる場合のみ)。Glk 系エンジンはプロトコルから正確に判別できる。
   * 'line' = 行入力 (通常コマンド) / 'char' = 1 キー入力 (pause・メニュー等)。
   * dfrotz エンジンは設定しない (kind からの推測のみ)。
   */
  request?: 'line' | 'char';
  /**
   * 装飾付きの構造化テキスト (分かるエンジンのみ。Glk 系はプロトコルが運ぶ)。
   * body と同じ内容の装飾版で、表示専用 — 翻訳・比較・メニュー検出は従来どおり
   * body (プレーン) を使う。dfrotz エンジンは設定しない。
   */
  rich?: StyledBlock[];
  /** ステータス行の装飾 (ゲーム指定の色/反転。例: ghosts は赤の反転バー) */
  statusStyle?: SpanStyle;
}

/** スパンの解決済み装飾 (Style_* マップ + css_styles を合成したもの) */
export interface SpanStyle {
  bold?: boolean;
  italic?: boolean;
  monospace?: boolean;
  reverse?: boolean;
  /** CSS color 値 (例: '#EF0000') */
  fg?: string;
  bg?: string;
  /** Glk スタイル名 (subheader/emphasized/input 等。CSS クラス付与用) */
  styleName?: string;
}

export interface StyledSpan {
  text: string;
  style?: SpanStyle;
}

export interface StyledLine {
  spans: StyledSpan[];
}

/**
 * 表示ブロック。
 * - 'grid': 上部ウィンドウ由来 (quote box 等)。固定ピッチ・桁/空白をそのまま保持
 * - 'para': buffer 由来の段落 (1 行 = 1 段落)
 */
export interface StyledBlock {
  kind: 'grid' | 'para';
  lines: StyledLine[];
}

/** 行内の全スパンが同一装飾ならそれを返す (段落一様装飾の判定用) */
export function uniformStyle(lines: StyledLine[]): SpanStyle | undefined {
  let found: SpanStyle | undefined;
  for (const line of lines) {
    for (const span of line.spans) {
      if (span.text.trim() === '') continue; // 空白のみのスパンは装飾判定から除外
      const s = span.style ?? {};
      if (found === undefined) {
        found = s;
      } else if (JSON.stringify(found) !== JSON.stringify(s)) {
        return undefined;
      }
    }
  }
  // 無装飾 ({} のみ) は undefined に正規化
  return found !== undefined && Object.keys(found).length > 0 ? found : undefined;
}

export interface ZEngine {
  /** 起動〜最初のプロンプトまでの出力を返す */
  start(): Promise<EngineOutput>;
  /** 1 コマンド送信→次の入力待ちまでの出力を返す */
  send(command: string): Promise<EngineOutput>;
  stop(): Promise<void>;
  readonly alive: boolean;
}

/**
 * dfrotz dumb モードのステータス行 (実機採取 2026-06-06, frotz 2.55):
 *   ` Great Hall                                ... Score: 0     Moves: 0`
 * 部屋名 + 2 個以上の空白 + Score: n + Moves: n
 */
export const STATUS_LINE_RE = /^ *(\S.*?) {2,}Score: *(-?\d+) +Moves: *(\d+) *$/;

export interface StatusInfo {
  room: string;
  score: number;
  moves: number;
}

export function parseStatusLine(line: string): StatusInfo | undefined {
  const m = STATUS_LINE_RE.exec(line);
  if (!m) return undefined;
  return { room: m[1]!.trim(), score: Number(m[2]), moves: Number(m[3]) };
}

/**
 * 受信生テキストから「本文」と「最後のステータス行」を分離する。
 * - ステータス行 (複数あれば最後を採用) を除去
 * - 末尾のプロンプト記号 `>` を除去
 * - 先頭/末尾の空行を除去
 */
export function splitRawOutput(raw: string): { body: string; statusLine?: string } {
  let text = raw;
  // 末尾のプロンプト (`\n>` または `> `) を除去
  text = text.replace(/\n?> ?$/, '');
  const lines = text.split('\n');
  let statusLine: string | undefined;
  const kept: string[] = [];
  for (const line of lines) {
    if (STATUS_LINE_RE.test(line)) {
      statusLine = line.trim();
      continue;
    }
    kept.push(line);
  }
  // 先頭・末尾の空行をトリム
  while (kept.length > 0 && kept[0]!.trim() === '') kept.shift();
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === '') kept.pop();
  // ステータス行除去で生じた連続空行を 1 つに潰す
  const body = kept.join('\n').replace(/\n{3,}/g, '\n\n');
  const result: { body: string; statusLine?: string } = { body };
  if (statusLine !== undefined) result.statusLine = statusLine;
  return result;
}

/**
 * ゲーム終了の検出 (PunyInform / Inform 標準)。
 * `*** You have died ***` 型バナー、RESTART/RESTORE 問い合わせ等。
 */
export const GAMEOVER_RES: RegExp[] = [
  /\*\*\*[^*]+\*\*\*/,
  /Would you like to RESTART/i,
  /RESTART, RESTORE/i,
];

export function looksGameOver(body: string): boolean {
  return GAMEOVER_RES.some((re) => re.test(body));
}
