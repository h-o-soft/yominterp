/**
 * DfrotzEngine: dfrotz (Frotz dumb モード) を子プロセスとして駆動する ZEngine 実装。
 *
 * プロンプト検知は状態機械:
 *   WaitingOutput --(無音 quiescenceMs & バッファ末尾 `>`)--> turn 確定
 *   WaitingOutput --(無音 queryTimeoutMs & 既知 query パターン)--> query 確定
 *   WaitingOutput --(無音 hardTimeoutMs)--> Timeout エラー
 *   (子プロセス exit)--> gameover 確定 / dead 化
 *
 * 実機採取 (frotz 2.55, ghosts.z5, 2026-06-06):
 *   - 通常ターン: 出力末尾が `\n>` で入力待ち。コマンド処理時は `> ` の直後に
 *     ステータス行が再描画される (`> Great Hall ... Score: 0     Moves: 0`)
 *   - query: `>Are you sure you want to quit?` のように `>` で終わらず待つ
 *   - `-R <dir>` 制限モードでは save/restore のファイル名は自動命名され
 *     filename プロンプトは出ない
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import {
  type EngineOutput,
  type OutputKind,
  type ZEngine,
  splitRawOutput,
  looksGameOver,
} from '../core/engine.js';

export interface DfrotzOptions {
  dfrotzPath: string;
  storyFile: string;
  seed: number;
  workDir: string;
  width: number;
  /** プロンプト確定に必要な無音時間 (ms)。実機採取に基づく既定 60 */
  quiescenceMs: number;
  /** `>` で終わらない入力待ち (yes-no 等) の確定無音時間 (ms) */
  queryTimeoutMs: number;
  /** 1 コマンドのハードタイムアウト (ms) */
  hardTimeoutMs: number;
  /** query とみなす既知パターン (設定で拡張可能) */
  queryPatterns?: RegExp[] | undefined;
}

/** `>` で終わらない入力待ちの既知パターン (実機採取で確定・設定で拡張) */
export const DEFAULT_QUERY_RES: RegExp[] = [
  /\? *$/, // "Are you sure you want to quit?" 等の yes-no
  /Please enter a filename/i,
  /press (any key|SPACE|RETURN|ENTER)/i,
  // ghosts.z5 冒頭の引用画面のような keypress 待ち pause:
  // 出力が空行で終わったまま `>` が来ない (実機採取 2026-06-06)
  /\n\n$/,
];

