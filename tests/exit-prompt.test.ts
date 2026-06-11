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
