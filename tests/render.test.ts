import { describe, expect, it } from 'vitest';
import {
  gridPlainText,
  paraGroups,
  styleToCss,
  styleTranslatedParagraphs,
} from '../src/web/ui/render.js';

describe('styleToCss', () => {
  it('bold/italic/styleName はクラス、色はインライン', () => {
    const v = styleToCss({ bold: true, styleName: 'subheader', fg: '#EF0000' });
    expect(v.classes).toEqual(['s-bold', 's-subheader']);
    expect(v.inline).toBe('color: #EF0000');
  });

  it('reverse は前景/背景を入れ替える (色未指定は端末既定色)', () => {
    expect(styleToCss({ reverse: true, fg: '#FFFFFF', bg: '#000000' }).inline).toBe(
      'color: #000000; background-color: #FFFFFF',
    );
    expect(styleToCss({ reverse: true }).inline).toBe(
      'color: var(--bg); background-color: var(--fg)',
    );
  });

  it('undefined は空', () => {
    expect(styleToCss(undefined)).toEqual({ classes: [], inline: '' });
  });
});

describe('paraGroups / styleTranslatedParagraphs (Lv1)', () => {
  const sub = { styleName: 'subheader', bold: true };
  const lines = [
    { spans: [{ text: 'Great Hall', style: sub }] },
    { spans: [{ text: '' }] },
    { spans: [{ text: 'Flames dance.' }] },
    { spans: [{ text: 'Wood crackles.' }] },
  ];

  it('空行区切りで段落グループ化し、一様装飾を得る', () => {
    const groups = paraGroups(lines);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ text: 'Great Hall', style: sub });
    expect(groups[1]!.style).toBeUndefined(); // 装飾なし段落
  });

  it('段落数一致 → 1:1 で訳文段落に装飾を対応付ける', () => {
    const out = styleTranslatedParagraphs('大広間\n\n炎が踊り、薪が爆ぜる。', lines);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ text: '大広間', style: sub });
    expect(out[1]!.style).toBeUndefined();
  });

  it('段落数不一致 → 全体一様の時だけ全段落に適用', () => {
    const allRed = [
      { spans: [{ text: 'line A', style: { fg: '#F00' } }] },
      { spans: [{ text: 'line B', style: { fg: '#F00' } }] },
    ];
    const out = styleTranslatedParagraphs('一段目\n\n二段目\n\n三段目', allRed);
    expect(out.every((p) => p.style?.fg === '#F00')).toBe(true);
    // 混在装飾で不一致 (先頭が見出しでもない) なら装飾なし
    const mixedLines = [
      { spans: [{ text: 'plain intro line' }] },
      { spans: [{ text: '' }] },
      { spans: [{ text: 'alert text', style: { bold: true } }] },
    ];
    const mixed = styleTranslatedParagraphs('一段目\n\n二段目\n\n三段目', mixedLines);
    expect(mixed.every((p) => p.style === undefined)).toBe(true);
  });
});

describe('gridPlainText', () => {
  it('桁空白を trim して翻訳入力用テキストに', () => {
    expect(
      gridPlainText({
        kind: 'grid',
        lines: [
          { spans: [{ text: '   ' }, { text: ' How you have fallen ' }, { text: '   ' }] },
          { spans: [{ text: '      ' }] },
          { spans: [{ text: '  -- Isaiah 14:12  ' }] },
        ],
      }),
    ).toBe('How you have fallen\n-- Isaiah 14:12');
  });
});

describe('styleTranslatedParagraphs: 見出し分離ヒューリスティック', () => {
  it('部屋名+本文が単一改行で繋がった訳文でも見出しに装飾が付く', () => {
    const sub = { styleName: 'subheader', bold: true };
    const original = [
      { spans: [{ text: 'Great Hall', style: sub }] },
      { spans: [{ text: '' }] },
      { spans: [{ text: 'Flames dance.' }] },
    ];
    const out = styleTranslatedParagraphs('大広間\n炎が踊っている。', original);
    expect(out[0]).toMatchObject({ text: '大広間', style: sub });
    expect(out[1]).toMatchObject({ text: '炎が踊っている。' });
    expect(out[1]!.style).toBeUndefined();
  });
});

