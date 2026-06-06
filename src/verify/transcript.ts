/**
 * game.transcript パーサ。
 * 形式: `// コメント` と前書きのあと、`>コマンド` 行 ＋ 続く出力ブロックの繰り返し。
 */

export interface TranscriptStep {
  /** 0 始まりの step 番号 */
  index: number;
  /** transcript の英コマンド行 (例: "take pouch then open it") */
  command: string;
  /** その step の期待出力ブロック (transcript 原文。参考用 — 照合はゴールデン採取側) */
  expectedOutput: string;
}

export function parseTranscript(text: string): TranscriptStep[] {
  const lines = text.split(/\r?\n/);
  const steps: TranscriptStep[] = [];
  let current: { command: string; output: string[] } | undefined;

  for (const line of lines) {
    if (line.startsWith('//')) continue;
    if (line.startsWith('>')) {
      if (current) {
        steps.push({
          index: steps.length,
          command: current.command,
          expectedOutput: current.output.join('\n').trim(),
        });
      }
      current = { command: line.slice(1).trim(), output: [] };
      continue;
    }
    if (current) current.output.push(line);
    // 前書き (最初の `>` 以前) は捨てる
  }
  if (current && current.command !== '') {
    steps.push({
      index: steps.length,
      command: current.command,
      expectedOutput: current.output.join('\n').trim(),
    });
  }
  return steps;
}
