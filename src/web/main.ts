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

function setBusy(busy: boolean): void {
  input.disabled = busy;
  sendButton.disabled = busy;
  if (!busy) input.focus();
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
  return new LLMClient(new FetchTransport(settings.baseUrl, settings.apiKey), {
    model: settings.model,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    timeoutMs: settings.timeoutMs,
  }, logger);
}

function showStatus(line: string | undefined): void {
  if (line === undefined) return;
  const s = parseStatusLine(line);
  statusLine.textContent = s
    ? `${s.room}  得点: ${s.score}  手数: ${s.moves}`
    : line.trim();
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
  print('', ja);
  if (settings.showRaw && ja !== body) print('raw', body);
  return ja;
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
  out: { body: string; statusLine?: string },
  spec: MenuSpec,
): Promise<void> {
  showStatus(out.statusLine);
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
}): Promise<void> {
  const spec = out.kind !== 'gameover' ? detectMenu(out.body) : undefined;
  if (spec !== undefined) {
    await presentMenu(out, spec);
    return;
  }
  await renderGameText(out.body, out.statusLine);
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
      else await renderGameText(r.output.body, r.output.statusLine);
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

    print('system', `${filename} を起動中…`);
    let out = await engine.start();
    // 冒頭の pause/引用画面: メニュー・真の質問でなければ表示して自動続行
    while (
      out.kind === 'query' &&
      detectMenu(out.body) === undefined &&
      !REAL_QUESTION_RE.test(out.body.trimEnd())
    ) {
      await renderGameText(out.body, out.statusLine);
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
        new FetchTransport(baseUrl.value.trim().replace(/\/$/, ''), apiKey.value.trim()),
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

  $('btn-sample').addEventListener('click', () => {
    void (async () => {
      dialog.close();
      try {
        const res = await fetch(`${import.meta.env.BASE_URL}games/darkpit.z3`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await startGame(new Uint8Array(await res.arrayBuffer()), 'darkpit.z3');
      } catch (err) {
        print('system', `サンプルの読み込みに失敗: ${String(err)}`);
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

  $('btn-download-log').addEventListener('click', () => {
    const blob = new Blob([logger.toJsonl()], { type: 'application/jsonl' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'yominterp-log.jsonl';
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

function wireTopbar(): void {
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
if (settings.model === '') {
  ($<HTMLDialogElement>('settings-dialog')).showModal();
}
// beforeunload 警告 (進行はメモリ上のみのため)
addEventListener('beforeunload', (e) => {
  if (engine !== undefined && !gameOver) e.preventDefault();
});