/** 子プロセスの差し替え点 (ユニットテストでフェイクを注入) */
export interface ChildLike {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write(data: string): unknown };
  on(event: 'exit' | 'error', listener: (...args: unknown[]) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

export type SpawnFn = (opts: DfrotzOptions) => ChildLike;

const defaultSpawn: SpawnFn = (opts) => {
  mkdirSync(opts.workDir, { recursive: true });
  const args = [
    '-p', // ASCII 化
    '-m', // MORE プロンプト抑止
    '-q', // 起動メッセージ抑止
    '-s', String(opts.seed), // 乱数固定 (transcript 検証の再現性の要)
    '-R', opts.workDir, // 読み書きパス制限
    '-w', String(opts.width),
    opts.storyFile,
  ];
  return spawn(opts.dfrotzPath, args, { stdio: ['pipe', 'pipe', 'pipe'] }) as unknown as ChildLike;
};

interface Pending {
  resolve: (out: EngineOutput) => void;
  reject: (err: Error) => void;
}

export class EngineTimeoutError extends Error {
  constructor(
    message: string,
    public readonly partialOutput: string,
  ) {
    super(message);
    this.name = 'EngineTimeoutError';
  }
}

export class DfrotzEngine implements ZEngine {
  private child: ChildLike | undefined;
  private buffer = '';
  private stderrBuf = '';
  private pending: Pending | undefined;
  private quiescenceTimer: NodeJS.Timeout | undefined;
  private queryTimer: NodeJS.Timeout | undefined;
  private hardTimer: NodeJS.Timeout | undefined;
  private exited = false;
  private readonly queryRes: RegExp[];

  constructor(
    private readonly opts: DfrotzOptions,
    private readonly spawnFn: SpawnFn = defaultSpawn,
  ) {
    this.queryRes = opts.queryPatterns ?? DEFAULT_QUERY_RES;
  }

  get alive(): boolean {
    return this.child !== undefined && !this.exited;
  }

  get stderrLog(): string {
    return this.stderrBuf;
  }

  async start(): Promise<EngineOutput> {
    if (this.child) throw new Error('engine already started');
    this.child = this.spawnFn(this.opts);
    this.child.stdout.on('data', (chunk: Buffer | string) => this.onData(String(chunk)));
    this.child.stderr.on('data', (chunk: Buffer | string) => {
      this.stderrBuf += String(chunk);
    });
    this.child.on('exit', () => this.onExit());
    this.child.on('error', (err) => this.onError(err as Error));
    return this.waitForOutput();
  }

  async send(command: string): Promise<EngineOutput> {
    if (!this.alive) throw new Error('engine is not running');
    if (this.pending) throw new Error('previous command still in flight');
    this.child!.stdin.write(command + '\n');
    return this.waitForOutput();
  }

  async stop(): Promise<void> {
    if (!this.child || this.exited) return;
    const child = this.child;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 1000);
      child.on('exit', () => {
        clearTimeout(t);
        resolve();
      });
      child.kill('SIGTERM');
    });
    this.exited = true;
    this.clearTimers();
  }

  // ---- 内部状態機械 ----

  private waitForOutput(): Promise<EngineOutput> {
    return new Promise<EngineOutput>((resolve, reject) => {
      this.pending = { resolve, reject };
      this.hardTimer = setTimeout(() => {
        const partial = this.buffer;
        this.buffer = '';
        this.settleReject(
          new EngineTimeoutError(
            `engine output timed out after ${this.opts.hardTimeoutMs}ms`,
            partial,
          ),
        );
      }, this.opts.hardTimeoutMs);
      // 既にバッファ済みのデータがある場合に備えて評価をスケジュール
      this.armQuiescence();
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (!this.pending) return; // 想定外の自発出力はバッファに溜め、次の wait で回収
    this.armQuiescence();
  }

  private armQuiescence(): void {
    if (this.quiescenceTimer) clearTimeout(this.quiescenceTimer);
    if (this.queryTimer) {
      clearTimeout(this.queryTimer);
      this.queryTimer = undefined;
    }
    this.quiescenceTimer = setTimeout(() => this.evaluate(), this.opts.quiescenceMs);
  }

  /** 無音 quiescenceMs 経過時の判定 */
  private evaluate(): void {
    if (!this.pending) return;
    const trimmed = this.buffer.replace(/[ \t]+$/, '');
    if (this.endsWithPrompt(trimmed)) {
      this.settleResolve('turn');
      return;
    }
    if (this.buffer.length === 0) return; // まだ何も来ていない (hard timeout 任せ)
    // `>` で終わらない入力待ちの可能性 → queryTimeoutMs まで追加待機して再判定
    const extra = Math.max(0, this.opts.queryTimeoutMs - this.opts.quiescenceMs);
    this.queryTimer = setTimeout(() => {
      if (!this.pending) return;
      const tail = this.buffer.replace(/[ \t]+$/, '');
      if (this.endsWithPrompt(tail)) {
        this.settleResolve('turn');
      } else if (this.queryRes.some((re) => re.test(tail.slice(-200)))) {
        this.settleResolve('query');
      }
      // 既知パターン外の無音は hard timeout で Timeout として報告 (query と混同しない)
    }, extra);
  }

  /** バッファ末尾がプロンプト `>` か (行頭の `>` のみプロンプトとみなす) */
  private endsWithPrompt(text: string): boolean {
    if (!text.endsWith('>')) return false;
    return text.length === 1 || text[text.length - 2] === '\n';
  }

  private onExit(): void {
    this.exited = true;
    if (this.pending) {
      // 終了直前の出力 (RESTART 問い合わせ後の y 等) を gameover として返す
      this.settleResolve('gameover');
    }
  }

  private onError(err: Error): void {
    this.exited = true;
    this.settleReject(new Error(`dfrotz process error: ${err.message}`));
  }

  private settleResolve(baseKind: OutputKind): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    this.clearTimers();
    const raw = this.buffer;
    this.buffer = '';
    const { body, statusLine } = splitRawOutput(raw);
    const kind: OutputKind =
      baseKind === 'turn' && looksGameOver(body) ? 'gameover' : baseKind;
    const out: EngineOutput = { raw, body, kind };
    if (statusLine !== undefined) out.statusLine = statusLine;
    pending.resolve(out);
  }

  private settleReject(err: Error): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    this.clearTimers();
    pending.reject(err);
  }

  private clearTimers(): void {
    if (this.quiescenceTimer) clearTimeout(this.quiescenceTimer);
    if (this.queryTimer) clearTimeout(this.queryTimer);
    if (this.hardTimer) clearTimeout(this.hardTimer);
    this.quiescenceTimer = this.queryTimer = this.hardTimer = undefined;
  }
}
