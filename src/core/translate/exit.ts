/**
 * 出口翻訳: ゲームの英語出力 → 日本語。
 * - dfrotz は 80-100 桁でハード改行するため、翻訳前に段落内改行をスペースへ
 *   正規化する (空行 = 段落境界は保持)
 * - 同一英文 (正規化後ハッシュ) の翻訳はセッション内 Map ＋ CacheStore に
 *   キャッシュし、部屋再訪・繰り返しメッセージの待ち時間とコストを削減する
 *
 * このファイルは環境非依存 (Node API import 禁止)。
 */
import type { ChatMessage, LLMClient } from '../llm/client.js';
import type { CacheStore, EventLogger, PromptProvider } from '../ports.js';
import { NULL_LOGGER } from '../ports.js';

/** 段落内のハード改行をスペースに正規化する (空行は段落境界として保持) */
export function unwrapParagraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((para) => para.split('\n').map((l) => l.trim()).join(' ').trim())
    .filter((para) => para !== '')
    .join('\n\n');
}

/** 依存なしの軽量ハッシュ (FNV-1a 32bit) — キャッシュキー用 */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export class ExitTranslator {
  private systemPrompt = '';
  private readonly mem = new Map<string, string>();
  private readonly logger: EventLogger;

  constructor(
    private readonly llm: LLMClient,
    private readonly prompts: PromptProvider,
    private readonly cache?: CacheStore,
    logger: EventLogger = NULL_LOGGER,
  ) {
    this.logger = logger;
  }

  async init(): Promise<void> {
    this.systemPrompt = await this.prompts.load('exit.system.md');
  }

  /** 英語本文を日本語へ。空文字は素通し */
  async translate(body: string): Promise<string> {
    const normalized = unwrapParagraphs(body);
    if (normalized === '') return '';
    const key = `exit:${fnv1a(normalized)}`;

    const hit = this.mem.get(key) ?? (await this.cache?.get(key));
    if (hit !== undefined) {
      this.mem.set(key, hit);
      this.logger.log({ event: 'exit.cacheHit', key });
      return hit;
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: this.systemPrompt },
      { role: 'user', content: normalized },
    ];
    const opts: { model?: string } = {};
    if (this.llm.config.exitModel !== undefined) opts.model = this.llm.config.exitModel;
    const ja = (await this.llm.chat(messages, opts)).trim();

    this.mem.set(key, ja);
    await this.cache?.set(key, ja);
    this.logger.log({ event: 'exit.translate', key, chars: normalized.length });
    return ja;
  }
}
