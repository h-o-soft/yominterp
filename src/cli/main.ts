/**
 * 対話 CLI: 日本語で Z-machine IF をプレイする。
 *
 *   npm run play            # config.json (なければ config.example.json) を使用
 *   ZLLM_MODEL=... npm run play
 *
 * メタコマンド: /quit /raw /undo /retry /score /save /help
 */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { parseStatusLine } from '../core/engine.js';
import { LLMClient } from '../core/llm/client.js';
import { Session, type TurnResult } from '../core/session.js';
import { EntryTranslator } from '../core/translate/entry.js';
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
  const entry = new EntryTranslator(llm, prompts, {
    contextTurns: cfg.context.turns,
    logger,
  });
  await entry.init(vocab);
  const exit = new ExitTranslator(
    llm,
    prompts,
    new FileCacheStore(`${cfg.cacheDir}/exit-translations.json`),
    logger,
  );
  await exit.init();

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

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`${DIM}日本語で指示してください。/help でメタコマンド一覧。${RESET}`);

  for (;;) {
    let line: string;
    try {
      line = (await rl.question('\n> ')).trim();
    } catch {
      break; // stdin が閉じられた (Ctrl-D / パイプ終端)
    }
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
    if (turn.error !== undefined) {
      const isJa = /[^\x00-\x7f]/.test(turn.error);
      console.log(`${YELLOW}${isJa ? turn.error : await exit.translate(turn.error)}${RESET}`);
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
