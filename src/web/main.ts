/**
 * Web プレイヤーアプリのエントリ (plan.md 段階2a)。
 * CLI (src/cli/main.ts) と同じ翻訳コア/セッション機構を Web UI に接続する。
 */
import { parseStatusLine } from '../core/engine.js';
import { LLMClient } from '../core/llm/client.js';
import { type MenuChoice, type MenuSpec, detectMenu, resolveMenuKey, splitMenuBlock } from '../core/menu.js';
import { REAL_QUESTION_RE, Session, sendResolvingPauses } from '../core/session.js';
import { EntryTranslator } from '../core/translate/entry.js';
import { ExitTranslator } from '../core/translate/exit.js';
import { usefulObjectNames } from '../core/translate/entry.js';
import { BundledPromptProvider, FetchTransport, IdbCacheStore, RingLogger } from './adapters.js';
import { EmglkenEngine } from './engine/emglken.js';
// wasm のハッシュ付き URL。glue が locateFile を自前上書きするため、
// バイナリを事前 fetch して Module.wasmBinary として注入する (詳細は emglken.ts)
import bocfelWasmUrl from 'emglken/build/bocfel.wasm?url';
import glulxeWasmUrl from 'emglken/build/glulxe.wasm?url';

const WASM_URLS: Record<string, string> = {
  bocfel: bocfelWasmUrl,
  glulxe: glulxeWasmUrl,
};

function wasmLoader(vm: 'bocfel' | 'glulxe'): () => Promise<ArrayBuffer> {
  return async () => {
    const res = await fetch(WASM_URLS[vm]!);
    if (!res.ok) throw new Error(`wasm の取得に失敗: HTTP ${res.status}`);
    return res.arrayBuffer();
  };
}
import { IdbSaveStore, ModalDialogPort } from './saves.js';
import { DEFAULT_SETTINGS, type WebSettings, loadSettings, saveSettings } from './settings.js';
import { analyzeStory, storyId } from './storyfile.js';
import {
  Pager,
  estimateLines,
  gridPlainText,
  splitForPaging,
  styleToCss,
  styleTranslatedParagraphs,
} from './ui/render.js';
import type { EngineOutput, SpanStyle, StyledBlock, StyledLine } from '../core/engine.js';
import { uniformStyle } from '../core/engine.js';

// ---- DOM ----
const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;
const terminal = $('#terminal'.slice(1));
const statusLine = $('status-line');
const input = $<HTMLInputElement>('input');
const sendButton = $<HTMLButtonElement>('btn-send');
const choices = $('choices');
const form = $<HTMLFormElement>('input-form');

function print(cls: string, text: string): HTMLParagraphElement {
  const p = document.createElement('p');
  p.className = cls;
  p.textContent = text;
  terminal.appendChild(p);
  terminal.scrollTop = terminal.scrollHeight;
  return p;
}

/** 段落一様装飾付きの段落を出力する (Lv1) */
function printStyledPara(text: string, style: SpanStyle | undefined): void {
  const p = print('', text);
  const css = styleToCss(style);
  if (css.classes.length > 0 || css.inline !== '') {
    p.classList.add('styled', ...css.classes);
    if (css.inline !== '') p.setAttribute('style', css.inline);
  }
}

/** quote box (grid ブロック) を装飾付きで出力する。中身は訳文テキスト */
function printGridBox(text: string, style: SpanStyle | undefined): void {
  const div = document.createElement('div');
  div.className = 'gridbox';
  div.textContent = text;
  const css = styleToCss(style ?? { reverse: true });
  div.classList.add(...css.classes);
  if (css.inline !== '') div.setAttribute('style', css.inline);
  terminal.appendChild(div);
  terminal.scrollTop = terminal.scrollHeight;
}

