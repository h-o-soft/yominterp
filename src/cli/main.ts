/**
 * 対話 CLI: 日本語で Z-machine IF をプレイする。
 *
 *   npm run play            # config.json (なければ config.example.json) を使用
 *   YOMINTERP_MODEL=... npm run play
 *
 * メタコマンド: /quit /raw /undo /retry /score /save /help
 */
import { DEFAULT_LANGUAGE, LANGUAGE_PROFILES } from '../core/i18n/language.js';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { parseStatusLine } from '../core/engine.js';
import { LLMClient } from '../core/llm/client.js';
import { detectMenu, resolveMenuKey } from '../core/menu.js';
import { type AppErrorCode, Session, type TurnResult, sendResolvingPauses } from '../core/session.js';

/** app (core) 由来エラーの日本語文言 (CLI は操作文言を日本語固定) */
const APP_ERROR_JA: Record<AppErrorCode, string> = {
  noCommands: 'LLM がコマンドを生成できませんでした。別の言い方を試してください。',
};
import { EntryTranslator, usefulObjectNames } from '../core/translate/entry.js';
import { ExitTranslator } from '../core/translate/exit.js';
import { extractDictionary } from '../core/zfile/dictionary.js';
import { objectNames } from '../core/zfile/objects.js';
import { FetchTransport, FileCacheStore, FilePromptProvider, JsonlLogger } from './adapters.js';
import { loadConfig, toLLMConfig } from './config.js';
import { DfrotzEngine } from './dfrotz.js';

const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

