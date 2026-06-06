/**
 * core/ports.ts の Node 実装。
 * 段階2 では同じ ports に対する Electron/Tauri 実装に差し替える。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CacheStore, EventLogger, LLMTransport, PromptProvider } from '../core/ports.js';

/** fetch による OpenAI 互換 API 転送 */
export class FetchTransport implements LLMTransport {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
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

  async post(path: string, body: unknown, timeoutMs: number): Promise<unknown> {
    const res = await fetch(this.baseUrl + path, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return this.handle(res);
  }

  async get(path: string, timeoutMs: number): Promise<unknown> {
    const res = await fetch(this.baseUrl + path, {
      headers: this.headers(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return this.handle(res);
  }
}

/** 複数ディレクトリを探索するファイルベースの PromptProvider */
export class FilePromptProvider implements PromptProvider {
  constructor(private readonly dirs: string[]) {}

  async load(name: string): Promise<string> {
    for (const dir of this.dirs) {
      const p = join(dir, name);
      if (existsSync(p)) return readFileSync(p, 'utf8');
    }
    throw new Error(`prompt not found: ${name} (searched: ${this.dirs.join(', ')})`);
  }
}

/** 単一 JSON ファイルの永続 KV キャッシュ (翻訳キャッシュ用) */
export class FileCacheStore implements CacheStore {
  private data: Record<string, string> | undefined;

  constructor(private readonly file: string) {}

  private ensureLoaded(): Record<string, string> {
    if (this.data === undefined) {
      try {
        this.data = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, string>;
      } catch {
        this.data = {};
      }
    }
    return this.data;
  }

  async get(key: string): Promise<string | undefined> {
    return this.ensureLoaded()[key];
  }

  async set(key: string, value: string): Promise<void> {
    const data = this.ensureLoaded();
    data[key] = value;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(data, null, 1));
  }
}

/** JSONL 追記ロガー */
export class JsonlLogger implements EventLogger {
  private prepared = false;

  constructor(private readonly file: string) {}

  log(event: Record<string, unknown>): void {
    if (!this.prepared) {
      mkdirSync(dirname(this.file), { recursive: true });
      this.prepared = true;
    }
    appendFileSync(this.file, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
  }
}
