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
