/**
 * 入口変換: 日本語の意図 → ゲームパーサが受理する正規英コマンド列。
 * 「翻訳」ではなく intent → 限定コマンド変換。
 *
 * 応答は弱いローカルモデル前提でプレーン行形式 (1 行 1 コマンド) とし、
 * 余計な行は「英字で始まり先頭語が辞書にある行のみ採用」のフィルタで除去する。
 *
 * このファイルは環境非依存 (Node API import 禁止)。
 */
import {
  type LanguageCode,
  DEFAULT_LANGUAGE,
  LANGUAGE_PROFILES,
  promptFileName,
} from '../i18n/language.js';
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
  /** プレイヤー言語の入力例。`ja` は後方互換 (旧 fewshot.entry.json) */
  input?: string;
  /** @deprecated `input` を使う。旧 ja 専用 few-shot との後方互換のため残す */
  ja?: string;
  commands: string[];
}

/** few-shot 例のプレイヤー入力文 (input 優先・ja 後方互換) */
function exampleInput(ex: FewShotExample): string {
  return ex.input ?? ex.ja ?? '';
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

/** 応答テキストをコマンド候補のセグメント列に整形する (辞書照合はしない) */
function cleanSegments(text: string): string[] {
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
      if (seg.length > 80) continue;
      if (!/^[a-z0-9]/.test(seg)) continue;
      out.push(seg);
    }
  }
  return out;
}

/**
 * LLM 応答からコマンド行を抽出する。
 * - コードフェンス・箇条書き記号・番号・プロンプト記号を剥がす
 * - 非 ASCII (日本語の説明文など) を含む行は捨てる
 * - `take lamp. go north` のような 1 行複数コマンドはピリオドで分割
 * - 先頭語が辞書 (切り詰め照合) にも ALWAYS_OK にもない行は捨てる
 */
export function parseCommands(
  text: string,
  dictSet: ReadonlySet<string>,
  dictWordLen = 9,
): string[] {
  const out: string[] = [];
  for (const seg of cleanSegments(text)) {
    if (/^\d+$/.test(seg)) {
      out.push(seg); // メニュー選択の番号
      continue;
    }
    if (!/^[a-z]/.test(seg)) continue;
    const first = seg.split(' ', 1)[0]!;
    if (!ALWAYS_OK.has(first) && !dictSet.has(truncateForDict(first, dictWordLen))) continue;
    out.push(seg);
  }
  return out;
}

/**
 * 辞書照合なしのコマンド候補抽出 (フォールバック用)。
 * 辞書に無い動詞 (例: darkpit に無い fight) でも、形の良い短い行は
 * そのままゲームへ渡し、実パーサの拒否 ("I don't understand") を
 * 自己修正ループに回す方が、盲目的な再生成より安全である
 * (再生成は e4b が "quit" 等の meta へ逃げる事故を起こした — 2026-06-06)。
 * 雑談英文の誤通過を抑えるため、語数と長さを通常より強く制限する。
 */
export function parseCandidates(text: string): string[] {
  return cleanSegments(text).filter((seg) => {
    if (/^\d+$/.test(seg)) return true;
    if (!/^[a-z]/.test(seg)) return false;
    const words = seg.split(' ');
    return words.length <= 6 && seg.length <= 40;
  });
}

/**
 * 破壊的/状態を変える meta コマンドは、プレイヤー入力にその意図が明示されている
 * 時だけ通す (通常行動の誤変換が quit 等に化けて発火するのを防ぐ)。
 * 意図キーワードは言語別 (LANGUAGE_PROFILES[language].metaIntent)。既定 ja。
 */
export function filterUnintendedMetas(
  commands: string[],
  userInput: string,
  language: LanguageCode = DEFAULT_LANGUAGE,
): { kept: string[]; dropped: string[] } {
  const metaIntent = LANGUAGE_PROFILES[language].metaIntent;
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const cmd of commands) {
    const first = cmd.split(' ', 1)[0]!;
    const meta = metaIntent.find(([re]) => re.test(first));
    if (meta !== undefined && !meta[1].test(userInput)) {
      dropped.push(cmd);
    } else {
      kept.push(cmd);
    }
  }
  return { kept, dropped };
}

