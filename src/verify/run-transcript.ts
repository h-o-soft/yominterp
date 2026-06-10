/**
 * transcript 自動検証ランナー (plan.md §7)。
 *
 * 1. ゴールデン採取: transcript の英コマンド行をそのまま seed 固定の dfrotz に
 *    流し、各 step の実出力を採取 (transcript 原文との照合でなくゴールデン照合)
 * 2. 本検証: 同じ seed で新規セッションを起動し、日本語入力 → 入口 LLM
 *    (自己修正込み) → エンジン の実出力を step ごとにゴールデンと比較
 * 3. 比較は「step 集約」: step 内全コマンドの本文出力を連結・正規化して比較。
 *    Moves 数・プロンプト数は比較しない (ステータス行は部屋名のみ)
 * 4. fail した step の後はリシンク: エンジンを再起動し、ゴールデン英コマンド列を
 *    step 1〜i まで再生してから step i+1 を試行 (replay 方式)
 * 5. レポート: 分類・リトライ・レイテンシ p50/p95・再現メタデータを JSON + MD で出力
 *
 *   npm run verify -- [--steps N] [--runs K] [--name suffix] [--exit-samples N]
 *                     [--engine dfrotz|emglken]
 */
import { existsSync, readFileSync } from 'node:fs';
import type { OutputKind, ZEngine } from '../core/engine.js';
import { parseStatusLine } from '../core/engine.js';
import { LLMClient } from '../core/llm/client.js';
import { Session, type TurnResult, sendExhaustingMenus } from '../core/session.js';
import { EntryTranslator, type TurnContext, usefulObjectNames } from '../core/translate/entry.js';
import { ExitTranslator, fnv1a } from '../core/translate/exit.js';
import { normalizeForCompare, tokenOverlap } from './compare.js';
import { extractDictionary } from '../core/zfile/dictionary.js';
import { objectNames } from '../core/zfile/objects.js';
import { FetchTransport, FileCacheStore, FilePromptProvider, JsonlLogger } from '../cli/adapters.js';
import { type AppConfig, loadConfig, toLLMConfig } from '../cli/config.js';
import { DfrotzEngine } from '../cli/dfrotz.js';
import { AutoDialogPort, MemorySaveStore } from '../web/engine/dialog.js';
import { EmglkenEngine } from '../web/engine/emglken.js';
import {
  type RunReport,
  type StepClass,
  type StepRecord,
  summarize,
  toMarkdown,
  writeReport,
} from './report.js';
import { parseTranscript, type TranscriptStep } from './transcript.js';
import type { JaCommand } from './gen-ja-commands.js';

const TRANSCRIPT = 'refs/ghosts_R14/game.transcript';
const JA_COMMANDS = 'fixtures/ja-commands.json';
const NEAR_MATCH_THRESHOLD = 0.85;

interface GoldenStep {
  command: string;
  body: string;
  room: string | null;
  kind: OutputKind;
  score: number | null;
}

// ---- エンジン制御 ----

export type EngineKind = 'dfrotz' | 'emglken';

function makeEngine(cfg: AppConfig, kind: EngineKind): ZEngine {
  if (kind === 'emglken') {
    return new EmglkenEngine({
      vm: 'bocfel',
      storyName: cfg.engine.storyFile.split('/').pop() ?? 'story.z5',
      storyData: new Uint8Array(readFileSync(cfg.engine.storyFile)),
      dialogPort: new AutoDialogPort('verify'),
      saveStore: new MemorySaveStore(),
    });
  }
  return new DfrotzEngine(cfg.engine);
}

async function startEngine(
  cfg: AppConfig,
  kind: EngineKind,
): Promise<{ engine: ZEngine; introBody: string }> {
  const engine = makeEngine(cfg, kind);
  let out = await engine.start();
  while (out.kind === 'query') out = await engine.send(''); // 冒頭の keypress 待ち
  return { engine, introBody: out.body };
}

function roomScore(statusLine: string | undefined, body: string): { room: string | null; score: number | null } {
  const s = statusLine !== undefined ? parseStatusLine(statusLine) : undefined;
  let score = s?.score ?? null;
  const m = /scored (\d+) out of \d+ points/.exec(body);
  if (m) score = Number(m[1]);
  return { room: s?.room ?? null, score };
}

