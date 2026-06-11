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

  it('Pager: 実測フック (PageMeasure) があれば推定カウンタでなく実測行数で判定する', async () => {
    const { Pager } = await import('../src/web/ui/render.js');
    // 実 DOM の使用行数をシミュレート: バー・echo 行など「カウンタに乗らない行」を
    // 含む実測値が判定に使われることを確認する (推定と実描画のドリフトの根本対策)
    let domLines = 0;
    let pageStart = 0;
    let waits = 0;
    const pager = new Pager(
      async () => {
        waits++;
        domLines = 0; // [More] のページクリア
      },
      10,
      {
        markPageStart: () => void (pageStart = domLines),
        usedLines: () => domLines - pageStart,
      },
    );
    // echo 行 2 行が「beforeAppend を通らず」DOM に直接乗った (推定カウンタは知らない)
    domLines += 2;
    await pager.beforeAppend(7); // 実測 2 + 7 = 9 ≤ 10 → 待たない
    domLines += 7;
    expect(waits).toBe(0);
    await pager.beforeAppend(2); // 実測 9 + 2 = 11 > 10 → 待つ (カウンタなら 9 で素通りしていた)
    domLines += 2;
    expect(waits).toBe(1);
  });

  it('Pager: grid 置換等で実 DOM が減ったら実測に従い [More] を出さない (HELP 混入の根治)', async () => {
    const { Pager } = await import('../src/web/ui/render.js');
    let domLines = 0;
    let pageStart = 0;
    let waits = 0;
    const pager = new Pager(
      async () => {
        waits++;
        domLines = 0;
      },
      10,
      {
        markPageStart: () => void (pageStart = domLines),
        usedLines: () => domLines - pageStart,
      },
    );
    // grid メニュー 7 行の表示 → 置換を繰り返す。実際の描画順 (renderRichOutput) は
    // 「旧 gridbox を DOM から削除 → pageGate → 新 grid を表示」なので、ゲート時点の
    // 実測は置換後の行数になる — 実測は累積しない
    for (let i = 0; i < 5; i++) {
      domLines -= domLines; // 置換: 前の grid は描画前に DOM から消える
      await pager.beforeAppend(7);
      domLines += 7; // 新しい grid 7 行
    }
    expect(waits).toBe(0); // 加算カウンタだと 35 行扱いで [More] が混入していた
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
 * 回帰防止: クラシック端末専用 (単一表示モデル) の契約。
 * モダンモードは廃止済み — 表示モードの分岐 (settings.classicMode) が
 * コードに復活しないことをソース文字列で固定する軽量ガード。実挙動は e2e で確認。
 */
import { readFileSync } from 'node:fs';
describe('クラシック専用 (単一表示モデル) 契約', () => {
  const main = readFileSync('src/web/main.ts', 'utf8');
  it('表示モード分岐 (settings.classicMode) が存在しない', () => {
    expect(main).not.toContain('classicMode');
    expect(main).not.toContain('btn-layout');
    const settings = readFileSync('src/web/settings.ts', 'utf8');
    expect(settings).not.toContain('classicMode');
  });
  it('keypress 待ち (resolveKeypresses) はキー待ちバーを出し、押下キーを VM へ送る', () => {
    // 冒頭引用画面・HELP 等の keypress 待ちは共通の resolveKeypresses が処理する。
    const fn = main.slice(main.indexOf('function resolveKeypresses'), main.indexOf('function resolveKeypresses') + 1600);
    expect(fn).toContain("waitForKey(tr('keyWaitBar'))");
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

describe('char 画面も含め常に wrap + ページングする契約 (縦横の溢れ防止)', () => {
  // anchorhead 冒頭の prologue (34 表示行の char query 画面) が paged=false で
  // ページャをバイパスし、縦に溢れて冒頭がスクロールアウトしていた回帰の防止。
  // 本文描画は常に splitForPaging (wrapToLines で物理行確定) + pageGate。
  const main = readFileSync('src/web/main.ts', 'utf8');
  it('renderGameText は常に splitForPaging + ページゲートを通す', () => {
    const fn = main.slice(main.indexOf('async function renderGameText'), main.indexOf('async function renderGameText') + 900);
    expect(fn).toContain('splitForPaging(ja, CLASSIC_COLS'); // 物理行確定 + ページ分割
    expect(fn).toContain('await pageGate(chunk)');
    expect(fn).not.toContain('paged'); // char 画面を例外にするフラグは廃止
  });
  it('printBodyParagraphs も常に splitForPaging する', () => {
    const fn = main.slice(main.indexOf('async function printBodyParagraphs'), main.indexOf('async function printBodyParagraphs') + 1600);
    expect(fn).toContain('splitForPaging(ja, CLASSIC_COLS');
    expect(fn).not.toContain('paged = '); // ページング例外フラグなし
  });
  it('resolveKeypresses (char 画面) もページングされた描画を使う', () => {
    const fn = main.slice(main.indexOf('async function resolveKeypresses'), main.indexOf('async function resolveKeypresses') + 1400);
    expect(fn).toContain('renderRichOutput(cur)');
    expect(fn).not.toContain('renderRichOutput(cur, false)');
  });
  it('ページャは実描画計測 (PageMeasure) を注入して生成される', () => {
    expect(main).toContain('markPageStart');
    expect(main).toContain('usedLines');
    expect(main).toContain('contentBottomPx');
  });
});
