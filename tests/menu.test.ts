import { describe, expect, it } from 'vitest';
import { detectMenu, resolveMenuKey, translateMenuLabels } from '../src/core/menu.js';

/** ghosts.z5 (PunyInform) 実機採取の番号式メニュー */
const NUMBERED =
  'Talk to Rosie about:\n' +
  '  1: Preparations\n' +
  '  2: Cora\n' +
  '  3: Snowstorm\n' +
  '\n' +
  '[ENTER] End conversation\n' +
  '\n' +
  '----------------------------------------------------------------------------------------------------';

/** darkpit.z3 (ZIL) 実機採取の文字式メニュー */
const LETTERED =
  'The old man lifts his head. His beard is white with dust and his eyes gleam in the gloom.\n' +
  '\n' +
  'Ask the old man about:\n' +
  '  A. Himself\n' +
  '  B. The guard\n' +
  '  C. The deep places\n' +
  '  D. End conversation';

describe('detectMenu', () => {
  it('PunyInform 番号式: choices と ENTER 終了を検出する', () => {
    const spec = detectMenu(NUMBERED);
    expect(spec).toBeDefined();
    expect(spec!.kind).toBe('numbered');
    expect(spec!.enterEnds).toBe(true);
    expect(spec!.choices.map((c) => `${c.key}:${c.label}`)).toEqual([
      '1:Preparations',
      '2:Cora',
      '3:Snowstorm',
    ]);
  });

  it('ZIL 文字式: A-D の choices と End conversation キーを検出する', () => {
    const spec = detectMenu(LETTERED);
    expect(spec).toBeDefined();
    expect(spec!.kind).toBe('lettered');
    expect(spec!.enterEnds).toBe(false);
    expect(spec!.endKey).toBe('D');
    expect(spec!.choices.map((c) => c.key)).toEqual(['A', 'B', 'C', 'D']);
    expect(spec!.choices[0]!.label).toBe('Himself');
  });

  it('応答 + 再表示メニューの混在では最後のブロックを採用する', () => {
    const body =
      'A. an old list in prose\nB. another item\n\n' + // 前半に紛らわしい列挙
      '"Find steel," he rasps.\n\n' +
      'Ask the old man about:\n  A. Himself\n  B. The guard\n  C. End conversation';
    const spec = detectMenu(body);
    expect(spec).toBeDefined();
    expect(spec!.choices.map((c) => c.key)).toEqual(['A', 'B', 'C']);
    expect(spec!.endKey).toBe('C');
  });

  it('単独の "A. ..." 行 (箇条書き 1 行) はメニューとみなさない', () => {
    expect(detectMenu('A. single item in some prose.')).toBeUndefined();
  });

  it('A から始まらない・連続しない文字列挙はメニューとみなさない', () => {
    expect(detectMenu('B. first\nC. second')).toBeUndefined();
    expect(detectMenu('A. first\nC. third')).toBeUndefined();
  });

  it('通常の本文・パーサエラーはメニューとみなさない', () => {
    expect(detectMenu('You take the lamp. It glows softly.')).toBeUndefined();
    expect(detectMenu('Choose A, B, C, or D.')).toBeUndefined();
  });
});

describe('translateMenuLabels (和訳本文からのラベル対応付け)', () => {
  const numbered = detectMenu(NUMBERED)!;
  const lettered = detectMenu(LETTERED)!;

  it('1 行に畳まれた和訳メニューからラベルを取り出す (実機形式)', () => {
    const ja = 'ロージーとの会話：1: コーラ 2: 休暇 3: 吹雪\n\n[Enter] 会話を終える';
    const labels = translateMenuLabels(numbered, ja);
    expect(labels.map((c) => `${c.key}:${c.label}`)).toEqual([
      '1:コーラ',
      '2:休暇',
      '3:吹雪',
    ]);
  });

  it('行分かれの和訳 (文字式) でも対応付けられる', () => {
    const ja =
      '老人に尋ねる：\nA. 彼自身について\nB. 衛兵について\nC. 深い場所について\nD. 会話を終える';
    const labels = translateMenuLabels(lettered, ja);
    expect(labels.map((c) => c.label)).toEqual([
      '彼自身について',
      '衛兵について',
      '深い場所について',
      '会話を終える',
    ]);
  });

  it('単一トピック+[Enter]マーカーが 1 行に畳まれてもラベルに混入しない (実機形式)', () => {
    const single = detectMenu('Talk to Rosie about:\n  1: Preparations\n\n[ENTER] End conversation')!;
    const ja = 'ロージーに話しかける：1: 準備について [Enter] 会話を終える';
    const labels = translateMenuLabels(single, ja);
    expect(labels[0]!.label).toBe('準備について');
  });

  it('和訳に現れないキーは原文ラベルにフォールバックする', () => {
    const ja = '会話：1: コーラ'; // 2, 3 が翻訳に現れなかったケース
    const labels = translateMenuLabels(numbered, ja);
    expect(labels[0]!.label).toBe('コーラ');
    expect(labels[1]!.label).toBe('Cora'); // 原文フォールバック
    expect(labels[2]!.label).toBe('Snowstorm');
  });

  it('台詞の後にメニューが来る和訳でも誤マッチしない (キーは出現順)', () => {
    const ja =
      'あなた：「準備は順調？」\nロージー：「ええ」\n\n老人に尋ねる：A. 彼自身 B. 衛兵 C. 深い場所 D. 会話を終える';
    const labels = translateMenuLabels(lettered, ja);
    expect(labels.map((c) => c.label)).toEqual(['彼自身', '衛兵', '深い場所', '会話を終える']);
  });
});

describe('resolveMenuKey', () => {
  const numbered = detectMenu(NUMBERED)!;
  const lettered = detectMenu(LETTERED)!;

  it('キー直接入力 (大文字小文字無視) を解決する', () => {
    expect(resolveMenuKey(numbered, '2')).toBe('2');
    expect(resolveMenuKey(lettered, 'a')).toBe('A');
    expect(resolveMenuKey(lettered, 'D')).toBe('D');
  });

  it('存在しないキーは undefined', () => {
    expect(resolveMenuKey(numbered, '9')).toBeUndefined();
    expect(resolveMenuKey(lettered, 'E')).toBeUndefined();
  });

  it('空入力: ENTER 終了形式は ""、文字式は endKey に解決する', () => {
    expect(resolveMenuKey(numbered, '')).toBe('');
    expect(resolveMenuKey(lettered, '')).toBe('D');
  });
});
