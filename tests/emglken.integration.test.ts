/**
 * EmglkenEngine 実機結合テスト (refs/ 不在ならスキップ)。
 * ghosts.z5 (v5) / darkpit.z3 (v3) / anchor.z8 (v8) / AnchorheadDemo.gblorb (Glulx)
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AutoDialogPort, MemorySaveStore } from '../src/web/engine/dialog.js';
import { EmglkenEngine, type EmglkenVMName } from '../src/web/engine/emglken.js';

const GHOSTS = 'refs/ghosts_R14/ghosts.z5';
const DARKPIT = 'refs/darkzil/darkpit.z3';
const ANCHOR = 'refs/anchorhead/anchor.z8';

function makeEngine(path: string, vm: EmglkenVMName = 'bocfel'): EmglkenEngine {
  return new EmglkenEngine({
    vm,
    storyName: path.split('/').pop()!,
    storyData: new Uint8Array(readFileSync(path)),
    dialogPort: new AutoDialogPort('testslot'),
    saveStore: new MemorySaveStore(),
  });
}

describe.skipIf(!existsSync(GHOSTS))('EmglkenEngine: ghosts.z5 (v5)', () => {
  it('起動 (引用画面=char query) → keypress → look → save/restore → quit', async () => {
    const engine = makeEngine(GHOSTS);
    const quote = await engine.start();
    expect(quote.kind).toBe('query');
    expect(quote.request).toBe('char');
    expect(quote.body).toContain('Isaiah');

    const intro = await engine.send('');
    expect(intro.kind).toBe('turn');
    expect(intro.request).toBe('line');
    expect(intro.body).toContain('Great Hall');

    const look = await engine.send('look');
    expect(look.body).toContain('fireplace');
    expect(look.statusLine).toMatch(/Great Hall/);

    const save = await engine.send('save');
    expect(save.body).toContain('Done');

    const north = await engine.send('north');
    expect(north.body).toContain('Vestibule');

    const restore = await engine.send('restore');
    // bocfel は復元時に履歴再生を行い "done." を出す (実機採取)
    expect(restore.body.toLowerCase()).toMatch(/done|playback/);
    const look2 = await engine.send('look');
    expect(look2.body).toContain('Great Hall'); // restore で元の部屋に戻った

    const quit = await engine.send('quit');
    expect(quit.body).toContain('Are you sure');
    const bye = await engine.send('y');
    expect(bye.kind).toBe('gameover');
    expect(engine.alive).toBe(false);
  }, 60000);
});

describe.skipIf(!existsSync(DARKPIT))('EmglkenEngine: darkpit.z3 (v3)', () => {
  it('起動 → talk to man → 文字メニュー (line 要求) → A → D', async () => {
    const engine = makeEngine(DARKPIT);
    const intro = await engine.start();
    expect(intro.body).toContain('Dungeon Cell');

    const talk = await engine.send('talk to man');
    expect(talk.body).toContain('A. Himself');

    const a = await engine.send('A');
    expect(a.body.toLowerCase()).toContain('thief');

    const d = await engine.send('D');
    expect(d.kind).toBe('turn');
    await engine.stop();
  }, 60000);
});

describe.skipIf(!existsSync(ANCHOR))('EmglkenEngine: anchor.z8 (v8)', () => {
  it('起動して序盤コマンドが通る', async () => {
    const engine = makeEngine(ANCHOR);
    const first = await engine.start();
    // Anchorhead は冒頭にキー待ち/タイトルがある可能性 — どちらでも進められること
    let out = first;
    for (let i = 0; i < 3 && out.kind === 'query'; i++) out = await engine.send('');
    expect(out.kind).toBe('turn');
    const look = await engine.send('look');
    expect(look.body.length).toBeGreaterThan(20);
    await engine.stop();
  }, 60000);
});