/** 原文ビュー (Lv2): スパン装飾を忠実に描画する */
function printRawRich(blocks: StyledBlock[]): void {
  for (const block of blocks) {
    const el = document.createElement(block.kind === 'grid' ? 'div' : 'p');
    el.className = block.kind === 'grid' ? 'gridbox raw' : 'raw';
    for (const [i, line] of block.lines.entries()) {
      for (const span of line.spans) {
        const sp = document.createElement('span');
        sp.textContent = span.text;
        const css = styleToCss(span.style);
        if (css.classes.length > 0) sp.classList.add(...css.classes);
        if (css.inline !== '') sp.setAttribute('style', css.inline);
        el.appendChild(sp);
      }
      if (i < block.lines.length - 1) el.appendChild(document.createTextNode('\n'));
    }
    terminal.appendChild(el);
  }
  terminal.scrollTop = terminal.scrollHeight;
}

/**
 * クラシックモードの続行操作待ち ([More] / キー待ち)。
 * バーを表示し、クリックまたは任意のキー入力で resolve する。
 */
function waitForContinue(label: string): Promise<void> {
  return new Promise((resolve) => {
    const bar = document.createElement('button');
    bar.className = 'more-bar';
    bar.textContent = label;
    terminal.appendChild(bar);
    terminal.scrollTop = terminal.scrollHeight;
    const done = () => {
      removeEventListener('keydown', onKey, true);
      bar.remove();
      resolve();
    };
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      done();
    };
    bar.addEventListener('click', done, { once: true });
    addEventListener('keydown', onKey, { capture: true, once: true });
    bar.focus();
  });
}

/** 実画面の「1 ページ」行数 (端末ペインの高さ基準 — 本物のページャと同じ) */
function screenPageLines(): number {
  const lineHeight = parseFloat(getComputedStyle(terminal).lineHeight) || 24;
  return Math.max(8, Math.floor(terminal.clientHeight / lineHeight) - 1);
}

const pager = new Pager(
  () => waitForContinue('—— [More] クリックまたはキーで続き ——'),
  screenPageLines,
);

/** ゲーム本文の表示前ゲート (クラシック時のみページ送り) */
async function pageGate(text: string): Promise<void> {
  if (!settings.classicMode) return;
  await pager.beforeAppend(estimateLines(text, 80));
}

/** 画面クリア (クラシック時は端末を実際にクリア。モダンは区切り線) */
function honorClear(): void {
  if (settings.classicMode) {
    terminal.innerHTML = '';
  } else {
    const hr = document.createElement('hr');
    terminal.appendChild(hr);
  }
  pager.reset();
}

function setBusy(busy: boolean): void {
  input.disabled = busy;
  sendButton.disabled = busy;
  if (!busy) input.focus();
}

// ---- Tauri ネイティブ HTTP (CORS/PNA 制約なしで 127.0.0.1 直結) ----
let nativeFetch: import('./adapters.js').FetchLike | undefined;
const isTauri = '__TAURI_INTERNALS__' in window;
async function initNativeFetch(): Promise<void> {
  if (!isTauri) return;
  try {
    const mod = await import('@tauri-apps/plugin-http');
    nativeFetch = mod.fetch as import('./adapters.js').FetchLike;
  } catch (err) {
    console.warn('Tauri plugin-http が利用できません (ブラウザ fetch を使用):', err);
  }
}

// ---- 状態 ----
let settings: WebSettings = loadSettings();
const logger = new RingLogger();
let engine: EmglkenEngine | undefined;
let session: Session | undefined;
let entry: EntryTranslator | undefined;
let exitTr: ExitTranslator | undefined;
let llm: LLMClient | undefined;
let activeMenu: MenuSpec | undefined;
let lastMenuBody = '';
let lastMenuLabeled: MenuChoice[] = [];
let gameOver = false;

function makeLLM(): LLMClient {
  return new LLMClient(new FetchTransport(settings.baseUrl, settings.apiKey, nativeFetch), {
    model: settings.model,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    timeoutMs: settings.timeoutMs,
  }, logger);
}

function showStatus(line: string | undefined, style?: SpanStyle): void {
  if (line === undefined) return;
  const s = parseStatusLine(line);
  statusLine.textContent = s
    ? `${s.room}  得点: ${s.score}  手数: ${s.moves}`
    : line.trim();
  // ゲーム指定のステータス色 (例: ghosts は赤の反転バー) を topbar に反映
  const topbar = document.getElementById('topbar')!;
  const css = styleToCss(style);
  if (css.inline !== '') {
    topbar.setAttribute('style', css.inline);
    statusLine.setAttribute('style', 'color: inherit');
  }
}

