/**
 * 入口変換: 日本語の意図 → ゲームパーサが受理する正規英コマンド列。
 * 「翻訳」ではなく intent → 限定コマンド変換。
 *
 * 応答は弱いローカルモデル前提でプレーン行形式 (1 行 1 コマンド) とし、
 * 余計な行は「英字で始まり先頭語が辞書にある行のみ採用」のフィルタで除去する。
 *
 * このファイルは環境非依存 (Node API import 禁止)。
 */
import { type ChatMessage, type LLMClient } from '../llm/client.js';
import type { EventLogger, PromptProvider } from '../ports.js';
import { NULL_LOGGER } from '../ports.js';

export interface GameVocabulary {
  /** 辞書語彙 (v5: 9 文字切り詰め済み) */
  dictWords: string[];
  /** オブジェクト short name (対象に使える名詞の裏付け) */
  objectNames: string[];
}

/** 直近ターンの文脈 (代名詞・省略・その場参照の解決用) */
export interface TurnContext {
  /** ゲーム英語出力 (原文) */
  gameOutput: string;
  /** そのターンで確定した英コマンド */
  commands: string[];
}

export interface FewShotExample {
  context?: string;
  ja: string;
  commands: string[];
}

export interface RetranslateRequest {
  jaInput: string;
  failedCommand: string;
  parserError: string;
  /** これまでに失敗済みのコマンド (再提案禁止リスト) */
  triedCommands: string[];
  recent: TurnContext[];
}

/** 方向語 + 慣用メタ語 (辞書フィルタの例外として常に許可) */
const ALWAYS_OK = new Set([
  'n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw', 'u', 'd',
  'north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest',
  'up', 'down', 'in', 'out',
  'l', 'look', 'x', 'examine', 'i', 'inventory', 'z', 'wait', 'g', 'again',
  'y', 'yes', 'no',
  'save', 'restore', 'score', 'undo', 'quit', 'restart', 'verbose', 'brief',
]);

/** 辞書の語長に切り詰める (v3: 6 文字 / v4+: 9 文字。実辞書から自動判定) */
export function truncateForDict(word: string, dictWordLen = 9): string {
  return word.slice(0, dictWordLen);
}

/** Inform コンパイラ内部オブジェクト等、プロンプトに不要な名前 */
const INTERNAL_OBJECT_NAMES = new Set([
  'Class', 'Object', 'Routine', 'String', '(Directions)', 'Room', 'object',
  '(Limbo)', 'Darkness', 'Compass',
]);

export function usefulObjectNames(names: string[]): string[] {
  return names.filter((n) => !INTERNAL_OBJECT_NAMES.has(n));
}

/**
 * LLM 応答からコマンド行を抽出する。
 * - コードフェンス・箇条書き記号・番号・プロンプト記号を剥がす
 * - 非 ASCII (日本語の説明文など) を含む行は捨てる
 * - `take lamp. go north` のような 1 行複数コマンドはピリオドで分割
 * - 先頭語が辞書 (9 文字切り詰め) にも ALWAYS_OK にもない行は捨てる
 */
