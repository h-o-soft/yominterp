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

/**
 * 本文行を「段落ブロック」と「空行」に分解する (改行・空行の完全保持用)。
 * - 連続する非空行 = 1 段落ブロック (まとめて翻訳)
 * - 空行は 1 行ずつ個別ブロック (連続空行はそのまま複数 = 空行数を保持)
 * ゲームが出した改行・空行を一切集約せず再現するための土台。
 */
export interface BodyBlock {
  blank: boolean;
  lines: StyledLine[];
}
export function splitBlocks(lines: StyledLine[]): BodyBlock[] {
  const out: BodyBlock[] = [];
  let cur: StyledLine[] = [];
  const flush = () => {
    if (cur.length > 0) {
      out.push({ blank: false, lines: cur });
      cur = [];
    }
  };
  for (const line of lines) {
    if (line.spans.map((s) => s.text).join('').trim() === '') {
      flush();
      out.push({ blank: true, lines: [line] });
    } else {
      cur.push(line);
    }
  }
  flush();
  return out;
}

/**
 * クラシック端末の寸法定義 (古典端末 80x24)。
 * - 横 80 桁 (等幅・全角=2 桁)
 * - 本文表示領域 24 行 (ステータスは上部バー、入力欄は下部 = 枠外)
 */
export const CLASSIC_COLS = 80;
export const CLASSIC_ROWS = 24;

/** 1 文字の表示幅 (全角 CJK = 2、半角 = 1) */
function charWidth(ch: string): number {
  return ch.codePointAt(0)! > 0xff ? 2 : 1;
}

/**
 * 1 論理行を cols 幅で折り返し、表示行の配列にする。
 * 空白で区切れる箇所を優先して折り返し (英単語を途中で割らない)、
 * 1 トークンが cols を超える場合のみ文字単位で割る (連続 CJK や長い URL 等)。
 */
export function wrapLine(line: string, cols: number): string[] {
  if (line === '') return [''];
  const out: string[] = [];
  let cur = '';
  let curW = 0;
  const pushCur = () => {
    out.push(cur.replace(/\s+$/, '')); // 行末にぶら下がる空白は表示上不要
    cur = '';
    curW = 0;
  };
  // 空白を保持しつつ「空白塊 / 非空白塊」でトークン化
  const tokens = line.match(/\s+|\S+/g) ?? [];
  for (const token of tokens) {
    const isSpace = /^\s+$/.test(token);
    let tokW = 0;
    for (const ch of token) tokW += charWidth(ch);
    if (curW + tokW <= cols) {
      cur += token;
      curW += tokW;
      continue;
    }
    // 行末にぶら下がる空白塊 (折返しで次行頭に来る) は捨てて改行する
    if (isSpace) {
      if (curW > 0) pushCur();
      continue;
    }
    // 入りきらない: 行頭の空白でなければ改行してから配置を試みる
    if (curW > 0 && !/^\s+$/.test(token)) pushCur();
    if (tokW <= cols) {
      // 改行後の行頭に置く (行頭の空白は捨てる)
      if (/^\s+$/.test(token)) continue;
      cur = token;
      curW = tokW;
    } else {
      // トークン自体が cols 超 → 文字単位で割る
      for (const ch of token) {
        const w = charWidth(ch);
        if (curW + w > cols && curW > 0) pushCur();
        cur += ch;
        curW += w;
      }
    }
  }
  pushCur();
  return out;
}

/** テキストを表示行 (\n + 折返し) に展開する */
export function wrapToLines(text: string, cols: number): string[] {
  return text.split('\n').flatMap((line) => wrapLine(line, cols));
}

/** 折返し込みの表示行数を数える (改行コードだけでなく wrap 分も +1 する) */
export function estimateLines(text: string, cols = CLASSIC_COLS): number {
  return wrapToLines(text, cols).length;
}

/** ページャ状態。waitFn (続行操作待ち) を注入してテスト可能にする */
export class Pager {
  private linesShown = 0;
  constructor(
    private readonly waitFn: () => Promise<void>,
    private readonly pageLines: number | (() => number) = CLASSIC_ROWS,
  ) {}

  private limit(): number {
    return typeof this.pageLines === 'function' ? this.pageLines() : this.pageLines;
  }

  /** ターン開始等でページ位置をリセット */
  reset(): void {
    this.linesShown = 0;
  }

  /**
   * ブロックを表示する直前に呼ぶ。
   * 「このブロックを足すと表示領域を超える」手前で続行操作を待つ
   * (先読み — あふれてから止めるのではなく、超える前に止める)。
   */
  async beforeAppend(estimatedLines: number): Promise<void> {
    if (this.linesShown > 0 && this.linesShown + estimatedLines > this.limit()) {
      await this.waitFn();
      this.linesShown = 0;
    }
    this.linesShown += estimatedLines;
  }
}

/**
 * テキストを「表示行 maxLines 行ごと」のチャンクに分割する (段落途中でも
 * ページ境界で止めるため)。**折返し (wrap) 込みの表示行**で数えるので、
 * 改行コードを含まない長い 1 段落も正しく分割される。
 * 各チャンクは折返し済みテキスト (\n 区切りの表示行) — 表示は white-space:pre 前提。
 */
export function splitForPaging(text: string, cols = CLASSIC_COLS, maxLines = CLASSIC_ROWS): string[] {
  const lines = wrapToLines(text, cols);
  const chunks: string[] = [];
  for (let i = 0; i < lines.length; i += maxLines) {
    chunks.push(lines.slice(i, i + maxLines).join('\n'));
  }
  return chunks.length > 0 ? chunks : [''];
}
