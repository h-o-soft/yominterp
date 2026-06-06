/**
 * 段階2a ステップ1: emglken スパイク。
 * Bocfel + 自前キャプチャ GlkOte + メモリ Dialog で ghosts.z5 を駆動し、
 * 生プロトコル (update/event) を採取して fixtures/ に保存する (ゲーム本文を含むため gitignore)。
 *
 *   npx tsx scripts/spike-emglken.mts refs/ghosts_R14/ghosts.z5
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Bocfel } from 'emglken';

const story = process.argv[2] ?? 'refs/ghosts_R14/ghosts.z5';
const protocolLog: { dir: 'update' | 'event'; data: unknown }[] = [];

// ---- メモリ Dialog (AsyncGlk Dialog IF) ----
class MemoryDialog {
  'async' = true;
  files = new Map<string, Uint8Array>();
  promptResponses: (string | null)[] = [];
  async init() {}
  async delete(path: string) {
    this.files.delete(path);
  }
  async exists(path: string) {
    return this.files.has(path);
  }
  get_dirs() {
    return { storyfile: '/mem', system_cwd: '/mem', temp: '/tmp', working: '/mem' };
  }
  prompt(extension: string, _save: boolean): Promise<string | null> {
    const name = this.promptResponses.shift() ?? null;
    console.log(`[Dialog.prompt] ext=${extension} → ${name}`);
    return Promise.resolve(name === null ? null : `${name}${extension}`);
  }
  read(path: string): Promise<Uint8Array | null> {
    console.log(`[Dialog.read] ${path} (${this.files.has(path) ? 'hit' : 'MISS'})`);
    return Promise.resolve(this.files.get(path) ?? null);
  }
  set_storyfile_dir(path: string) {
    return { storyfile: path, working: path };
  }
  async write(files: Record<string, Uint8Array>) {
    for (const [path, data] of Object.entries(files)) {
      console.log(`[Dialog.write] ${path} (${data.length} bytes)`);
      // 注意: data は WASM ヒープのビューの可能性 → 必ずコピーして保持する
      this.files.set(path, new Uint8Array(data));
    }
  }
}

// ---- キャプチャ GlkOte ----
type AcceptFn = (ev: Record<string, unknown>) => void;
class CaptureGlkOte {
  accept: AcceptFn = () => {};
  private waiter: ((data: any) => void) | undefined;
  async init(options: any) {
    if (!options?.accept) throw new Error('no accept');
    this.accept = options.accept;
    this.accept({ type: 'init', gen: 0, metrics: { width: 80, height: 24 }, support: ['timer'] });
  }
  update(data: any) {
    protocolLog.push({ dir: 'update', data });
    const w = this.waiter;
    this.waiter = undefined;
    if (w) w(data);
    else console.log('[update with no waiter]', JSON.stringify(data).slice(0, 120));
  }
  nextUpdate(): Promise<any> {
    return new Promise((r) => (this.waiter = r));
  }
  send(ev: Record<string, unknown>) {
    protocolLog.push({ dir: 'event', data: ev });
    this.accept(ev);
  }
  // GlkOteBase 互換の残り
  getinterface() {
    return {};
  }
  log(_msg: string) {}
  warning(msg: string) {
    console.warn('[GlkOte.warning]', msg);
  }
  error(err: unknown) {
    console.error('[GlkOte.error]', err);
    throw err instanceof Error ? err : new Error(String(err));
  }
  inited() {
    return true;
  }
}

function describe(update: any): string {
  if (update.type !== 'update') return `type=${update.type}`;
  const parts: string[] = [`gen=${update.gen}`];
  for (const c of update.content ?? []) {
    if (c.lines) parts.push(`grid#${c.id}:${c.lines.length}行`);
    if (c.text) parts.push(`buf#${c.id}:${c.text.length}para`);
  }
  for (const i of update.input ?? []) parts.push(`input#${i.id}:${i.type}(gen${i.gen})`);
  if (update.specialinput) parts.push(`special:${JSON.stringify(update.specialinput)}`);
  if (update.windows) parts.push(`windows:${update.windows.map((w: any) => `${w.id}=${w.type}`).join(',')}`);
  if (update.disable) parts.push('disable');
  return parts.join(' ');
}

function bufferText(update: any): string {
  let out = '';
  for (const c of update.content ?? []) {
    for (const para of c.text ?? []) {
      const line = (para.content ?? []).map((s: any) => (typeof s === 'string' ? s : (s.text ?? ''))).join('');
      out += line + '\n';
    }
  }
  return out;
}

async function main() {
  const dialog = new MemoryDialog();
  const glkote = new CaptureGlkOte();
  dialog.files.set('/mem/story.z5', new Uint8Array(readFileSync(story)));
  dialog.promptResponses = ['spikeslot', 'spikeslot']; // save → restore で同じ名前

  const vm = await (Bocfel as any)();
  console.log('=== start ===');
  const p0 = glkote.nextUpdate();
  // 注: bocfel 固有オプション (-z seed 等) は RemGlk-rs グルーが受理しない (実測)。
  // seed 固定は不可 → ゴールデン採取も emglken 側で行う方針 (plan.md §1)。
  vm.start({ arguments: ['/mem/story.z5'], GlkOte: glkote, Dialog: dialog });
  let u = await p0;
  console.log(describe(u));

  // 入力要求が来るまで／来ているか確認しつつ進める
  const steps: { ev: Record<string, unknown>; label: string }[] = [
    { ev: { type: 'char', value: ' ' }, label: 'keypress (引用画面)' },
    { ev: { type: 'line', value: 'look' }, label: 'look' },
    { ev: { type: 'line', value: 'north' }, label: 'north' },
    { ev: { type: 'line', value: 'save' }, label: 'save' },
    { ev: { type: 'line', value: 'restore' }, label: 'restore' },
    { ev: { type: 'line', value: 'look' }, label: 'look (restore後)' },
    { ev: { type: 'line', value: 'quit' }, label: 'quit' },
    { ev: { type: 'char', value: 'y' }, label: 'y (quit確認)' },
  ];

  for (const step of steps) {
    // specialinput (fileref_prompt) が来ていたら specialresponse で応答
    while (u.specialinput) {
      const name = dialog.promptResponses.shift() ?? null;
      console.log(`=== specialresponse: ${JSON.stringify(u.specialinput)} → ${name}`);
      const pu = glkote.nextUpdate();
      glkote.send({
        type: 'specialresponse',
        gen: u.gen,
        response: 'fileref_prompt',
        value: name,
      });
      u = await pu;
      console.log(describe(u));
      const t = bufferText(u);
      if (t.trim()) console.log(t.split('\n').slice(0, 4).join('\n'));
    }
    // 直近 update の input 要求から window id / gen を拾う
    const inputReq = (u.input ?? [])[0];
    if (!inputReq) {
      console.log(`!! 入力要求なしで ${step.label} に到達。中断`);
      break;
    }
    const ev = { ...step.ev, gen: u.gen, window: inputReq.id };
    console.log(`=== send: ${step.label} (window=${inputReq.id}, 要求type=${inputReq.type}) ===`);
    const pu = glkote.nextUpdate();
    glkote.send(ev);
    u = await pu;
    console.log(describe(u));
    const text = bufferText(u);
    if (text.trim()) console.log(text.split('\n').slice(0, 6).join('\n'));
  }

  mkdirSync('fixtures', { recursive: true });
  writeFileSync('fixtures/glkote-ghosts-spike.json', JSON.stringify(protocolLog, null, 1));
  console.log(`\nプロトコルログ ${protocolLog.length} 件 → fixtures/glkote-ghosts-spike.json`);
  console.log('Dialog files:', [...dialog.files.keys()]);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
