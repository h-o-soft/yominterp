/**
 * 装飾描画の純関数ヘルパ (DOM 非依存・テスト可能)。
 * - SpanStyle → CSS クラス/インラインスタイル
 * - 翻訳済みテキストへの段落一様装飾の対応付け (Lv1)
 */
import {
  type SpanStyle,
  type StyledBlock,
  type StyledLine,
  uniformStyle,
} from '../../core/engine.js';

export interface CssView {
  classes: string[];
  /** インライン style 文字列 (色は動的なのでクラス化しない) */
  inline: string;
}

/** SpanStyle を CSS 表現へ。reverse は fg/bg の入替で表現する */
export function styleToCss(style: SpanStyle | undefined): CssView {
  if (style === undefined) return { classes: [], inline: '' };
  const classes: string[] = [];
  if (style.bold === true) classes.push('s-bold');
  if (style.italic === true) classes.push('s-italic');
  if (style.monospace === true) classes.push('s-mono');
  if (style.styleName !== undefined) classes.push(`s-${style.styleName}`);
  const fg = style.fg;
  const bg = style.bg;
  const parts: string[] = [];
  if (style.reverse === true) {
    // 反転: 前景/背景を入れ替える。色未指定なら端末既定色で反転
    parts.push(`color: ${bg ?? 'var(--bg)'}`, `background-color: ${fg ?? 'var(--fg)'}`);
    classes.push('s-reverse');
  } else {
    if (fg !== undefined) parts.push(`color: ${fg}`);
    if (bg !== undefined) parts.push(`background-color: ${bg}`);
  }
  return { classes, inline: parts.join('; ') };
}

/** rich の para 行を空行区切りで「段落グループ」へ (各グループの一様装飾付き) */
export interface ParaGroup {
  text: string;
  style: SpanStyle | undefined;
}

export function paraGroups(lines: StyledLine[]): ParaGroup[] {
  const groups: ParaGroup[] = [];
  let current: StyledLine[] = [];
  let currentKey: string | undefined;
  const flush = () => {
    if (current.length === 0) return;
    const text = current
      .map((l) => l.spans.map((s) => s.text).join(''))
      .join('\n')
      .trim();
    if (text !== '') groups.push({ text, style: uniformStyle(current) });
    current = [];
    currentKey = undefined;
  };
  for (const line of lines) {
    const text = line.spans.map((s) => s.text).join('');
    if (text.trim() === '') {
      flush();
      continue;
    }
    // 空行に加えて「行の一様装飾の境界」でもグループを分ける
    // (bocfel の buffer は見出し行と本文行の間に空行を挟まないことがある)
    const key = JSON.stringify(uniformStyle([line]) ?? null);
    if (current.length > 0 && key !== currentKey) flush();
    current.push(line);
    currentKey = key;
  }
  flush();
  return groups;
}

/**
 * 翻訳済みテキストの段落へ装飾を対応付ける (Lv1: ブロック一様のみ)。
 * - 原文段落数 == 訳文段落数 → 1:1 で各段落に適用 (出口翻訳は段落構造を保つ規則)
 * - 一致しない → 全段落が同一装飾の場合のみ全体に適用、それ以外は装飾なし
 */
export function styleTranslatedParagraphs(
  translated: string,
  original: StyledLine[],
): { text: string; style: SpanStyle | undefined }[] {
  const jaParas = translated
    .split(/\n{2,}/)
    .map((t) => t.trim())
    .filter((t) => t !== '');
  const groups = paraGroups(original);
  if (jaParas.length === groups.length) {
    return jaParas.map((text, i) => ({ text, style: groups[i]!.style }));
  }
  // 不一致でも「先頭が単一行の見出し (subheader 等)」の典型形なら、訳文の最初の行を
  // 見出しとして切り出す (出口翻訳は部屋名+本文を単一改行で繋ぐことがある)
  if (groups.length >= 2 && groups[0]!.style !== undefined && !groups[0]!.text.includes('\n')) {
    const lines = translated.split('\n');
    const heading = lines[0]!.trim();
    if (lines.length > 1 && heading !== '' && heading.length <= 40) {
      const rest = lines
        .slice(1)
        .join('\n')
        .split(/\n{2,}/)
        .map((t) => t.trim())
        .filter((t) => t !== '');
      const restGroups = groups.slice(1);
      return [
        { text: heading, style: groups[0]!.style },
        ...rest.map((text, i) => ({
          text,
          style: rest.length === restGroups.length ? restGroups[i]!.style : undefined,
        })),
      ];
    }
  }
  const whole = uniformStyle(original);
  return jaParas.map((text) => ({ text, style: whole }));
}

/** grid ブロックのプレーンテキスト (翻訳入力用。桁空白は trim) */
export function gridPlainText(block: StyledBlock): string {
  return block.lines
    .map((l) => l.spans.map((s) => s.text).join('').trim())
    .filter((t) => t !== '')
    .join('\n');
}