async function captureGolden(
  cfg: AppConfig,
  steps: TranscriptStep[],
  engineKind: EngineKind,
): Promise<{ golden: GoldenStep[]; introBody: string }> {
  const { engine, introBody } = await startEngine(cfg, engineKind);
  const golden: GoldenStep[] = [];
  for (const step of steps) {
    // 会話メニューは「1」で全トピック読み切り (LLM 側 Session と同じ集約)
    const out = await sendExhaustingMenus(engine, step.command);
    const { room, score } = roomScore(out.statusLine, out.body);
    golden.push({ command: step.command, body: out.body, room, kind: out.kind, score });
    if (out.kind === 'gameover') break;
  }
  await engine.stop();
  return { golden, introBody };
}

// ---- 本検証 ----

interface VerifyDeps {
  cfg: AppConfig;
  entry: EntryTranslator;
  logger: JsonlLogger;
  engineKind: EngineKind;
}

function goldenContexts(golden: GoldenStep[], upto: number, turns: number): TurnContext[] {
  return golden
    .slice(Math.max(0, upto - turns), upto)
    .map((g) => ({ commands: [g.command], gameOutput: g.body }));
}

function classifyStep(
  turn: TurnResult,
  golden: GoldenStep,
): { cls: StepClass; near: boolean; actualRoom: string | null; detail?: string } {
  const last = turn.results[turn.results.length - 1];
  const actualRoom = last !== undefined ? roomScore(last.output.statusLine, last.output.body).room : null;
  if (turn.error !== undefined) {
    return { cls: 'fail-parser', near: false, actualRoom, detail: turn.error.source === 'game' ? turn.error.message : turn.error.code };
  }
  const aggregated = turn.results.map((r) => r.output.body).join('\n\n');
  const a = normalizeForCompare(aggregated);
  const g = normalizeForCompare(golden.body);
  const corrected = turn.results.some((r) => r.corrected);
  if (a === g) {
    return { cls: corrected ? 'pass-corrected' : 'pass', near: false, actualRoom };
  }
  const overlap = tokenOverlap(a, g);
  const roomOk = golden.room === null || actualRoom === golden.room;
  if (roomOk && overlap >= NEAR_MATCH_THRESHOLD) {
    return { cls: corrected ? 'pass-corrected' : 'pass', near: true, actualRoom };
  }
  return {
    cls: 'fail-accepted-wrong',
    near: false,
    actualRoom,
    detail: `overlap=${overlap.toFixed(2)} room=${actualRoom ?? '?'}≠${golden.room ?? '?'} sent=[${turn.results.map((r) => r.command).join('; ')}]`,
  };
}

