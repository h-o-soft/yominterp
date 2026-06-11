import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 回帰防止: exit プロンプトに特定作品 (ghosts = ゴシックホラー/古い洋館/1986 スコットランド)
// の priming が残ると、短い status 文字列 (部屋名) の翻訳でモデルがその世界観の
// シーンを捏造する (ninetenths の Sloping Path で「部屋の暗闇/石造りの廊下/どうする?」
// を出していた)。priming を持たず・創作禁止を明示することを固定する。
describe('exit プロンプトの中立性 (ゴシック捏造防止)', () => {
  const suffixes = ['', '.es', '.fr', '.de', '.pt-BR'];
  for (const suf of suffixes) {
    const path = `prompts/exit.system${suf}.md`;
    const text = readFileSync(path, 'utf8');
    it(`${path} に特定作品の priming がない`, () => {
      expect(text).not.toMatch(/gothic|ゴシック|an old manor|古い洋館|1986/i);
    });
    it(`${path} に「原文にない内容を創作しない」制約がある`, () => {
      expect(text).toMatch(/創作|invent|fabricate/i);
    });
  }
});

// 回帰防止: 地の文・システム応答の口調汚染 (ghosts で実測した「ランプの油が
// なくなっているわ」問題)。glossary の女性NPC名や直前の会話相手の口調が
// 地の文に伝播しないよう、ナレーション中立規則をプロンプト契約として固定する。
describe('exit プロンプトのナレーション中立規則 (口調汚染防止)', () => {
  it('ja: 常体・性別終助詞禁止・引用内のみ話者口調の規則がある', () => {
    const text = readFileSync('prompts/exit.system.md', 'utf8');
    expect(text).toMatch(/常体/);
    expect(text).toMatch(/性別を感じさせる終助詞/);
    expect(text).toMatch(/主人公の性別を断定/);
    expect(text).toMatch(/引用の外 \(地の文\) に持ち込まない/);
  });
  for (const suf of ['.es', '.fr', '.de', '.pt-BR']) {
    it(`exit.system${suf}.md: ナレーション中立 (neutral register) の規則がある`, () => {
      const text = readFileSync(`prompts/exit.system${suf}.md`, 'utf8');
      expect(text).toMatch(/neutral register/);
      expect(text).toMatch(/gender-neutral wording/);
      expect(text).toMatch(/Only inside quoted speech/);
    });
  }
  it('glossary 節に「文体の手がかりにしない」の補助指示がある (exit.ts)', () => {
    const src = readFileSync('src/core/translate/exit.ts', 'utf8');
    expect(src).toMatch(/文体・口調の手がかりにしない/);
  });
});
