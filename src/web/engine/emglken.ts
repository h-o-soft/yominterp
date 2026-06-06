/**
 * EmglkenEngine: emglken (WASM VM) を駆動する ZEngine 実装。
 * Node (検証) とブラウザの両方で動く (DOM 非依存)。
 *
 * dfrotz 版と違いプロンプト検知のタイマーは不要 — GlkOte プロトコルが
 * 入力要求 (line/char) を明示するため、kind を正確に判定できる。
 *   line 入力要求 → 'turn' / char 入力要求 → 'query' / VM 終了 → 'gameover'
 *
 * セーブ/ロード: specialinput (fileref_prompt) を DialogPort (UI 境界) へ委譲し、
 * specialresponse で応答。データは EmglkenDialog → SaveStore (永続境界)。
 */
import {
  type EngineOutput,
  type OutputKind,
  type ZEngine,
  looksGameOver,
  parseStatusLine,
} from '../../core/engine.js';
import { type DialogPort, EmglkenDialog, type SaveStore } from './dialog.js';
import { GlkOteCapture, type SettledUpdate } from './glkote-capture.js';

export type EmglkenVMName = 'bocfel' | 'glulxe' | 'git';

export interface EmglkenEngineOptions {
  vm: EmglkenVMName;
  storyName: string;
  storyData: Uint8Array;
  dialogPort: DialogPort;
  saveStore: SaveStore;
  /**
   * wasm バイナリの事前供給 (ブラウザバンドル用)。
   * emglken の glue は Module.locateFile を**無条件で自前上書き**し、動的引数の
   * `new URL(name, import.meta.url)` は Vite が rewrite できないため、ビルド後は
   * 非ハッシュ名 (bocfel.wasm) への fetch になり SPA フォールバックの HTML を
   * 読んで CompileError になる (実測)。Module.wasmBinary 注入なら glue の URL
   * 解決自体をスキップできる。Node では省略 (glue が fs 経由で解決する)。
   */
  loadWasmBinary?: (() => Promise<ArrayBuffer>) | undefined;
}

/** settle 内容から EngineOutput を構築する (純関数・テスト可能) */
export function settledToOutput(settled: SettledUpdate, sentCommand: string | undefined): EngineOutput {
  // buffer 行の整形: コマンド echo と末尾のプロンプト残骸を除去
  const lines = [...settled.bufferLines];
  while (lines.length > 0 && lines[0]!.trim() === '') lines.shift();
  if (
    sentCommand !== undefined &&
    lines.length > 0 &&
    lines[0]!.trim().toLowerCase() === sentCommand.trim().toLowerCase()
  ) {
    lines.shift(); // 入力 echo
  }
  while (lines.length > 0) {
    const last = lines[lines.length - 1]!.trim();
    if (last === '' || last === '>') lines.pop();
    else break;
  }
  let body = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  // 拡大 grid (quote 画面・PunyInform 会話メニュー等) は本文の一部として扱う。
  // メニューは buffer の台詞と同時に grid 再描画されるため、buffer が
  // 非空でも grid を先頭に連結する (dfrotz のレイアウトと同順)
  if (settled.gridHeight > 3 && settled.gridLines.length > 0) {
    const gridText = settled.gridLines.map((l) => l.trim()).join('\n');
    body = body === '' ? gridText : `${gridText}\n\n${body}`;
  }

  // ステータス行: 小さい grid (≤3 行) の先頭行。大きい grid は本文扱いなので除外
  let statusLine: string | undefined;
  if (settled.gridHeight > 0 && settled.gridHeight <= 3) {
    const candidate = settled.gridLines.find((l) => parseStatusLine(l) !== undefined);
    statusLine = candidate ?? settled.gridLines[0];
  }

  let kind: OutputKind;
  let request: 'line' | 'char' | undefined;
  if (settled.ended) {
    kind = 'gameover';
  } else if (settled.input?.type === 'char') {
    kind = 'query';
    request = 'char';
  } else {
    kind = 'turn';
    request = 'line';
  }
  if (kind !== 'gameover' && looksGameOver(body)) kind = 'gameover';

  const out: EngineOutput = { raw: body, body, kind };
  if (statusLine !== undefined) out.statusLine = statusLine.trimEnd();
  if (request !== undefined) out.request = request;
  return out;
}

export class EmglkenEngine implements ZEngine {
  private capture = new GlkOteCapture();
  private dialog: EmglkenDialog;
  private started = false;
  private dead = false;
  private lastRequest: 'line' | 'char' = 'line';
  private lastWindowId = 0;

  constructor(private readonly opts: EmglkenEngineOptions) {
    this.dialog = new EmglkenDialog(opts.saveStore);
  }

  get alive(): boolean {
    return this.started && !this.dead;
  }

