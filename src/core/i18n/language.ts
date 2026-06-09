/**
 * 言語コードと言語プロファイルのレジストリ (多言語対応の中核)。
 *
 * 設計の不変条件 (plan.md):
 * - 既定言語は日本語 (ja)。多言語は実験的オプションで、ja の挙動は一切変えない。
 * - ja は「無印」プロンプトファイル (entry.system.md 等) を canonical とする。
 *   他言語は接尾辞付き (entry.system.fr.md 等)。
 * - **fail closed**: 非 ja で言語別ファイルが無いとき、無印 (日本語) へ暗黙で
 *   フォールバックしない。PromptProvider.load がファイル不在で throw する。
 *
 * core 用 LanguageProfile は entry/exit/meta/glossary に責務を限定する
 * (UI メッセージカタログは src/web/i18n 側。core の環境非依存境界を守る)。
 *
 * このファイルは環境非依存 (Node API import 禁止)。
 */

export type LanguageCode = 'ja' | 'es' | 'fr' | 'de' | 'pt-BR';

/** フェーズ1 対象言語 (ja + ラテン文字4言語)。CJK/RTL は対象外 */
export const SUPPORTED_LANGUAGES: readonly LanguageCode[] = ['ja', 'es', 'fr', 'de', 'pt-BR'];

export const DEFAULT_LANGUAGE: LanguageCode = 'ja';

export function isLanguageCode(value: unknown): value is LanguageCode {
  return typeof value === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

/**
 * 設定値 (env/config/localStorage) の言語コードを検証する。
 * 許可リスト外は **エラー** (silent fallback はしない — 非 ja prompt の
 * fail closed と整合させ、設定ミスを早期に気づかせる)。
 */
export function coerceLanguage(value: unknown): LanguageCode {
  if (value === undefined || value === null || value === '') return DEFAULT_LANGUAGE;
  if (isLanguageCode(value)) return value;
  throw new Error(
    `未対応の言語コードです: ${String(value)} (対応: ${SUPPORTED_LANGUAGES.join(', ')})`,
  );
}

/**
 * プロンプト/few-shot のファイル名を言語別に解決する。
 * - ja: 無印 (canonical) — 'entry.system.md' / 'fewshot.entry.json'
 * - 他言語: 拡張子の手前に言語コードを挿入 — 'entry.system.fr.md' / 'fewshot.entry.fr.json'
 */
export function promptFileName(base: string, lang: LanguageCode): string {
  if (lang === DEFAULT_LANGUAGE) return base;
  const dot = base.lastIndexOf('.');
  if (dot < 0) return `${base}.${lang}`;
  return `${base.slice(0, dot)}.${lang}${base.slice(dot)}`;
}

/**
 * core 用の言語プロファイル。
 * フェーズ0 では表示名のみ (レジストリの器)。フェーズA で META_INTENT の
 * キーワード表・glossary 構築プロンプト・固有名詞回収戦略・入口ラベル等を
 * ここへ集約する (entry/exit/meta/glossary に責務限定)。
 */
export interface LanguageProfile {
  code: LanguageCode;
  /** UI の言語セレクタ等に出す表示名 */
  label: string;
}

export const LANGUAGE_PROFILES: Record<LanguageCode, LanguageProfile> = {
  ja: { code: 'ja', label: '日本語' },
  es: { code: 'es', label: 'Español' },
  fr: { code: 'fr', label: 'Français' },
  de: { code: 'de', label: 'Deutsch' },
  'pt-BR': { code: 'pt-BR', label: 'Português (Brasil)' },
};