export interface EntryTranslatorOptions {
  contextTurns: number;
  /** 直近文脈の文字数上限 (長文ゲームでのプロンプト肥大対策)。既定 4096 */
  contextChars?: number;
  logger?: EventLogger;
  /** プレイヤー言語 (既定 ja)。ja は無印プロンプト、他言語は接尾辞 + fail closed */
  language?: LanguageCode;
}

/**
 * 入口の補助プロンプト (LLM への命令)。ja は現状の日本語 (不変)、en は多言語
 * モデルに普遍的に効く英語。プレイヤー言語の auxPromptLang で選ぶ。
 */
interface AuxPrompts {
  retryNormal: string;
  retryMeta: string;
  recentLabel: string;
  inputLabel: string;
  situationLabel: string;
  instructionLabel: string;
  failedLine: (cmd: string) => string;
  parserErrorLine: (err: string) => string;
  triedLine: (list: string) => string;
  retranslateBody: string;
  menuSelectorSystem: string;
  menuLabel: string;
  menuInputLabel: string;
}

const AUX_PROMPTS: Record<'ja' | 'en', AuxPrompts> = {
  ja: {
    retryNormal: 'コマンド行のみを出力し直せ。説明は不要。1 行 1 コマンド。',
    retryMeta:
      'quit や save などの meta コマンドではなく、プレイヤーの行動を表すコマンド行のみを出力し直せ。説明は不要。',
    recentLabel: '[直近のゲーム出力]',
    inputLabel: '[プレイヤー入力]',
    situationLabel: '[状況]',
    instructionLabel: '[指示]',
    failedLine: (cmd) => `変換したコマンド「${cmd}」はパーサに拒否された。`,
    parserErrorLine: (err) => `パーサのエラー: ${err}`,
    triedLine: (list) => `失敗済みコマンド (再提案禁止): ${list}`,
    retranslateBody:
      'プレイヤーの意図はそのままに、語彙・言い回しだけを変えたコマンドを出力し直せ。\n' +
      '- 動詞の意味を変えてはならない (例: 「戦う」を talk や look の行動に置き換えるのは禁止)。\n' +
      '- 対象を勝手に別の物に変えてはならない。\n' +
      '- ゲームの辞書で同じ意図を表せないなら、コマンドを出さず GIVEUP とだけ出力せよ。\n' +
      '1 行 1 コマンド。説明は不要。',
    menuSelectorSystem:
      'あなたはゲームの会話メニューの選択器である。メニュー (番号または文字の選択肢) と' +
      'プレイヤーの日本語指示が与えられる。指示に最も合う選択肢の**キーだけ** (例: 1, 2, A, B) を' +
      '出力する。会話を終える・立ち去る意図なら END とだけ出力する。説明・記号・引用符は書かない。',
    menuLabel: '[メニュー]',
    menuInputLabel: '[プレイヤー指示]',
  },
  en: {
    retryNormal: 'Output only command lines. No explanation. One command per line.',
    retryMeta:
      "Output only command lines for the player's action, not meta-commands like quit or save. No explanation.",
    recentLabel: '[Recent game output]',
    inputLabel: '[Player input]',
    situationLabel: '[Situation]',
    instructionLabel: '[Instruction]',
    failedLine: (cmd) => `The command "${cmd}" was rejected by the parser.`,
    parserErrorLine: (err) => `Parser error: ${err}`,
    triedLine: (list) => `Already-failed commands (do not propose again): ${list}`,
    retranslateBody:
      "Keep the player's intent unchanged; only rephrase the vocabulary/wording of the command.\n" +
      '- Do not change the verb meaning (e.g. do not turn "fight" into talk or look).\n' +
      '- Do not switch the target to a different object.\n' +
      "- If the game's dictionary cannot express the same intent, output nothing but GIVEUP.\n" +
      'One command per line. No explanation.',
    menuSelectorSystem:
      "You are a selector for the game's conversation menu. You are given the menu (numbered or " +
      "lettered choices) and the player's instruction. Output ONLY the key of the best-matching " +
      'choice (e.g. 1, 2, A, B). If the intent is to end or leave the conversation, output only END. ' +
      'No explanation, symbols, or quotes.',
    menuLabel: '[Menu]',
    menuInputLabel: '[Player instruction]',
  },
};

