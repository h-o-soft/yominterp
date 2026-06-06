/**
 * エンジン移植検証 (LLM なし、plan.md 段階2 §7(a)):
 * transcript の英コマンド列をそのまま dfrotz / EmglkenEngine 双方に流し、
 * step ごとの正規化本文・room・score を突き合わせる。
 *
 *   npx tsx src/verify/engine-parity.ts [--steps N]
 *
 * 乱数 seed は emglken (bocfel) では固定できないため、乱数由来の文言差は
 * トークン重なり率で吸収し、不一致 step は分類して報告する。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseStatusLine } from '../core/engine.js';
import { sendExhaustingMenus } from '../core/session.js';
import type { ZEngine } from '../core/engine.js';
import { loadConfig } from '../cli/config.js';
import { DfrotzEngine } from '../cli/dfrotz.js';
import { AutoDialogPort, MemorySaveStore } from '../web/engine/dialog.js';
import { EmglkenEngine } from '../web/engine/emglken.js';
import { normalizeForCompare, tokenOverlap } from './compare.js';
import { parseTranscript } from './transcript.js';

const TRANSCRIPT = 'refs/ghosts_R14/game.transcript';
const STORY = 'refs/ghosts_R14/ghosts.z5';

interface StepCapture {
  command: string;
  body: string;
  room: string | null;
  kind: string;
}

async function runAll(engine: ZEngine, commands: string[]): Promise<StepCapture[]> {
  let out = await engine.start();
  while (out.kind === 'query') out = await engine.send('');
  const steps: StepCapture[] = [];
  for (const command of commands) {
    out = await sendExhaustingMenus(engine, command);
    const status = out.statusLine !== undefined ? parseStatusLine(out.statusLine) : undefined;
    steps.push({ command, body: out.body, room: status?.room ?? null, kind: out.kind });
    if (out.kind === 'gameover') break;
  }
  await engine.stop();
  return steps;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  if (!existsSync(TRANSCRIPT) || !existsSync(STORY)) {
    console.error('refs/ghosts_R14 がありません');
    process.exit(1);
  }
  const stepLimit = arg('--steps') !== undefined ? Number(arg('--steps')) : null;
  const all = parseTranscript(readFileSync(TRANSCRIPT, 'utf8'));
  const commands = (stepLimit !== null ? all.slice(0, stepLimit) : all).map((s) => s.command);
  const cfg = loadConfig();
  cfg.engine.storyFile = STORY;

  console.log(`dfrotz 側を再生中 (${commands.length} steps)...`);
  const dfrotz = await runAll(new DfrotzEngine(cfg.engine), commands);

  console.log('emglken (bocfel) 側を再生中...');
  const emglken = await runAll(
    new EmglkenEngine({
      vm: 'bocfel',
      storyName: 'ghosts.z5',
      storyData: new Uint8Array(readFileSync(STORY)),
      dialogPort: new AutoDialogPort('parity'),
      saveStore: new MemorySaveStore(),
    }),
    commands,
  );

  let exact = 0;
  let near = 0;
  const mismatches: { i: number; command: string; overlap: number; roomOk: boolean }[] = [];
  const n = Math.min(dfrotz.length, emglken.length);
  for (let i = 0; i < n; i++) {
    const a = normalizeForCompare(dfrotz[i]!.body);
    const b = normalizeForCompare(emglken[i]!.body);
    const roomOk = dfrotz[i]!.room === emglken[i]!.room;
    if (a === b && roomOk) {
      exact++;
      continue;
    }
    const overlap = tokenOverlap(a, b);
    if (roomOk && overlap >= 0.85) {
      near++;
    } else {
      mismatches.push({ i, command: dfrotz[i]!.command, overlap, roomOk });
    }
  }

  const report = {
    steps: n,
    dfrotzSteps: dfrotz.length,
    emglkenSteps: emglken.length,
    exact,
    near,
    mismatch: mismatches.length,
    finalKind: { dfrotz: dfrotz[dfrotz.length - 1]?.kind, emglken: emglken[emglken.length - 1]?.kind },
    mismatches: mismatches.slice(0, 30),
  };
  mkdirSync('reports', { recursive: true });
  writeFileSync('reports/engine-parity.json', JSON.stringify(report, null, 1));
  console.log(
    `\nパリティ: 完全一致 ${exact}/${n} (${((exact / n) * 100).toFixed(1)}%) / 実質一致 ${near} / 不一致 ${mismatches.length}`,
  );
  for (const m of mismatches.slice(0, 10)) {
    console.log(`  #${m.i} ${m.command} overlap=${m.overlap.toFixed(2)} room${m.roomOk ? '一致' : '不一致'}`);
  }
  console.log('→ reports/engine-parity.json');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
