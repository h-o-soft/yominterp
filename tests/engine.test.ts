import { describe, expect, it } from 'vitest';
import {
  looksGameOver,
  parseStatusLine,
  splitRawOutput,
} from '../src/core/engine.js';

describe('parseStatusLine', () => {
  it('実機形式のステータス行をパースする', () => {
    const line =
      ' Great Hall                                                               Score: 0     Moves: 12';
    expect(parseStatusLine(line)).toEqual({ room: 'Great Hall', score: 0, moves: 12 });
  });

  it('負のスコアも受理する', () => {
    expect(parseStatusLine(' Cellar    Score: -3   Moves: 99')).toEqual({
      room: 'Cellar',
      score: -3,
      moves: 99,
    });
  });

  it('本文行にはマッチしない', () => {
    expect(parseStatusLine('You can see a lamp here.')).toBeUndefined();
    expect(parseStatusLine('The score is 0 and moves are 3.')).toBeUndefined();
  });
});

describe('splitRawOutput', () => {
  it('ステータス行とプロンプトを除いた本文を返す', () => {
    const raw =
      ' Great Hall                          Score: 0     Moves: 1\n' +
      '\n' +
      'You see nothing special.\n' +
      '\n' +
      '>';
    const { body, statusLine } = splitRawOutput(raw);
    expect(body).toBe('You see nothing special.');
    expect(statusLine).toMatch(/^Great Hall/);
  });

  it('複数ステータス行は最後を採用する', () => {
    const raw =
      ' Great Hall      Score: 0     Moves: 1\n\nFirst.\n\n' +
      ' Vestibule       Score: 5     Moves: 2\n\nSecond.\n\n>';
    const { body, statusLine } = splitRawOutput(raw);
    expect(statusLine).toMatch(/^Vestibule/);
    expect(body).toBe('First.\n\nSecond.');
  });

  it('段落構造 (空行) を保持する', () => {
    const raw = 'Para one line one\nline two\n\nPara two\n\n>';
    expect(splitRawOutput(raw).body).toBe('Para one line one\nline two\n\nPara two');
  });

  it('query 出力 (プロンプトなし) はそのまま本文になる', () => {
    const raw = 'Are you sure you want to quit?';
    const { body, statusLine } = splitRawOutput(raw);
    expect(body).toBe('Are you sure you want to quit?');
    expect(statusLine).toBeUndefined();
  });
});

describe('looksGameOver', () => {
  it('*** バナーを検出する', () => {
    expect(looksGameOver('*** You have died ***')).toBe(true);
    expect(looksGameOver('*** You have won ***')).toBe(true);
  });
  it('RESTART 問い合わせを検出する', () => {
    expect(looksGameOver('Would you like to RESTART, RESTORE a saved game or QUIT?')).toBe(true);
  });
  it('通常の本文は検出しない', () => {
    expect(looksGameOver('You open the door. It creaks.')).toBe(false);
  });
});

describe('uniformStyle (段落一様装飾の判定)', () => {
  it('全スパン同一装飾ならそれを返す (空白のみスパンは無視)', async () => {
    const { uniformStyle } = await import('../src/core/engine.js');
    const style = { reverse: true, fg: '#FFF' };
    expect(
      uniformStyle([
        { spans: [{ text: '  ' }, { text: 'quote', style }, { text: '  ' }] },
        { spans: [{ text: 'line 2', style }] },
      ]),
    ).toEqual(style);
  });
  it('装飾が混在すれば undefined', async () => {
    const { uniformStyle } = await import('../src/core/engine.js');
    expect(
      uniformStyle([
        { spans: [{ text: 'a', style: { bold: true } }, { text: 'b', style: { italic: true } }] },
      ]),
    ).toBeUndefined();
  });
});