function printStatus(statusLine: string | undefined): void {
  if (!statusLine) return;
  const s = parseStatusLine(statusLine);
  if (s) {
    console.log(`${CYAN}── ${s.room} ── 得点: ${s.score} ── 手数: ${s.moves} ──${RESET}`);
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger = new JsonlLogger(
    `${cfg.logDir}/session-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`,
  );
  const transport = new FetchTransport(cfg.llm.baseUrl, cfg.llm.apiKey);
  const llm = new LLMClient(transport, toLLMConfig(cfg), logger);

  // LLM 疎通チェック (早期検知)
  try {
    const models = await llm.listModels();
    if (!models.includes(cfg.llm.model)) {
      console.warn(
        `${YELLOW}警告: モデル ${cfg.llm.model} が ${cfg.llm.baseUrl} に見つかりません。` +
          `利用可能: ${models.join(', ')}${RESET}`,
      );
    }
  } catch {
    console.error(
      `LLM サーバー (${cfg.llm.baseUrl}) に接続できません。\n` +
        'LM Studio などの OpenAI 互換サーバーを起動してから再実行してください。',
    );
    process.exit(1);
  }

  // ストーリーファイルから辞書・オブジェクト名を抽出 (起動時に一度だけ)
  const memory = new Uint8Array(readFileSync(cfg.engine.storyFile));
  const vocab = {
    dictWords: extractDictionary(memory).words,
    objectNames: objectNames(memory),
  };

  const prompts = new FilePromptProvider(['prompts', 'fixtures']);
  const language = cfg.language ?? DEFAULT_LANGUAGE;
  const entry = new EntryTranslator(
    llm,
    prompts,
    {
      contextTurns: cfg.context.turns,
      logger,
      language,
    },
    new FileCacheStore(`${cfg.cacheDir}/entry-commands.json`),
  );
  await entry.init(vocab);
  const exit = new ExitTranslator(
    llm,
    prompts,
    new FileCacheStore(`${cfg.cacheDir}/exit-translations.json`),
    logger,
    language,
  );
  // 固有名詞グロッサリ (Cora=コーラ 等の正準表記) をオブジェクト名から構築
  await exit.init(usefulObjectNames(vocab.objectNames));

  const engine = new DfrotzEngine(cfg.engine);
  const session = new Session(engine, entry, cfg.selfCorrect ? {
    maxRetriesPerCommand: cfg.selfCorrect.maxRetriesPerCommand,
    maxLlmCallsPerInput: cfg.selfCorrect.maxLlmCallsPerInput,
    contextTurns: cfg.context.turns,
  } : { maxRetriesPerCommand: 2, maxLlmCallsPerInput: 8, contextTurns: 2 }, logger);

  let showRaw = false;
  let lastInput = '';

  console.log(`${DIM}起動中: ${cfg.engine.storyFile} (dfrotz) / ${cfg.llm.model}${RESET}`);
  let first = await engine.start();
  // 冒頭の keypress 待ち画面 (引用など) は表示して自動で進める
  while (first.kind === 'query') {
    console.log('\n' + (await exit.translate(first.body)) + '\n');
    first = await engine.send('');
  }
  printStatus(first.statusLine);
  console.log('\n' + (await exit.translate(first.body)) + '\n');
  session.pushGameOutput(first.body);
  if (showRaw) console.log(`${DIM}${first.body}${RESET}`);

  // readline は question 待機外に届いた行を捨てるため、行キューで保持する
  // (パイプ入力でのスクリプトプレイ・処理中の先行入力を取りこぼさない)
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const lineQueue: string[] = [];
  const lineWaiters: ((line: string | undefined) => void)[] = [];
  let stdinClosed = false;
  rl.on('line', (l) => {
    const w = lineWaiters.shift();
    if (w) w(l);
    else lineQueue.push(l);
  });
  rl.on('close', () => {
    stdinClosed = true;
    while (lineWaiters.length > 0) lineWaiters.shift()!(undefined);
  });
  /** プロンプトを表示して次の 1 行を読む。stdin 終端なら undefined */
  function ask(promptText: string): Promise<string | undefined> {
    const queued = lineQueue.shift();
    if (queued !== undefined) {
      process.stdout.write(promptText + queued + '\n'); // キュー消費もエコーして可視化
      return Promise.resolve(queued);
    }
    if (stdinClosed) return Promise.resolve(undefined);
    process.stdout.write(promptText);
    return new Promise((resolve) => lineWaiters.push(resolve));
  }

  console.log(`${DIM}日本語で指示してください。/help でメタコマンド一覧。${RESET}`);

  for (;;) {
    const answer = await ask('\n> ');
    if (answer === undefined) break; // stdin が閉じられた (Ctrl-D / パイプ終端)
    const line = answer.trim();
    if (line === '') continue;

    if (line === '/help') {
      console.log(
        '/quit 終了 / /raw 原文表示切替 / /undo 直前の手を取り消し / /retry 直前入力を再実行\n' +
          '/score 得点表示 / /save セーブ / /restore ロード',
      );
      continue;
    }
    if (line === '/quit') break;
    if (line === '/raw') {
      showRaw = !showRaw;
      console.log(`${DIM}原文表示: ${showRaw ? 'ON' : 'OFF'}${RESET}`);
      continue;
    }

    // 直接エンジンに送るメタコマンド
    const direct: Record<string, string> = {
      '/undo': 'undo',
      '/score': 'score',
      '/save': 'save',
      '/restore': 'restore',
    };
    let turn: TurnResult;
    try {
      if (line in direct) {
        const out = await engine.send(direct[line]!);
        printStatus(out.statusLine);
        console.log(`${DIM}[${direct[line]}]${RESET} ` + (await exit.translate(out.body)));
        if (showRaw) console.log(`${DIM}${out.body}${RESET}`);
        continue;
      }
      const input = line === '/retry' ? lastInput : line;
      if (input === '') continue;
      lastInput = input;
      turn = await session.handleUserInput(input);
    } catch (err) {
      console.error(`${YELLOW}エラー: ${String(err)}${RESET}`);
      if (!engine.alive) {
        console.error('エンジンが停止しました。再起動するには CLI を立ち上げ直してください。');
        break;
      }
      continue;
    }

    for (const r of turn.results) {
      // 実際に送った英コマンドを常に表示 (誤変換に気づけるように)
      console.log(`${DIM}> ${r.command}${r.corrected ? ' (自己修正)' : ''}${RESET}`);
      printStatus(r.output.statusLine);
      const ja = await exit.translate(r.output.body);
      if (ja !== '') console.log(ja);
      if (showRaw && r.output.body !== '') console.log(`${DIM}${r.output.body}${RESET}`);
    }

    // 会話メニュー (番号式 / 文字式): プレイヤーが選択肢を選ぶ対話ループ
    let menuOut = turn.results[turn.results.length - 1]?.output;
    let menuSpec = menuOut !== undefined ? detectMenu(menuOut.body) : undefined;
    while (menuOut !== undefined && menuSpec !== undefined) {
      const keys = menuSpec.choices.map((c) => c.key).join('/');
      const endHint = menuSpec.enterEnds
        ? ' / 空 Enter で会話を終える'
        : menuSpec.endKey !== undefined
          ? ` / 空 Enter = ${menuSpec.endKey} (会話を終える)`
          : '';
      const raw = (
        (await ask(`${DIM}(${keys} で選択 / 日本語で指示${endHint})${RESET}\n? `)) ?? ''
      ).trim(); // stdin 終端なら会話を終える扱い
      let selection: string | undefined;
      if (raw === '' || raw === '/end' || LANGUAGE_PROFILES[language].endConversationWords.includes(raw.toLowerCase())) {
        selection = menuSpec.enterEnds ? '' : menuSpec.endKey;
      } else if (/^[A-Za-z0-9]{1,2}$/.test(raw)) {
        selection = resolveMenuKey(menuSpec, raw);
      } else {
        // 日本語指示 → 入口 LLM でキーに変換 ('' = 終了の意図)
        const llmKey = await entry.selectMenuOption(raw, menuOut.body);
        selection =
          llmKey === ''
            ? menuSpec.enterEnds
              ? ''
              : menuSpec.endKey
            : resolveMenuKey(menuSpec, llmKey);
      }
      if (selection === undefined) {
        console.log(`${YELLOW}その選択肢はありません (${keys}${endHint})${RESET}`);
        continue; // メニューは開いたまま → 選び直し
      }
      console.log(`${DIM}> ${selection === '' ? '(会話を終える)' : selection}${RESET}`);
      let out;
      try {
        out = await sendResolvingPauses(engine, selection);
      } catch (err) {
        // 無効入力にゲームが無反応のままのことがある (メニューは開いたまま)
        console.log(`${YELLOW}反応がありません。選び直してください。(${String(err)})${RESET}`);
        continue;
      }
      printStatus(out.statusLine);
      const ja = await exit.translate(out.body);
      if (ja !== '') console.log(ja);
      if (showRaw && out.body !== '') console.log(`${DIM}${out.body}${RESET}`);
      session.pushGameOutput(out.body);
      if (out.kind === 'gameover') {
        turn.gameOver = true;
        break;
      }
      menuOut = out;
      menuSpec = detectMenu(out.body);
    }
    if (turn.error !== undefined) {
      // game 由来 (ゲーム英語) は出口翻訳に回す。app 由来は既にプレイヤー向け文言
      const msg =
        turn.error.source === 'game'
          ? await exit.translate(turn.error.message)
          : APP_ERROR_JA[turn.error.code];
      console.log(`${YELLOW}${msg}${RESET}`);
    }
    if (turn.aborted) {
      console.log(`${DIM}(途中で失敗したため残りの動作は中止しました)${RESET}`);
    }
    if (turn.gameOver) {
      console.log(`${DIM}ゲームが終了しました。${RESET}`);
      break;
    }
  }

  rl.close();
  await engine.stop();
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
