import { describe, expect, it } from 'vitest';
import { GlkOteCapture } from '../src/web/engine/glkote-capture.js';
import { settledToOutput } from '../src/web/engine/emglken.js';

/** 合成 fixture (ゲーム本文を含まない・コミット可) で状態機械を検証する */

function makeCapture(): { cap: GlkOteCapture; sent: Record<string, unknown>[] } {
  const cap = new GlkOteCapture();
  const sent: Record<string, unknown>[] = [];
  void cap.init({ accept: (ev) => sent.push(ev) });
  return { cap, sent };
}

describe('GlkOteCapture (状態機械)', () => {
  it('init で init イベントを送る', () => {
    const { sent } = makeCapture();
    expect(sent[0]).toMatchObject({ type: 'init', gen: 0 });
  });

  it('buffer 段落の蓄積と append 結合、入力要求で settle する', async () => {
    const { cap } = makeCapture();
    const p = cap.waitSettle();
    cap.update({
      type: 'update',
      gen: 1,
      windows: [{ id: 2, type: 'buffer' }],
      content: [
        {
          id: 2,
          text: [
            { content: [{ text: 'Hello ' }] },
            { append: true, content: [{ text: 'world.' }] },
            { content: ['Second para.'] },
          ],
        },
      ],
      input: [{ id: 2, gen: 1, type: 'line' }],
    });
    const s = await p;
    expect(s.bufferLines).toEqual(['Hello world.', 'Second para.']);
    expect(s.input).toMatchObject({ id: 2, type: 'line' });
  });

  it('grid は行置き換え・clear で全消去・高さを windows から把握する', async () => {
    const { cap } = makeCapture();
    const p1 = cap.waitSettle();
    cap.update({
      type: 'update',
      gen: 1,
      windows: [{ id: 3, type: 'grid', gridheight: 12 }],
      content: [
        { id: 3, lines: [{ line: 0, content: [{ text: 'quote line A' }] }, { line: 2, content: [{ text: 'quote line B' }] }] },
      ],
      input: [{ id: 2, gen: 1, type: 'char' }],
    });
    const s1 = await p1;
    expect(s1.gridLines).toEqual(['quote line A', 'quote line B']);
    expect(s1.gridHeight).toBe(12);

    const p2 = cap.waitSettle();
    cap.update({
      type: 'update',
      gen: 2,
      windows: [{ id: 3, type: 'grid', gridheight: 1 }],
      content: [{ id: 3, clear: true, lines: [{ line: 0, content: [{ text: ' Hall  Score: 0  Moves: 1' }] }] }],
      input: [{ id: 2, gen: 2, type: 'line' }],
    });
    const s2 = await p2;
    expect(s2.gridLines).toEqual([' Hall  Score: 0  Moves: 1']);
    expect(s2.gridHeight).toBe(1);
  });

  it('grid 縮小 (clear なし) は現在の高さを超える残留行を捨てる', async () => {
    // ninetenths の画面崩れ: upper window をメニューで拡大 → 選択後に高さだけ縮小し
    // 各行をクリアしないゲームで、古いメニュー行が残留して本文に重なっていた。
    const { cap } = makeCapture();
    const p1 = cap.waitSettle();
    cap.update({
      type: 'update',
      gen: 1,
      windows: [{ id: 3, type: 'grid', gridheight: 7 }],
      content: [
        {
          id: 3,
          lines: [
            { line: 0, content: [{ text: ' Dark room  Score: 0' }] },
            { line: 2, content: [{ text: 'What do you do?' }] },
            { line: 3, content: [{ text: '1: open the door' }] },
            { line: 4, content: [{ text: '2: walk on' }] },
          ],
        },
      ],
      input: [{ id: 2, gen: 1, type: 'char' }],
    });
    const s1 = await p1;
    expect(s1.gridLines).toContain('1: open the door');

    // 選択後: clear を送らず gridheight を 1 に縮小するだけ
    const p2 = cap.waitSettle();
    cap.update({
      type: 'update',
      gen: 2,
      windows: [{ id: 3, type: 'grid', gridheight: 1 }],
      content: [{ id: 3, lines: [{ line: 0, content: [{ text: ' Hilltop  Score: 1' }] }] }],
      input: [{ id: 2, gen: 2, type: 'line' }],
    });
    const s2 = await p2;
    // 現在の高さ 1 で切り詰め → 残留メニュー行は出ない
    expect(s2.gridLines).toEqual([' Hilltop  Score: 1']);
    expect(s2.gridLines).not.toContain('1: open the door');
    expect(s2.gridHeight).toBe(1);
  });

  it('拡大 grid の中身が更新されないターンは gridFreshContent=false (残留連結を防ぐ)', async () => {
    // メニュー (line>0) を表示したターンは fresh=true、次に高さだけ残って中身が
    // 更新されない (ステータス line 0 のみ or 更新なし) ターンは fresh=false。
    const { cap } = makeCapture();
    const p1 = cap.waitSettle();
    cap.update({
      type: 'update',
      gen: 1,
      windows: [{ id: 3, type: 'grid', gridheight: 12 }],
      content: [
        {
          id: 3,
          lines: [
            { line: 0, content: [{ text: ' Stone corridor' }] },
            { line: 2, content: [{ text: 'What do you do?' }] },
            { line: 3, content: [{ text: '1: approach the door' }] },
          ],
        },
      ],
      input: [{ id: 2, gen: 1, type: 'char' }],
    });
    const s1 = await p1;
    expect(s1.gridFreshContent).toBe(true); // メニュー描画ターン

    // 次ターン: 高さは 12 のまま、ステータス行 (line 0) だけ更新 → 中身は古いまま
    const p2 = cap.waitSettle();
    cap.update({
      type: 'update',
      gen: 2,
      windows: [{ id: 3, type: 'grid', gridheight: 12 }],
      content: [{ id: 3, lines: [{ line: 0, content: [{ text: ' The Hilltop' }] }] }],
      input: [{ id: 2, gen: 2, type: 'line' }],
    });
    const s2 = await p2;
    expect(s2.gridFreshContent).toBe(false); // 古いメニューを連結しないための信号
  });

  it('specialinput で settle し、disable+入力なしで ended になる', async () => {
    const { cap } = makeCapture();
    const p = cap.waitSettle();
    cap.update({
      type: 'update',
      gen: 5,
      specialinput: { type: 'fileref_prompt', filemode: 'write', filetype: 'save' },
    });
    const s = await p;
    expect(s.special).toMatchObject({ filemode: 'write' });

    const p2 = cap.waitSettle();
    cap.update({ type: 'update', gen: 6, disable: true });
    const s2 = await p2;
    expect(s2.ended).toBe(true);
  });

  it('error update は waitSettle を reject する', async () => {
    const { cap } = makeCapture();
    const p = cap.waitSettle();
    cap.update({ type: 'error', message: 'boom' } as never);
    await expect(p).rejects.toThrow(/boom/);
  });
});