async function translateOut(body: string): Promise<string> {
  if (exitTr === undefined || body.trim() === '') return body;
  try {
    return await exitTr.translate(body);
  } catch (err) {
    print('system', `翻訳エラー: ${String(err)} — 原文を表示します`);
    return body;
  }
}

async function renderGameText(body: string, statusLineRaw?: string): Promise<string> {
  showStatus(statusLineRaw);
  if (body.trim() === '') return '';
  const ja = await translateOut(body);
  for (const chunk of settings.classicMode ? splitForPaging(ja, 80, screenPageLines()) : [ja]) {
    await pageGate(chunk);
    print('', chunk);
  }
  if (settings.showRaw && ja !== body) print('raw', body);
  return ja;
}

/**
 * 装飾付き出力の描画 (Lv1): grid ブロックは quote box として、buffer 段落は
 * 段落一様装飾を訳文に対応付けて描画する。rich が無いエンジンは従来描画。
 * 戻り値は表示した訳文 (メニュー検出やセッション履歴は従来どおり body を使う)。
 */
async function renderRichOutput(out: {
  body: string;
  statusLine?: string;
  statusStyle?: SpanStyle;
  rich?: StyledBlock[];
  cleared?: boolean;
}): Promise<string> {
  // ゲームの画面クリア要求を honor (クラシック=実クリア / モダン=区切り線)
  if (out.cleared === true) honorClear();
  showStatus(out.statusLine, out.statusStyle);
  if (out.rich === undefined) {
    return renderGameText(out.body);
  }
  const grid = out.rich.find((b) => b.kind === 'grid');
  const para = out.rich.find((b) => b.kind === 'para');
  let shown = '';
  if (grid !== undefined) {
    const plain = gridPlainText(grid);
    if (plain !== '') {
      const ja = await translateOut(plain);
      await pageGate(ja);
      printGridBox(ja, uniformStyle(grid.lines));
      shown += ja;
    }
  }
  if (para !== undefined) {
    const paraLines: StyledLine[] = para.lines;
    const plain = paraLines
      .map((l) => l.spans.map((sp) => sp.text).join(''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (plain !== '') {
      const ja = await translateOut(plain);
      for (const styled of styleTranslatedParagraphs(ja, paraLines)) {
        for (const chunk of settings.classicMode ? splitForPaging(styled.text, 80, screenPageLines()) : [styled.text]) {
          await pageGate(chunk);
          printStyledPara(chunk, styled.style);
        }
      }
      shown += (shown === '' ? '' : '\n\n') + ja;
    }
  }
  if (settings.showRaw && out.rich.length > 0) printRawRich(out.rich);
  return shown;
}

// ---- メニュー UI ----
function clearChoices(): void {
  choices.hidden = true;
  choices.innerHTML = '';
  activeMenu = undefined;
}

function showMenuChoices(spec: MenuSpec, body: string, labeled: MenuChoice[]): void {
  activeMenu = spec;
  lastMenuBody = body;
  lastMenuLabeled = labeled;
  choices.innerHTML = '';
  for (const c of labeled) {
    const b = document.createElement('button');
    b.textContent = `${c.key}: ${c.label}`;
    b.addEventListener('click', () => void submitMenuSelection(c.key));
    choices.appendChild(b);
  }
  // ENTER 終了形式のみ汎用ボタンを足す (文字式の endKey は選択肢として既に表示済み)
  if (spec.enterEnds) {
    const b = document.createElement('button');
    b.textContent = '会話を終える';
    b.addEventListener('click', () => void submitMenuSelection(''));
    choices.appendChild(b);
  }
  choices.hidden = false;
  input.placeholder = '番号/文字で選択、または日本語で指示';
}

function showQuestionChoices(): void {
  choices.innerHTML = '';
  for (const [label, value] of [['はい', 'yes'], ['いいえ', 'no']] as const) {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', () => void submitDirect(value));
    choices.appendChild(b);
  }
  choices.hidden = false;
}

// ---- ゲーム進行 ----

/**
 * メニューを MenuSpec ベースで構造整形して表示する。
 * 地の文だけを通常の出口翻訳に通し、ヘッダ・各ラベルは個別に翻訳する
 * (本文丸ごと翻訳だと LLM がメニューを 1 行に畳む・訳語が揺れる・
 *  対応付けに失敗してボタンが英語のままになるため)。
 * 個別翻訳はキャッシュされるので 2 回目以降は安定かつ即時。
 */
async function presentMenu(
  out: { body: string; statusLine?: string; statusStyle?: SpanStyle },
  spec: MenuSpec,
): Promise<void> {
  showStatus(out.statusLine, out.statusStyle);
  const { narrative, headerLine } = splitMenuBlock(out.body, spec);
  if (narrative !== '') {
    const ja = await translateOut(narrative);
    print('', ja);
    if (settings.showRaw && ja !== narrative) print('raw', narrative);
  }
  const cleanup = (t: string) => t.trim().replace(/^[「『"']+|[」』"'。]+$/g, '');
  const headerJa = headerLine !== undefined ? cleanup(await translateOut(headerLine)) : '';
  const labelsJa = await Promise.all(spec.choices.map((c) => translateOut(c.label)));
  const labeled: MenuChoice[] = spec.choices.map((c, i) => ({
    key: c.key,
    label: cleanup(labelsJa[i] ?? '') || c.label,
  }));
  const menuLines = [
    ...(headerJa !== '' ? [headerJa] : []),
    ...labeled.map((c) => `  ${c.key}: ${c.label}`),
    ...(spec.enterEnds ? ['  (空 Enter: 会話を終える)'] : []),
  ];
  print('', menuLines.join('\n'));
  if (settings.showRaw) {
    print('raw', [headerLine ?? '', ...spec.choices.map((c) => `  ${c.key}: ${c.label}`)].filter((l) => l !== '').join('\n'));
  }
  showMenuChoices(spec, out.body, labeled);
}

/** 出力 1 件の表示と後処理 (メニュー/質問/終了の UI 提示) */
async function presentOutput(out: {
  body: string;
  kind: string;
  statusLine?: string;
  statusStyle?: SpanStyle;
  rich?: StyledBlock[];
}): Promise<void> {
  const spec = out.kind !== 'gameover' ? detectMenu(out.body) : undefined;
  if (spec !== undefined) {
    await presentMenu(out, spec);
    return;
  }
  await renderRichOutput(out);
  clearChoices();
  if (out.kind === 'query' && REAL_QUESTION_RE.test(out.body.trimEnd())) {
    showQuestionChoices();
    return;
  }
  if (out.kind === 'gameover') {
    gameOver = true;
    print('system', '―― ゲーム終了 ――');
    input.placeholder = '設定から新しいゲームを読み込めます';
  }
}

async function submitMenuSelection(key: string): Promise<void> {
  if (engine === undefined || session === undefined) return;
  setBusy(true);
  pager.reset();
  clearChoices();
  try {
    print('cmd', `> ${key === '' ? '(会話を終える)' : key}`);
    const out = await sendResolvingPauses(engine, key);
    session.pushGameOutput(out.body);
    await presentOutput(out);
  } catch (err) {
    print('system', `エラー: ${String(err)}`);
  } finally {
    setBusy(false);
  }
}

async function submitDirect(command: string): Promise<void> {
  if (engine === undefined || session === undefined) return;
  setBusy(true);
  pager.reset();
  clearChoices();
  try {
    print('cmd', `> ${command}`);
    const out = await sendResolvingPauses(engine, command);
    session.pushGameOutput(out.body);
    await presentOutput(out);
  } catch (err) {
    print('system', `エラー: ${String(err)}`);
  } finally {
    setBusy(false);
  }
}

async function handleUserInput(ja: string): Promise<void> {
  if (engine === undefined || session === undefined || entry === undefined) {
    print('system', '先に設定からゲームを読み込んでください');
    return;
  }
  if (gameOver) {
    print('system', 'ゲームは終了しています。設定から新しいゲームを読み込んでください');
    return;
  }
  setBusy(true);
  pager.reset();
  print('user', ja);
  const thinking = print('thinking', '考え中…');
  try {
    // メニュー表示中は選択として解釈
    if (activeMenu !== undefined) {
      const spec = activeMenu;
      let selection: string | undefined;
      const trimmed = ja.trim();
      if (trimmed === '' || ['終わる', '終える', '終了', 'やめる'].includes(trimmed)) {
        selection = spec.enterEnds ? '' : spec.endKey;
      } else if (/^[A-Za-z0-9]{1,2}$/.test(trimmed)) {
        selection = resolveMenuKey(spec, trimmed);
      } else {
        const llmKey = await entry.selectMenuOption(trimmed, lastMenuBody);
        selection =
          llmKey === '' ? (spec.enterEnds ? '' : spec.endKey) : resolveMenuKey(spec, llmKey);
      }
      thinking.remove();
      if (selection === undefined) {
        print('system', `その選択肢はありません (${spec.choices.map((c) => c.key).join('/')})`);
        showMenuChoices(spec, lastMenuBody, lastMenuLabeled);
        return;
      }
      await submitMenuSelection(selection);
      return;
    }

    const turn = await session.handleUserInput(ja);
    thinking.remove();
    const lastResult = turn.results[turn.results.length - 1];
    for (const r of turn.results) {
      print('cmd', `> ${r.command}${r.corrected ? ' (自己修正)' : ''}`);
      if (r === lastResult) await presentOutput(r.output);
      else await renderRichOutput(r.output);
    }
    if (turn.error !== undefined) {
      const isJa = /[^\x00-\x7f]/.test(turn.error);
      print('system', isJa ? turn.error : await translateOut(turn.error));
    }
    if (turn.aborted) print('cmd', '(途中で失敗したため残りの動作は中止しました)');
    if (turn.gameOver) gameOver = true; // 表示は presentOutput 側
  } catch (err) {
    thinking.remove();
    print('system', `エラー: ${String(err)}`);
  } finally {
    setBusy(false);
  }
}

async function startGame(data: Uint8Array, filename: string): Promise<void> {
  setBusy(true);
  terminal.innerHTML = '';
  clearChoices();
  gameOver = false;
  try {
    const info = analyzeStory(data, filename);
    if (info.format === 'glulx') {
      print('system', 'Glulx 対応は準備中です (フェーズ2b)。Z-code (.z3/.z5/.z8/.zblorb) をご利用ください');
      return;
    }
    if (info.vocabError !== undefined) {
      print('system', `辞書抽出に失敗しました (辞書なしで続行): ${info.vocabError}`);
    }
    const id = await storyId(info);

    llm = makeLLM();
    const prompts = new BundledPromptProvider();
    entry = new EntryTranslator(llm, prompts, {
      contextTurns: settings.contextTurns,
      logger,
    });
    await entry.init(info.vocab);
    exitTr = new ExitTranslator(llm, prompts, new IdbCacheStore(`exit:${id}`), logger);
    const glossaryNote = print('thinking', '固有名詞の用語集を準備中…');
    try {
      await exitTr.init(usefulObjectNames(info.vocab.objectNames));
    } catch (err) {
      // LLM 不通でもゲーム自体は起動する (翻訳は原文フォールバック)
      print('system', `LLM に接続できません (原文表示で続行): ${String(err).slice(0, 160)}`);
      print('system', '右上の「設定」→ 接続テストで接続を確認できます');
      await exitTr.init([]);
    } finally {
      glossaryNote.remove();
    }

    engine = new EmglkenEngine({
      vm: 'bocfel',
      storyName: filename,
      storyData: data,
      dialogPort: new ModalDialogPort(),
      saveStore: new IdbSaveStore(id),
      loadWasmBinary: wasmLoader('bocfel'),
    });
    session = new Session(engine, entry, {
      maxRetriesPerCommand: 2,
      maxLlmCallsPerInput: 8,
      contextTurns: settings.contextTurns,
    }, logger);

    const loading = print('system', `${filename} を起動中…`);
    pager.reset();
    let out = await engine.start();
    loading.remove(); // 起動完了 → ローディング表示を消す
    // 冒頭の pause/引用画面: メニュー・真の質問でなければ表示して進める。
    // クラシックモードではゲームのキー待ちを honor し、ユーザーのキー入力を待つ
    while (
      out.kind === 'query' &&
      detectMenu(out.body) === undefined &&
      !REAL_QUESTION_RE.test(out.body.trimEnd())
    ) {
      await renderRichOutput(out);
      if (settings.classicMode) {
        await waitForContinue('—— キーを押して続行 ——');
      }
      out = await engine.send('');
    }
    session.pushGameOutput(out.body);
    await presentOutput(out);
    print('system', '日本語で指示してください (例: 周りを見る)');
  } catch (err) {
    print('system', `起動エラー: ${String(err)}`);
  } finally {
    setBusy(false);
  }
}

// ---- 設定ダイアログ ----

function wireSettings(): void {
  const dialog = $<HTMLDialogElement>('settings-dialog');
  const baseUrl = $<HTMLInputElement>('set-baseurl');
  const apiKey = $<HTMLInputElement>('set-apikey');
  const persist = $<HTMLInputElement>('set-persistkey');
  const model = $<HTMLInputElement>('set-model');
  const modelList = $<HTMLDataListElement>('model-list');
  const testResult = $('test-result');

  const commit = () => {
    settings = {
      ...settings,
      baseUrl: baseUrl.value.trim().replace(/\/$/, '') || DEFAULT_SETTINGS.baseUrl,
      apiKey: apiKey.value.trim(),
      persistKey: persist.checked,
      model: model.value.trim(),
    };
    saveSettings(settings);
  };

  $('btn-settings').addEventListener('click', () => {
    baseUrl.value = settings.baseUrl;
    apiKey.value = settings.apiKey;
    persist.checked = settings.persistKey;
    model.value = settings.model;
    testResult.textContent = '';
    dialog.showModal();
  });
  // close イベントだけに依存せず、変更の都度コミットする (取りこぼし防止)
  for (const el of [baseUrl, apiKey, model]) el.addEventListener('change', commit);
  persist.addEventListener('change', commit);
  dialog.addEventListener('close', commit);

  $('btn-test').addEventListener('click', () => {
    void (async () => {
      testResult.className = '';
      testResult.textContent = '確認中…';
      const probe = new LLMClient(
        new FetchTransport(baseUrl.value.trim().replace(/\/$/, ''), apiKey.value.trim(), nativeFetch),
        { model: model.value.trim() || 'test', temperature: 0, maxTokens: 8, timeoutMs: 20000 },
      );
      try {
        const models = await probe.listModels();
        modelList.innerHTML = '';
        for (const m of models) {
          const opt = document.createElement('option');
          opt.value = m;
          modelList.appendChild(opt);
        }
        testResult.className = 'ok';
        testResult.textContent = `接続 OK (モデル ${models.length} 件)`;
      } catch {
        // /models 非対応サーバ → chat 疎通にフォールバック (plan: 2 段接続テスト)
        try {
          await probe.chat([{ role: 'user', content: 'ping' }]);
          testResult.className = 'ok';
          testResult.textContent = '接続 OK (chat 疎通)';
        } catch (err) {
          testResult.className = 'ng';
          testResult.textContent = String(err).slice(0, 200);
        }
      }
    })();
  });

  const fileInput = $<HTMLInputElement>('file-input');
  $('btn-open').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    void (async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      dialog.close();
      await startGame(new Uint8Array(await file.arrayBuffer()), file.name);
      fileInput.value = '';
    })();
  });

  $('btn-open-url').addEventListener('click', () => {
    void (async () => {
      const url = window.prompt('ストーリーファイルの URL (.z3/.z5/.z8 等):');
      if (!url) return;
      dialog.close();
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const name = new URL(url, location.href).pathname.split('/').pop() || 'story.z5';
        await startGame(new Uint8Array(await res.arrayBuffer()), name);
      } catch (err) {
        print('system', `URL からの読み込みに失敗: ${String(err)} (配信元が CORS を許可している必要があります)`);
      }
    })();
  });

  $('btn-download-log').addEventListener('click', () => {
    const blob = new Blob([logger.toJsonl()], { type: 'application/jsonl' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'yominterp-log.jsonl';
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

function applyLayoutMode(): void {
  document.body.classList.toggle('classic', settings.classicMode);
  document.body.classList.toggle('modern', !settings.classicMode);
}

function wireTopbar(): void {
  const layoutButton = $('btn-layout');
  applyLayoutMode();
  layoutButton.classList.toggle('active', settings.classicMode);
  layoutButton.addEventListener('click', () => {
    settings.classicMode = !settings.classicMode;
    layoutButton.classList.toggle('active', settings.classicMode);
    applyLayoutMode();
    saveSettings(settings);
  });

  const rawButton = $('btn-raw');
  rawButton.classList.toggle('active', settings.showRaw);
  rawButton.addEventListener('click', () => {
    settings.showRaw = !settings.showRaw;
    rawButton.classList.toggle('active', settings.showRaw);
    saveSettings(settings);
  });
  $('btn-save').addEventListener('click', () => void submitDirect('save'));
  $('btn-restore').addEventListener('click', () => void submitDirect('restore'));
}

// ---- 起動 ----
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const value = input.value.trim();
  if (value === '') return;
  input.value = '';
  void handleUserInput(value);
});

wireSettings();
wireTopbar();
print('system', 'yominterp — 英語のインタラクティブフィクションを日本語で遊ぶ');
print('system', '右上の「設定」から LLM 接続先を設定し、ゲームを読み込んでください');

/**
 * 自動検証モード (VITE_AUTOTEST=<collector URL> で起動した時のみ)。
 * Tauri ネイティブ HTTP の直結実証用: collector からストーリーを取得し、
 * LM Studio (127.0.0.1:1234) 直結で 2 ターンプレイして結果を POST する。
 */
async function runAutotest(collector: string): Promise<void> {
  const f = nativeFetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  // report は native → browser の順で試す (どちらかが死んでいても結果を届ける)
  const report = async (data: Record<string, unknown>): Promise<void> => {
    const init: RequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    };
    try {
      await f(`${collector}/result`, init);
    } catch (e1) {
      try {
        await fetch(`${collector}/result`, { ...init, body: JSON.stringify({ ...data, reportVia: 'browser', nativeReportError: String(e1) }) });
      } catch {
        /* 届けられない */
      }
    }
  };
  try {
    settings = {
      ...settings,
      baseUrl: 'http://127.0.0.1:1234/v1',
      model: 'gemma-4-e4b-it-ud-japanese-imatrix',
      apiKey: '',
    };
    const storyRes = await f(`${collector}/story`);
    const story = new Uint8Array(await storyRes.arrayBuffer());
    await startGame(story, 'autotest.z3');
    await handleUserInput('周りを見る');
    await handleUserInput('老人と話す');
    const text = terminal.textContent ?? '';
    const buttons = [...choices.querySelectorAll('button')].map((b) => b.textContent ?? '');
    await report({
      ok: true,
      env: isTauri ? 'tauri' : 'browser',
      nativeFetch: nativeFetch !== undefined,
      tail: text.slice(-1200),
      buttons,
    });
  } catch (err) {
    await report({ ok: false, env: isTauri ? 'tauri' : 'browser', error: String(err) });
  }
}

void (async () => {
  await initNativeFetch();
  if (isTauri) print('system', 'デスクトップ版: ローカル LLM へ直結します (CORS/proxy 設定は不要)');
  const autotest = (import.meta.env.VITE_AUTOTEST as string | undefined) ?? '';
  if (autotest !== '') {
    await runAutotest(autotest);
    return;
  }
  if (settings.model === '') {
    ($<HTMLDialogElement>('settings-dialog')).showModal();
  }
})();
// beforeunload 警告 (進行はメモリ上のみのため)
addEventListener('beforeunload', (e) => {
  if (engine !== undefined && !gameOver) e.preventDefault();
});
