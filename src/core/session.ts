/**
 * 1 ユーザー入力のオーケストレーション:
 *   日本語入力 → 入口変換 → コマンド列を順に engine へ → パーサエラーなら自己修正 →
 *   (出口翻訳は CLI/検証側で合成)
 *
 * 自己修正ループ (plan.md §6):
 *   - パーサエラー検知 → 入口 LLM に言い直しを要求 (リトライ ≤ maxRetriesPerCommand)
 *   - 同一コマンドの再提案は棄却 (ループ防止)・失敗履歴を蓄積して明示
 *   - リトライが尽きたら残りコマンドを破棄 (世界状態が想定とズレるため)
 *   - 累計 LLM 呼び出し上限 (maxLlmCallsPerInput) で暴走防止
 *   - 曖昧解決の問い返し (clarify) も同じ言い直しループで処理する
 *     (次プロンプトでフルコマンドを打ち直せば曖昧質問への回答になる)
 *
 * このファイルは環境非依存 (Node API import 禁止)。
 */
import type { EngineOutput, ZEngine } from './engine.js';
import { TALK_MENU_RE, detectMenu } from './menu.js';
import type { EventLogger } from './ports.js';
import { NULL_LOGGER } from './ports.js';
import { classifyParserResponse } from './selfcorrect.js';
import type { EntryTranslator, TurnContext } from './translate/entry.js';

export { TALK_MENU_RE } from './menu.js';

export interface SessionOptions {
  maxRetriesPerCommand: number;
  maxLlmCallsPerInput: number;
  /** 入口プロンプトに含める直近ターン数 */
  contextTurns: number;
  /** パーサエラー判定の追加パターン (設定で拡張) */
  extraParserErrorRes?: RegExp[] | undefined;
  /**
   * 会話メニューを「1」連打で全トピック自動消化する (検証/replay 専用)。
   * 既定 false = メニューは query としてユーザーに返し選択させる (対話プレイ)。
   * transcript は会話全文を 1 step として記録しているため、ゴールデン照合では
   * true にして両側の集約単位を揃える。
   */
  autoExhaustMenus?: boolean | undefined;
}

export interface CommandResult {
  /** 実際に engine に送って確定したコマンド */
  command: string;
  output: EngineOutput;
  /** 自己修正を経て確定したか */
  corrected: boolean;
  retries: number;
}

/** app (core) 由来エラーのコード。Web/CLI 側でローカライズする */
export type AppErrorCode = 'noCommands';

/**
 * ターンで表面化したエラーの出自。
 * - 'game': ゲーム (英語) のパーサエラー等。message を**出口翻訳に回す** (プレイヤー言語へ)。
 * - 'app': アプリ/core 由来。**code** を返し、Web/CLI 側でメッセージカタログから
 *   プレイヤー言語の文言にする (core に言語別文字列を持たない・二重翻訳もしない)。
 */
export type TurnError =
  | { source: 'game'; message: string }
  | { source: 'app'; code: AppErrorCode };

export interface TurnResult {
  /** 確定したコマンドと出力 (送信順) */
  results: CommandResult[];
  /** 解決できず表面化したエラー (出自付き)。source で翻訳要否を判定する */
  error?: TurnError;
  /** 残りコマンドの破棄が起きたか */
  aborted: boolean;
  gameOver: boolean;
  /** この入力で消費した入口 LLM 呼び出し数 (概算) */
  llmCalls: number;
}

/** 自動応答してはいけない「真の質問」(yes-no・ストーリー上の選択) の末尾パターン */
export const REAL_QUESTION_RE = /(\?|yes or no[.:\]]*)\s*$/i;

/**
 * コマンドを送り、自動応答できる中間入力待ちを解決しながら出力を読み切る。
 * 自動応答の範囲は用途で異なる (下の 2 つの公開関数を参照)。
 */
