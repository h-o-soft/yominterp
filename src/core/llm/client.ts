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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class LLMClient {
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

  /** chat completion を 1 回呼び、テキスト応答を返す (指数バックオフで 2 回まで再試行) */
  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    const body = {
      model: opts.model ?? this.config.model,
      messages,
      temperature: opts.temperature ?? this.config.temperature,
      max_tokens: opts.maxTokens ?? this.config.maxTokens,
      stream: false,
    };
    const maxAttempts = 3;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const startedAt = nowMs();
      try {
        const res = (await this.transport.post('/chat/completions', body, this.config.timeoutMs)) as {
          choices?: { message?: { content?: string } }[];
        };
        const content = res.choices?.[0]?.message?.content;
        this.logger.log({
          event: 'llm.chat',
          model: body.model,
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
          model: body.model,
          attempt,
          ms: nowMs() - startedAt,
          error: String(err),
        });
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
