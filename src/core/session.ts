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
import type { EventLogger } from './ports.js';
import { NULL_LOGGER } from './ports.js';
import { classifyParserResponse } from './selfcorrect.js';
import type { EntryTranslator, TurnContext } from './translate/entry.js';

export interface SessionOptions {
  maxRetriesPerCommand: number;
  maxLlmCallsPerInput: number;
  /** 入口プロンプトに含める直近ターン数 */
  contextTurns: number;
  /** パーサエラー判定の追加パターン (設定で拡張) */
  extraParserErrorRes?: RegExp[] | undefined;
}

export interface CommandResult {
  /** 実際に engine に送って確定したコマンド */
  command: string;
  output: EngineOutput;
  /** 自己修正を経て確定したか */
  corrected: boolean;
  retries: number;
}

export interface TurnResult {
  /** 確定したコマンドと出力 (送信順) */
  results: CommandResult[];
  /** 解決できず表面化したパーサエラー等 (英語原文。CLI が和訳して提示) */
  error?: string;
  /** 残りコマンドの破棄が起きたか */
  aborted: boolean;
  gameOver: boolean;
  /** この入力で消費した入口 LLM 呼び出し数 (概算) */
  llmCalls: number;
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
        error: 'LLM がコマンドを生成できませんでした。別の言い方を試してください。',
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
        const out = await this.engine.send(cmd);
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
    if (surfacedError !== undefined) turn.error = surfacedError;
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
