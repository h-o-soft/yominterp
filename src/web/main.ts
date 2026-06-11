/**
 * Web プレイヤーアプリのエントリ (plan.md 段階2a)。
 * CLI (src/cli/main.ts) と同じ翻訳コア/セッション機構を Web UI に接続する。
 */
import { parseStatusGeneric } from '../core/engine.js';
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
  CLASSIC_COLS,
  CLASSIC_ROWS,
  Pager,
  estimateLines,
  gridPlainText,
  splitBlocks,
  splitForPaging,
  styleToCss,
  wrapToLines,
} from './ui/render.js';
import type { EngineOutput, SpanStyle, StyledBlock, StyledLine } from '../core/engine.js';
import { uniformStyle } from '../core/engine.js';
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_PROFILES,
  SUPPORTED_LANGUAGES,
  isLanguageCode,
} from '../core/i18n/language.js';
import { applyDomI18n, t } from './i18n/messages.js';

// ---- DOM ----
const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;
const terminal = $('#terminal'.slice(1));
const statusLine = $('status-line');
const statusLeft = $('status-left');
const statusRight = $('status-right');
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

/** quote box (grid ブロック) を装飾付きで出力する。中身は訳文テキスト。
 *  クラシックは pre 表示なので 80 桁で折り返してから入れる (横はみ出し防止) */
