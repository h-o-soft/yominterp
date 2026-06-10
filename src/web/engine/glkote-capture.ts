/**
 * GlkOte プロトコルのキャプチャ実装 (AsyncGlk の GlkOte インターフェース互換)。
 * VM からの update を構造化して蓄積し、入力要求/特殊入力/終了で「settle」する。
 * DOM 非依存 (Node 検証とブラウザの両方で使う)。
 *
 * プロトコル形状は実機採取 (scripts/spike-emglken.mts, 2026-06-06) に基づく:
 * - update: { type:'update', gen, windows?, content?, input?, specialinput?, disable? }
 * - grid window content: { id, clear?, lines: [{line, content:[{text,style,css_styles}|string]}] }
 * - buffer window content: { id, clear?, text: [{append?, content?:[...]}] }
 * - input 要求: { id, gen, type:'line'|'char' }
 * - イベント返信: { type:'line'|'char'|'specialresponse', gen, window?, value?, ... }
 *
 * 装飾 (2026-06-07 追加): スパンの style 名・css_styles (reverse/色) と window の
 * Style_* マップを解決済み SpanStyle として保持する (Lv1/Lv2 表示用)。
 * プレーンテキスト系 (body/比較/メニュー検出) は従来どおりスパン text の連結。
 */
import type { SpanStyle, StyledLine, StyledSpan } from '../../core/engine.js';

export interface GlkInputRequest {
  id: number;
  gen: number;
  type: 'line' | 'char';
}

export interface GlkSpecialInput {
  type: string; // 'fileref_prompt'
  filemode?: string;
  filetype?: string;
}

interface GlkWindowInfo {
  type: 'grid' | 'buffer' | 'graphics';
  height: number;
  /** Style_* 名 → 文字属性 (window 単位で届く) */
  styleMap: Map<string, { bold?: boolean; italic?: boolean; monospace?: boolean }>;
}

/** 1 回の settle までに蓄積した内容 */
export interface SettledUpdate {
  /** buffer window に新規追加された行 (echo 除去前)。プレーン */
  bufferLines: string[];
  /** buffer の装飾付き行 (bufferLines と同一 index) */
  richBuffer: StyledLine[];
  /** grid window の最新の全行 (window id 昇順・非空行のみ)。プレーン */
  gridLines: string[];
  /** grid の装飾付き全行 (空行含む・桁/空白保持。window id 昇順) */
  richGrid: StyledLine[];
  /** 最も背の高い grid の高さ (quote 画面判定用) */
  gridHeight: number;
  /**
   * この settle 中に grid window の **ステータス行以外 (line>0)** が更新されたか。
   * 拡大 grid (メニュー/カットシーン) を本文に連結してよいのは「このターンに
   * 中身が更新された」場合だけ。更新が無いのに高さだけ残った古いメニューを
   * 連結し続けると、画面上部に残留して本文に重なる (ninetenths)。
   */
  gridFreshContent: boolean;
  input?: GlkInputRequest;
  special?: GlkSpecialInput;
  /** disable=true かつ入力要求なし (VM 終了) */
  ended: boolean;
  /** この settle 中に buffer window の clear (画面クリア) があった */
  cleared: boolean;
  gen: number;
}

type SpanLike =
  | string
  | {
      text?: string;
      style?: string;
      css_styles?: Record<string, unknown>;
    };

interface CssStyles {
  reverse?: number | boolean;
  color?: string;
  'background-color'?: string;
}

function resolveSpan(
  raw: SpanLike,
  styleMap: GlkWindowInfo['styleMap'] | undefined,
): StyledSpan {
  if (typeof raw === 'string') return { text: raw };
  const text = raw.text ?? '';
  const style: SpanStyle = {};
  if (raw.style !== undefined && raw.style !== 'normal') style.styleName = raw.style;
  const mapped = raw.style !== undefined ? styleMap?.get(raw.style) : undefined;
  if (mapped?.bold === true) style.bold = true;
  if (mapped?.italic === true) style.italic = true;
  if (mapped?.monospace === true) style.monospace = true;
  const css = raw.css_styles as CssStyles | undefined;
  if (css !== undefined) {
    if (css.reverse === 1 || css.reverse === true) style.reverse = true;
    if (typeof css.color === 'string') style.fg = css.color;
    if (typeof css['background-color'] === 'string') style.bg = css['background-color'];
  }
  return Object.keys(style).length > 0 ? { text, style } : { text };
}

export function lineText(line: StyledLine): string {
  return line.spans.map((s) => s.text).join('');
}

