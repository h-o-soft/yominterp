import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { parseTranscript } from '../src/verify/transcript.js';
import { normalizeForCompare, tokenOverlap } from '../src/verify/compare.js';
import { percentile, summarize, type StepRecord } from '../src/verify/report.js';

describe('parseTranscript', () => {
  it('コメント・前書きをスキップし (コマンド, 出力) の列に分解する', () => {
    const text = [
      '// comment',
      '',
      'Start of a transcript of',
      'Some Game',
      '',
      '>look',
      '',
      'Great Hall',
      'A big hall.',
      '',
      '>take pouch then open it',
      'Taken.',
      'Opened.',
      '',
    ].join('\n');
    const steps = parseTranscript(text);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ index: 0, command: 'look' });
    expect(steps[0]!.expectedOutput).toContain('Great Hall');
    expect(steps[1]!.command).toBe('take pouch then open it');
    expect(steps[1]!.expectedOutput).toBe('Taken.\nOpened.');
  });

  it('YES/NO 質問へのインライン回答 (`>` なし) を独立 step として抽出する', () => {
    const text = [
      '>sw',
      'A long cutscene.',
      '[You have a choice. Please answer YES or NO.]',
      'no',
      'You: Thank you.',
      'More story.',
      '',
      '>turn on torch',
      'You switch it on.',
    ].join('\n');
    const steps = parseTranscript(text);
    expect(steps.map((s) => s.command)).toEqual(['sw', 'no', 'turn on torch']);
    expect(steps[0]!.expectedOutput).toContain('Please answer YES or NO');
    expect(steps[1]!.expectedOutput).toContain('More story.');
  });

  const TRANSCRIPT = 'refs/ghosts_R14/game.transcript';
  it.skipIf(!existsSync(TRANSCRIPT))('実 transcript は 185 コマンド + インライン回答 2 = 187 step', () => {
    const steps = parseTranscript(readFileSync(TRANSCRIPT, 'utf8'));
    expect(steps).toHaveLength(187);
    expect(steps[0]!.command).toBe('look');
    expect(steps.some((s) => s.command === 'take pouch then open it')).toBe(true);
    expect(steps.filter((s) => s.command === 'no')).toHaveLength(1);
    expect(steps.filter((s) => s.command === 'yes')).toHaveLength(1);
  });
});

describe('比較の正規化', () => {
  it('折返し・大文字小文字・記号の差を吸収する', () => {
    const a = 'You take the pouch.\nIt is heavy!';
    const b = 'You take the\npouch. It is heavy!';
    expect(normalizeForCompare(a)).toBe(normalizeForCompare(b));
  });

  it('tokenOverlap: 同一は 1、無関係は低い', () => {
    expect(tokenOverlap('a b c', 'a b c')).toBe(1);
    expect(tokenOverlap('a b c d', 'a b c x')).toBeCloseTo(0.75);
    expect(tokenOverlap('hello world', 'foo bar')).toBe(0);
  });
});

describe('report 集計', () => {
  const rec = (classification: StepRecord['classification'], latencyMs = 1000): StepRecord => ({
    index: 0,
    enCommand: 'x',
    jaInput: 'x',
    sentCommands: ['x'],
    classification,
    nearMatch: false,
    retries: 0,
    llmCalls: 1,
    latencyMs,
    goldenRoom: null,
    actualRoom: null,
    resynced: false,
  });

  it('分類別の率と percentile を計算する', () => {
    const steps = [
      rec('pass', 1000),
      rec('pass', 2000),
      rec('pass-corrected', 3000),
      rec('fail-accepted-wrong', 4000),
    ];
    const s = summarize(steps, 410, 60000);
    expect(s.passRate).toBeCloseTo(0.5);
    expect(s.correctedRate).toBeCloseTo(0.75);
    expect(s.acceptedWrongRate).toBeCloseTo(0.25);
    expect(s.finalScore).toBe(410);
  });

  it('percentile', () => {
    const vals = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(vals, 50)).toBe(5);
    expect(percentile(vals, 95)).toBe(10);
    expect(percentile([], 50)).toBe(0);
  });
});
