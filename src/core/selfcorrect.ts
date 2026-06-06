/**
 * パーサ応答の分類 (自己修正ループの判定材料)。
 *
 * パターンは実機採取 (ghosts.z5 / PunyInform v5.5.2, 2026-06-06) ＋
 * Inform/PunyInform 標準メッセージ。設定で拡張可能。
 *
 * 注意: 自己修正が直せるのは「パーサに拒否された」コマンドのみ。
 * パーサを通過した「有効だが意図と違うコマンド」(誤対象の open 等) は
 * ここでは検知できない。CLI は送信コマンドを常時表示し、/undo を提供する。
 * 検証では fail-accepted-wrong として独立計測する。
 *
 * このファイルは環境非依存 (Node API import 禁止)。
 */

/** パーサがコマンドを拒否した (世界状態は変化していない) */
export const PARSER_ERROR_RES: RegExp[] = [
  // ghosts.z5 (PunyInform カスタム) — 実機採取
  /That's an unknown verb/i,
  /You don't see anything like that/i,
  /You probably wanted to say/i,
  /I can't see who you are referring to/i,
  /You won't get very far without input/i,
  // Inform / PunyInform 標準
  /^(I |That's )?(don'?t|didn'?t) (know|understand)/im,
  /You can'?t see any such thing/i,
  /That'?s not a verb I recognise/i,
  /not something you need to refer to/i,
  /I only understood you as far as/i,
  /You can'?t use multiple objects/i,
  /That sentence isn'?t one I recognise/i,
  /There seems to be a noun missing/i,
  /wasn'?t enough of that sentence/i,
];

/** 曖昧解決の問い返し (エラーではなく追加 1 ターンで対象を答える) */
export const CLARIFY_RES: RegExp[] = [
  /What do you want to[\s\S]{0,60}\?/i,
  /Wh(?:o|om) do you (?:want|mean)[\s\S]{0,60}\?/i,
  /Which do you mean/i,
];

export type ParserCheck =
  | { type: 'ok' }
  | { type: 'error'; message: string }
  | { type: 'clarify'; question: string };

export function classifyParserResponse(
  body: string,
  extraErrorRes: RegExp[] = [],
): ParserCheck {
  for (const re of CLARIFY_RES) {
    const m = re.exec(body);
    if (m) return { type: 'clarify', question: m[0] };
  }
  for (const re of [...PARSER_ERROR_RES, ...extraErrorRes]) {
    if (re.test(body)) return { type: 'error', message: body.trim() };
  }
  return { type: 'ok' };
}
