/**
 * transcript の各英コマンドに対応する自然な日本語指示を LLM で一括生成し、
 * fixtures/ja-commands.json に固定する (揺らぎの再現性のため実行毎生成はしない)。
 *
 * 注意: 生成物は transcript (攻略手順・著作物) の派生物のため fixtures/ は gitignore。
 * 生成は機械的であり人間レビューは後追いで行う (レポートにもその旨を明記)。
 *
 *   npm run gen-ja            # 全 185 step
 *   npm run gen-ja -- --force # 既存を上書き
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { LLMClient } from '../core/llm/client.js';
import { FetchTransport } from '../cli/adapters.js';
import { loadConfig, toLLMConfig } from '../cli/config.js';
import { parseTranscript, type TranscriptStep } from './transcript.js';

const OUT_PATH = 'fixtures/ja-commands.json';
const TRANSCRIPT = 'refs/ghosts_R14/game.transcript';
const CHUNK = 10;

export interface JaCommand {
  index: number;
  en: string;
  ja: string;
}

const SYSTEM = `あなたはテキストアドベンチャーゲームのテストデータ作成者である。
英語のゲームコマンドそれぞれに対して、日本語プレイヤーがゲームに入力しそうな自然な日本語の指示文を 1 行ずつ作る。

規則:
- 出力は「番号: 日本語指示」の行のみ。入力と同じ番号を使う。説明を書かない。
- "A then B" のような複合コマンドは 1 つの日本語文に統合する (例: "take pouch then open it" → "3: 袋を取って開けて")。
- it / them は直前のコマンドの対象を指す。日本語では「それ」と言うか対象名を使う。
- 人名・地名などの固有名詞はカタカナにしてよい (Rosie → ロージー)。xyzzy のような魔法の言葉はそのまま。
- 方角は日本語で (north → 北へ)。
- 表現は命令調・依頼調などを適度に変えて自然にする。ただし意味を足したり削ったりしない。
- 英単語をそのまま残さない (固有名詞・魔法の言葉を除く)。`;

function chunkPrompt(steps: TranscriptStep[], all: TranscriptStep[]): string {
  return steps
    .map((s) => {
      const prev = s.index > 0 ? all[s.index - 1]!.command : '(ゲーム開始直後)';
      return `${s.index}: ${s.command}  (直前のコマンド: ${prev})`;
    })
    .join('\n');
}

function parseNumbered(text: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s*[:.]\s*(.+)$/.exec(line.trim());
    if (m) map.set(Number(m[1]), m[2]!.trim());
  }
  return map;
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force');
  if (existsSync(OUT_PATH) && !force) {
    console.log(`${OUT_PATH} は既に存在します (--force で再生成)`);
    return;
  }
  const cfg = loadConfig();
  const llm = new LLMClient(new FetchTransport(cfg.llm.baseUrl, cfg.llm.apiKey), toLLMConfig(cfg));
  const steps = parseTranscript(readFileSync(TRANSCRIPT, 'utf8'));
  console.log(`${steps.length} step を ${CHUNK} 件ずつ生成します (model: ${cfg.llm.model})`);

  const results = new Map<number, string>();
  for (let i = 0; i < steps.length; i += CHUNK) {
    const chunk = steps.slice(i, i + CHUNK);
    const user = chunkPrompt(chunk, steps);
    let parsed = parseNumbered(
      await llm.chat([
        { role: 'system', content: SYSTEM },
        { role: 'user', content: user },
      ]),
    );
    // 欠けた番号は 1 件ずつ再生成
    for (const s of chunk) {
      if (!parsed.has(s.index)) {
        console.warn(`  step ${s.index} が欠落 → 個別に再生成`);
        const single = parseNumbered(
          await llm.chat([
            { role: 'system', content: SYSTEM },
            { role: 'user', content: chunkPrompt([s], steps) },
          ]),
        );
        parsed = new Map([...parsed, ...single]);
      }
      const ja = parsed.get(s.index);
      if (ja === undefined) throw new Error(`step ${s.index} の日本語生成に失敗`);
      results.set(s.index, ja);
    }
    console.log(`  ${Math.min(i + CHUNK, steps.length)}/${steps.length}`);
  }

  const out: { meta: Record<string, unknown>; commands: JaCommand[] } = {
    meta: {
      generatedAt: new Date().toISOString(),
      model: cfg.llm.model,
      source: TRANSCRIPT,
      note: 'LLM 一括生成。人間レビューは後追い (未済の場合あり)。transcript 派生物のため git にコミットしない。',
    },
    commands: steps.map((s) => ({ index: s.index, en: s.command, ja: results.get(s.index)! })),
  };
  mkdirSync('fixtures', { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 1));
  console.log(`書き出し: ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
