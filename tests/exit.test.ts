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

interface CapturedCall {
  system: string;
  user: string;
}

function makeTranslator(
  cache?: CacheStore,
  respond?: (user: string, system: string) => string,
): { tr: ExitTranslator; calls: string[]; full: CapturedCall[] } {
  const calls: string[] = [];
  const full: CapturedCall[] = [];
  const transport: LLMTransport = {
    post: async (_p, body) => {
      const messages = (body as { messages: { content: string }[] }).messages;
      const system = messages[0]!.content;
      const user = messages[1]!.content;
      calls.push(user);
      full.push({ system, user });
      const content = respond ? respond(user, system) : `JA(${user.slice(0, 20)})`;
      return { choices: [{ message: { content } }] };
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
  return { tr: new ExitTranslator(llm, PROMPTS, cache), calls, full };
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

describe('固有名詞グロッサリ', () => {
  const respond = (user: string, _system: string): string => {
    // グロッサリ構築呼び出し (候補リストが user に来る) には選別結果を返す
    if (user.includes('Cora') && user.includes('Great Hall') && !user.includes('JA')) {
      return 'Cora = コーラ\nRosie = ロージー\nNotInList = ニセモノ';
    }
    return `JA(${user.slice(0, 30)})`;
  };

  it('init: 候補から人名グロッサリを構築し、候補外の創作は捨てる', async () => {
    const { tr } = makeTranslator(undefined, respond);
    await tr.init(['Cora', 'Rosie', 'Great Hall', 'lamp']);
    expect(Object.fromEntries(tr.glossaryEntries())).toEqual({
      Cora: 'コーラ',
      Rosie: 'ロージー',
    });
  });

  it('全翻訳 (地の文もメニュー断片も) の system プロンプトに正準表記を注入する', async () => {
    const { tr, full } = makeTranslator(undefined, respond);
    await tr.init(['Cora', 'Rosie', 'Great Hall', 'lamp']);
    await tr.translate('Cora is here.');
    await tr.translate('Talk to Rosie about:\n  1: Cora\n\n[ENTER] End conversation');
    // full[0] はグロッサリ構築呼び出し。以降の翻訳呼び出しを確認
    for (const call of full.slice(1)) {
      expect(call.system).toContain('固有名詞の正準表記');
      expect(call.system).toContain('Cora = コーラ');
      expect(call.system).toContain('Rosie = ロージー');
    }
  });

  it('グロッサリは CacheStore に永続化され再構築時は LLM を呼ばない', async () => {
    const store = new Map<string, string>();
    const cache: CacheStore = {
      get: async (k) => store.get(k),
      set: async (k, v) => void store.set(k, v),
    };
    const a = makeTranslator(cache, respond);
    await a.tr.init(['Cora', 'Rosie', 'Great Hall', 'lamp']);
    expect(a.calls).toHaveLength(1);
    const b = makeTranslator(cache, respond);
    await b.tr.init(['Cora', 'Rosie', 'Great Hall', 'lamp']);
    expect(b.calls).toHaveLength(0); // キャッシュヒット
    expect(Object.fromEntries(b.tr.glossaryEntries())).toMatchObject({ Cora: 'コーラ' });
  });

  it('キャッシュキーにグロッサリ版数を含む (グロッサリ無し時代の訳と混ざらない)', async () => {
    const store = new Map<string, string>();
    const cache: CacheStore = {
      get: async (k) => store.get(k),
      set: async (k, v) => void store.set(k, v),
    };
    const plain = makeTranslator(cache); // グロッサリ無し
    await plain.tr.init();
    await plain.tr.translate('Cora smiles.');
    const withGlossary = makeTranslator(cache, respond);
    await withGlossary.tr.init(['Cora', 'Rosie', 'Great Hall', 'lamp']);
    await withGlossary.tr.translate('Cora smiles.');
    // グロッサリ構築 1 回 + 翻訳 1 回 = キャッシュに頼らず再翻訳している
    expect(withGlossary.calls).toHaveLength(2);
  });

  it('翻訳結果の「カタカナ (原文)」併記から未知の固有名詞を自動蓄積する', async () => {
    const { tr, full } = makeTranslator(undefined, (user) =>
      user.includes('Ysabella') ? 'イザベラ (Ysabella) が現れた。' : `JA(${user.slice(0, 10)})`,
    );
    await tr.init();
    await tr.translate('Ysabella appears.');
    expect(Object.fromEntries(tr.glossaryEntries())).toEqual({ Ysabella: 'イザベラ' });
    await tr.translate('Ysabella smiles.');
    expect(full[full.length - 1]!.system).toContain('Ysabella = イザベラ');
  });
});