/** '.Style_xxx' → 'xxx' の属性マップを window update から取り出す */
function parseStyleMap(
  styles: Record<string, Record<string, unknown>> | undefined,
): GlkWindowInfo['styleMap'] {
  const map: GlkWindowInfo['styleMap'] = new Map();
  if (styles === undefined) return map;
  for (const [selector, attrs] of Object.entries(styles)) {
    const m = /^\.Style_(\w+)$/.exec(selector);
    if (m === null) continue;
    map.set(m[1]!, {
      ...(attrs['font-weight'] === 'bold' ? { bold: true } : {}),
      ...(attrs['font-style'] === 'italic' ? { italic: true } : {}),
      ...(attrs.monospace === 1 || attrs.monospace === true ? { monospace: true } : {}),
    });
  }
  return map;
}

export class GlkOteCapture {
  private accept: (ev: Record<string, unknown>) => void = () => {};
  private windows = new Map<number, GlkWindowInfo>();
  private gridContent = new Map<number, StyledLine[]>();
  private pendingBuffer: StyledLine[] = [];
  private lastInput: GlkInputRequest | undefined;
  private lastSpecial: GlkSpecialInput | undefined;
  /** この settle 中に grid の line>0 (ステータス行以外) が更新されたか */
  private gridFreshContent = false;
  private pendingCleared = false;
  private ended = false;
  private gen = 0;
  private settleWaiter: ((s: SettledUpdate) => void) | undefined;
  private errorWaiter: ((err: Error) => void) | undefined;

  // ---- AsyncGlk GlkOte インターフェース ----

  async init(options: { accept?: (ev: Record<string, unknown>) => void }): Promise<void> {
    if (!options?.accept) throw new Error('GlkOteCapture: accept がありません');
    this.accept = options.accept;
    this.accept({
      type: 'init',
      gen: 0,
      metrics: { width: 100, height: 30 },
      support: ['garglktext'],
    });
  }

  update(data: {
    type: string;
    gen?: number;
    message?: string;
    windows?: {
      id: number;
      type: string;
      gridheight?: number;
      height?: number;
      styles?: Record<string, Record<string, unknown>>;
    }[];
    content?: {
      id: number;
      clear?: boolean;
      lines?: { line: number; content?: SpanLike[] }[];
      text?: { append?: boolean; content?: SpanLike[] }[];
    }[];
    input?: GlkInputRequest[];
    specialinput?: GlkSpecialInput;
    disable?: boolean;
  }): void {
    if (data.type === 'error') {
      const err = new Error(`VM error: ${data.message ?? 'unknown'}`);
      const ew = this.errorWaiter;
      if (ew) {
        this.clearWaiters();
        ew(err);
        return;
      }
      throw err;
    }
    if (data.type !== 'update') return; // pass/retry は無視
    this.gen = data.gen ?? this.gen;

    // ---- DEBUG: GlkOte の window/content 生データを採取 (調査用・後で除去) ----
    {
      const g = globalThis as { __GLKLOG?: unknown[] };
      if (g.__GLKLOG === undefined) g.__GLKLOG = [];
      if (g.__GLKLOG.length > 300) g.__GLKLOG.shift();
      g.__GLKLOG.push({
        gen: data.gen,
        windows: (data.windows ?? []).map((w) => ({ id: w.id, type: w.type, gridheight: w.gridheight, height: w.height })),
        content: (data.content ?? []).map((c) => ({
          id: c.id,
          clear: c.clear,
          lines: c.lines?.map((l) => ({ line: l.line, text: (l.content ?? []).map((s) => (typeof s === 'string' ? s : s.text)).join('') })),
          textParas: c.text?.length,
          bufText: c.text?.map((para) => (para.content ?? []).map((s) => (typeof s === 'string' ? s : s.text)).join('')).join(' | ').slice(0, 300),
        })),
      });
    }

    for (const w of data.windows ?? []) {
      const existing = this.windows.get(w.id);
      this.windows.set(w.id, {
        type: (w.type as GlkWindowInfo['type']) ?? 'buffer',
        height: w.gridheight ?? w.height ?? 0,
        styleMap: w.styles !== undefined ? parseStyleMap(w.styles) : (existing?.styleMap ?? new Map()),
      });
      if (!this.gridContent.has(w.id) && w.type === 'grid') this.gridContent.set(w.id, []);
    }

    for (const c of data.content ?? []) {
      const info = this.windows.get(c.id);
      if (c.lines !== undefined) {
        // grid: 行単位の置き換え (clear で全消去)。桁/空白はそのまま保持
        const lines = c.clear ? [] : (this.gridContent.get(c.id) ?? []);
        for (const l of c.lines) {
          lines[l.line] = { spans: (l.content ?? []).map((s) => resolveSpan(s, info?.styleMap)) };
          // ステータス行 (line 0) 以外の更新 = 拡大 grid (メニュー等) の中身が
          // このターンに描き換わった。clear も「中身が変わった」とみなす。
          if (l.line > 0) this.gridFreshContent = true;
        }
        if (c.clear === true) this.gridFreshContent = true;
        this.gridContent.set(c.id, lines);
      }
      if (c.text !== undefined) {
        // buffer: 追加された段落のみ蓄積。clear は「画面クリア」信号として記録する
        // (ghosts の引用画面→本編遷移で実測。蓄積済みテキストには影響しない)
        if (c.clear === true) this.pendingCleared = true;
        if (info === undefined || info.type === 'buffer' || c.id !== -1) {
          for (const para of c.text) {
            const spans = (para.content ?? []).map((s) => resolveSpan(s, info?.styleMap));
            if (para.append === true && this.pendingBuffer.length > 0) {
              this.pendingBuffer[this.pendingBuffer.length - 1]!.spans.push(...spans);
            } else {
              this.pendingBuffer.push({ spans });
            }
          }
        }
      }
    }

    if (data.input !== undefined && data.input.length > 0) {
      this.lastInput = data.input[0];
    }
    if (data.specialinput !== undefined) {
      this.lastSpecial = data.specialinput;
    }
    if (data.disable === true && (data.input === undefined || data.input.length === 0)) {
      this.ended = true;
    }

    // settle 条件: 入力要求 / 特殊入力 / 終了
    if (this.lastInput !== undefined || this.lastSpecial !== undefined || this.ended) {
      const waiter = this.settleWaiter;
      if (waiter !== undefined) {
        this.clearWaiters();
        waiter(this.takeSettled());
      }
    }
  }

