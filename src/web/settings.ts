/**
 * 設定の保持と設定ダイアログ。
 * - apiKey は既定 in-memory (リロードで消える)。永続化は明示 opt-in (plan.md 段階2)
 * - その他の設定は localStorage
 */
import { type LanguageCode, DEFAULT_LANGUAGE, coerceLanguage } from '../core/i18n/language.js';

export interface WebSettings {
  baseUrl: string;
  model: string;
  apiKey: string; // in-memory (persistKey=true の時のみ localStorage)
  persistKey: boolean;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  contextTurns: number;
  showRaw: boolean;
  /** プレイヤー言語 (既定 ja)。多言語は実験的オプション */
  language: LanguageCode;
}

const LS_KEY = 'yominterp-settings';
const LS_API_KEY = 'yominterp-apikey';

export const DEFAULT_SETTINGS: WebSettings = {
  baseUrl: 'http://127.0.0.1:1234/v1',
  model: '',
  apiKey: '',
  persistKey: false,
  temperature: 0,
  maxTokens: 1024,
  timeoutMs: 120000,
  contextTurns: 2,
  showRaw: false,
  language: DEFAULT_LANGUAGE,
};

export function loadSettings(): WebSettings {
  let stored: Partial<WebSettings> = {};
  try {
    stored = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}') as Partial<WebSettings>;
  } catch {
    /* localStorage 不可・破損 → 既定 */
  }
  const settings: WebSettings = { ...DEFAULT_SETTINGS, ...stored, apiKey: '' };
  // localStorage が壊れて不正な言語コードでもアプリは起動させる (既定へ)。
  // 設定 UI のセレクタは許可値のみなので、実害は手編集時の堅牢性のみ。
  try {
    settings.language = coerceLanguage(settings.language);
  } catch {
    settings.language = DEFAULT_LANGUAGE;
  }
  if (settings.persistKey) {
    try {
      settings.apiKey = localStorage.getItem(LS_API_KEY) ?? '';
    } catch {
      /* noop */
    }
  }
  return settings;
}

export function saveSettings(s: WebSettings): void {
  try {
    const { apiKey: _omit, ...rest } = s;
    localStorage.setItem(LS_KEY, JSON.stringify(rest));
    if (s.persistKey) localStorage.setItem(LS_API_KEY, s.apiKey);
    else localStorage.removeItem(LS_API_KEY);
  } catch {
    /* プライベートモード等 — メモリのみで続行 */
  }
}
