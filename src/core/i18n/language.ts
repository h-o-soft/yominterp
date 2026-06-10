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
  /**
   * 固有名詞 glossary 戦略:
   * - 'katakana': 日本語のカタカナ正準化 (LLM で人名を選別 + カタカナ(原文)併記から回収)
   * - 'none': 原文維持 (identity)。ラテン文字言語は固有名詞をそのまま使うため glossary 不要
   */
  glossary: 'katakana' | 'none';
  /**
   * 入口 META_INTENT のキーワード正規表現 (メタ操作の意図判定)。
   * [英コマンドにマッチする RegExp, プレイヤー言語の意図キーワード RegExp][]
   */
  metaIntent: [RegExp, RegExp][];
  /**
   * 入口の補助プロンプト (retry/retranslate/メニュー選択器・文脈ラベル) の言語。
   * - 'ja': 日本語 (既定・既存挙動を一切変えない)
   * - 'en': 英語 (多言語モデルに普遍的に効く命令文)。非日本語はこちら。
   * 補助プロンプトは「LLM への命令」なので、ターゲット言語そのものより
   * モデルが確実に理解する言語にする方が品質が安定する。
   */
  auxPromptLang: 'ja' | 'en';
  /** メニューで会話を終える意図のキーワード (プレイヤー言語・小文字照合) */
  endConversationWords: string[];
}

/** ja の META_INTENT (日本語キーワード) — 既存挙動を変えないため exit/entry から移設 */
const JA_META_INTENT: [RegExp, RegExp][] = [
  [/^(quit|q)$/, /終了|やめ(る|たい)|終わ(る|り|らせ)|ゲームを(終|や)|クイット/],
  [/^restart$/, /最初から|初めから|リスタート|やり直|再スタート/],
  [/^restore$/, /ロード|リストア|復元|再開|セーブを(読|呼)/],
  [/^save$/, /セーブ|保存/],
  [/^undo$/, /取り消|アンドゥ|(手|ターン)を戻/],
];

const FR_META_INTENT: [RegExp, RegExp][] = [
  [/^(quit|q)$/, /quitter|arrêter|terminer le jeu|abandonner/i],
  [/^restart$/, /recommencer|redémarrer|depuis le début/i],
  [/^restore$/, /charger|restaurer|reprendre|sauvegarde/i],
  [/^save$/, /sauvegarder|enregistrer/i],
  [/^undo$/, /annuler|défaire|revenir en arrière/i],
];

const ES_META_INTENT: [RegExp, RegExp][] = [
  [/^(quit|q)$/, /salir|terminar el juego|abandonar/i],
  [/^restart$/, /reiniciar|empezar de nuevo|desde el principio/i],
  [/^restore$/, /cargar|restaurar|continuar|partida guardada/i],
  [/^save$/, /guardar|salvar/i],
  [/^undo$/, /deshacer|anular|volver atrás/i],
];

const DE_META_INTENT: [RegExp, RegExp][] = [
  [/^(quit|q)$/, /beenden|aufhören|spiel beenden/i],
  [/^restart$/, /neu ?starten|von vorne|neustart/i],
  [/^restore$/, /laden|wiederherstellen|fortsetzen|spielstand/i],
  [/^save$/, /speichern|sichern/i],
  // 「zurück」単独は移動の「戻る」と衝突するため undo の語彙から外す (Codex 指摘)
  [/^undo$/, /rückgängig|zurücknehmen|widerrufen/i],
];

const PT_META_INTENT: [RegExp, RegExp][] = [
  [/^(quit|q)$/, /sair|encerrar o jogo|abandonar/i],
  [/^restart$/, /reiniciar|recomeçar|do início/i],
  [/^restore$/, /carregar|restaurar|continuar|jogo salvo/i],
  [/^save$/, /salvar|guardar/i],
  [/^undo$/, /desfazer|anular|voltar atrás/i],
];

export const LANGUAGE_PROFILES: Record<LanguageCode, LanguageProfile> = {
  ja: {
    code: 'ja', label: '日本語', glossary: 'katakana', metaIntent: JA_META_INTENT,
    auxPromptLang: 'ja',
    endConversationWords: ['終わる', '終える', '終了', 'やめる'],
  },
  es: {
    code: 'es', label: 'Español', glossary: 'none', metaIntent: ES_META_INTENT,
    auxPromptLang: 'en',
    endConversationWords: ['terminar', 'salir', 'irse', 'adiós', 'fin'],
  },
  fr: {
    code: 'fr', label: 'Français', glossary: 'none', metaIntent: FR_META_INTENT,
    auxPromptLang: 'en',
    endConversationWords: ['terminer', 'quitter', 'partir', 'au revoir', 'fin'],
  },
  de: {
    code: 'de', label: 'Deutsch', glossary: 'none', metaIntent: DE_META_INTENT,
    auxPromptLang: 'en',
    endConversationWords: ['beenden', 'schließen', 'verlassen', 'tschüss', 'ende'],
  },
  'pt-BR': {
    code: 'pt-BR', label: 'Português (Brasil)', glossary: 'none', metaIntent: PT_META_INTENT,
    auxPromptLang: 'en',
    endConversationWords: ['encerrar', 'terminar', 'sair', 'tchau', 'fim'],
  },
};