export function parseCommands(
  text: string,
  dictSet: ReadonlySet<string>,
  dictWordLen = 9,
): string[] {
  const out: string[] = [];
  for (let line of text.split('\n')) {
    line = line.trim();
    if (line === '' || line.startsWith('```')) continue;
    line = line.replace(/^([>*•-]|\d+[.)])\s*/, '');
    line = line.replace(/^["'`]+|["'`]+$/g, '');
    if (line === '') continue;
    if (/[^\x20-\x7e]/.test(line)) continue; // 非 ASCII を含む行は説明文とみなす
    for (let seg of line.split(/\.\s+|\.$|;\s*/)) {
      seg = seg.trim().toLowerCase().replace(/\s+/g, ' ');
      if (seg === '') continue;
      if (/^\d+$/.test(seg)) {
        out.push(seg); // メニュー選択の番号
        continue;
      }
      if (!/^[a-z]/.test(seg)) continue;
      if (seg.length > 80) continue;
      const first = seg.split(' ', 1)[0]!;
      if (!ALWAYS_OK.has(first) && !dictSet.has(truncateForDict(first, dictWordLen))) continue;
      out.push(seg);
    }
  }
  return out;
}

export interface EntryTranslatorOptions {
  contextTurns: number;
  logger?: EventLogger;
}

export class EntryTranslator {
  private systemPrompt = '';
  private fewshot: FewShotExample[] = [];
  private dictSet: Set<string> = new Set();
  /** 辞書の切り詰め語長 (実辞書の最大語長から判定: v3=6, v4+=9) */
  private dictWordLen = 9;
  private readonly logger: EventLogger;

  constructor(
    private readonly llm: LLMClient,
    private readonly prompts: PromptProvider,
    private readonly opts: EntryTranslatorOptions,
  ) {
    this.logger = opts.logger ?? NULL_LOGGER;
  }

  async init(vocab: GameVocabulary): Promise<void> {
    const template = await this.prompts.load('entry.system.md');
    const objects = usefulObjectNames(vocab.objectNames);
    this.dictWordLen = Math.max(6, ...vocab.dictWords.map((w) => w.length));
    this.systemPrompt = template
      .replace('{{DICT_WORDS}}', vocab.dictWords.join(' '))
      .replace('{{OBJECT_NAMES}}', objects.join(', '))
      .replaceAll('{{DICT_WORD_LEN}}', String(this.dictWordLen));
    this.dictSet = new Set(vocab.dictWords.map((w) => w.toLowerCase()));
    try {
      this.fewshot = JSON.parse(await this.prompts.load('fewshot.entry.json')) as FewShotExample[];
    } catch {
      this.fewshot = [];
    }
  }

  /** 日本語入力 → 英コマンド列。コマンドが 1 つも取れなければ 1 回だけ言い直させる */
  async translate(jaInput: string, recent: TurnContext[]): Promise<string[]> {
    const messages = this.buildMessages(jaInput, recent);
    const first = await this.chatEntry(messages);
    let commands = parseCommands(first, this.dictSet, this.dictWordLen);
    if (commands.length === 0) {
      const retryMessages: ChatMessage[] = [
        ...messages,
        { role: 'assistant', content: first },
        {
          role: 'user',
          content: 'コマンド行のみを出力し直せ。説明は不要。1 行 1 コマンド。',
        },
      ];
      commands = parseCommands(await this.chatEntry(retryMessages), this.dictSet, this.dictWordLen);
    }
    this.logger.log({ event: 'entry.translate', jaInput, commands });
    return commands;
  }

  /** パーサエラーを受けた言い直し (自己修正ループから呼ばれる) */
  async retranslate(req: RetranslateRequest): Promise<string[]> {
    const messages: ChatMessage[] = [
      { role: 'system', content: this.systemPrompt },
      {
        role: 'user',
        content:
          this.formatUser(this.recentText(req.recent), req.jaInput) +
          '\n\n[状況]\n' +
          `変換したコマンド「${req.failedCommand}」はパーサに拒否された。\n` +
          `パーサのエラー: ${req.parserError}\n` +
          (req.triedCommands.length > 0
            ? `失敗済みコマンド (再提案禁止): ${req.triedCommands.join(' / ')}\n`
            : '') +
          '同じ意図を表す別のコマンドを出力し直せ。1 行 1 コマンド。説明は不要。',
      },
    ];
    const commands = parseCommands(await this.chatEntry(messages), this.dictSet, this.dictWordLen);
    this.logger.log({ event: 'entry.retranslate', failed: req.failedCommand, commands });
    return commands;
  }

  /**
   * 会話メニュー (番号/文字選択) に対する日本語指示を選択肢のキーへ変換する。
   * 会話を終える意図なら '' を返す (終了方法へのマッピングは呼び出し元)。
   */
  async selectMenuOption(jaInput: string, menuBody: string): Promise<string> {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'あなたはゲームの会話メニューの選択器である。メニュー (番号または文字の選択肢) と' +
          'プレイヤーの日本語指示が与えられる。指示に最も合う選択肢の**キーだけ** (例: 1, 2, A, B) を' +
          '出力する。会話を終える・立ち去る意図なら END とだけ出力する。説明・記号・引用符は書かない。',
      },
      {
        role: 'user',
        content: `[メニュー]\n${menuBody}\n\n[プレイヤー指示]\n${jaInput}`,
      },
    ];
    const res = (await this.chatEntry(messages)).trim();
    let selection = '';
    if (!/^end$/i.test(res) && !/\bEND\b/.test(res)) {
      // 1〜2 桁の番号 or 単独の 1 文字 (A〜Z) を拾う
      const m = /\b(\d{1,2})\b/.exec(res) ?? /\b([A-Za-z])\b/.exec(res);
      if (m) selection = m[1]!.toUpperCase();
    }
    this.logger.log({ event: 'entry.selectMenu', jaInput, response: res, selection });
    return selection;
  }

  buildMessages(jaInput: string, recent: TurnContext[]): ChatMessage[] {
    const messages: ChatMessage[] = [{ role: 'system', content: this.systemPrompt }];
    for (const ex of this.fewshot) {
      messages.push({ role: 'user', content: this.formatUser(ex.context ?? '', ex.ja) });
      messages.push({ role: 'assistant', content: ex.commands.join('\n') });
    }
    messages.push({ role: 'user', content: this.formatUser(this.recentText(recent), jaInput) });
    return messages;
  }

  private chatEntry(messages: ChatMessage[]): Promise<string> {
    const opts: { model?: string } = {};
    if (this.llm.config.entryModel !== undefined) opts.model = this.llm.config.entryModel;
    return this.llm.chat(messages, opts);
  }

  private formatUser(context: string, ja: string): string {
    const ctx = context.trim();
    return (ctx !== '' ? `[直近のゲーム出力]\n${ctx}\n\n` : '') + `[プレイヤー入力]\n${ja}`;
  }

  private recentText(recent: TurnContext[]): string {
    const turns = recent.slice(-this.opts.contextTurns);
    const parts: string[] = [];
    for (const t of turns) {
      for (const c of t.commands) parts.push(`> ${c}`);
      if (t.gameOutput.trim() !== '') parts.push(t.gameOutput.trim());
    }
    return parts.join('\n');
  }
}