describe('wrapLine / estimateLines (折返しカウント)', () => {
  it('wrapLine: 空白境界で折り返す (英単語を途中で割らない)', async () => {
    const { wrapLine } = await import('../src/web/ui/render.js');
    // "aaaa bbbb cccc" を 10 桁で → "aaaa bbbb" / "cccc"
    expect(wrapLine('aaaa bbbb cccc', 10)).toEqual(['aaaa bbbb', 'cccc']);
    // 行頭の空白は折返し後に捨てる
    expect(wrapLine('aaaaaaaa bbbbbbbb', 10)).toEqual(['aaaaaaaa', 'bbbbbbbb']);
  });

  it('wrapLine: 1 トークンが cols 超なら文字単位で割る', async () => {
    const { wrapLine } = await import('../src/web/ui/render.js');
    expect(wrapLine('x'.repeat(25), 10)).toEqual(['xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxx']);
  });

  it('wrapLine: 全角は 2 桁幅で折り返す', async () => {
    const { wrapLine } = await import('../src/web/ui/render.js');
    // 全角 6 文字 = 幅 12 を 8 桁で → 4 文字(幅8) / 2 文字
    expect(wrapLine('あいうえおか', 8)).toEqual(['あいうえ', 'おか']);
  });

  it('estimateLines: 改行コードだけでなく wrap 分も +1 で数える', async () => {
    const { estimateLines } = await import('../src/web/ui/render.js');
    expect(estimateLines('short')).toBe(1);
    expect(estimateLines('a\nb\nc')).toBe(3); // 改行 3 行
    expect(estimateLines('x'.repeat(170), 80)).toBe(3); // wrap で 3 行 (170/80)
    expect(estimateLines('あ'.repeat(50), 80)).toBe(2); // 全角 50 = 幅 100 → 2 行
    // 改行 + wrap の複合: 1 行目が wrap して 2 行 + 2 行目 1 行 = 3
    expect(estimateLines('x'.repeat(120) + '\nshort', 80)).toBe(3);
  });

  it('estimateLines のデフォルト cols は 80 (クラシック定義)', async () => {
    const { estimateLines, CLASSIC_COLS } = await import('../src/web/ui/render.js');
    expect(CLASSIC_COLS).toBe(80);
    expect(estimateLines('x'.repeat(81))).toBe(2); // デフォルト 80 桁で折返し
  });

  it('Pager: 1 ページを超える直前に waitFn を呼び、リセット後は呼ばない', async () => {
    const { Pager } = await import('../src/web/ui/render.js');
    let waits = 0;
    const pager = new Pager(async () => void waits++, 10);
    await pager.beforeAppend(6); // 6/10
    expect(waits).toBe(0);
    await pager.beforeAppend(6); // 超える → 待つ → 6/10
    expect(waits).toBe(1);
    await pager.beforeAppend(3); // 9/10
    expect(waits).toBe(1);
    pager.reset();
    await pager.beforeAppend(9); // リセット後の最初は待たない
    expect(waits).toBe(1);
  });

  it('Pager: 先頭ブロックが 1 ページ超でも待たずに表示する (空画面で止めない)', async () => {
    const { Pager } = await import('../src/web/ui/render.js');
    let waits = 0;
    const pager = new Pager(async () => void waits++, 10);
    await pager.beforeAppend(25);
    expect(waits).toBe(0);
  });
});

describe('splitForPaging (長段落のページ分割・wrap 込み)', () => {
  it('改行コードの行を maxLines ごとにチャンク化する', async () => {
    const { splitForPaging } = await import('../src/web/ui/render.js');
    const text = Array.from({ length: 25 }, (_, i) => `line${i}`).join('\n');
    const chunks = splitForPaging(text, 80, 10);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.split('\n')).toHaveLength(10);
    expect(chunks.join('\n')).toBe(text); // 内容は欠落しない
  });

  it('改行コードを含まない長い 1 段落も wrap 表示行で分割する (溢れ防止)', async () => {
    const { splitForPaging } = await import('../src/web/ui/render.js');
    // 全角 100 文字 = 幅 200 = 80 桁で 3 表示行 (80/80/40)。maxLines=2 → 2 チャンク
    const para = 'あ'.repeat(100);
    const chunks = splitForPaging(para, 80, 2);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.split('\n')).toHaveLength(2); // 2 表示行
    // 全文字が保たれる (欠落なし)
    expect(chunks.join('').replace(/\n/g, '')).toBe(para);
  });

  it('短い段落はそのまま 1 チャンク', async () => {
    const { splitForPaging } = await import('../src/web/ui/render.js');
    expect(splitForPaging('a b', 80, 10)).toEqual(['a b']);
  });
});