async function sendWithAutoReplies(
  engine: ZEngine,
  command: string,
  pickReply: (body: string) => string | undefined,
  maxAutoReplies: number,
): Promise<EngineOutput> {
  let out = await engine.send(command);
  let merged = out;
  let n = 0;
  while (out.kind === 'query' && n < maxAutoReplies) {
    const reply = pickReply(out.body);
    if (reply === undefined) break; // 自動応答しない query は呼び出し元へ返す
    n++;
    out = await engine.send(reply);
    const next: EngineOutput = {
      raw: merged.raw + out.raw,
      body: merged.body + '\n\n' + out.body,
      kind: out.kind,
    };
    const status = out.statusLine ?? merged.statusLine;
    if (status !== undefined) next.statusLine = status;
    merged = next;
  }
  return merged;
}

/**
 * 検証/replay 専用: 会話メニューも自動で読み切る。
 *   - 会話メニュー ("[ENTER] End conversation") → 「1」を選び続けて全トピック消化
 *     (ghosts.z5 の transcript は全トピック消化の会話全文を 1 step として記録
 *      しているため、ゴールデン照合にはこの集約が必要)
 *   - keypress 待ちの pause/カットシーン画面 (末尾が `?` でない query) → 空行で続行
 *   - `?` で終わる query (yes-no 等の真の質問) は自動応答せず呼び出し元へ返す
 * 出力は連結した 1 つの EngineOutput として返す。
 */
export async function sendExhaustingMenus(
  engine: ZEngine,
  command: string,
  maxAutoReplies = 30,
): Promise<EngineOutput> {
  return sendWithAutoReplies(
    engine,
    command,
    (body) => {
      if (TALK_MENU_RE.test(body)) return '1';
      if (!REAL_QUESTION_RE.test(body.trimEnd())) return ''; // keypress 待ち pause
      return undefined;
    },
    maxAutoReplies,
  );
}

/**
 * 対話プレイ用: pause/カットシーン画面のみ空行で自動続行する。
 * 会話メニューと真の質問 (yes-no 等) は自動応答せず query のまま返し、
 * ユーザーに選択させる (メニュー提示ループは CLI 側)。
 */
export async function sendResolvingPauses(
  engine: ZEngine,
  command: string,
  maxAutoReplies = 30,
): Promise<EngineOutput> {
  return sendWithAutoReplies(
    engine,
    command,
    (body) => {
      if (detectMenu(body) !== undefined) return undefined; // メニューはユーザーが選ぶ
      if (!REAL_QUESTION_RE.test(body.trimEnd())) return ''; // keypress 待ち pause
      return undefined;
    },
    maxAutoReplies,
  );
}

export class Session {
  /** 確定済みターンの履歴 (入口プロンプトの文脈用) */
  readonly history: TurnContext[] = [];
  private readonly logger: EventLogger;

  constructor(
    private readonly engine: ZEngine,
    private readonly entry: EntryTranslator,
    private readonly opts: SessionOptions,
    logger: EventLogger = NULL_LOGGER,
  ) {
    this.logger = logger;
  }

  /** ゲーム側の自発出力 (起動直後の本文など) を文脈履歴に積む */
  pushGameOutput(body: string): void {
    this.history.push({ gameOutput: body, commands: [] });
  }