  // GlkOteBase 互換の残り (VM 側から呼ばれ得るもの)
  getinterface(): Record<string, unknown> {
    return {};
  }
  log(_msg: string): void {}
  warning(_msg: string): void {}
  error(err: unknown): void {
    const e = err instanceof Error ? err : new Error(String(err));
    const ew = this.errorWaiter;
    if (ew) {
      this.clearWaiters();
      ew(e);
    } else {
      throw e;
    }
  }
  inited(): boolean {
    return true;
  }

  // ---- エンジン側 API ----

  /** 次の settle (入力要求・特殊入力・終了) を待つ */
  waitSettle(): Promise<SettledUpdate> {
    if (this.lastInput !== undefined || this.lastSpecial !== undefined || this.ended) {
      return Promise.resolve(this.takeSettled());
    }
    return new Promise((resolve, reject) => {
      this.settleWaiter = resolve;
      this.errorWaiter = reject;
    });
  }

  /** イベント送信 (line/char/specialresponse) */
  sendEvent(ev: Record<string, unknown>): void {
    this.accept({ gen: this.gen, ...ev });
  }

  /** VM 終了を外部 (vm.start の reject) から通知 */
  markEnded(): void {
    this.ended = true;
    const waiter = this.settleWaiter;
    if (waiter !== undefined) {
      this.clearWaiters();
      waiter(this.takeSettled());
    }
  }

  private clearWaiters(): void {
    this.settleWaiter = undefined;
    this.errorWaiter = undefined;
  }

  private takeSettled(): SettledUpdate {
    const richBuffer = this.pendingBuffer;
    this.pendingBuffer = [];
    const input = this.lastInput;
    const special = this.lastSpecial;
    this.lastInput = undefined;
    this.lastSpecial = undefined;

    const gridIds = [...this.gridContent.keys()].sort((a, b) => a - b);
    const gridLines: string[] = [];
    const richGrid: StyledLine[] = [];
    let gridHeight = 0;
    for (const id of gridIds) {
      const h = this.windows.get(id)?.height ?? 0;
      if (h > gridHeight) gridHeight = h;
      // grid window の現在の高さ h を超える行は、upper window が縮小 (メニュー →
      // ステータス1行 等) した後に残った無効行。これを捨てないと、拡大メニューが
      // 毎ターン本文先頭に再連結されて画面上部に残留・重畳する (ninetenths で発現)。
      const content = h > 0 ? (this.gridContent.get(id) ?? []).slice(0, h) : [];
      for (const line of content) {
        const resolved = line ?? { spans: [] };
        richGrid.push(resolved);
        const text = lineText(resolved);
        if (text.trim() !== '') gridLines.push(text);
      }
    }

    const settled: SettledUpdate = {
      bufferLines: richBuffer.map(lineText),
      richBuffer,
      gridLines,
      richGrid,
      gridHeight,
      gridFreshContent: this.gridFreshContent,
      ended: this.ended,
      cleared: this.pendingCleared,
      gen: this.gen,
    };
    this.pendingCleared = false;
    this.gridFreshContent = false;
    if (input !== undefined) settled.input = input;
    if (special !== undefined) settled.special = special;
    return settled;
  }
}
