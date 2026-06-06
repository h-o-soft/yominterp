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
  const base = { gridLines: [], gridHeight: 0, ended: false, gen: 1 };

  it('echo と末尾プロンプトを除去し、line 要求は turn/request=line', () => {
    const out = settledToOutput(
      {
        ...base,
        bufferLines: ['look', '', 'Great Hall', 'A big hall.', '', '>'],
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
      { ...base, bufferLines: ['Press a key...'], input: { id: 2, gen: 1, type: 'char' } },
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
        gridLines: ['  How you have fallen', '  -- Isaiah 14:12'],
        gridHeight: 12,
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
        gridLines: ['Talk to Rosie about:', '1: Cora', '[ENTER] End conversation'],
        gridHeight: 8,
        input: { id: 2, gen: 3, type: 'char' },
      },
      undefined,
    );
    expect(out.body).toMatch(/^Talk to Rosie about:/);
    expect(out.body).toContain('[ENTER] End conversation');
    expect(out.body).toContain('Rosie: "Hello."');
    expect(out.kind).toBe('query');
  });

  it('小さい grid はステータス行として保持する', () => {
    const out = settledToOutput(
      {
        ...base,
        bufferLines: ['You are here.'],
        gridLines: [' Great Hall      Score: 0     Moves: 1'],
        gridHeight: 1,
        input: { id: 2, gen: 1, type: 'line' },
      },
      'look',
    );
    expect(out.statusLine).toMatch(/^ Great Hall/);
    expect(out.body).toBe('You are here.');
  });

  it('ended は gameover、本文の *** バナーでも gameover', () => {
    expect(settledToOutput({ ...base, bufferLines: [], ended: true }, undefined).kind).toBe('gameover');
    expect(
      settledToOutput(
        { ...base, bufferLines: ['*** You have died ***'], input: { id: 2, gen: 1, type: 'line' } },
        undefined,
      ).kind,
    ).toBe('gameover');
  });
});