/**
 * 回帰防止: 冒頭キー待ち・画面クリアはモード非依存で honor する。
 * (Tauri で classicMode=false 保存時にキー待ちが素通りしていた件の回帰防止。
 *  ロジックは main.ts のループ条件 — ここでは「分岐が classicMode を見ない」契約を
 *  ソース文字列で固定する軽量ガード。実挙動は e2e で確認。)
 */
import { readFileSync } from 'node:fs';
describe('キー待ち/クリアのモード非依存契約', () => {
  const main = readFileSync('src/web/main.ts', 'utf8');
  it('honorClear は classicMode で分岐しない (両モードで実クリア)', () => {
    const fn = main.slice(main.indexOf('function honorClear'), main.indexOf('function honorClear') + 200);
    expect(fn).not.toContain('settings.classicMode');
  });
  it('keypress 待ち (resolveKeypresses) は classicMode 条件なしで waitForContinue を呼ぶ', () => {
    // 冒頭引用画面・HELP 等の keypress 待ちは共通の resolveKeypresses が処理する。
    const fn = main.slice(main.indexOf('function resolveKeypresses'), main.indexOf('function resolveKeypresses') + 700);
    expect(fn).toContain("waitForKey(tr('keyWaitBar'))");
    expect(fn).not.toMatch(/if \(settings\.classicMode\)\s*\{\s*await waitForKey/);
    // char 入力要求のときに、押されたキーをそのまま VM へ送る (HELP の Q 等)
    expect(fn).toContain("request === 'char'");
    expect(fn).toContain('engine.send(key)');
  });
});

describe('splitBlocks (改行・空行の完全保持)', () => {
  const L = (t: string) => ({ spans: [{ text: t }] });
  it('連続非空行を段落に、空行は1行ずつ個別ブロックにする', async () => {
    const { splitBlocks } = await import('../src/web/ui/render.js');
    // 段落 + 空行2つ + 段落 (ghosts のタイトル前演出)
    const blocks = splitBlocks([L('作家の行き詰まり。'), L(''), L(''), L('ブラックウッド邸の亡霊たち')]);
    expect(blocks.map((b) => b.blank)).toEqual([false, true, true, false]);
    // 空行2つが2ブロックとして保持される (集約されない)
    expect(blocks.filter((b) => b.blank)).toHaveLength(2);
    expect(blocks[0]!.lines.map((l) => l.spans[0]!.text)).toEqual(['作家の行き詰まり。']);
    expect(blocks[3]!.lines.map((l) => l.spans[0]!.text)).toEqual(['ブラックウッド邸の亡霊たち']);
  });
  it('複数行の段落は1ブロックにまとめる', async () => {
    const { splitBlocks } = await import('../src/web/ui/render.js');
    const blocks = splitBlocks([L('line A'), L('line B'), L(''), L('line C')]);
    expect(blocks.map((b) => b.blank)).toEqual([false, true, false]);
    expect(blocks[0]!.lines).toHaveLength(2);
  });
  it('空白のみの行も空行として扱う', async () => {
    const { splitBlocks } = await import('../src/web/ui/render.js');
    const blocks = splitBlocks([L('x'), L('   '), L('y')]);
    expect(blocks.map((b) => b.blank)).toEqual([false, true, false]);
  });
});

describe('クラシックは paged=false でも wrap する契約 (char 画面の横はみ出し防止)', () => {
  // anchorhead 冒頭の prologue が keypress 待ち(char query)経由で paged=false になり、
  // splitForPaging ごとスキップされて 80桁 wrap が当たらず横はみ出していた回帰の防止。
  // ページ送り([More])だけ paged で制御し、wrap はクラシックで常に行う。
  const main = readFileSync('src/web/main.ts', 'utf8');
  it('renderGameText は classic なら paged に依らず wrap する', () => {
    const fn = main.slice(main.indexOf('async function renderGameText'), main.indexOf('async function renderGameText') + 800);
    expect(fn).toContain('wrapToLines(ja, CLASSIC_COLS)'); // paged=false 時も wrap
    expect(fn).toContain('settings.classicMode');
  });
  it('printBodyParagraphs も classic なら paged に依らず wrap する', () => {
    const fn = main.slice(main.indexOf('async function printBodyParagraphs'), main.indexOf('async function printBodyParagraphs') + 1200);
    expect(fn).toContain('wrapToLines(ja, CLASSIC_COLS)');
  });
});
