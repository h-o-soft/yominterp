import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LANGUAGE,
  SUPPORTED_LANGUAGES,
  coerceLanguage,
  isLanguageCode,
  promptFileName,
} from '../src/core/i18n/language.js';

describe('language コード', () => {
  it('既定は ja、対象は ja+ラテン4言語', () => {
    expect(DEFAULT_LANGUAGE).toBe('ja');
    expect([...SUPPORTED_LANGUAGES].sort()).toEqual(['de', 'es', 'fr', 'ja', 'pt-BR'].sort());
  });

  it('isLanguageCode は許可値のみ true', () => {
    expect(isLanguageCode('ja')).toBe(true);
    expect(isLanguageCode('fr')).toBe(true);
    expect(isLanguageCode('zh')).toBe(false);
    expect(isLanguageCode('')).toBe(false);
    expect(isLanguageCode(undefined)).toBe(false);
  });

  it('coerceLanguage: 未指定は既定、許可値は通す、許可外はエラー (silent fallback しない)', () => {
    expect(coerceLanguage(undefined)).toBe('ja');
    expect(coerceLanguage('')).toBe('ja');
    expect(coerceLanguage('fr')).toBe('fr');
    expect(() => coerceLanguage('zh')).toThrow(/未対応の言語/);
    expect(() => coerceLanguage('klingon')).toThrow();
  });
});

describe('promptFileName (ja=無印 canonical / 他言語=接尾辞)', () => {
  it('ja は無印 (既存ファイル名のまま)', () => {
    expect(promptFileName('entry.system.md', 'ja')).toBe('entry.system.md');
    expect(promptFileName('exit.system.md', 'ja')).toBe('exit.system.md');
    expect(promptFileName('fewshot.entry.json', 'ja')).toBe('fewshot.entry.json');
  });

  it('他言語は拡張子の手前に言語コードを挿入', () => {
    expect(promptFileName('entry.system.md', 'fr')).toBe('entry.system.fr.md');
    expect(promptFileName('exit.system.md', 'de')).toBe('exit.system.de.md');
    expect(promptFileName('fewshot.entry.json', 'es')).toBe('fewshot.entry.es.json');
    expect(promptFileName('exit.system.md', 'pt-BR')).toBe('exit.system.pt-BR.md');
  });
});