export class EntryTranslator {
  private systemPrompt = '';
  private fewshot: FewShotExample[] = [];
  private dictSet: Set<string> = new Set();
  /** 辞書の切り詰め語長 (実辞書の最大語長から判定: v3=6, v4+=9) */
  private dictWordLen = 9;
  private readonly aux: AuxPrompts;
  private readonly logger: EventLogger;

  constructor(
    private readonly llm: LLMClient,
    private readonly prompts: PromptProvider,
    private readonly opts: EntryTranslatorOptions,
  ) {
    this.logger = opts.logger ?? NULL_LOGGER;
    // 補助プロンプトの言語 (ja=日本語/他=英語)。ja は現状不変
    this.aux = AUX_PROMPTS[LANGUAGE_PROFILES[opts.language ?? DEFAULT_LANGUAGE].auxPromptLang];
  }

  async init(vocab: GameVocabulary): Promise<void> {
    const lang = this.opts.language ?? DEFAULT_LANGUAGE;
    // ja は無印 (canonical)、他言語は接尾辞。非 ja でファイルが無ければ
    // PromptProvider.load が throw する (fail closed: 暗黙の日本語化をしない)。
    const template = await this.prompts.load(promptFileName('entry.system.md', lang));
    const objects = usefulObjectNames(vocab.objectNames);
    this.dictWordLen = Math.max(6, ...vocab.dictWords.map((w) => w.length));
    this.systemPrompt = template
      .replace('{{DICT_WORDS}}', vocab.dictWords.join(' '))
      .replace('{{OBJECT_NAMES}}', objects.join(', '))
      .replaceAll('{{DICT_WORD_LEN}}', String(this.dictWordLen));
    this.dictSet = new Set(vocab.dictWords.map((w) => w.toLowerCase()));
    // few-shot: ja は parse 失敗を空配列で握りつぶす (後方互換)。非 ja は
    // missing / JSON 不正も fail closed (起動エラーへ寄せる)。
    const fewshotName = promptFileName('fewshot.entry.json', lang);
    if (lang === DEFAULT_LANGUAGE) {
      try {
        this.fewshot = JSON.parse(await this.prompts.load(fewshotName)) as FewShotExample[];
      } catch {
        this.fewshot = [];
      }
    } else {
      this.fewshot = JSON.parse(await this.prompts.load(fewshotName)) as FewShotExample[];
    }
  }

  /** 応答からコマンドを抽出 (辞書フィルタ → 候補フォールバック → meta ガード) */
  private extractCommands(raw: string, jaInput: string): { kept: string[]; dropped: string[] } {
    let commands = parseCommands(raw, this.dictSet, this.dictWordLen);
    if (commands.length === 0) {
      // 辞書外の動詞でも形の良い行はそのまま通す (実パーサの拒否 → 自己修正へ)
      commands = parseCandidates(raw);
    }
    // 破壊的 meta (quit 等) はプレイヤー入力に意図がある時だけ (言語別キーワード)
    const result = filterUnintendedMetas(commands, jaInput, this.opts.language ?? DEFAULT_LANGUAGE);
    if (result.dropped.length > 0) {
      this.logger.log({ event: 'entry.metaDropped', jaInput, dropped: result.dropped });
    }
    return result;
  }