  async start(): Promise<EngineOutput> {
    if (this.started) throw new Error('engine already started');
    this.started = true;
    const storyPath = this.dialog.setStory(this.opts.storyName, this.opts.storyData);

    // VM の終了 (quit) は Emscripten Asyncify 内部の throw となり、
    // unhandledRejection (Node) / unhandledrejection (ブラウザ) として届く (実機採取)。
    // vm.start() 自体は同期で戻り値なし。
    this.installExitTrap();

    const factory = await this.loadVM();
    const vm = await factory(
      this.opts.loadWasmBinary !== undefined
        ? { wasmBinary: await this.opts.loadWasmBinary() }
        : {},
    );
    vm.start({ arguments: [storyPath], GlkOte: this.capture, Dialog: this.dialog });
    return this.settle(undefined);
  }

  async send(command: string): Promise<EngineOutput> {
    if (!this.alive) throw new Error('engine is not running');
    if (this.lastRequest === 'char') {
      this.capture.sendEvent({
        type: 'char',
        window: this.lastWindowId,
        value: command === '' ? 'return' : command[0],
      });
    } else {
      this.capture.sendEvent({ type: 'line', window: this.lastWindowId, value: command });
    }
    return this.settle(command);
  }

  async stop(): Promise<void> {
    // WASM VM に kill はない。イベントを送らなければ実行されないため、参照を破棄するのみ
    this.dead = true;
    this.removeExitTrap();
  }

  // ---- ExitStatus (VM 終了) の捕捉 ----

  private nodeHandler: ((reason: unknown) => void) | undefined;
  private browserHandler: ((ev: { reason?: unknown; preventDefault(): void }) => void) | undefined;

  private isExitStatus(reason: unknown): boolean {
    return (reason as { name?: string } | undefined)?.name === 'ExitStatus';
  }

  private installExitTrap(): void {
    const onExit = () => {
      this.dead = true;
      this.capture.markEnded();
      this.removeExitTrap();
    };
    const g = globalThis as Record<string, unknown>;
    const proc = g.process as
      | { on(ev: string, fn: (r: unknown) => void): void; off(ev: string, fn: (r: unknown) => void): void }
      | undefined;
    if (proc?.on !== undefined) {
      this.nodeHandler = (reason: unknown) => {
        if (this.isExitStatus(reason)) onExit();
      };
      proc.on('unhandledRejection', this.nodeHandler);
    }
    const addEv = g.addEventListener as
      | ((type: string, fn: (ev: { reason?: unknown; preventDefault(): void }) => void) => void)
      | undefined;
    if (typeof addEv === 'function') {
      this.browserHandler = (ev) => {
        if (this.isExitStatus(ev.reason)) {
          ev.preventDefault();
          onExit();
        }
      };
      addEv.call(globalThis, 'unhandledrejection', this.browserHandler);
    }
  }

  private removeExitTrap(): void {
    const g = globalThis as Record<string, unknown>;
    const proc = g.process as
      | { off(ev: string, fn: (r: unknown) => void): void }
      | undefined;
    if (this.nodeHandler !== undefined && proc?.off !== undefined) {
      proc.off('unhandledRejection', this.nodeHandler);
      this.nodeHandler = undefined;
    }
    const removeEv = g.removeEventListener as ((type: string, fn: unknown) => void) | undefined;
    if (this.browserHandler !== undefined && typeof removeEv === 'function') {
      removeEv.call(globalThis, 'unhandledrejection', this.browserHandler);
      this.browserHandler = undefined;
    }
  }

  /** settle を待ち、fileref (セーブ/ロード) は内部で解決してから EngineOutput を返す */
  private async settle(sentCommand: string | undefined): Promise<EngineOutput> {
    for (;;) {
      const settled = await this.capture.waitSettle();
      if (settled.special !== undefined) {
        await this.handleSpecial(settled);
        continue; // 応答後の次の settle へ (出力は蓄積されて次に合流)
      }
      if (settled.input !== undefined) {
        this.lastRequest = settled.input.type;
        this.lastWindowId = settled.input.id;
      }
      if (settled.ended) this.dead = true;
      return settledToOutput(settled, sentCommand);
    }
  }

  private async handleSpecial(settled: SettledUpdate): Promise<void> {
    const mode = settled.special?.filemode === 'read' ? 'restore' : 'save';
    const existing = await this.opts.saveStore.list();
    const name = await this.opts.dialogPort.requestSaveSlot(mode, existing);
    // value は素の名前を返す (VM が get_dirs().working + 名前 + 拡張子のパスにする — 実機採取)
    this.capture.sendEvent({
      type: 'specialresponse',
      response: 'fileref_prompt',
      value: name,
    });
  }

  private async loadVM(): Promise<import('emglken').VMFactory> {
    // index ('emglken') を import すると GPL の tads/scare を含む全 wasm が
    // バンドルに混入するため、必要なエンジンだけ個別 import する
    switch (this.opts.vm) {
      case 'bocfel':
        return (await import('emglken/build/bocfel.js')).default;
      case 'glulxe':
        return (await import('emglken/build/glulxe.js')).default;
      case 'git':
        return (await import('emglken/build/git.js')).default;
    }
  }
}