  async handleUserInput(jaInput: string): Promise<TurnResult> {
    let llmCalls = 1;
    const partial: TurnContext = { gameOutput: '', commands: [] };
    const recent = () => [...this.history, ...(partial.commands.length > 0 ? [partial] : [])];

    const queue = await this.entry.translate(jaInput, recent());
    this.logger.log({ event: 'session.translate', jaInput, queue });
    if (queue.length === 0) {
      return {
        results: [],
        error: { source: 'app', code: 'noCommands' },
        aborted: false,
        gameOver: false,
        llmCalls,
      };
    }

    const results: CommandResult[] = [];
    let aborted = false;
    let gameOver = false;
    let surfacedError: string | undefined;

    while (queue.length > 0) {
      const intended = queue.shift()!;
      let cmd = intended;
      const tried: string[] = [];
      let retries = 0;
      let confirmed = false;

      for (;;) {
        // 対話プレイでは会話メニューを自動消化せずユーザーに返す
        // (検証/replay は autoExhaustMenus=true で全消化し transcript の集約単位に揃える)
        const out = this.opts.autoExhaustMenus
          ? await sendExhaustingMenus(this.engine, cmd)
          : await sendResolvingPauses(this.engine, cmd);
        if (out.kind === 'gameover') {
          results.push({ command: cmd, output: out, corrected: retries > 0, retries });
          this.appendPartial(partial, cmd, out.body);
          gameOver = true;
          break;
        }
        if (out.kind === 'query') {
          // 中間質問 (quit 確認等) はそのままユーザーに返す。残りコマンドは破棄
          results.push({ command: cmd, output: out, corrected: retries > 0, retries });
          this.appendPartial(partial, cmd, out.body);
          confirmed = true;
          if (queue.length > 0) aborted = true;
          queue.length = 0;
          break;
        }
        const check = classifyParserResponse(out.body, this.opts.extraParserErrorRes ?? []);
        if (check.type === 'ok') {
          results.push({ command: cmd, output: out, corrected: retries > 0, retries });
          this.appendPartial(partial, cmd, out.body);
          confirmed = true;
          // 文字選択型メニュー (darkpit 等) は通常の `>` プロンプト = turn として
          // 届く。メニューが開いたら残りコマンドは破棄し、選択は上位層 (CLI) に委ねる
          if (!this.opts.autoExhaustMenus && detectMenu(out.body) !== undefined) {
            if (queue.length > 0) aborted = true;
            queue.length = 0;
          }
          break;
        }

        // パーサエラー / 曖昧問い返し → 言い直し
        tried.push(cmd);
        this.logger.log({
          event: 'session.parserReject',
          type: check.type,
          command: cmd,
          body: out.body,
          retries,
        });
        if (retries >= this.opts.maxRetriesPerCommand || llmCalls >= this.opts.maxLlmCallsPerInput) {
          surfacedError = out.body;
          break;
        }
        retries++;
        llmCalls++;
        const replacements = await this.entry.retranslate({
          jaInput,
          failedCommand: cmd,
          parserError: out.body,
          triedCommands: tried,
          recent: recent(),
        });
        const fresh = replacements.filter((c) => !tried.includes(c));
        if (fresh.length === 0) {
          surfacedError = out.body; // 同一案しか出ない → 打ち切り
          break;
        }
        cmd = fresh[0]!;
        // 言い直しが複数コマンドに分かれた場合は残りを直後に差し込む
        if (fresh.length > 1) queue.unshift(...fresh.slice(1));
      }

      if (gameOver) break;
      if (!confirmed) {
        // リトライが尽きた: 残りコマンドを破棄 (世界状態が想定とズレるため)
        if (queue.length > 0) aborted = true;
        queue.length = 0;
        break;
      }
    }

    // 確定した内容を 1 ターンとして履歴に積む
    if (partial.commands.length > 0) {
      this.history.push(partial);
    }

    const turn: TurnResult = {
      results,
      aborted,
      gameOver,
      llmCalls,
    };
    // surfacedError はゲーム (英語) のパーサエラー → game 出自 (出口翻訳に回す)
    if (surfacedError !== undefined) turn.error = { source: 'game', message: surfacedError };
    this.logger.log({
      event: 'session.turn',
      jaInput,
      commands: results.map((r) => r.command),
      aborted,
      gameOver,
      error: surfacedError ?? null,
      llmCalls,
    });
    return turn;
  }

  private appendPartial(partial: TurnContext, cmd: string, body: string): void {
    partial.commands.push(cmd);
    partial.gameOutput = partial.gameOutput === '' ? body : partial.gameOutput + '\n\n' + body;
  }
}