function printGridBox(text: string, style: SpanStyle | undefined): void {
  const div = document.createElement('div');
  div.className = 'gridbox';
  div.textContent = settings.classicMode ? wrapToLines(text, CLASSIC_COLS).join('\n') : text;
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

/**
 * char 入力要求 (read_char) に対し、ユーザーが**実際に押したキー**を返す。
 * HELP のような「N/P/Q/RETURN で操作する char メニュー」では任意キー固定では
 * 抜けられない (Q を押す必要がある) ため、押下キーをそのまま VM へ送る。
 * Enter は '' (= VM 側で return)、その他の単一文字はその文字、クリックは space。
 * 修飾キー単独は無視して待ち続ける。
 */
function waitForKey(label: string): Promise<string> {
  return new Promise((resolve) => {
    const bar = document.createElement('button');
    bar.className = 'more-bar';
    bar.textContent = label;
    terminal.appendChild(bar);
    terminal.scrollTop = terminal.scrollHeight;
    const done = (key: string) => {
      removeEventListener('keydown', onKey, true);
      bar.remove();
      resolve(key);
    };
    const onKey = (e: KeyboardEvent) => {
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return; // 修飾単独は待つ
      e.preventDefault();
      e.stopPropagation();
      done(e.key === 'Enter' ? '' : e.key.length === 1 ? e.key : ' ');
    };
    bar.addEventListener('click', () => done(' '), { once: true }); // クリックは space
    addEventListener('keydown', onKey, { capture: true });
    bar.focus();
  });
}

/**
 * クラシックの 1 ページ表示行数 = 実表示枠の行数 − 1 ([More] バー分)。
 * 枠は定義上 24 行だが、ウィンドウが小さく枠が縮む場合はその実行数で計算する
 * (実表示領域に基づくページ送り。あふれを防ぐ)。
 */
function classicPageLines(): number {
  const lh = parseFloat(getComputedStyle(terminal).lineHeight) || 24;
  const padY =
    parseFloat(getComputedStyle(terminal).paddingTop) +
    parseFloat(getComputedStyle(terminal).paddingBottom);
  const rows = Math.floor((terminal.clientHeight - padY) / lh);
  return Math.max(6, Math.min(CLASSIC_ROWS, rows) - 1);
}

const pager = new Pager(async () => {
  await waitForContinue(tr('moreBar'));
  // 古典端末のページ動作: [More] で続けるとき画面をクリアして次ページを上から
  // 表示する (枠 24 行を厳守し、前ページが残って枠を超えるのを防ぐ)。
  terminal.innerHTML = '';
}, classicPageLines);

/**
 * ゲーム本文の表示前ゲート。[More] ページ送りはクラシック専用
 * (モダンはスクロールで一気に読める利点を保つため)。
 * キー待ち・画面クリアはモード非依存で honor する (別関数)。
 */
async function pageGate(text: string): Promise<void> {
  if (!settings.classicMode) return;
  await pager.beforeAppend(estimateLines(text, CLASSIC_COLS));
}

/**
 * 画面クリア (ゲームが画面クリアを意図した演出。両モードで honor する)。
 * これはレイアウト (固定幅/可変幅) とは直交する「ゲームの表示意図」なので
 * モダンモードでも実際に端末をクリアする。
 */
function honorClear(): void {
  terminal.innerHTML = '';
  terminal.classList.remove('welcoming');
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

/** ステータス行の前回の生テキスト (重複翻訳を避ける) */
let lastStatusRaw: string | undefined;
/** 部屋名(英語)→ 訳。glossary 非依存でステータス表示を安定させる (言語/ゲーム切替でクリア) */
const roomTranslations = new Map<string, string>();

function showStatus(line: string | undefined, style?: SpanStyle): void {
  if (line === undefined) return;
  // ゲーム指定のステータス色 (例: ghosts は赤の反転バー) を topbar に反映
  const topbar = document.getElementById('topbar')!;
  const css = styleToCss(style);
  if (css.inline !== '') {
    topbar.setAttribute('style', css.inline);
    statusLine.setAttribute('style', 'color: inherit');
  }
  if (line === lastStatusRaw) return;
  lastStatusRaw = line;

  // 左=場所名 / 右=右寄せ情報 (得点・手数 / 日付等) を別要素に振り分けて右寄せ表示する
  const setStatus = (left: string, right: string) => {
    if (lastStatusRaw !== line) return;
    statusLeft.textContent = left;
    statusRight.textContent = right;
  };
  const parsed = parseStatusGeneric(line);
  // まず英語/数値を即表示 (翻訳待ちでブロックしない)。裏で和訳して差し替える
  if ('room' in parsed) {
    const right = `${tr('scoreLabel')}: ${parsed.score}　${tr('movesLabel')}: ${parsed.moves}`;
    const expectedRoom = parsed.room;
    // 部屋名は毎ターン同じでも、ステータス行は手数で変わるため exit 翻訳キャッシュは
    // 効くが、glossary が増えるとキー(glossaryHash)が変わってキャッシュが外れ、
    // 部屋名が毎回 LLM 再翻訳になって表示が間に合わず英語のまま残る (7手目で発現)。
    // 部屋名は固有名詞表記より表示安定を優先し、glossary 非依存のセッション内
    // キャッシュで即日本語表示する。
    const cached = roomTranslations.get(expectedRoom);
    setStatus(cached ?? parsed.room, right);
    if (cached === undefined) {
      void translateOut(parsed.room).then((ja) => {
        roomTranslations.set(expectedRoom, ja);
        const cur = lastStatusRaw !== undefined ? parseStatusGeneric(lastStatusRaw) : undefined;
        if (cur !== undefined && 'room' in cur && cur.room === expectedRoom) {
          statusLeft.textContent = ja;
        }
      });
    }
  } else {
    // 「左(場所名) …空白… 右(座標/時刻/日付)」形式 (ninetenths の "The Hilltop
    //  y:.. d:.. h:.. m:.." 等)。右は手数/時刻で毎ターン変わるため exit 翻訳キャッシュ
    //  が効かず、左(場所名)も glossary 増加でキャッシュが外れて翻訳が遅れ、英語のまま
    //  残る (7手目で発現)。左は glossary 非依存のセッションキャッシュで即日本語表示する。
    const right = parsed.right;
    const expectedLeft = parsed.left;
    const cachedL = roomTranslations.get(expectedLeft);
    setStatus(cachedL ?? parsed.left, right ?? '');
    if (cachedL === undefined) {
      void Promise.all([
        translateOut(parsed.left),
        right !== undefined ? translateOut(right) : Promise.resolve(''),
      ]).then(([l, r]) => {
        roomTranslations.set(expectedLeft, l);
        const cur = lastStatusRaw !== undefined ? parseStatusGeneric(lastStatusRaw) : undefined;
        if (cur !== undefined && 'left' in cur && cur.left === expectedLeft) setStatus(l, r);
      });
    }
  }
}

/** ゲーム指定の背景色を端末全体に適用し、文字背景・余白を統一する (Z-machine の
 *  「背景色設定」= 文字背景 = 画面塗り。window 背景は GlkOte に来ないので文字
 *  スパンの背景色から拾う) */
let gameBg: string | undefined;
function applyGameBackground(bg: string | undefined): void {
  if (bg === undefined || bg === gameBg) return;
  gameBg = bg;
  terminal.style.backgroundColor = bg;
  document.body.style.backgroundColor = bg;
}

/** out の rich/statusStyle から本文の背景色を拾って端末全体に適用する */
function applyBackgroundFrom(out: { rich?: StyledBlock[]; statusStyle?: SpanStyle }): void {
  let bg: string | undefined;
  for (const block of out.rich ?? []) {
    for (const line of block.lines) {
      for (const span of line.spans) {
        // reverse は前景/背景が入れ替わるので地色判定から除外
        if (span.style?.bg !== undefined && span.style.reverse !== true) {
          bg = span.style.bg;
          break;
        }
      }
      if (bg !== undefined) break;
    }
    if (bg !== undefined) break;
  }
  applyGameBackground(bg);
}

async function translateOut(body: string): Promise<string> {
  if (exitTr === undefined || body.trim() === '') return body;
  try {
    return await exitTr.translate(body);
  } catch (err) {
    print('system', tr('translateError', { err: String(err) }));
    return body;
  }
}

async function renderGameText(body: string, statusLineRaw?: string, paged = true): Promise<string> {
  showStatus(statusLineRaw);
  if (body.trim() === '') return '';
  const ja = await translateOut(body);
  const usePager = settings.classicMode && paged;
  for (const chunk of usePager ? splitForPaging(ja, CLASSIC_COLS, classicPageLines()) : [ja]) {
    if (usePager) await pageGate(chunk);
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
async function renderRichOutput(
  out: {
    body: string;
    statusLine?: string;
    statusStyle?: SpanStyle;
    rich?: StyledBlock[];
    cleared?: boolean;
  },
  paged = true,
): Promise<string> {
  // ゲームの画面クリア要求を honor (クラシック=実クリア / モダン=区切り線)
  if (out.cleared === true) {
    honorClear();
  } else {
    // upper window (grid box) は「現在の画面状態」を表す窓。本文に焼き付けず、
    // 前ターンに描画した grid box は消してから今回の grid を出す。これで grid が
    // 縮小/消滅 (メニュー終了・別の場所へ) したら過去のメニュー/カットシーンが
    // 画面に残らない (ninetenths の黄色メニュー残留の根治)。本文 buffer 段落は
    // スクロール履歴として残す。原文ビューの gridbox (.raw) は対象外。
    for (const el of terminal.querySelectorAll('.gridbox:not(.raw)')) el.remove();
  }
  applyBackgroundFrom(out); // ゲーム背景色を端末全体に統一
  showStatus(out.statusLine, out.statusStyle);
  if (out.rich === undefined) {
    return renderGameText(out.body, undefined, paged);
  }
  const grid = out.rich.find((b) => b.kind === 'grid');
  const para = out.rich.find((b) => b.kind === 'para');
  let shown = '';
  if (grid !== undefined) {
    const plain = gridPlainText(grid);
    if (plain !== '') {
      const ja = await translateOut(plain);
      if (paged) await pageGate(ja);
      printGridBox(ja, uniformStyle(grid.lines));
      shown += ja;
    }
  }
  if (para !== undefined && para.lines.some((l) => l.spans.map((s) => s.text).join('').trim() !== '')) {
    // grid (quote box) の後に本文が続くなら間に空き 1 行
    if (shown !== '') {
      if (paged) await pageGate('');
      print('', '');
    }
    // 段落別装飾が取れない段落も、本文全体の既定装飾 (ghosts は黒背景/白文字) を当てる
    shown += await printBodyParagraphs(para.lines, uniformStyle(para.lines), paged);
  }
  if (settings.showRaw && out.rich.length > 0) printRawRich(out.rich);
  return shown;
}

/**
 * 本文行を描画する (地の文・会話セリフ共通経路)。
 * **ゲーム由来の改行・空行を一切集約せず完全保持する** (splitBlocks):
 * - 段落ブロック (連続非空行) はまとめて翻訳 → 段落装飾 + 80 桁 wrap で表示
 * - 空行はそのまま空行として出力 (連続空行は連続したまま = 演出の空き 2 行等を再現)
 * wrap (右端 80 桁の折返し) だけは別途行う — 明示的な改行・空行はいじらない。
 */
async function printBodyParagraphs(
  lines: StyledLine[],
  fallbackStyle?: SpanStyle,
  paged = true,
): Promise<string> {
  let shown = '';
  const usePager = settings.classicMode && paged;
  // 空行は即出力せず保留する。[More] のページクリアでページ境界の空行が
  // 消えないよう、保留空行は「次の段落とセット」で改ページ判定し、改ページ後の
  // 先頭に繰り越して出す (タイトル前の空行などが境界で失われないように)。
  let pendingBlanks = 0;
  const emitBlanks = () => {
    for (let i = 0; i < pendingBlanks; i++) {
      print('', '');
      shown += '\n';
    }
    pendingBlanks = 0;
  };
  for (const block of splitBlocks(lines)) {
    if (block.blank) {
      pendingBlanks++;
      continue;
    }
    const plain = block.lines.map((l) => l.spans.map((s) => s.text).join('')).join('\n');
    const ja = await translateOut(plain);
    const style = uniformStyle(block.lines) ?? fallbackStyle;
    const chunks = usePager ? splitForPaging(ja, CLASSIC_COLS, classicPageLines()) : [ja];
    // 保留空行 + 段落先頭をまとめて改ページ判定 (空行が境界でちぎれて消えない)
    if (usePager) await pager.beforeAppend(pendingBlanks + estimateLines(chunks[0]!, CLASSIC_COLS));
    emitBlanks(); // 改ページ後ならクリア済みの次ページ先頭に空行を繰り越す
    printStyledPara(chunks[0]!, style);
    for (const chunk of chunks.slice(1)) {
      if (usePager) await pager.beforeAppend(estimateLines(chunk, CLASSIC_COLS));
      printStyledPara(chunk, style);
    }
    shown += ja;
  }
  // ターン末尾の空行も保持する (集約・削除しない)
  if (usePager && pendingBlanks > 0) await pager.beforeAppend(pendingBlanks);
  emitBlanks();
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
    b.textContent = tr('endConversation');
    b.addEventListener('click', () => void submitMenuSelection(''));
    choices.appendChild(b);
  }
  choices.hidden = false;
  input.placeholder = tr('inputPlaceholderMenu');
}

function showQuestionChoices(): void {
  choices.innerHTML = '';
  for (const [label, value] of [[tr('yes'), 'yes'], [tr('no'), 'no']] as const) {
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
  out: { body: string; statusLine?: string; statusStyle?: SpanStyle; rich?: StyledBlock[] },
  spec: MenuSpec,
): Promise<void> {
  applyBackgroundFrom(out);
  showStatus(out.statusLine, out.statusStyle);
  // 会話セリフ (narrative) も地の文と同じ既定装飾 (ghosts は黒背景/白文字) を当てる。
  // rich の para から一様装飾を取得 (会話は一様) し fallback とする
  const para = out.rich?.find((b) => b.kind === 'para');
  const bodyStyle = para !== undefined ? uniformStyle(para.lines) : undefined;
  const { narrative, headerLine } = splitMenuBlock(out.body, spec);
  if (narrative.trim() !== '') {
    // narrative の改行・空行を保持したまま地の文と共通経路へ (各行を StyledLine 化)
    const narrLines: StyledLine[] = narrative.split('\n').map((t) => ({ spans: [{ text: t }] }));
    await printBodyParagraphs(narrLines, bodyStyle);
    if (settings.showRaw) print('raw', narrative);
  }
  const cleanup = (t: string) => t.trim().replace(/^[「『"']+|[」』"'。]+$/g, '');
  const headerJa = headerLine !== undefined ? cleanup(await translateOut(headerLine)) : '';
  const labelsJa = await Promise.all(spec.choices.map((c) => translateOut(c.label)));
  const labeled: MenuChoice[] = spec.choices.map((c, i) => ({
    key: c.key,
    label: cleanup(labelsJa[i] ?? '') || c.label,
  }));
  const menuLines = [
    ...(narrative !== '' ? [''] : []), // セリフとメニューの間に空き 1 行
    ...(headerJa !== '' ? [headerJa] : []),
    ...labeled.map((c) => `  ${c.key}: ${c.label}`),
    ...(spec.enterEnds ? [tr('enterEndsConversation')] : []),
  ];
  const menuText = menuLines.join('\n');
  await pageGate(menuText);
  printStyledPara(menuText, bodyStyle); // メニューも本文と同じ地色
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
    print('system', tr('gameOverBanner'));
    input.placeholder = tr('loadNewGameHint');
  }
}

async function submitMenuSelection(key: string): Promise<void> {
  if (engine === undefined || session === undefined) return;
  setBusy(true);
  pager.reset();
  clearChoices();
  try {
    print('cmd', `> ${key === '' ? tr('conversationEnded') : key}`);
    const out = await sendResolvingPauses(engine, key);
    session.pushGameOutput(out.body);
    await presentOutput(out);
  } catch (err) {
    print('system', tr('error', { err: String(err) }));
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
    print('system', tr('error', { err: String(err) }));
  } finally {
    setBusy(false);
  }
}

/**
 * keypress 待ち (char 入力要求の query) を、ユーザーのキー/クリックで 1 つずつ進める。
 * 冒頭の引用画面・HELP・カットシーンの「press space」を honor する共通経路。
 * char query の間 [描画 → キー待ちバー → space 送信] を繰り返し、最初の非 char 出力を返す。
 */
async function resolveKeypresses(out: EngineOutput): Promise<EngineOutput> {
  let cur = out;
  while (
    engine !== undefined &&
    cur.kind === 'query' &&
    cur.request === 'char' &&
    detectMenu(cur.body) === undefined &&
    !REAL_QUESTION_RE.test(cur.body.trimEnd())
  ) {
    await renderRichOutput(cur, false); // char メニュー画面は1画面更新 — [More] を挟まない
    // 押されたキーをそのまま VM へ (引用画面は任意キーで進み、HELP メニューは Q/N/P 等で操作)
    const key = await waitForKey(tr('keyWaitBar'));
    cur = await engine.send(key);
  }
  return cur;
}

/** 英語コマンドを入口翻訳せず直接ゲームへ送る (「>」直接入力の実体) */
async function sendRawCommand(raw: string): Promise<void> {
  if (engine === undefined || session === undefined) return;
  if (raw === '') {
    setBusy(false);
    return;
  }
  setBusy(true);
  pager.reset();
  print('cmd', `> ${raw}`);
  try {
    let out = await sendResolvingPauses(engine, raw);
    if (out.kind === 'query' && out.request === 'char') {
      out = await resolveKeypresses(out);
    }
    session.pushGameOutput(out.body);
    await presentOutput(out);
    if (out.kind === 'gameover') gameOver = true;
  } catch (err) {
    print('system', tr('error', { err: String(err) }));
  } finally {
    setBusy(false);
  }
}

async function handleUserInput(ja: string): Promise<void> {
  if (engine === undefined || session === undefined || entry === undefined) {
    print('system', tr('loadGameFirst'));
    return;
  }
  if (gameOver) {
    print('system', tr('gameEnded'));
    return;
  }
  // 「>」プレフィックスは英語コマンドを入口翻訳せずそのままゲームへ送る回復手段
  // (詰まった時にプレイヤーが正解の英コマンドを直接打てる。LLM を通さないので
  //  完全に決定論的。メニュー選択中は通常処理に委ねる)。
  if (activeMenu === undefined && ja.trimStart().startsWith('>')) {
    await sendRawCommand(ja.trimStart().slice(1).trim());
    return;
  }
  setBusy(true);
  pager.reset();
  print('user', ja);
  const thinking = print('thinking', tr('thinking'));
  try {
    // メニュー表示中は選択として解釈
    if (activeMenu !== undefined) {
      const spec = activeMenu;
      let selection: string | undefined;
      const trimmed = ja.trim();
      if (trimmed === '' || LANGUAGE_PROFILES[settings.language].endConversationWords.includes(trimmed.toLowerCase())) {
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
        print('system', tr('noSuchChoice', { keys: spec.choices.map((c) => c.key).join('/') }));
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
      print('cmd', `> ${r.command}${r.corrected ? ' ' + tr('corrected') : ''}`);
      if (r !== lastResult) {
        await renderRichOutput(r.output);
        continue;
      }
      // 最後の出力が keypress 待ち (HELP 等) なら、ユーザーキーで進めてから提示する。
      // resolveKeypresses が char query 画面を描画し、最初の非 char 出力を返す。
      if (r.output.kind === 'query' && r.output.request === 'char') {
        const final = await resolveKeypresses(r.output);
        if (final !== r.output) session.pushGameOutput(final.body);
        await presentOutput(final);
      } else {
        await presentOutput(r.output);
      }
    }
    if (turn.error !== undefined) {
      // game 由来 (ゲーム英語) は出口翻訳に回す。app 由来は既にプレイヤー向け文言
      const msg =
        turn.error.source === 'game'
          ? await translateOut(turn.error.message)
          : tr(turn.error.code === 'noCommands' ? 'appNoCommands' : 'appNoCommands');
      print('system', msg);
    }
    if (turn.aborted) print('cmd', tr('abortedRest'));
    if (turn.gameOver) gameOver = true; // 表示は presentOutput 側
  } catch (err) {
    thinking.remove();
    print('system', tr('error', { err: String(err) }));
  } finally {
    setBusy(false);
  }
}

async function startGame(data: Uint8Array, filename: string): Promise<void> {
  setBusy(true);
  // 設定で選んだ言語を「次に開くゲーム」= ここで UI・本文ともに反映する
  // (ゲーム中の言語変更は commit では UI に即時反映していない。ここで揃う)
  applyUiLanguage();
  terminal.innerHTML = '';
  terminal.classList.remove('welcoming');
  clearChoices();
  // ゲーム切替: 背景色・ステータスのキャッシュをリセット
  gameBg = undefined;
  lastStatusRaw = undefined;
  roomTranslations.clear(); // 言語/ゲームが変わると部屋名の訳も変わる
  terminal.style.backgroundColor = '';
  document.body.style.backgroundColor = '';
  gameOver = false;
  try {
    const info = analyzeStory(data, filename);
    if (info.format === 'glulx') {
      print('system', tr('glulxNotReady'));
      return;
    }
    if (info.vocabError !== undefined) {
      print('system', tr('dictExtractFail', { err: String(info.vocabError) }));
    }
    const id = await storyId(info);

    llm = makeLLM();
    const prompts = new BundledPromptProvider();
    entry = new EntryTranslator(
      llm,
      prompts,
      {
        contextTurns: settings.contextTurns,
        scope: id,
        logger,
        language: settings.language,
      },
      new IdbCacheStore(`entry:${id}`),
    );
    await entry.init(info.vocab);
    exitTr = new ExitTranslator(
      llm,
      prompts,
      new IdbCacheStore(`exit:${id}`),
      logger,
      settings.language,
      id,
    );
    const glossaryNote = print('thinking', tr('glossaryPreparing'));
    try {
      await exitTr.init(usefulObjectNames(info.vocab.objectNames));
    } catch (err) {
      // LLM 不通でもゲーム自体は起動する (翻訳は原文フォールバック)
      print('system', tr('llmConnectFail', { err: String(err).slice(0, 160) }));
      print('system', tr('settingsHint'));
      await exitTr.init([]);
    } finally {
      glossaryNote.remove();
    }

    engine = new EmglkenEngine({
      vm: 'bocfel',
      storyName: filename,
      storyData: data,
      dialogPort: new ModalDialogPort(() => settings.language),
      saveStore: new IdbSaveStore(id),
      loadWasmBinary: wasmLoader('bocfel'),
    });
    session = new Session(engine, entry, {
      maxRetriesPerCommand: 2,
      maxLlmCallsPerInput: 8,
      contextTurns: settings.contextTurns,
    }, logger);

    const loading = print('system', tr('startingGame', { filename }));
    pager.reset();
    let out = await engine.start();
    loading.remove(); // 起動完了 → ローディング表示を消す
    // 冒頭の引用画面・keypress 待ちは演出意図なので両モードで honor し、ユーザーの
    // キー入力を待って進める (HELP 等のキー待ちと同じ resolveKeypresses 経路)。
    out = await resolveKeypresses(out);
    session.pushGameOutput(out.body);
    await presentOutput(out);
    print('system', tr('inputPlaceholderExample'));
  } catch (err) {
    print('system', tr('startError', { err: String(err) }));
  } finally {
    setBusy(false);
  }
}

// ---- 設定ダイアログ ----

/**
 * <html lang> をプレイ言語に合わせる。ただし UI 文言は当面日本語のままなので
 * (フェーズC で i18n)、ゲーム本文領域 (#terminal) の lang だけ切り替え、
 * document 全体は ja のままにして UI=ja / 本文=選択言語 の混在を厳密にする。
 */
function applyUiLanguage(): void {
  // UI 文言も翻訳済みなので document 全体の lang を選択言語にする
  document.documentElement.lang = settings.language;
  terminal.setAttribute('lang', settings.language);
  applyDomI18n(settings.language); // index.html の data-i18n を選択言語へ
}
/** UI 文言を引く近道 (現在の設定言語) */
function tr(key: Parameters<typeof t>[1], params?: Parameters<typeof t>[2]): string {
  return t(settings.language, key, params);
}

function wireSettings(): void {
  const dialog = $<HTMLDialogElement>('settings-dialog');
  const baseUrl = $<HTMLInputElement>('set-baseurl');
  const apiKey = $<HTMLInputElement>('set-apikey');
  const persist = $<HTMLInputElement>('set-persistkey');
  const model = $<HTMLInputElement>('set-model');
  const modelList = $<HTMLDataListElement>('model-list');
  const testResult = $('test-result');
  const langSelect = $<HTMLSelectElement>('set-language');
  // 言語セレクタを LANGUAGE_PROFILES から生成 (既定 ja)
  for (const code of SUPPORTED_LANGUAGES) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = LANGUAGE_PROFILES[code].label;
    langSelect.appendChild(opt);
  }

  // フォームの各入力を現在の settings から hydrate する。option 生成直後・設定を
  // 開く前・auto-open 前に必ず呼ぶ (これを怠ると select が先頭 ja のまま残り、
  // 「UI=fr なのにセレクタ表示が日本語」になる — Codex 高指摘の根本原因)
  const syncSettingsForm = () => {
    baseUrl.value = settings.baseUrl;
    apiKey.value = settings.apiKey;
    persist.checked = settings.persistKey;
    model.value = settings.model;
    langSelect.value = settings.language;
  };
  syncSettingsForm(); // 起動時の初期同期 (auto-open もこの値を表示する)

  const commit = () => {
    settings = {
      ...settings,
      baseUrl: baseUrl.value.trim().replace(/\/$/, '') || DEFAULT_SETTINGS.baseUrl,
      apiKey: apiKey.value.trim(),
      persistKey: persist.checked,
      model: model.value.trim(),
      language: isLanguageCode(langSelect.value) ? langSelect.value : DEFAULT_SETTINGS.language,
    };
    saveSettings(settings);
    // 言語変更の UI 反映はゲーム未開始時のみ即時。ゲーム中は entry/exit/session/
    // キャッシュが開始時の言語を保持しているため、UI も「次に開くゲームから」に
    // 揃える (注意書きと実装の整合。startGame で applyUiLanguage を呼ぶ)
    if (engine === undefined) applyUiLanguage();
  };

  $('btn-settings').addEventListener('click', () => {
    syncSettingsForm();
    testResult.textContent = '';
    dialog.showModal();
  });
  // close イベントだけに依存せず、変更の都度コミットする (取りこぼし防止)
  for (const el of [baseUrl, apiKey, model, langSelect]) el.addEventListener('change', commit);
  persist.addEventListener('change', commit);
  dialog.addEventListener('close', commit);

  $('btn-test').addEventListener('click', () => {
    void (async () => {
      testResult.className = '';
      testResult.textContent = tr('checking');
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
        testResult.textContent = tr('connectOk', { n: models.length });
      } catch {
        // /models 非対応サーバ → chat 疎通にフォールバック (plan: 2 段接続テスト)
        try {
          await probe.chat([{ role: 'user', content: 'ping' }]);
          testResult.className = 'ok';
          testResult.textContent = tr('connectOkChat');
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
      const url = window.prompt(tr('urlPrompt'));
      if (!url) return;
      dialog.close();
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const name = new URL(url, location.href).pathname.split('/').pop() || 'story.z5';
        await startGame(new Uint8Array(await res.arrayBuffer()), name);
      } catch (err) {
        print('system', tr('urlLoadFail', { err: String(err) }));
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
  // 「開く」は設定内のボタンと共通の file-input を起動 (change は wireSettings 配線済み)
  $('btn-open-top').addEventListener('click', () => $<HTMLInputElement>('file-input').click());

  // ☰ ハンバーガーメニューの開閉。項目クリックで閉じ、メニュー外クリックでも閉じる
  const menuButton = $('btn-menu');
  const menu = $('topbar-menu');
  const setMenu = (open: boolean) => {
    menu.hidden = !open;
    menuButton.setAttribute('aria-expanded', String(open));
  };
  menuButton.addEventListener('click', (e) => {
    e.stopPropagation();
    setMenu(menu.hidden);
  });
  // メニュー内ボタンを押したら各機能 (既存リスナ) 実行後にメニューを閉じる
  for (const item of menu.querySelectorAll('button')) {
    item.addEventListener('click', () => setMenu(false));
  }
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target as Node) && e.target !== menuButton) setMenu(false);
  });
}

// ---- 起動 ----
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const value = input.value.trim();
  if (value === '') return;
  input.value = '';
  void handleUserInput(value);
});

/** 起動時/ゲーム未読み込み時のウェルカム画面 (ロゴ + サブタイトル + 操作ヒント) */
function showWelcome(): void {
  terminal.innerHTML = '';
  terminal.classList.add('welcoming');
  const wrap = document.createElement('div');
  wrap.className = 'welcome';
  const logo = document.createElement('p');
  logo.className = 'logo';
  logo.textContent = 'yominterp';
  const subtitle = document.createElement('p');
  subtitle.className = 'subtitle';
  subtitle.textContent = tr('welcomeSubtitle');
  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = tr('welcomeHint');
  const rawHint = document.createElement('p');
  rawHint.className = 'hint';
  rawHint.textContent = tr('rawCommandHint');
  wrap.append(logo, subtitle, hint, rawHint);
  terminal.appendChild(wrap);
}

wireSettings();
wireTopbar();
applyUiLanguage();
showWelcome();

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
