/**
 * 検証結果のレポート出力 (JSON + Markdown サマリ)。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type StepClass =
  | 'pass'
  | 'pass-corrected'
  | 'fail-parser'
  | 'fail-accepted-wrong'
  | 'fail-engine';

export interface StepRecord {
  index: number;
  enCommand: string;
  jaInput: string;
  sentCommands: string[];
  classification: StepClass;
  /** 正規化後の完全一致でなくトークン重なり等で「実質一致」と判定した */
  nearMatch: boolean;
  retries: number;
  llmCalls: number;
  latencyMs: number;
  goldenRoom: string | null;
  actualRoom: string | null;
  /** この step の失敗により次 step の前にリシンクした */
  resynced: boolean;
  detail?: string;
}

export interface RunMeta {
  startedAt: string;
  finishedAt: string;
  model: string;
  entryModel: string | null;
  exitModel: string | null;
  temperature: number;
  topP: number | null;
  promptHashes: Record<string, string>;
  fixtureHash: string;
  seed: number;
  stepLimit: number | null;
  storyFile: string;
}

export interface RunSummary {
  steps: number;
  pass: number;
  passCorrected: number;
  failParser: number;
  failAcceptedWrong: number;
  failEngine: number;
  /** 一発正解率 (pass / steps) */
  passRate: number;
  /** 自己修正込み成功率 ((pass+pass-corrected) / steps) */
  correctedRate: number;
  acceptedWrongRate: number;
  resyncs: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  finalScore: number | null;
  totalDurationMs: number;
}

export interface RunReport {
  meta: RunMeta;
  summary: RunSummary;
  steps: StepRecord[];
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

export function summarize(
  steps: StepRecord[],
  finalScore: number | null,
  totalDurationMs: number,
): RunSummary {
  const count = (c: StepClass) => steps.filter((s) => s.classification === c).length;
  const latencies = steps.map((s) => s.latencyMs);
  const n = steps.length || 1;
  return {
    steps: steps.length,
    pass: count('pass'),
    passCorrected: count('pass-corrected'),
    failParser: count('fail-parser'),
    failAcceptedWrong: count('fail-accepted-wrong'),
    failEngine: count('fail-engine'),
    passRate: count('pass') / n,
    correctedRate: (count('pass') + count('pass-corrected')) / n,
    acceptedWrongRate: count('fail-accepted-wrong') / n,
    resyncs: steps.filter((s) => s.resynced).length,
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    finalScore,
    totalDurationMs,
  };
}

const pct = (x: number) => (x * 100).toFixed(1) + '%';

export function toMarkdown(report: RunReport): string {
  const { meta, summary } = report;
  const lines: string[] = [
    `# transcript 検証レポート`,
    '',
    `- 実行: ${meta.startedAt} 〜 ${meta.finishedAt}`,
    `- モデル: ${meta.model} (entry: ${meta.entryModel ?? '同'}, exit: ${meta.exitModel ?? '同'})`,
    `- temperature: ${meta.temperature} / top_p: ${meta.topP ?? '(既定)'}`,
    `- seed: ${meta.seed} / story: ${meta.storyFile}`,
    `- プロンプト版数: ${Object.entries(meta.promptHashes)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')}`,
    `- fixture 版数: ${meta.fixtureHash}`,
    meta.stepLimit !== null ? `- step 制限: 先頭 ${meta.stepLimit} step のみ` : '',
    '',
    `## サマリ (${summary.steps} steps)`,
    '',
    `| 指標 | 値 | 目標 |`,
    `|---|---|---|`,
    `| 一発正解 (pass) | ${summary.pass} (${pct(summary.passRate)}) | ≥ 80% |`,
    `| 自己修正込み (pass+corrected) | ${summary.pass + summary.passCorrected} (${pct(summary.correctedRate)}) | ≥ 95% |`,
    `| fail-parser | ${summary.failParser} | — |`,
    `| fail-accepted-wrong | ${summary.failAcceptedWrong} (${pct(summary.acceptedWrongRate)}) | ≤ 2% |`,
    `| fail-engine | ${summary.failEngine} | 0 |`,
    `| リシンク回数 | ${summary.resyncs} | 0 (なし完走) |`,
    `| step レイテンシ p50 | ${(summary.latencyP50Ms / 1000).toFixed(1)}s | — |`,
    `| step レイテンシ p95 | ${(summary.latencyP95Ms / 1000).toFixed(1)}s | ≤ 15s |`,
    `| 最終スコア | ${summary.finalScore ?? '?'} | 410 |`,
    `| 総所要時間 | ${(summary.totalDurationMs / 60000).toFixed(1)} 分 | — |`,
    '',
    `## 失敗 step 一覧`,
    '',
  ];
  const fails = report.steps.filter((s) => s.classification.startsWith('fail'));
  if (fails.length === 0) {
    lines.push('(なし)');
  } else {
    lines.push(`| # | 英コマンド | 日本語入力 | 送信コマンド | 分類 | 詳細 |`, `|---|---|---|---|---|---|`);
    for (const s of fails) {
      lines.push(
        `| ${s.index} | \`${s.enCommand}\` | ${s.jaInput} | \`${s.sentCommands.join(' / ')}\` | ${s.classification} | ${(s.detail ?? '').replace(/\n/g, ' ').slice(0, 120)} |`,
      );
    }
  }
  lines.push('');
  return lines.filter((l) => l !== undefined).join('\n');
}

export function writeReport(report: RunReport, dir: string, name: string): { json: string; md: string } {
  mkdirSync(dir, { recursive: true });
  const jsonPath = join(dir, `${name}.json`);
  const mdPath = join(dir, `${name}.md`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 1));
  writeFileSync(mdPath, toMarkdown(report));
  return { json: jsonPath, md: mdPath };
}