async function verifyRun(
  deps: VerifyDeps,
  golden: GoldenStep[],
  jaCommands: JaCommand[],
  introBody: string,
): Promise<{ records: StepRecord[]; finalScore: number | null; durationMs: number }> {
  const { cfg, entry, logger, engineKind } = deps;
  const t0 = Date.now();
  const records: StepRecord[] = [];
  let finalScore: number | null = null;

  const sessionOpts = {
    maxRetriesPerCommand: cfg.selfCorrect.maxRetriesPerCommand,
    maxLlmCallsPerInput: cfg.selfCorrect.maxLlmCallsPerInput,
    contextTurns: cfg.context.turns,
    autoExhaustMenus: true, // ゴールデン側 (sendExhaustingMenus) と集約単位を揃える
  };

  let { engine } = await startEngine(cfg, engineKind);
  let session = new Session(engine, entry, sessionOpts, logger);
  session.pushGameOutput(introBody);
  let needResync = false;

  for (let i = 0; i < golden.length; i++) {
    const g = golden[i]!;
    const ja = jaCommands[i]!;

    if (needResync) {
      // リシンク: エンジン再起動 → ゴールデン英コマンド列を step i-1 まで再生
      await engine.stop();
      ({ engine } = await startEngine(cfg, engineKind));
      for (let k = 0; k < i; k++) {
        await sendExhaustingMenus(engine, golden[k]!.command);
      }
      session = new Session(engine, entry, sessionOpts, logger);
      if (i === 0) session.pushGameOutput(introBody);
      for (const ctx of goldenContexts(golden, i, cfg.context.turns)) {
        session.history.push(ctx);
      }
      needResync = false;
    }

    const start = Date.now();
    let rec: StepRecord;
    try {
      const turn = await session.handleUserInput(ja.ja);
      const { cls, near, actualRoom, detail } = classifyStep(turn, g);
      const lastResult = turn.results[turn.results.length - 1];
      if (lastResult !== undefined) {
        const { score } = roomScore(lastResult.output.statusLine, lastResult.output.body);
        if (score !== null) finalScore = score;
      }
      rec = {
        index: i,
        enCommand: g.command,
        jaInput: ja.ja,
        sentCommands: turn.results.map((r) => r.command),
        classification: cls,
        nearMatch: near,
        retries: turn.results.reduce((acc, r) => acc + r.retries, 0),
        llmCalls: turn.llmCalls,
        latencyMs: Date.now() - start,
        goldenRoom: g.room,
        actualRoom,
        resynced: false,
        ...(detail !== undefined ? { detail } : {}),
      };
    } catch (err) {
      rec = {
        index: i,
        enCommand: g.command,
        jaInput: ja.ja,
        sentCommands: [],
        classification: 'fail-engine',
        nearMatch: false,
        retries: 0,
        llmCalls: 0,
        latencyMs: Date.now() - start,
        goldenRoom: g.room,
        actualRoom: null,
        resynced: false,
        detail: String(err),
      };
    }

    // fail (または非 turn 出力で世界状態が信用できない) → 次 step の前にリシンク
    const lastKind = g.kind;
    if (rec.classification.startsWith('fail') && lastKind !== 'gameover') {
      rec.resynced = true;
      needResync = true;
    }
    records.push(rec);
    logger.log({ event: 'verify.step', ...rec });
    const mark =
      rec.classification === 'pass' ? '✓' : rec.classification === 'pass-corrected' ? '✓*' : '✗';
    console.log(
      `  [${String(i + 1).padStart(3)}/${golden.length}] ${mark} ${rec.classification}${rec.nearMatch ? ' (near)' : ''} ` +
        `${(rec.latencyMs / 1000).toFixed(1)}s  ${g.command}  ⇐ ${ja.ja}` +
        (rec.detail !== undefined ? `\n        ${rec.detail.split('\n')[0]?.slice(0, 110)}` : ''),
    );
  }

  await engine.stop();
  return { records, finalScore, durationMs: Date.now() - t0 };
}

