import { describe, expect, it } from 'vitest';
import { SUPPORTED_LANGUAGES } from '../src/core/i18n/language.js';
import { t } from '../src/web/i18n/messages.js';

describe('UI メッセージカタログ', () => {
  it('t: placeholder を params で差し込む', () => {
    expect(t('ja', 'scoreLabel')).toBe('得点');
    expect(t('ja', 'connectOk', { n: 6 })).toBe('接続 OK (モデル 6 件)');
    expect(t('fr', 'connectOk', { n: 6 })).toBe('Connexion OK (6 modèles)');
    expect(t('ja', 'startingGame', { filename: 'ghosts.z5' })).toBe('ghosts.z5 を起動中…');
  });

  it('全対象言語が ja と同じキー集合を持つ (欠落なし)', () => {
    // ja のキー一覧を基準に、全言語で未訳 ([key] 形式) が出ないことを確認
    const jaKeys = (
      [
        'moreBar',
        'keyWaitBar',
        'scoreLabel',
        'movesLabel',
        'endConversation',
        'inputPlaceholder',
        'welcomeSubtitle',
        'welcomeHint',
        'menuOpen',
        'menuSettings',
        'settingsTitle',
        'playLanguage',
        'betaNotice',
        'saveTitle',
        'loadTitle',
        'noSaves',
        'overwrite',
        'error',
        'startingGame',
        'connectOk',
        'gameOverBanner',
        'thinking',
      ] as const
    ).map((k) => k);
    for (const lang of SUPPORTED_LANGUAGES) {
      for (const key of jaKeys) {
        const v = t(lang, key, { n: 1, name: 'x', filename: 'x', err: 'x', keys: 'x' });
        expect(v, `${lang}:${key} が未訳`).not.toMatch(/^\[/); // 未訳は [key] になる
        expect(v.length, `${lang}:${key} が空`).toBeGreaterThan(0);
      }
    }
  });

  it('未対応キーは [key] で可視化される (静かな ja フォールバックをしない)', () => {
    // 型外のキーを無理やり渡しても [key] になる
    expect(t('fr', 'nonexistent' as never)).toBe('[nonexistent]');
  });
});
