/**
 * core ↔ 環境 (Node / Electron / Tauri) の DI 境界。
 * core はこのインターフェースのみに依存し、実装は cli/adapters.ts (Node) が注入する。
 * 段階2 では同じ ports に対する Electron/Tauri 実装に差し替える
 * (CORS / API key 露出対策も transport 差し替えで吸収)。
 *
 * このファイルは環境非依存 (Node API import 禁止)。
 */

/** プロンプトテンプレート (prompts/*.md, fixtures/*.json) の読み込み */
export interface PromptProvider {
  /** name は相対パス (例: "entry.system.md")。見つからなければ throw */
  load(name: string): Promise<string>;
}

/** 翻訳キャッシュ等の永続 KV ストア */
export interface CacheStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

/** OpenAI 互換 API への HTTP 転送。fetch / main プロセス proxy 等で実装 */
export interface LLMTransport {
  /**
   * POST {baseUrl}{path} (path 例: "/chat/completions")。
   * 応答 JSON をパース済みオブジェクトで返す。HTTP エラーは throw。
   */
  post(path: string, body: unknown, timeoutMs: number): Promise<unknown>;
  /** GET {baseUrl}{path} (疎通チェック用, path 例: "/models") */
  get(path: string, timeoutMs: number): Promise<unknown>;
}

/** 構造化ログ (JSONL)。検証の分析材料 */
export interface EventLogger {
  log(event: Record<string, unknown>): void;
}

export const NULL_LOGGER: EventLogger = { log: () => {} };
