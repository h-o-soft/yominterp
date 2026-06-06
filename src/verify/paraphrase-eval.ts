/**
 * 言い換えセット eval (plan.md §7.6):
 * 同一 step に対する別表現の日本語 3 種 × 20 step で、表現揺れへの頑健性を測る。
 * 「攻略手順の暗記」でなく汎化していることの確認用。
 *
 * 各試行は「ゴールデン英コマンド列を step i-1 まで replay した状態」から
 * 言い換え文 1 つを実行し、step i のゴールデン出力と比較する。
 *
 *   npx tsx src/verify/paraphrase-eval.ts [--samples 20] [--force-gen]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { LLMClient } from '../core/llm/client.js';
import { Session } from '../core/session.js';
import { sendExhaustingMenus } from '../core/session.js';
import { EntryTranslator } from '../core/translate/entry.js';
import { fnv1a } from '../core/translate/exit.js';
import { extractDictionary } from '../core/zfile/dictionary.js';
import { objectNames } from '../core/zfile/objects.js';
import { FetchTransport, FilePromptProvider, JsonlLogger } from '../cli/adapters.js';
import { type AppConfig, loadConfig, toLLMConfig } from '../cli/config.js';
import { DfrotzEngine } from '../cli/dfrotz.js';
import { normalizeForCompare, tokenOverlap } from './compare.js';
import { parseTranscript } from './transcript.js';
import type { JaCommand } from './gen-ja-commands.js';

const PARAPHRASES_PATH = 'fixtures/ja-paraphrases.json';
const TRANSCRIPT = 'refs/ghosts_R14/game.transcript';

interface ParaphraseSet {
  index: number;
  en: string;
  variants: string[]; // 3 種
}

const GEN_SYSTEM = `あなたはテキストアドベンチャーのテストデータ作成者である。
与えられた英語コマンドと日本語指示に対し、同じ意味の「別の言い方」の日本語を 3 つ作る。
- 出力は「1: ...」「2: ...」「3: ...」の 3 行のみ。
- 丁寧語/命令形/口語など文体を変える、語順を変える、同義語を使う、など表現を散らす。
- 意味を足したり削ったりしない。固有名詞はそのまま。`;

async function generate(cfg: AppConfig, llm: LLMClient, samples: number): Promise<ParaphraseSet[]> {
  const steps = parseTranscript(readFileSync(TRANSCRIPT, 'utf8'));
  const jaAll = (JSON.parse(readFileSync('fixtures/ja-commands.json', 'utf8')) as { commands: JaCommand[] }).commands;
  // 動詞付きコマンドを優先して等間隔サンプリング (方向 1 語は易しすぎるため)
  const candidates = steps.filter((s) => s.command.includes(' ') && s.command !== 'no' && s.command !== 'yes');
  const stride = Math.max(1, Math.floor(candidates.length / samples));
  const picked = candidates.filter((_, i) => i % stride === 0).slice(0, samples);

  const sets: ParaphraseSet[] = [];
  for (const s of picked) {
    const ja = jaAll[s.index]!.ja;
    const res = await llm.chat([
      { role: 'system', content: GEN_SYSTEM },
      { role: 'user', content: `英語コマンド: ${s.command}\n元の日本語: ${ja}` },
    ]);
    const variants: string[] = [];
    for (const line of res.split('\n')) {
      const m = /^\s*[123]\s*[:.]\s*(.+)$/.exec(line.trim());
      if (m) variants.push(m[1]!.trim());
    }
    if (variants.length >= 3) {
      sets.push({ index: s.index, en: s.command, variants: variants.slice(0, 3) });
      console.log(`  ${s.index} ${s.command}: ${variants.join(' / ')}`);
    } else {
      console.warn(`  ${s.index} ${s.command}: 言い換え生成失敗 (skip)`);
    }
  }
  mkdirSync('fixtures', { recursive: true });
  writeFileSync(PARAPHRASES_PATH, JSON.stringify({ meta: { generatedAt: new Date().toISOString(), model: cfg.llm.model }, sets }, null, 1));
  return sets;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const samples = Number(arg('--samples') ?? '20');
  const logger = new JsonlLogger(`${cfg.logDir}/paraphrase-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  const llm = new LLMClient(new FetchTransport(cfg.llm.baseUrl, cfg.llm.apiKey), toLLMConfig(cfg), logger);

  let sets: ParaphraseSet[];
  if (existsSync(PARAPHRASES_PATH) && !process.argv.includes('--force-gen')) {
    sets = (JSON.parse(readFileSync(PARAPHRASES_PATH, 'utf8')) as { sets: ParaphraseSet[] }).sets;
  } else {
    console.log('言い換えセットを生成中...');
    sets = await generate(cfg, llm, samples);
  }

  const memory = new Uint8Array(readFileSync(cfg.engine.storyFile));
  const prompts = new FilePromptProvider(['prompts', 'fixtures']);
  const entry = new EntryTranslator(llm, prompts, { contextTurns: cfg.context.turns, logger });
  await entry.init({ dictWords: extractDictionary(memory).words, objectNames: objectNames(memory) });

  const steps = parseTranscript(readFileSync(TRANSCRIPT, 'utf8'));

  // ゴールデン採取 (対象 step まで)
  const maxIndex = Math.max(...sets.map((s) => s.index));
  console.log(`ゴールデン採取 (〜step ${maxIndex})...`);
  const goldenEngine = new DfrotzEngine(cfg.engine);
  let out = await goldenEngine.start();
  while (out.kind === 'query') out = await goldenEngine.send('');
  const introBody = out.body;
  const golden: { command: string; body: string }[] = [];
  for (const s of steps.slice(0, maxIndex + 1)) {
    const o = await sendExhaustingMenus(goldenEngine, s.command);
    golden.push({ command: s.command, body: o.body });
  }
  await goldenEngine.stop();

  // 各 step × 3 言い換え
  let total = 0;
  let ok = 0;
  const results: Record<string, unknown>[] = [];
  for (const set of sets) {
    for (const [vi, variant] of set.variants.entries()) {
      const engine = new DfrotzEngine(cfg.engine);
      let o = await engine.start();
      while (o.kind === 'query') o = await engine.send('');
      for (let k = 0; k < set.index; k++) await sendExhaustingMenus(engine, golden[k]!.command);
      const session = new Session(engine, entry, {
        maxRetriesPerCommand: cfg.selfCorrect.maxRetriesPerCommand,
        maxLlmCallsPerInput: cfg.selfCorrect.maxLlmCallsPerInput,
        contextTurns: cfg.context.turns,
        autoExhaustMenus: true, // ゴールデン側と集約単位を揃える
      }, logger);
      if (set.index === 0) session.pushGameOutput(introBody);
      for (const g of golden.slice(Math.max(0, set.index - cfg.context.turns), set.index)) {
        session.history.push({ commands: [g.command], gameOutput: g.body });
      }
      const turn = await session.handleUserInput(variant);
      await engine.stop();

      const agg = turn.results.map((r) => r.output.body).join('\n\n');
      const match =
        turn.error === undefined &&
        (normalizeForCompare(agg) === normalizeForCompare(golden[set.index]!.body) ||
          tokenOverlap(normalizeForCompare(agg), normalizeForCompare(golden[set.index]!.body)) >= 0.85);
      total++;
      if (match) ok++;
      const corrected = turn.results.some((r) => r.corrected);
      results.push({ index: set.index, en: set.en, variant, vi, match, corrected, sent: turn.results.map((r) => r.command) });
      console.log(`  [${set.index}#${vi + 1}] ${match ? '✓' : '✗'}${corrected ? '*' : ''} ${set.en} ⇐ ${variant} → [${turn.results.map((r) => r.command).join('; ')}]`);
    }
  }

  const rate = ok / Math.max(total, 1);
  mkdirSync('reports', { recursive: true });
  writeFileSync(
    'reports/paraphrase-eval.json',
    JSON.stringify({ meta: { model: cfg.llm.model, fixtureHash: fnv1a(readFileSync(PARAPHRASES_PATH, 'utf8')), at: new Date().toISOString() }, rate, ok, total, results }, null, 1),
  );
  console.log(`\n言い換え頑健性: ${ok}/${total} (${(rate * 100).toFixed(1)}%) → reports/paraphrase-eval.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
