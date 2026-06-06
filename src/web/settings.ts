/**
 * 設定の保持と設定ダイアログ。
 * - apiKey は既定 in-memory (リロードで消える)。永続化は明示 opt-in (plan.md 段階2)
 * - その他の設定は localStorage
 */

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
};

export function loadSettings(): WebSettings {
  let stored: Partial<WebSettings> = {};
  try {
    stored = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}') as Partial<WebSettings>;
  } catch {
    /* localStorage 不可・破損 → 既定 */
  }
  const settings: WebSettings = { ...DEFAULT_SETTINGS, ...stored, apiKey: '' };
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
