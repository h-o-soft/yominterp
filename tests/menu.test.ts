import { describe, expect, it } from 'vitest';
import { detectMenu, resolveMenuKey, splitMenuBlock } from '../src/core/menu.js';

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

describe('splitMenuBlock (メニューと地の文の分離)', () => {
  it('ghosts 形式: ヘッダ・選択肢・[ENTER]・罫線を除き、台詞だけ残る', () => {
    const body =
      'Talk to Cora about:\n' +
      '1: Shopping\n' +
      '[ENTER] End conversation\n' +
      '----------------------------------------------------------------------------------------------------\n' +
      '\n' +
      'You: "How was town?"\n' +
      'Cora: "Lovely, dear."';
    const spec = detectMenu(body)!;
    const { narrative, headerLine } = splitMenuBlock(body, spec);
    expect(headerLine).toBe('Talk to Cora about:');
    expect(narrative).toBe('You: "How was town?"\nCora: "Lovely, dear."');
  });

  it('darkpit 形式: 前置きの地の文が残り、ヘッダを検出する', () => {
    const spec = detectMenu(LETTERED)!;
    const { narrative, headerLine } = splitMenuBlock(LETTERED, spec);
    expect(headerLine).toBe('Ask the old man about:');
    expect(narrative).toBe(
      'The old man lifts his head. His beard is white with dust and his eyes gleam in the gloom.',
    );
  });

  it('メニューのみの本文では narrative が空になる', () => {
    const spec = detectMenu(NUMBERED)!;
    const { narrative, headerLine } = splitMenuBlock(NUMBERED, spec);
    expect(headerLine).toBe('Talk to Rosie about:');
    expect(narrative).toBe('');
  });

  it('ヘッダが無い場合も選択肢行だけ除去される', () => {
    const body = 'Some narration.\n\n1: Shopping\n\n[ENTER] End conversation';
    const spec = detectMenu(body)!;
    const { narrative, headerLine } = splitMenuBlock(body, spec);
    expect(headerLine).toBeUndefined();
    expect(narrative).toBe('Some narration.');
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