describe('settledToOutput (EngineOutput 構築)', () => {
  /** プレーン文字列から rich 行を作る (テスト補助) */
  const richOf = (lines: string[]) => lines.map((l) => ({ spans: [{ text: l }] }));
  const richGridOf = richOf;
  const base = {
    gridLines: [] as string[],
    richGrid: richOf([]),
    gridHeight: 0,
    gridFreshContent: false,
    ended: false,
    cleared: false,
    gen: 1,
  };

  it('echo と末尾プロンプトを除去し、line 要求は turn/request=line', () => {
    const out = settledToOutput(
      {
        ...base,
        bufferLines: ['look', '', 'Great Hall', 'A big hall.', '', '>'],
        richBuffer: richOf(['look', '', 'Great Hall', 'A big hall.', '', '>']),
        input: { id: 2, gen: 1, type: 'line' },
      },
      'look',
    );
    expect(out.kind).toBe('turn');
    expect(out.request).toBe('line');
    expect(out.body).toBe('Great Hall\nA big hall.');
  });

  it('char 要求は query/request=char', () => {
    const out = settledToOutput(
      { ...base, bufferLines: ['Press a key...'],
        richBuffer: richOf(['Press a key...']), input: { id: 2, gen: 1, type: 'char' } },
      undefined,
    );
    expect(out.kind).toBe('query');
    expect(out.request).toBe('char');
  });

  it('大きい grid (quote 画面) は buffer が空なら本文になる', () => {
    const out = settledToOutput(
      {
        ...base,
        bufferLines: [],
        richBuffer: richOf([]),
        gridLines: ['  How you have fallen', '  -- Isaiah 14:12'],
        richGrid: richGridOf(['  How you have fallen', '  -- Isaiah 14:12']),
        gridHeight: 12,
        gridFreshContent: true,
        input: { id: 2, gen: 1, type: 'char' },
      },
      undefined,
    );
    expect(out.body).toContain('Isaiah');
    expect(out.statusLine).toBeUndefined();
  });

  it('大きい grid は buffer に台詞があっても本文の先頭に連結する (会話メニュー)', () => {
    const out = settledToOutput(
      {
        ...base,
        bufferLines: ['You: "Hey Rosie."', 'Rosie: "Hello."'],
        richBuffer: richOf(['You: "Hey Rosie."', 'Rosie: "Hello."']),
        gridLines: ['Talk to Rosie about:', '1: Cora', '[ENTER] End conversation'],
        richGrid: richGridOf(['Talk to Rosie about:', '1: Cora', '[ENTER] End conversation']),
        gridHeight: 8,
        gridFreshContent: true,
        input: { id: 2, gen: 3, type: 'char' },
      },
      undefined,
    );
    expect(out.body).toMatch(/^Talk to Rosie about:/);
    expect(out.body).toContain('[ENTER] End conversation');
    expect(out.body).toContain('Rosie: "Hello."');
    expect(out.kind).toBe('query');
  });

  it('拡大 grid 内のステータス行は本文に混ぜず statusLine へ分離する', () => {
    const out = settledToOutput(
      {
        ...base,
        bufferLines: ['You: "Hi."'],
        richBuffer: richOf(['You: "Hi."']),
        gridLines: [
          ' Vestibule      Score: 35     Moves: 11',
          'Talk to Cora about:',
          '1: Shopping',
          '[ENTER] End conversation',
        ],
        richGrid: richGridOf([
          ' Vestibule      Score: 35     Moves: 11',
          'Talk to Cora about:',
          '1: Shopping',
          '[ENTER] End conversation',
        ]),
        gridHeight: 8,
        gridFreshContent: true,
        input: { id: 2, gen: 3, type: 'char' },
      },
      undefined,
    );
    expect(out.statusLine).toMatch(/^ Vestibule/);
    expect(out.body).not.toContain('Score: 35');
    expect(out.body).toContain('Talk to Cora about:');
    expect(out.body).toContain('You: "Hi."');
  });

  it('小さい grid はステータス行として保持する', () => {
    const out = settledToOutput(
      {
        ...base,
        bufferLines: ['You are here.'],
        richBuffer: richOf(['You are here.']),
        gridLines: [' Great Hall      Score: 0     Moves: 1'],
        richGrid: richGridOf([' Great Hall      Score: 0     Moves: 1']),
        gridHeight: 1,
        gridFreshContent: false,
        input: { id: 2, gen: 1, type: 'line' },
      },
      'look',
    );
    expect(out.statusLine).toMatch(/^ Great Hall/);
    expect(out.body).toBe('You are here.');
  });

  it('ended は gameover、本文の *** バナーでも gameover', () => {
    expect(settledToOutput({ ...base, bufferLines: [],
        richBuffer: richOf([]), ended: true }, undefined).kind).toBe('gameover');
    expect(
      settledToOutput(
        { ...base, bufferLines: ['*** You have died ***'],
        richBuffer: richOf(['*** You have died ***']), input: { id: 2, gen: 1, type: 'line' } },
        undefined,
      ).kind,
    ).toBe('gameover');
  });
});

