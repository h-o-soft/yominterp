/**
 * OpenAI 互換 API (/v1/chat/completions) の薄いクライアント。
 * HTTP は LLMTransport (DI) に委ね、ここではリトライ・応答整形のみ扱う。
 *
 * このファイルは環境非依存 (Node API import 禁止)。
 */
import { type EventLogger, type LLMTransport, NULL_LOGGER } from '../ports.js';

export interface LLMConfig {
  model: string;
  /** 入口変換用モデル (省略時 model) */
  entryModel?: string | undefined;
  /** 出口翻訳用モデル (省略時 model) */
  exitModel?: string | undefined;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export class LLMError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'LLMError';
  }
}

/** transport が投げるエラーに status (HTTP) が乗っている想定 */
function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  if (status === undefined) return true; // 接続失敗 / タイムアウト
  return status >= 500;
}

/**
 * HTTP 400 の「このパラメータは非対応」エラーから対象パラメータ名を抽出する。
 * OpenAI の新しめのモデル (o1/o3/gpt-5 系) は max_tokens を廃止して
 * max_completion_tokens を要求し、temperature も既定値以外を拒否する。
 * エラー本文の例:
 *   "Unsupported parameter: 'max_tokens' is not supported with this model.
 *    Use 'max_completion_tokens' instead." (param: max_tokens,
 *    code: unsupported_parameter)
 * transport はエラーメッセージに応答本文を含める (HTTP 400: {...}) ので、
 * 文字列から param を拾う (LM Studio / Ollama は max_tokens を受けるため、
 * ここに来るのは本家 OpenAI 等の互換サーバのみ)。
 */
function unsupportedParamFrom(
  err: unknown,
): { param: string; kind: 'parameter' | 'value' } | undefined {
  if ((err as { status?: number }).status !== 400) return undefined;
  const msg = String((err as Error).message ?? err);
  // kind は code (unsupported_parameter / unsupported_value) を優先し、
  // 無ければメッセージの "Unsupported parameter/value" 表現から推定する。
  // param と kind の「組」で判定する (例: unsupported_value + max_tokens を
  // 改名と誤検出して状態を恒久変更しないため)
  const kind = (/['"]?code['"]?\s*:\s*['"]unsupported_(parameter|value)['"]/.exec(msg)?.[1] ??
    /Unsupported (parameter|value)/i.exec(msg)?.[1]?.toLowerCase()) as
    | 'parameter'
    | 'value'
    | undefined;
  if (kind !== 'parameter' && kind !== 'value') return undefined;
  const param =
    /['"]?param['"]?\s*:\s*['"]([\w.]+)['"]/.exec(msg)?.[1] ??
    /Unsupported (?:parameter|value)s?:?\s*['"]([\w.]+)['"]/i.exec(msg)?.[1];
  if (param === undefined) return undefined;
  return { param, kind };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class LLMClient {
  /**
   * トークン上限のパラメータ名。OpenAI の新モデルが max_tokens を 400 で拒否
   * したら max_completion_tokens に切り替え、以後この接続では切替後を使う
   * (LM Studio / Ollama / 旧 OpenAI は従来どおり max_tokens)。
   */
  private tokenParam: 'max_tokens' | 'max_completion_tokens' = 'max_tokens';
  /** temperature が unsupported_value (固定値モデル) なら以後省略する */
  private omitTemperature = false;

  constructor(
    private readonly transport: LLMTransport,
    readonly config: LLMConfig,
    private readonly logger: EventLogger = NULL_LOGGER,
  ) {}

  /** /models による疎通チェック。利用可能なモデル id を返す */
  async listModels(): Promise<string[]> {
    const res = (await this.transport.get('/models', 5000)) as {
      data?: { id?: string }[];
    };
    return (res.data ?? []).map((m) => m.id ?? '').filter((id) => id !== '');
  }

  /** 現在の互換設定で chat completion のリクエスト body を組み立てる */
  private chatBody(messages: ChatMessage[], opts: ChatOptions): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: opts.model ?? this.config.model,
      messages,
      [this.tokenParam]: opts.maxTokens ?? this.config.maxTokens,
      stream: false,
    };
    if (!this.omitTemperature) body.temperature = opts.temperature ?? this.config.temperature;
    return body;
  }

  /**
   * 400 unsupported_parameter/value に対し、互換設定を切り替えて再試行可能なら
   * true を返す。
   * - max_tokens 非対応 (OpenAI o1/o3/gpt-5 系) → max_completion_tokens へ改名
   * - temperature 非対応 (固定値モデル) → 以後省略
   * 再試行可否は「この呼び出しが送った body が旧形式だったか」で判定する —
   * 並行呼び出しで他のリクエストが先に切り替えた後でも、自分の body が古ければ
   * 再試行する (状態は既に新しいので二重切替はしない)。再試行後の body は
   * 新形式で組まれるため、同じ 400 が続いても再発火せず構造的に終了する。
   */
  private adaptToUnsupportedParam(err: unknown, sentBody: Record<string, unknown>): boolean {
    const u = unsupportedParamFrom(err);
    if (u === undefined) return false;
    if (u.param === 'max_tokens' && u.kind === 'parameter') {
      if (this.tokenParam === 'max_tokens') {
        this.tokenParam = 'max_completion_tokens';
        this.logger.log({ event: 'llm.paramAdapt', param: u.param, to: 'max_completion_tokens' });
      }
      return 'max_tokens' in sentBody;
    }
    if (u.param === 'temperature' && u.kind === 'value') {
      if (!this.omitTemperature) {
        this.omitTemperature = true;
        this.logger.log({ event: 'llm.paramAdapt', param: u.param, to: 'omitted' });
      }
      return 'temperature' in sentBody;
    }
    return false;
  }

  /** chat completion を 1 回呼び、テキスト応答を返す (指数バックオフで 2 回まで再試行) */
  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    const model = opts.model ?? this.config.model;
    const maxAttempts = 3;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // body は試行ごとに組み直す (上の互換切替を反映するため)
      const body = this.chatBody(messages, opts);
      const startedAt = nowMs();
      try {
        const res = (await this.transport.post('/chat/completions', body, this.config.timeoutMs)) as {
          choices?: { message?: { content?: string } }[];
        };
        const content = res.choices?.[0]?.message?.content;
        this.logger.log({
          event: 'llm.chat',
          model,
          attempt,
          ms: nowMs() - startedAt,
          ok: content !== undefined,
        });
        if (content === undefined || content === null) {
          throw new LLMError('LLM returned an empty response');
        }
        return content;
      } catch (err) {
        lastErr = err;
        this.logger.log({
          event: 'llm.error',
          model,
          attempt,
          ms: nowMs() - startedAt,
          error: String(err),
        });
        // パラメータ非互換 (400) は原因が確定的なので、設定を切り替えて
        // 試行回数を消費せずに即やり直す (再試行後の body は新形式になるので
        // 同種の発火は呼び出しごとに高々 1 回)
        if (this.adaptToUnsupportedParam(err, body)) {
          attempt--;
          continue;
        }
        if (attempt < maxAttempts && isRetryable(err)) {
          await sleep(500 * 4 ** (attempt - 1)); // 500ms, 2s
          continue;
        }
        break;
      }
    }
    throw lastErr instanceof LLMError
      ? lastErr
      : new LLMError(`LLM request failed: ${String(lastErr)}`, lastErr);
  }
}

function nowMs(): number {
  return globalThis.performance?.now() ?? 0;
}
