/**
 * 会話/選択メニューの汎用検出。
 *
 * ゲームによりメニュー形式は多様なため、出力テキストから構造を検出して
 * MenuSpec に正規化する。対応形式 (実機採取に基づく):
 *
 * 1. numbered — PunyInform talk menu (ghosts.z5, 実機採取 2026-06-06):
 *      Talk to Rosie about:
 *        1: Preparations
 *        2: Cora
 *      [ENTER] End conversation
 *    engine 上は `>` なしの query として届く。空行 (ENTER) で会話終了。
 *
 * 2. lettered — ZIL 自作メニュー (darkpit.z3, 実機採取 2026-06-06):
 *      Ask the old man about:
 *        A. Himself
 *        B. The guard
 *        D. End conversation
 *      >
 *    通常の `>` プロンプト (kind=turn) で 1 文字 (大小可) を待つ。
 *    「End conversation」は選択肢の 1 つ (ENTER では終われない)。
 *
 * 新形式はここに検出器を足す (detectMenu が順に試す)。
 *
 * このファイルは環境非依存 (Node API import 禁止)。
 */

export interface MenuChoice {
  /** ゲームに送る選択キー ("1".. / "A"..) */
  key: string;
  label: string;
}

export interface MenuSpec {
  kind: 'numbered' | 'lettered';
  choices: MenuChoice[];
  /** 空行 (ENTER) で会話を終えられる形式か */
  enterEnds: boolean;
  /** 「会話を終える」に相当する選択肢のキー (あれば) */
  endKey?: string;
}

/** PunyInform 形式のメニュー末尾マーカー */
export const TALK_MENU_RE = /\[ENTER\] End conversation/;

const END_LABEL_RE = /\b(end|leave|stop|goodbye|farewell)\b.*\b(conversation|talk(ing)?)\b|^end$|さようなら/i;

function detectNumbered(body: string): MenuSpec | undefined {
  if (!TALK_MENU_RE.test(body)) return undefined;
  const choices: MenuChoice[] = [];
  for (const line of body.split('\n')) {
    const m = /^\s{0,8}(\d{1,2}):\s+(\S.*)$/.exec(line);
    if (m) choices.push({ key: m[1]!, label: m[2]!.trim() });
  }
  if (choices.length === 0) return undefined;
  return { kind: 'numbered', choices, enterEnds: true };
}

function detectLettered(body: string): MenuSpec | undefined {
  // 行頭 (字下げ可) の "A. label" / "A) label" を走査し、
  // A から始まる連続した最後のブロックを採用する (応答+再表示メニューの混在対策)
  const lines = body.split('\n');
  let current: MenuChoice[] = [];
  let lastComplete: MenuChoice[] | undefined;
  for (const line of lines) {
    const m = /^\s{0,8}([A-Z])[.)]\s+(\S.*)$/.exec(line);
    if (m) {
      const expected = String.fromCharCode(65 + current.length); // A, B, C...
      if (m[1] === 'A') {
        current = [{ key: 'A', label: m[2]!.trim() }];
      } else if (m[1] === expected) {
        current.push({ key: m[1]!, label: m[2]!.trim() });
      } else {
        current = [];
      }
      if (current.length >= 2) lastComplete = [...current];
    } else if (line.trim() !== '') {
      current = []; // 非選択肢行でブロックが途切れる
    }
  }
  if (lastComplete === undefined) return undefined; // 1 行だけの "A. ..." は箇条書きとみなす
  const end = lastComplete.find((c) => END_LABEL_RE.test(c.label));
  const spec: MenuSpec = { kind: 'lettered', choices: lastComplete, enterEnds: false };
  if (end !== undefined) spec.endKey = end.key;
  return spec;
}

/** 出力本文からメニューを検出する。なければ undefined */
export function detectMenu(body: string): MenuSpec | undefined {
  return detectNumbered(body) ?? detectLettered(body);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 出口翻訳済みテキストから各選択肢キーの和訳ラベルを対応付ける。
 * 翻訳でメニューが 1 行に畳まれることがある (実機: 「会話：1: コーラ 2: 休暇 3: 吹雪」)
 * ため、キーを**出現順に**走査し、次のキーまたは行末までをラベルとする。
 * 見つからないキーは原文ラベルのまま (フォールバック)。
 */
export function translateMenuLabels(spec: MenuSpec, translatedText: string): MenuChoice[] {
  // 各キーの出現位置を順序付きで探す
  const hits: { choice: MenuChoice; labelStart: number }[] = [];
  let cursor = 0;
  for (const choice of spec.choices) {
    const re = new RegExp(`(?:^|[\\s：:>（(])${escapeRe(choice.key)}\\s*[:.．：]\\s*`);
    const m = re.exec(translatedText.slice(cursor));
    if (m === null) continue;
    const labelStart = cursor + m.index + m[0].length;
    hits.push({ choice, labelStart });
    cursor = labelStart;
  }
  const labelOf = new Map<string, string>();
  for (let i = 0; i < hits.length; i++) {
    const { choice, labelStart } = hits[i]!;
    const nextStart = i + 1 < hits.length ? hits[i + 1]!.labelStart : translatedText.length;
    // 次キーの "X:" プレフィックス部分や行末より手前で切る
    let segment = translatedText.slice(labelStart, nextStart);
    const newline = segment.indexOf('\n');
    if (newline >= 0) segment = segment.slice(0, newline);
    // "[Enter] 会話を終える" 等の角括弧マーカー以降は除去 (1 行畳み翻訳対策)
    segment = segment.replace(/[\[［].*$/, '');
    // 次キーの先頭 ("2:" の "2" の直前空白) を除去
    segment = segment.replace(/[\s（(]*[0-9A-Za-z]\s*[:.．：]\s*$/, '');
    const label = segment.trim();
    if (label !== '') labelOf.set(choice.key, label);
  }
  return spec.choices.map((c) => ({ key: c.key, label: labelOf.get(c.key) ?? c.label }));
}

/** ユーザーの生入力をメニュー選択キーに解決する (キー直接入力のみ。日本語は LLM 側) */
export function resolveMenuKey(spec: MenuSpec, raw: string): string | undefined {
  const token = raw.trim().toUpperCase();
  if (token === '') return spec.enterEnds ? '' : spec.endKey;
  const hit = spec.choices.find((c) => c.key.toUpperCase() === token);
  return hit?.key;
}
