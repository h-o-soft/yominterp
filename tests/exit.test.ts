import { describe, expect, it } from 'vitest';
import { ExitTranslator, fnv1a, unwrapParagraphs } from '../src/core/translate/exit.js';
import { LLMClient } from '../src/core/llm/client.js';
import type { CacheStore, LLMTransport, PromptProvider } from '../src/core/ports.js';

describe('unwrapParagraphs (80 桁折返しの解除)', () => {
  it('段落内のハード改行をスペースにし、空行は段落境界として保持する', () => {
    const text = 'Flames dance in the fireplace and wood\ncrackles as it burns.\n\nIn one corner\nstands a tree.';
    expect(unwrapParagraphs(text)).toBe(
      'Flames dance in the fireplace and wood crackles as it burns.\n\nIn one corner stands a tree.',
    );
  });

  it('連続空行は 1 つの段落境界に潰す', () => {
    expect(unwrapParagraphs('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('前後の空白行を除去する', () => {
    expect(unwrapParagraphs('\n\nhello\n\n')).toBe('hello');
  });
});

describe('fnv1a', () => {
  it('決定的で入力差に敏感', () => {
    expect(fnv1a('abc')).toBe(fnv1a('abc'));
    expect(fnv1a('abc')).not.toBe(fnv1a('abd'));
  });
});

const PROMPTS: PromptProvider = {
  load: async (name) => {
    if (name === 'exit.system.md') return '英日翻訳者として翻訳せよ。';
    throw new Error('not found');
  },
};

function makeTranslator(cache?: CacheStore): { tr: ExitTranslator; calls: string[] } {
  const calls: string[] = [];
  const transport: LLMTransport = {
    post: async (_p, body) => {
      const userMsg = (body as { messages: { content: string }[] }).messages[1]!.content;
      calls.push(userMsg);
      return { choices: [{ message: { content: `JA(${userMsg.slice(0, 20)})` } }] };
    },
    get: async () => ({}),
  };
  const llm = new LLMClient(transport, {
    model: 'm',
    exitModel: 'exit-m',
    temperature: 0,
    maxTokens: 100,
    timeoutMs: 1000,
  });
  return { tr: new ExitTranslator(llm, PROMPTS, cache), calls };
}

describe('ExitTranslator', () => {
  it('折返し解除した本文を LLM に渡し、訳文を返す', async () => {
    const { tr, calls } = makeTranslator();
    await tr.init();
    const ja = await tr.translate('Hello\nworld.');
    expect(ja).toBe('JA(Hello world.)');
    expect(calls).toEqual(['Hello world.']);
  });

  it('同一英文 (正規化後) はキャッシュし LLM を呼ばない', async () => {
    const { tr, calls } = makeTranslator();
    await tr.init();
    await tr.translate('Same text here.');
    await tr.translate('Same\ntext here.'); // 折返し位置だけ違う
    expect(calls).toHaveLength(1);
  });

  it('CacheStore 越しに永続キャッシュが効く', async () => {
    const store = new Map<string, string>();
    const cache: CacheStore = {
      get: async (k) => store.get(k),
      set: async (k, v) => void store.set(k, v),
    };
    const a = makeTranslator(cache);
    await a.tr.init();
    await a.tr.translate('Persistent text.');
    expect(store.size).toBe(1);
    // 新しいインスタンス (セッション) でもヒットする
    const b = makeTranslator(cache);
    await b.tr.init();
    const ja = await b.tr.translate('Persistent text.');
    expect(b.calls).toHaveLength(0);
    expect(ja).toContain('Persistent text'.slice(0, 10));
  });

  it('空文字は LLM を呼ばず素通し', async () => {
    const { tr, calls } = makeTranslator();
    await tr.init();
    expect(await tr.translate('  \n ')).toBe('');
    expect(calls).toHaveLength(0);
  });
});
