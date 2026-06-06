import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  type ChildLike,
  DfrotzEngine,
  type DfrotzOptions,
  EngineTimeoutError,
} from '../src/cli/dfrotz.js';

class FakeChild implements ChildLike {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  written: string[] = [];
  private emitter = new EventEmitter();
  stdin = {
    write: (data: string) => {
      this.written.push(data);
      return true;
    },
  };
  on(event: 'exit' | 'error', listener: (...args: unknown[]) => void): this {
    this.emitter.on(event, listener);
    return this;
  }
  kill(): boolean {
    queueMicrotask(() => this.emitter.emit('exit', 0));
    return true;
  }
  emitExit(): void {
    this.emitter.emit('exit', 0);
  }
  emitOut(text: string): void {
    this.stdout.emit('data', Buffer.from(text));
  }
}

const TEST_OPTS: DfrotzOptions = {
  dfrotzPath: 'dfrotz',
  storyFile: 'dummy.z5',
  seed: 1,
  workDir: '/tmp/zllm-test',
  width: 100,
  quiescenceMs: 20,
  queryTimeoutMs: 80,
  hardTimeoutMs: 400,
};

function makeEngine(): { engine: DfrotzEngine; child: FakeChild } {
  const child = new FakeChild();
  const engine = new DfrotzEngine(TEST_OPTS, () => child);
  return { engine, child };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('DfrotzEngine (モック stdout)', () => {
  it('start: 分割チャンク・遅延配信でもプロンプトまで集約して turn を返す', async () => {
    const { engine, child } = makeEngine();
    const p = engine.start();
    child.emitOut('Intro text.\n\n Great Hall      Score: 0     Mov');
    await sleep(5);
    child.emitOut('es: 0\n\nWelcome body.\n');
    await sleep(5);
    child.emitOut('\n>');
    const out = await p;
    expect(out.kind).toBe('turn');
    expect(out.body).toBe('Intro text.\n\nWelcome body.');
    expect(out.statusLine).toMatch(/^Great Hall/);
    expect(engine.alive).toBe(true);
  });

  it('send: stdin にコマンドを書き、次プロンプトまでの出力を返す', async () => {
    const { engine, child } = makeEngine();
    const ps = engine.start();
    child.emitOut('Intro.\n\n>');
    await ps;
    const p = engine.send('look');
    expect(child.written).toEqual(['look\n']);
    child.emitOut(' Great Hall      Score: 0     Moves: 1\n\nYou look around.\n\n>');
    const out = await p;
    expect(out.kind).toBe('turn');
    expect(out.body).toBe('You look around.');
  });

  it('本文中の "> " で始まらない `>` は誤検知しない (行頭 `>` のみプロンプト)', async () => {
    const { engine, child } = makeEngine();
    const ps = engine.start();
    child.emitOut('Intro.\n\n>');
    await ps;
    const p = engine.send('read sign');
    child.emitOut('The sign says -> go north.\n');
    await sleep(60); // quiescence は経過するが行頭 `>` でないので未確定
    child.emitOut('\n>');
    const out = await p;
    expect(out.body).toBe('The sign says -> go north.');
  });

  it('query: `>` で終わらない既知パターンは kind=query', async () => {
    const { engine, child } = makeEngine();
    const ps = engine.start();
    child.emitOut('Intro.\n\n>');
    await ps;
    const p = engine.send('quit');
    child.emitOut('Are you sure you want to quit?');
    const out = await p;
    expect(out.kind).toBe('query');
    expect(out.body).toBe('Are you sure you want to quit?');
  });

  it('gameover: *** バナーは kind=gameover', async () => {
    const { engine, child } = makeEngine();
    const ps = engine.start();
    child.emitOut('Intro.\n\n>');
    await ps;
    const p = engine.send('jump off cliff');
    child.emitOut('\n*** You have died ***\n\nWould you like to RESTART?\n\n>');
    const out = await p;
    expect(out.kind).toBe('gameover');
  });

  it('gameover: 子プロセス exit でも残りバッファを gameover として返し dead 化', async () => {
    const { engine, child } = makeEngine();
    const ps = engine.start();
    child.emitOut('Intro.\n\n>');
    await ps;
    const p = engine.send('y');
    child.emitOut('Goodbye.\n');
    child.emitExit();
    const out = await p;
    expect(out.kind).toBe('gameover');
    expect(out.body).toBe('Goodbye.');
    expect(engine.alive).toBe(false);
    await expect(engine.send('look')).rejects.toThrow(/not running/);
  });

  it('query: `>` なしで出力が止まれば既知パターン外でも query (会話メニュー等)', async () => {
    const { engine, child } = makeEngine();
    const ps = engine.start();
    child.emitOut('Intro.\n\n>');
    await ps;
    const p = engine.send('talk to rosie');
    child.emitOut('Talk to Rosie about:\n  1: Preparations\n\n[ENTER] End conversation\n\nYou: "Hey."');
    const out = await p;
    expect(out.kind).toBe('query');
  });

  it('timeout: 出力ゼロのままの長時間無音は EngineTimeoutError', async () => {
    const { engine, child } = makeEngine();
    const ps = engine.start();
    child.emitOut('Intro.\n\n>');
    await ps;
    const p = engine.send('wait');
    await expect(p).rejects.toThrow(EngineTimeoutError);
  });

  it('多重 send は拒否する', async () => {
    const { engine, child } = makeEngine();
    const ps = engine.start();
    child.emitOut('Intro.\n\n>');
    await ps;
    const p1 = engine.send('look');
    await expect(engine.send('look')).rejects.toThrow(/in flight/);
    child.emitOut('Ok.\n\n>');
    await p1;
  });
});
