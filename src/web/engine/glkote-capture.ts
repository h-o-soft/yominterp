/**
 * GlkOte プロトコルのキャプチャ実装 (AsyncGlk の GlkOte インターフェース互換)。
 * VM からの update を構造化して蓄積し、入力要求/特殊入力/終了で「settle」する。
 * DOM 非依存 (Node 検証とブラウザの両方で使う)。
 *
 * プロトコル形状は実機採取 (scripts/spike-emglken.mts, 2026-06-06) に基づく:
 * - update: { type:'update', gen, windows?, content?, input?, specialinput?, disable? }
 * - grid window content: { id, clear?, lines: [{line, content:[{text}|string]}] }
 * - buffer window content: { id, clear?, text: [{append?, content?:[{text}|string]}] }
 * - input 要求: { id, gen, type:'line'|'char' }
 * - イベント返信: { type:'line'|'char'|'specialresponse', gen, window?, value?, ... }
 */

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
}

/** 1 回の settle までに蓄積した内容 */
export interface SettledUpdate {
  /** buffer window に新規追加された行 (echo 除去前) */
  bufferLines: string[];
  /** grid window の最新の全行 (window id 昇順・非空行のみ) */
  gridLines: string[];
  /** 最も背の高い grid の高さ (quote 画面判定用) */
  gridHeight: number;
  input?: GlkInputRequest;
  special?: GlkSpecialInput;
  /** disable=true かつ入力要求なし (VM 終了) */
  ended: boolean;
  gen: number;
}

type SpanLike = string | { text?: string };

function spanText(spans: SpanLike[] | undefined): string {
  if (!spans) return '';
  return spans.map((s) => (typeof s === 'string' ? s : (s.text ?? ''))).join('');
}

export class GlkOteCapture {
  private accept: (ev: Record<string, unknown>) => void = () => {};
  private windows = new Map<number, GlkWindowInfo>();
  private gridContent = new Map<number, string[]>();
  private pendingBufferLines: string[] = [];
  private lastInput: GlkInputRequest | undefined;
  private lastSpecial: GlkSpecialInput | undefined;
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
    windows?: { id: number; type: string; gridheight?: number; height?: number }[];
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

    for (const w of data.windows ?? []) {
      this.windows.set(w.id, {
        type: (w.type as GlkWindowInfo['type']) ?? 'buffer',
        height: w.gridheight ?? w.height ?? 0,
      });
      if (!this.gridContent.has(w.id) && w.type === 'grid') this.gridContent.set(w.id, []);
    }

    for (const c of data.content ?? []) {
      const info = this.windows.get(c.id);
      if (c.lines !== undefined) {
        // grid: 行単位の置き換え (clear で全消去)
        const lines = c.clear ? [] : (this.gridContent.get(c.id) ?? []);
        for (const l of c.lines) lines[l.line] = spanText(l.content);
        this.gridContent.set(c.id, lines);
      }
      if (c.text !== undefined) {
        // buffer: 追加された段落のみ蓄積 (clear はバッファ画面の消去 — 蓄積には影響しない)
        if (info === undefined || info.type === 'buffer' || c.id !== -1) {
          for (const para of c.text) {
            const text = spanText(para.content);
            if (para.append === true && this.pendingBufferLines.length > 0) {
              this.pendingBufferLines[this.pendingBufferLines.length - 1] += text;
            } else {
              this.pendingBufferLines.push(text);
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
    // 既に settle 条件を満たしていれば即時
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
    const bufferLines = this.pendingBufferLines;
    this.pendingBufferLines = [];
    const input = this.lastInput;
    const special = this.lastSpecial;
    this.lastInput = undefined;
    this.lastSpecial = undefined;

    const gridIds = [...this.gridContent.keys()].sort((a, b) => a - b);
    const gridLines: string[] = [];
    let gridHeight = 0;
    for (const id of gridIds) {
      const h = this.windows.get(id)?.height ?? 0;
      if (h > gridHeight) gridHeight = h;
      for (const line of this.gridContent.get(id) ?? []) {
        if (line !== undefined && line.trim() !== '') gridLines.push(line);
      }
    }

    const settled: SettledUpdate = {
      bufferLines,
      gridLines,
      gridHeight,
      ended: this.ended,
      gen: this.gen,
    };
    if (input !== undefined) settled.input = input;
    if (special !== undefined) settled.special = special;
    return settled;
  }
}
