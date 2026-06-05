/**
 * ghosts.z5 + 実 dfrotz の結合煙テスト。
 * refs/ (商用作品・gitignore) と dfrotz が無い環境ではスキップする。
 */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DfrotzEngine } from '../src/cli/dfrotz.js';

const STORY = 'refs/ghosts_R14/ghosts.z5';

function hasDfrotz(): boolean {
  try {
    execSync('which dfrotz', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const available = existsSync(STORY) && hasDfrotz();

describe.skipIf(!available)('DfrotzEngine 結合 (ghosts.z5)', () => {
  function makeEngine(): DfrotzEngine {
    return new DfrotzEngine({
      dfrotzPath: 'dfrotz',
      storyFile: STORY,
      seed: 1234,
      workDir: '/tmp/zllm-test',
      width: 100,
      quiescenceMs: 60,
      queryTimeoutMs: 2000,
      hardTimeoutMs: 10000,
    });
  }

  it('起動 (引用画面 query) → keypress → look → quit 確認 query → 終了', async () => {
    const engine = makeEngine();
    // ghosts.z5 は冒頭に keypress 待ちの引用画面を出す
    const quote = await engine.start();
    expect(quote.kind).toBe('query');
    expect(quote.body).toContain('Isaiah');

    const first = await engine.send('');
    expect(first.kind).toBe('turn');
    expect(first.body).toContain('Great Hall');
    expect(first.statusLine).toMatch(/^Great Hall/);

    const look = await engine.send('look');
    expect(look.kind).toBe('turn');
    expect(look.body).toContain('fireplace');
    expect(look.statusLine).toMatch(/Moves: 1/);

    const err = await engine.send('frobnicate');
    expect(err.kind).toBe('turn');
    expect(err.body).toContain("That's an unknown verb");

    const quit = await engine.send('quit');
    expect(quit.kind).toBe('query');
    expect(quit.body).toContain('Are you sure you want to quit?');

    const bye = await engine.send('y');
    expect(bye.kind).toBe('gameover');
    expect(engine.alive).toBe(false);
  }, 30000);

  it('再現性: 同一 seed・同一コマンド列で同一出力', async () => {
    async function run(): Promise<string> {
      const engine = makeEngine();
      await engine.start();
      await engine.send(''); // 引用画面の keypress
      const a = await engine.send('north');
      const b = await engine.send('look');
      await engine.stop();
      return a.body + '\n---\n' + b.body;
    }
    const [r1, r2] = [await run(), await run()];
    expect(r1).toBe(r2);
  }, 60000);
});