describe('装飾の保持 (Lv1/Lv2)', () => {
  it('capture: window の Style_* マップと css_styles を SpanStyle に解決する', async () => {
    const { cap } = makeCapture();
    const p = cap.waitSettle();
    cap.update({
      type: 'update',
      gen: 1,
      windows: [
        {
          id: 2,
          type: 'buffer',
          styles: {
            '.Style_subheader': { 'font-weight': 'bold', 'font-style': 'normal', monospace: 0 },
            '.Style_emphasized': { 'font-weight': 'normal', 'font-style': 'italic', monospace: 0 },
          },
        },
      ],
      content: [
        {
          id: 2,
          text: [
            { content: [{ style: 'subheader', text: 'Great Hall' }] },
            {
              content: [
                { style: 'normal', text: 'A ' },
                { style: 'emphasized', text: 'very' },
                { style: 'normal', text: ' big hall.' },
              ],
            },
            {
              content: [
                {
                  style: 'normal',
                  text: 'Red alert',
                  css_styles: { color: '#EF0000', 'background-color': '#000000', reverse: 1 },
                },
              ],
            },
          ],
        },
      ],
      input: [{ id: 2, gen: 1, type: 'line' }],
    } as never);
    const s = await p;
    expect(s.richBuffer[0]!.spans[0]).toEqual({
      text: 'Great Hall',
      style: { styleName: 'subheader', bold: true },
    });
    expect(s.richBuffer[1]!.spans[1]).toEqual({
      text: 'very',
      style: { styleName: 'emphasized', italic: true },
    });
    expect(s.richBuffer[2]!.spans[0]!.style).toMatchObject({
      reverse: true,
      fg: '#EF0000',
      bg: '#000000',
    });
    // プレーン側は従来どおりの連結
    expect(s.bufferLines[1]).toBe('A very big hall.');
  });

  it('settledToOutput: 拡大 grid は rich の grid ブロックとして桁/空白を保持する', () => {
    const richGrid = [
      { spans: [{ text: ' Hall    Score: 0     Moves: 1', style: { reverse: true, fg: '#EF0000' } }] },
      { spans: [{ text: '   ' }, { text: ' quote line ', style: { reverse: true } }, { text: '   ' }] },
      { spans: [{ text: '   ' }, { text: '  -- Author ', style: { reverse: true } }, { text: '   ' }] },
    ];
    const out = settledToOutput(
      {
        bufferLines: [],
        richBuffer: [],
        gridLines: [' Hall    Score: 0     Moves: 1', '    quote line    ', '     -- Author    '],
        richGrid,
        gridHeight: 8,
        gridFreshContent: true,
        ended: false,
        cleared: false,
        gen: 1,
        input: { id: 2, gen: 1, type: 'char' },
      },
      undefined,
    );
    expect(out.rich).toBeDefined();
    const grid = out.rich![0]!;
    expect(grid.kind).toBe('grid');
    // ステータス行は rich からも除外され statusStyle に回る
    expect(grid.lines).toHaveLength(2);
    expect(grid.lines[0]!.spans[1]!.text).toBe(' quote line '); // 空白桁保持
    expect(out.statusStyle).toMatchObject({ reverse: true, fg: '#EF0000' });
  });

  it('settledToOutput: buffer の echo 除去が rich にも同期する', () => {
    const lines = ['look', '', 'Great Hall', 'desc.', '', '>'];
    const out = settledToOutput(
      {
        bufferLines: lines,
        richBuffer: lines.map((l) => ({
          spans: [{ text: l, ...(l === 'Great Hall' ? { style: { styleName: 'subheader', bold: true } } : {}) }],
        })),
        gridLines: [],
        richGrid: [],
        gridHeight: 0,
        gridFreshContent: false,
        ended: false,
        cleared: false,
        gen: 1,
        input: { id: 2, gen: 1, type: 'line' },
      },
      'look',
    );
    const para = out.rich!.find((b) => b.kind === 'para')!;
    expect(para.lines.map((l) => l.spans.map((s) => s.text).join(''))).toEqual([
      '',
      'Great Hall',
      'desc.',
    ]);
    expect(para.lines[1]!.spans[0]!.style).toMatchObject({ bold: true });
  });
});