  /** 日本語入力 → 英コマンド列。コマンドが 1 つも取れなければ 1 回だけ言い直させる */
  async translate(jaInput: string, recent: TurnContext[]): Promise<string[]> {
    const messages = this.buildMessages(jaInput, recent);
    const first = await this.chatEntry(messages);
    let { kept, dropped } = this.extractCommands(first, jaInput);
    if (kept.length === 0) {
      const instruction = dropped.length > 0 ? this.aux.retryMeta : this.aux.retryNormal;
      const retryMessages: ChatMessage[] = [
        ...messages,
        { role: 'assistant', content: first },
        { role: 'user', content: instruction },
      ];
      ({ kept } = this.extractCommands(await this.chatEntry(retryMessages), jaInput));
    }
    this.logger.log({ event: 'entry.translate', jaInput, commands: kept });
    return kept;
  }

  /**
   * パーサエラーを受けた言い直し (自己修正ループから呼ばれる)。
   *
   * 言い直しは「同一意図の言い換え」に限定する。意図を変えた代替コマンド
   * (例: 戦う → talk) を自己修正が選ぶと accepted-wrong を自作してしまうため、
   * 辞書の語彙で同じ意図を表せない場合は GIVEUP させて空を返し、
   * 呼び出し元 (session) がゲームの拒否メッセージをそのままユーザーに見せる。
   */
  async retranslate(req: RetranslateRequest): Promise<string[]> {
    const messages: ChatMessage[] = [
      { role: 'system', content: this.systemPrompt },
      {
        role: 'user',
        content:
          this.formatUser(this.recentText(req.recent), req.jaInput) +
          `\n\n${this.aux.situationLabel}\n` +
          this.aux.failedLine(req.failedCommand) + '\n' +
          this.aux.parserErrorLine(req.parserError) + '\n' +
          (req.triedCommands.length > 0
            ? this.aux.triedLine(req.triedCommands.join(' / ')) + '\n'
            : '') +
          `${this.aux.instructionLabel}\n` +
          this.aux.retranslateBody,
      },
    ];
    const raw = await this.chatEntry(messages);
    // GIVEUP = 同一意図の言い換えが作れない → 空を返してゲームの拒否を表面化させる
    if (/\bGIVE ?UP\b/i.test(raw)) {
      this.logger.log({ event: 'entry.retranslateGiveup', failed: req.failedCommand });
      return [];
    }
    // 言い直しでも破壊的 meta への退避は許さない
    const { kept } = this.extractCommands(raw, req.jaInput);
    this.logger.log({ event: 'entry.retranslate', failed: req.failedCommand, commands: kept });
    return kept;
  }

  /**
   * 会話メニュー (番号/文字選択) に対する日本語指示を選択肢のキーへ変換する。
   * 会話を終える意図なら '' を返す (終了方法へのマッピングは呼び出し元)。
   */
  async selectMenuOption(jaInput: string, menuBody: string): Promise<string> {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: this.aux.menuSelectorSystem,
      },
      {
        role: 'user',
        content: `${this.aux.menuLabel}\n${menuBody}\n\n${this.aux.menuInputLabel}\n${jaInput}`,
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
      messages.push({ role: 'user', content: this.formatUser(ex.context ?? '', exampleInput(ex)) });
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
    return (
      (ctx !== '' ? `${this.aux.recentLabel}\n${ctx}\n\n` : '') + `${this.aux.inputLabel}\n${ja}`
    );
  }

  private recentText(recent: TurnContext[]): string {
    const turns = recent.slice(-this.opts.contextTurns);
    const parts: string[] = [];
    for (const t of turns) {
      for (const c of t.commands) parts.push(`> ${c}`);
      if (t.gameOutput.trim() !== '') parts.push(t.gameOutput.trim());
    }
    let text = parts.join('\n');
    // 長文ゲーム対策: 文字数上限を超えたら古い側 (先頭) から切り詰める
    const cap = this.opts.contextChars ?? 4096;
    if (text.length > cap) {
      text = '…' + text.slice(text.length - cap);
    }
    return text;
  }
}
