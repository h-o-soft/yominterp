import { describe, expect, it } from 'vitest';
import { LLMClient } from '../src/core/llm/client.js';
import { NULL_LOGGER } from '../src/core/ports.js';
import type { CacheStore, LLMTransport, PromptProvider } from '../src/core/ports.js';
import { EntryTranslator } from '../src/core/translate/entry.js';
import { ExitTranslator } from '../src/core/translate/exit.js';

/** 言語別ファイルを持つ fake PromptProvider (ja=無印, fr=接尾辞。de は欠落) */
const MULTILANG_PROMPTS: PromptProvider = {
  load: async (name) => {
    const map: Record<string, string> = {
      'exit.system.md': 'JA exit prompt',
      'exit.system.fr.md': 'FR exit prompt',
      'entry.system.md': 'JA entry {{DICT_WORDS}} {{OBJECT_NAMES}} {{DICT_WORD_LEN}}',
      'entry.system.fr.md': 'FR entry {{DICT_WORDS}} {{OBJECT_NAMES}} {{DICT_WORD_LEN}}',
      'fewshot.entry.json': '[]',
      'fewshot.entry.fr.json': '[]',
    };
    const v = map[name];
    if (v === undefined) throw new Error(`prompt not found: ${name}`);
    return v;
  },
};

function makeExit(
  cache: CacheStore | undefined,
  language: 'ja' | 'fr' | 'de',
): { tr: ExitTranslator; systems: string[]; calls: number } {
  const systems: string[] = [];
  const counter = { n: 0 };
  const transport: LLMTransport = {
    post: async (_p, body) => {
      const messages = (body as { messages: { content: string }[] }).messages;
      systems.push(messages[0]!.content);
      counter.n++;
      return { choices: [{ message: { content: `T(${messages[1]!.content})` } }] };
    },
    get: async () => ({}),
  };
  const llm = new LLMClient(transport, {
    model: 'm',
    temperature: 0,
    maxTokens: 100,
    timeoutMs: 1000,
  });
  const tr = new ExitTranslator(llm, MULTILANG_PROMPTS, cache, NULL_LOGGER, language);
  return {
    tr,
    systems,
    get calls() {
      return counter.n;
    },
  };
}

describe('多言語: 出口プロンプトの言語別解決と fail closed', () => {
  it('ja は無印 prompt を使う', async () => {
    const e = makeExit(undefined, 'ja');
    await e.tr.init();
    await e.tr.translate('Hello.');
    expect(e.systems[0]).toContain('JA exit prompt');
  });

  it('fr は接尾辞 prompt を使う (暗黙の日本語化をしない)', async () => {
    const e = makeExit(undefined, 'fr');
    await e.tr.init();
    await e.tr.translate('Hello.');
    expect(e.systems[0]).toContain('FR exit prompt');
    expect(e.systems[0]).not.toContain('JA exit prompt');
  });

  it('言語別ファイルが無いと fail closed (init が throw・無印へ落ちない)', async () => {
    const e = makeExit(undefined, 'de'); // de ファイルは MULTILANG_PROMPTS に無い
    await expect(e.tr.init()).rejects.toThrow(/exit\.system\.de\.md/);
  });
});

describe('多言語: 翻訳キャッシュが言語間で混ざらない', () => {
  it('ja でキャッシュした訳が fr では再利用されない (別キー)', async () => {
    const store = new Map<string, string>();
    const cache: CacheStore = {
      get: async (k) => store.get(k),
      set: async (k, v) => void store.set(k, v),
    };
    const ja = makeExit(cache, 'ja');
    await ja.tr.init();
    await ja.tr.translate('Same English text.');
    expect(ja.calls).toBe(1);

    // 同じ英文を fr で翻訳 → ja のキャッシュにヒットせず LLM を呼ぶ
    const fr = makeExit(cache, 'fr');
    await fr.tr.init();
    await fr.tr.translate('Same English text.');
    expect(fr.calls).toBe(1); // ja キャッシュに当たっていれば 0 になるはず

    // それぞれ自分の言語のキャッシュには当たる
    const ja2 = makeExit(cache, 'ja');
    await ja2.tr.init();
    await ja2.tr.translate('Same English text.');
    expect(ja2.calls).toBe(0); // ja の永続キャッシュにヒット
  });
});

describe('多言語: 入口プロンプト/few-shot の言語別解決と fail closed', () => {
  const vocab = { dictWords: ['look', 'take'], objectNames: ['lamp'] };

  function makeEntry(language: 'ja' | 'fr' | 'de'): EntryTranslator {
    const transport: LLMTransport = {
      post: async () => ({ choices: [{ message: { content: 'look' } }] }),
      get: async () => ({}),
    };
    const llm = new LLMClient(transport, {
      model: 'm',
      temperature: 0,
      maxTokens: 100,
      timeoutMs: 1000,
    });
    return new EntryTranslator(llm, MULTILANG_PROMPTS, { contextTurns: 2, language });
  }

  it('ja は無印 entry/fewshot を読む', async () => {
    await expect(makeEntry('ja').init(vocab)).resolves.toBeUndefined();
  });

  it('fr は接尾辞 entry/fewshot を読む', async () => {
    await expect(makeEntry('fr').init(vocab)).resolves.toBeUndefined();
  });

  it('de は entry ファイル欠落で fail closed', async () => {
    await expect(makeEntry('de').init(vocab)).rejects.toThrow(/entry\.system\.de\.md/);
  });
});
