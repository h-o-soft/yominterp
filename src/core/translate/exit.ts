/**
 * 出口翻訳: ゲームの英語出力 → 日本語。
 * - dfrotz は 80-100 桁でハード改行するため、翻訳前に段落内改行をスペースへ
 *   正規化する (空行 = 段落境界は保持)
 * - 同一英文 (正規化後ハッシュ) の翻訳はセッション内 Map ＋ CacheStore に
 *   キャッシュし、部屋再訪・繰り返しメッセージの待ち時間とコストを削減する
 * - 固有名詞グロッサリ: EN→カタカナの正準表記マップを全翻訳の system プロンプトに
 *   注入し、地の文・会話メニュー・短い断片で表記を一貫させる。
 *     (1) 起動時にオブジェクト名由来の候補から LLM で一括構築 (CacheStore に永続)
 *     (2) 翻訳結果の「カタカナ (原文)」併記から未知の固有名詞を自動蓄積
 *   翻訳キャッシュのキーにはグロッサリ版数ハッシュを含め、表記確定前の訳が
 *   混ざらないようにする。
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

/** グロッサリ構築用プロンプト (人名・呼び名だけを選別させる) */
const GLOSSARY_SYSTEM = `あなたはゲーム翻訳の用語集作成者である。
与えられた語のリストから、人名・愛称・カタカナ表記にすべき固有名詞だけを選び、
1 行ずつ「英語 = カタカナ」の形式で出力する。
- 部屋名・普通名詞・訳すと日本語の普通名詞になるもの (例: Great Hall, kitchen, lamp) は出力しない。
- カタカナは日本語として自然な表記にする (例: Cora = コーラ, Rosie = ロージー)。
- 説明や前置きを書かない。`;

/** 翻訳結果の「カタカナ (原文)」併記から表記を回収する */
const KATAKANA_MENTION_RE = /([ァ-ヴー・]{2,})\s*[(（]([A-Z][A-Za-z'’ -]{1,30})[)）]/g;

export class ExitTranslator {
  private systemPrompt = '';
  private readonly mem = new Map<string, string>();
  private readonly logger: EventLogger;
  /** EN 固有名詞 → カタカナ正準表記 */
  private readonly glossary = new Map<string, string>();
  private glossaryHash = '0';

  constructor(
    private readonly llm: LLMClient,
    private readonly prompts: PromptProvider,
    private readonly cache?: CacheStore,
    logger: EventLogger = NULL_LOGGER,
  ) {
    this.logger = logger;
  }

  /**
   * @param properNounCandidates 固有名詞の候補 (オブジェクト短縮名など)。
   *        LLM で人名等だけを選別してグロッサリを構築する (結果は CacheStore に永続)。
   */
  async init(properNounCandidates: string[] = []): Promise<void> {
    this.systemPrompt = await this.prompts.load('exit.system.md');
    if (properNounCandidates.length > 0) {
      await this.buildGlossary(properNounCandidates);
    }
  }

  /** 現在のグロッサリ (テスト・デバッグ用) */
  glossaryEntries(): [string, string][] {
    return [...this.glossary.entries()];
  }

  private exitModelId(): string {
    return this.llm.config.exitModel ?? this.llm.config.model;
  }

  private async buildGlossary(candidates: string[]): Promise<void> {
    const sorted = [...new Set(candidates)].sort();
    const cacheKey = `exit-glossary:${fnv1a(sorted.join('|') + '@' + this.exitModelId())}`;
    let listing = await this.cache?.get(cacheKey);
    if (listing === undefined) {
      const messages: ChatMessage[] = [
        { role: 'system', content: GLOSSARY_SYSTEM },
        { role: 'user', content: sorted.join('\n') },
      ];
      const opts: { model?: string } = {};
      if (this.llm.config.exitModel !== undefined) opts.model = this.llm.config.exitModel;
      listing = await this.llm.chat(messages, opts);
      await this.cache?.set(cacheKey, listing);
    }
    const candidateSet = new Set(sorted.map((c) => c.toLowerCase()));
    for (const line of listing.split('\n')) {
      const m = /^\s*([A-Za-z'’ .-]+?)\s*[=＝]\s*([ァ-ヴー・]+)\s*$/.exec(line.trim());
      if (!m) continue;
      const en = m[1]!.trim();
      // 候補リスト内の語 (大文字小文字無視) だけ採用 — LLM の創作を防ぐ
      if (!candidateSet.has(en.toLowerCase())) continue;
      this.glossary.set(en, m[2]!);
    }
    this.refreshGlossaryHash();
    this.logger.log({
      event: 'exit.glossary',
      size: this.glossary.size,
      entries: Object.fromEntries(this.glossary),
    });
  }

  private refreshGlossaryHash(): void {
    const serialized = [...this.glossary.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([en, ja]) => `${en}=${ja}`)
      .join('|');
    this.glossaryHash = serialized === '' ? '0' : fnv1a(serialized);
  }

  /** グロッサリ節を付加した system プロンプト */
  private effectiveSystemPrompt(): string {
    if (this.glossary.size === 0) return this.systemPrompt;
    const lines = [...this.glossary.entries()].map(([en, ja]) => `- ${en} = ${ja}`);
    return (
      this.systemPrompt +
      '\n\n# 固有名詞の正準表記 (必ずこの表記を使う。単独の語でも同じ)\n' +
      lines.join('\n')
    );
  }

  /** 翻訳結果の「カタカナ (原文)」併記から未知の固有名詞を自動蓄積する */
  private harvestProperNouns(ja: string): void {
    let grew = false;
    for (const m of ja.matchAll(KATAKANA_MENTION_RE)) {
      const en = m[2]!.trim();
      if (en === '' || this.glossary.has(en)) continue;
      this.glossary.set(en, m[1]!);
      grew = true;
      this.logger.log({ event: 'exit.glossaryHarvest', en, ja: m[1] });
    }
    if (grew) this.refreshGlossaryHash();
  }

  /** 英語本文を日本語へ。空文字は素通し */
  async translate(body: string): Promise<string> {
    const normalized = unwrapParagraphs(body);
    if (normalized === '') return '';
    // グロッサリ版数をキーに含め、表記が違う時期のキャッシュと混ざらないようにする
    const key = `exit:${this.glossaryHash}:${fnv1a(normalized)}`;

    const hit = this.mem.get(key) ?? (await this.cache?.get(key));
    if (hit !== undefined) {
      this.mem.set(key, hit);
      this.logger.log({ event: 'exit.cacheHit', key });
      return hit;
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: this.effectiveSystemPrompt() },
      { role: 'user', content: normalized },
    ];
    const opts: { model?: string } = {};
    if (this.llm.config.exitModel !== undefined) opts.model = this.llm.config.exitModel;
    const ja = (await this.llm.chat(messages, opts)).trim();

    this.mem.set(key, ja);
    await this.cache?.set(key, ja);
    this.logger.log({ event: 'exit.translate', key, chars: normalized.length });
    this.harvestProperNouns(ja);
    return ja;
  }
}