// ---- メイン ----

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  if (!existsSync(TRANSCRIPT)) {
    console.error(`${TRANSCRIPT} がありません (refs/ は配布物に含まれません)`);
    process.exit(1);
  }
  if (!existsSync(JA_COMMANDS)) {
    console.error(`${JA_COMMANDS} がありません。先に: npm run gen-ja`);
    process.exit(1);
  }

  const cfg = loadConfig();
  const stepLimit = arg('--steps') !== undefined ? Number(arg('--steps')) : null;
  const runs = Number(arg('--runs') ?? '1');
  const name = arg('--name') ?? cfg.llm.model.replace(/[^\w.-]/g, '_');
  const exitSamples = Number(arg('--exit-samples') ?? '0');
  const engineKind = (arg('--engine') ?? 'dfrotz') as EngineKind;
  if (engineKind !== 'dfrotz' && engineKind !== 'emglken') {
    throw new Error(`--engine は dfrotz|emglken (指定: ${engineKind})`);
  }

  const logger = new JsonlLogger(
    `${cfg.logDir}/verify-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`,
  );
  const llm = new LLMClient(new FetchTransport(cfg.llm.baseUrl, cfg.llm.apiKey), toLLMConfig(cfg), logger);
  await llm.listModels(); // 疎通チェック (失敗なら throw)

  const memory = new Uint8Array(readFileSync(cfg.engine.storyFile));
  const prompts = new FilePromptProvider(['prompts', 'fixtures']);
  const entry = new EntryTranslator(llm, prompts, { contextTurns: cfg.context.turns, logger });
  await entry.init({ dictWords: extractDictionary(memory).words, objectNames: objectNames(memory) });

  const allSteps = parseTranscript(readFileSync(TRANSCRIPT, 'utf8'));
  const steps = stepLimit !== null ? allSteps.slice(0, stepLimit) : allSteps;
  const jaAll = (JSON.parse(readFileSync(JA_COMMANDS, 'utf8')) as { commands: JaCommand[] }).commands;
  const jaCommands = steps.map((s) => {
    const ja = jaAll[s.index];
    if (ja === undefined || ja.en !== s.command) {
      throw new Error(`ja-commands と transcript の step ${s.index} が一致しません (再生成: npm run gen-ja -- --force)`);
    }
    return ja;
  });

  console.log(`ゴールデン採取中 (${steps.length} steps, engine=${engineKind})...`);
  const { golden, introBody } = await captureGolden(cfg, steps, engineKind);
  console.log(`ゴールデン採取完了: ${golden.length} steps`);

  const promptHashes: Record<string, string> = {
    'entry.system.md': fnv1a(await prompts.load('entry.system.md')),
    'fewshot.entry.json': fnv1a(await prompts.load('fewshot.entry.json')),
  };
  const fixtureHash = fnv1a(readFileSync(JA_COMMANDS, 'utf8'));

  const reports: RunReport[] = [];
  for (let run = 1; run <= runs; run++) {
    console.log(`\n=== 本検証 run ${run}/${runs} (model: ${cfg.llm.model}) ===`);
    const startedAt = new Date().toISOString();
    const { records, finalScore, durationMs } = await verifyRun({ cfg, entry, logger, engineKind }, golden, jaCommands, introBody);
    const report: RunReport = {
      meta: {
        startedAt,
        finishedAt: new Date().toISOString(),
        model: cfg.llm.model,
        entryModel: cfg.llm.entryModel,
        exitModel: cfg.llm.exitModel,
        temperature: cfg.llm.temperature,
        topP: null,
        promptHashes,
        fixtureHash,
        seed: cfg.engine.seed,
        stepLimit,
        storyFile: cfg.engine.storyFile,
      },
      summary: summarize(records, finalScore, durationMs),
      steps: records,
    };
    reports.push(report);
    const paths = writeReport(report, 'reports', `${name}-run${run}`);
    console.log(`\nrun ${run} レポート: ${paths.md}`);
    const s = report.summary;
    console.log(
      `  pass=${s.pass}/${s.steps} (${(s.passRate * 100).toFixed(1)}%) ` +
        `corrected込み=${(s.correctedRate * 100).toFixed(1)}% ` +
        `accepted-wrong=${(s.acceptedWrongRate * 100).toFixed(1)}% ` +
        `resync=${s.resyncs} p50=${(s.latencyP50Ms / 1000).toFixed(1)}s p95=${(s.latencyP95Ms / 1000).toFixed(1)}s ` +
        `score=${s.finalScore ?? '?'}`,
    );
  }

  // 複数 run の平均±ばらつき
  if (runs > 1) {
    const agg = (f: (r: RunReport) => number) => {
      const vals = reports.map(f);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      return `${(mean * 100).toFixed(1)}% (min ${(Math.min(...vals) * 100).toFixed(1)} / max ${(Math.max(...vals) * 100).toFixed(1)})`;
    };
    const lines = [
      `# ${runs} run 集計 (${name})`,
      '',
      `- 一発正解率: ${agg((r) => r.summary.passRate)}`,
      `- 自己修正込み: ${agg((r) => r.summary.correctedRate)}`,
      `- accepted-wrong: ${agg((r) => r.summary.acceptedWrongRate)}`,
      `- リシンク回数: ${reports.map((r) => r.summary.resyncs).join(', ')}`,
      `- p95 レイテンシ: ${reports.map((r) => (r.summary.latencyP95Ms / 1000).toFixed(1) + 's').join(', ')}`,
      `- 最終スコア: ${reports.map((r) => r.summary.finalScore ?? '?').join(', ')}`,
      '',
    ];
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync('reports', { recursive: true });
    writeFileSync(`reports/${name}-aggregate.md`, lines.join('\n'));
    console.log(`\n集計: reports/${name}-aggregate.md\n${lines.join('\n')}`);
  }

  // 出口翻訳の目視レビュー用対訳サンプル (plan §7.7: 自動判定はしない)
  if (exitSamples > 0) {
    const exit = new ExitTranslator(llm, prompts, new FileCacheStore(`${cfg.cacheDir}/exit-translations.json`), logger);
    await exit.init(usefulObjectNames(objectNames(memory)));
    const lines: string[] = ['# 出口翻訳 目視レビュー用対訳サンプル', ''];
    for (const g of golden.slice(0, exitSamples)) {
      lines.push(`## > ${g.command}`, '', '```', g.body, '```', '', await exit.translate(g.body), '');
    }
    const { writeFileSync: wf } = await import('node:fs');
    wf(`reports/${name}-exit-samples.md`, lines.join('\n'));
    console.log(`出口対訳サンプル: reports/${name}-exit-samples.md`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
