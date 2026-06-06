/**
 * core/ports.ts の Web 実装 (plan.md 段階2 §2)。
 * - BundledPromptProvider: prompts/ を Vite の ?raw import で静的バンドル
 * - IdbCacheStore: IndexedDB (idb-keyval)。不可ならメモリへフォールバック
 * - FetchTransport: 段階1 cli/adapters.ts と同等 (CORS ヒント付き)
 * - RingLogger: リングバッファ + console。API key を含むフィールドは記録しない
 */
import { get as idbGet, set as idbSet } from 'idb-keyval';
import type { CacheStore, EventLogger, LLMTransport, PromptProvider } from '../core/ports.js';

// Vite の ?raw import (ビルド時に文字列として埋め込まれる)
import entrySystem from '../../prompts/entry.system.md?raw';
import exitSystem from '../../prompts/exit.system.md?raw';
import fewshotEntry from '../../prompts/fewshot.entry.json?raw';

export class BundledPromptProvider implements PromptProvider {
  private readonly map: Record<string, string> = {
    'entry.system.md': entrySystem,
    'exit.system.md': exitSystem,
    'fewshot.entry.json': fewshotEntry,
  };
  async load(name: string): Promise<string> {
    const found = this.map[name];
    if (found === undefined) throw new Error(`prompt not found: ${name}`);
    return found;
  }
}

/** IndexedDB ベースの KV (プライベートモード等で失敗したらメモリのみ) */
export class IdbCacheStore implements CacheStore {
  private readonly mem = new Map<string, string>();
  private idbOk = true;

  constructor(private readonly prefix: string) {}

  private key(k: string): string {
    return `${this.prefix}:${k}`;
  }

  async get(key: string): Promise<string | undefined> {
    const hit = this.mem.get(key);
    if (hit !== undefined) return hit;
    if (!this.idbOk) return undefined;
    try {
      const v = await idbGet<string>(this.key(key));
      if (v !== undefined) this.mem.set(key, v);
      return v;
    } catch {
      this.idbOk = false;
      return undefined;
    }
  }

  async set(key: string, value: string): Promise<void> {
    this.mem.set(key, value);
    if (!this.idbOk) return;
    try {
      await idbSet(this.key(key), value);
    } catch {
      this.idbOk = false;
    }
  }
}

export type FetchLike = typeof fetch;

/**
 * fetch による OpenAI 互換転送。接続失敗時に CORS ヒントを付与。
 * fetchFn を差し替え可能 (Tauri ではネイティブ HTTP (@tauri-apps/plugin-http) を
 * 注入し、ブラウザの CORS/PNA 制約なしで 127.0.0.1 の LLM へ直結する)。
 */
export class FetchTransport implements LLMTransport {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchFn: FetchLike = (...args) => fetch(...args),
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey !== '') h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  /**
   * https の公開サイトから http://127.0.0.1 (LM Studio / 中継 proxy) へ接続する
   * ための fetch 追加オプション。Chrome の Local Network Access では
   * targetAddressSpace の明示で mixed-content が許可される (初回はユーザーに
   * 許可プロンプトが出る)。
   */
  private extraInit(): RequestInit {
    if (/^http:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(this.baseUrl)) {
      return { targetAddressSpace: 'loopback' } as RequestInit;
    }
    return {};
  }

  private async handle(res: Response): Promise<unknown> {
    if (!res.ok) {
      const text = (await res.text()).slice(0, 500);
      const err = new Error(`HTTP ${res.status}: ${text}`) as Error & { status: number };
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  private corsHint(err: unknown): Error {
    return new Error(
      `LLM サーバー (${this.baseUrl}) に接続できません。サーバー起動と CORS 設定を確認してください ` +
        `(LM Studio: Settings → Developer → Enable CORS / Ollama: OLLAMA_ORIGINS)。元エラー: ${String(err)}`,
    );
  }

  async post(path: string, body: unknown, timeoutMs: number): Promise<unknown> {
    try {
      const res = await this.fetchFn(this.baseUrl + path, {
        ...this.extraInit(),
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return await this.handle(res);
    } catch (err) {
      if (err instanceof TypeError) throw this.corsHint(err); // ネットワーク/CORS 失敗
      throw err;
    }
  }

  async get(path: string, timeoutMs: number): Promise<unknown> {
    try {
      const res = await this.fetchFn(this.baseUrl + path, {
        ...this.extraInit(),
        headers: this.headers(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return await this.handle(res);
    } catch (err) {
      if (err instanceof TypeError) throw this.corsHint(err);
      throw err;
    }
  }
}

/** API key を含み得るフィールド名 (ログから除外) */
const SECRET_FIELD_RE = /key|token|authorization|secret/i;

export function sanitizeLogEvent(event: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(event)) {
    out[k] = SECRET_FIELD_RE.test(k) ? '[redacted]' : v;
  }
  return out;
}

/** リングバッファロガー (設定画面から JSONL ダウンロード可能) */
export class RingLogger implements EventLogger {
  private readonly buffer: string[] = [];

  constructor(private readonly capacity = 2000) {}

  log(event: Record<string, unknown>): void {
    const entry = JSON.stringify({ ts: new Date().toISOString(), ...sanitizeLogEvent(event) });
    this.buffer.push(entry);
    if (this.buffer.length > this.capacity) this.buffer.shift();
  }

  toJsonl(): string {
    return this.buffer.join('\n');
  }
}
