import { describe, expect, it } from 'vitest';
import {
  applyTemplateBlock,
  EntryTranslator,
  filterUnintendedMetas,
  parseCandidates,
  parseCommands,
  truncateForDict,
  usefulObjectNames,
} from '../src/core/translate/entry.js';
import { LLMClient } from '../src/core/llm/client.js';
import type { LLMTransport, PromptProvider } from '../src/core/ports.js';

const DICT = new Set([
  'take', 'lamp', 'go', 'open', 'pouch', 'door', 'dig', 'spot', 'spade',
  'rosie', 'call', 'apparitio', 'xyzzy', 'knock', 'on',
]);

describe('parseCommands (応答パース)', () => {
  it('プレーン行形式: 1 行 1 コマンド', () => {
    expect(parseCommands('take lamp\nnorth', DICT)).toEqual(['take lamp', 'north']);
  });

  it('コードフェンス・箇条書き・番号・引用符を剥がす', () => {
    const text = '```\n- take lamp\n1. open pouch\n> north\n"x lamp"\n```';
    expect(parseCommands(text, DICT)).toEqual(['take lamp', 'open pouch', 'north', 'x lamp']);
  });

  it('日本語の説明文行は捨てる', () => {
    const text = '了解しました。以下のコマンドです:\ntake lamp\nこれでランプを取ります';
    expect(parseCommands(text, DICT)).toEqual(['take lamp']);
  });

  it('1 行複数コマンドはピリオド/セミコロンで分割する', () => {
    expect(parseCommands('take lamp. go north', DICT)).toEqual(['take lamp', 'go north']);
    expect(parseCommands('open door; north', DICT)).toEqual(['open door', 'north']);
  });

  it('末尾ピリオドは除去する', () => {
    expect(parseCommands('take lamp.', DICT)).toEqual(['take lamp']);
  });

  it('先頭語が辞書にも慣用語にもない行は捨てる', () => {
    expect(parseCommands('frobnicate the lamp\ntake lamp', DICT)).toEqual(['take lamp']);
  });

  it('辞書は 9 文字切り詰めで照合する (apparition → apparitio)', () => {
    expect(parseCommands('x apparition', new Set(['x', 'apparitio']))).toEqual(['x apparition']);
    expect(truncateForDict('apparition')).toBe('apparitio');
  });

  it('大文字・余分な空白を正規化する', () => {
    expect(parseCommands('Take  Lamp', DICT)).toEqual(['take lamp']);
  });

  it('方向語・メタ語は辞書になくても通す', () => {
    expect(parseCommands('ne\nundo\ny', new Set())).toEqual(['ne', 'undo', 'y']);
  });

  it('コマンドが 1 つもなければ空配列', () => {
    expect(parseCommands('すみません、わかりません。', DICT)).toEqual([]);
  });
});

describe('parseCandidates (辞書照合なしフォールバック)', () => {
  it('辞書外の動詞でも形の良い行は候補として通す', () => {
    expect(parseCandidates('fight guard')).toEqual(['fight guard']);
  });

  it('整形 (引用符・箇条書き・日本語行除去) は通常と同じ', () => {
    expect(parseCandidates('- "fight guard"\n了解しました')).toEqual(['fight guard']);
  });

  it('長い英文 (雑談) は候補にしない', () => {
    expect(
      parseCandidates('here is what you should probably try to do in this situation now'),
    ).toEqual([]);
  });
});

describe('filterUnintendedMetas (破壊的 meta ガード)', () => {
  it('日本語入力に意図がない quit/restart/restore/save/undo は落とす', () => {
    for (const meta of ['quit', 'q', 'restart', 'restore', 'save', 'undo']) {
      const { kept, dropped } = filterUnintendedMetas([meta], '衛兵と戦う');
      expect(kept, meta).toEqual([]);
      expect(dropped, meta).toEqual([meta]);
    }
  });

  it('意図が明示されていれば通す', () => {
    expect(filterUnintendedMetas(['quit'], 'ゲームを終了して').kept).toEqual(['quit']);
    expect(filterUnintendedMetas(['save'], 'セーブして').kept).toEqual(['save']);
    expect(filterUnintendedMetas(['restore'], 'さっきのセーブをロードして').kept).toEqual([
      'restore',
    ]);
    expect(filterUnintendedMetas(['restart'], '最初からやり直す').kept).toEqual(['restart']);
    expect(filterUnintendedMetas(['undo'], '直前の手を取り消して').kept).toEqual(['undo']);
  });

  it('通常コマンドは影響を受けない (quiet 等の前方一致も誤爆しない)', () => {
    const { kept, dropped } = filterUnintendedMetas(
      ['kill guard', 'take lamp', 'quietly open door'],
      '衛兵を倒す',
    );
    expect(kept).toEqual(['kill guard', 'take lamp', 'quietly open door']);
    expect(dropped).toEqual([]);
  });
});

describe('applyTemplateBlock', () => {
  const tpl = 'A\n{{#TAG}}kept line\n{{/TAG}}B';

  it('keep=true でマーカーを外して中身を残す', () => {
    expect(applyTemplateBlock(tpl, 'TAG', true)).toBe('A\nkept line\nB');
  });

  it('keep=false でブロックごと除去する', () => {
    expect(applyTemplateBlock(tpl, 'TAG', false)).toBe('A\nB');
  });

  it('マーカーが無いテンプレートには無害 (無変化)', () => {
    const plain = 'no markers here';
    expect(applyTemplateBlock(plain, 'TAG', true)).toBe(plain);
    expect(applyTemplateBlock(plain, 'TAG', false)).toBe(plain);
  });
});

describe('usefulObjectNames', () => {
  it('Inform 内部オブジェクトを除外する', () => {
    expect(usefulObjectNames(['Class', 'Object', 'Great Hall', 'lamp'])).toEqual([
      'Great Hall',
      'lamp',
    ]);
  });
});

// ---- EntryTranslator (LLM はフェイク) ----

const FAKE_PROMPTS: PromptProvider = {
  load: async (name) => {
    if (name === 'entry.system.md') {
      return 'SYSTEM\n## DICT\n{{DICT_WORDS}}\n## OBJ\n{{OBJECT_NAMES}}';
    }
    if (name === 'fewshot.entry.json') {
      return JSON.stringify([
        { ja: '北へ', commands: ['north'] },
        { context: 'A box is here.', ja: 'それを開けて', commands: ['open box'] },
      ]);
    }
    throw new Error('not found');
  },
};

function makeTranslator(responses: string[]): { tr: EntryTranslator; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const transport: LLMTransport = {
    post: async (_p, body) => {
      calls.push((body as { messages: unknown[] }).messages);
      const content = responses[Math.min(calls.length - 1, responses.length - 1)] ?? '';
      return { choices: [{ message: { content } }] };
    },
    get: async () => ({}),
  };
  const llm = new LLMClient(transport, {
    model: 'm',
    entryModel: 'entry-m',
    temperature: 0,
    maxTokens: 100,
    timeoutMs: 1000,
  });
  return { tr: new EntryTranslator(llm, FAKE_PROMPTS, { contextTurns: 2 }), calls };
}

const VOCAB = {
  dictWords: ['take', 'lamp', 'north', 'open', 'box'],
  objectNames: ['Class', 'lamp', 'Great Hall'],
};

describe('EntryTranslator: all-except/from の辞書依存ゲーティング', () => {
  // "all but/except" はゲーム側パーサ実装依存 (darkzil の minilib は ALL の次の語を
  // 一切見ない) なので、辞書に except/but/from が実在する時だけ該当ブロックを残す。
  // 非対応時は代替コマンド列 (drop 等) へ組み替える指示を足さない (無理に通す実装は
  // しない方針): ブロックが丸ごと消え、既存の一般則に委ねる。
  const GATE_PROMPTS: PromptProvider = {
    load: async (name) => {
      if (name === 'entry.system.md') {
        return (
          'SYSTEM {{DICT_WORDS}}\n' +
          '{{#IF_ALL_EXCEPT}}HAS_EXCEPT_BLOCK word={{ALL_EXCEPT_WORD}}{{/IF_ALL_EXCEPT}}\n' +
          '{{#IF_ALL_FROM}}HAS_FROM_BLOCK{{/IF_ALL_FROM}}'
        );
      }
      if (name === 'fewshot.entry.json') return '[]';
      throw new Error('not found');
    },
  };

  async function systemPromptFor(dictWords: string[]): Promise<string> {
    const calls: unknown[][] = [];
    const transport: LLMTransport = {
      post: async (_p, body) => {
        calls.push((body as { messages: unknown[] }).messages);
        return { choices: [{ message: { content: 'look' } }] };
      },
      get: async () => ({}),
    };
    const llm = new LLMClient(transport, { model: 'm', temperature: 0, maxTokens: 10, timeoutMs: 1000 });
    const tr = new EntryTranslator(llm, GATE_PROMPTS, { contextTurns: 2 });
    await tr.init({ dictWords, objectNames: [] });
    await tr.translate('見る', []);
    return (calls[0] as { content: string }[])[0]!.content;
  }

  it('辞書に except/but/from が無ければ (darkpit 相当) 両ブロックとも消え、代替指示も足さない', async () => {
    const prompt = await systemPromptFor(['take', 'all', 'look']);
    expect(prompt).not.toContain('HAS_EXCEPT_BLOCK');
    expect(prompt).not.toContain('HAS_FROM_BLOCK');
    expect(prompt).not.toContain('drop');
  });

  it('辞書に except と but の両方があれば except を優先する', async () => {
    const prompt = await systemPromptFor(['take', 'all', 'except', 'but', 'from']);
    expect(prompt).toContain('HAS_EXCEPT_BLOCK word=except');
    expect(prompt).toContain('HAS_FROM_BLOCK');
  });

  it('辞書に but しか無ければ but を使う (except を誤って教えない)', async () => {
    const prompt = await systemPromptFor(['take', 'all', 'but']);
    expect(prompt).toContain('HAS_EXCEPT_BLOCK word=but');
    expect(prompt).not.toContain('word=except');
  });
});

describe('EntryTranslator', () => {
  it('system プロンプトに辞書とオブジェクト名を埋め込み、few-shot を挟む', async () => {
    const { tr, calls } = makeTranslator(['take lamp']);
    await tr.init(VOCAB);
    await tr.translate('ランプを取って', []);
    const messages = calls[0] as { role: string; content: string }[];
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toContain('take lamp north open box');
    expect(messages[0]!.content).toContain('lamp, Great Hall');
    expect(messages[0]!.content).not.toContain('Class');
    // few-shot 2 例 = user/assistant 4 通 + 実入力 1 通
    expect(messages.length).toBe(6);
    expect(messages[5]!.content).toContain('ランプを取って');
  });

  it('直近文脈は contextChars を超えると古い側から切り詰める', async () => {
    const calls: unknown[][] = [];
    const transport: LLMTransport = {
      post: async (_p, body) => {
        calls.push((body as { messages: unknown[] }).messages);
        return { choices: [{ message: { content: 'look' } }] };
      },
      get: async () => ({}),
    };
    const llm = new LLMClient(transport, { model: 'm', temperature: 0, maxTokens: 10, timeoutMs: 1000 });
    const tr = new EntryTranslator(llm, FAKE_PROMPTS, { contextTurns: 2, contextChars: 100 });
    await tr.init(VOCAB);
    const longOutput = 'OLD '.repeat(100) + 'TAIL_MARKER';
    await tr.translate('見る', [{ gameOutput: longOutput, commands: ['wait'] }]);
    const messages = calls[0] as { content: string }[];
    const user = messages[messages.length - 1]!.content;
    expect(user).toContain('TAIL_MARKER');
    expect(user).not.toContain('> wait'); // 先頭側が切られている
    expect(user.length).toBeLessThan(300);
  });

  it('直近文脈 (確定コマンド → ゲーム出力) を user メッセージに含める', async () => {
    const { tr, calls } = makeTranslator(['open box']);
    await tr.init(VOCAB);
    await tr.translate('それを開けて', [
      { gameOutput: 'You see a box.', commands: ['look'] },
    ]);
    const messages = calls[0] as { content: string }[];
    const last = messages[messages.length - 1]!.content;
    expect(last).toContain('> look');
    expect(last).toContain('You see a box.');
  });

  it('辞書外の動詞 (fight 等) は再生成せずそのまま通す (実パーサに委ねる)', async () => {
    const { tr, calls } = makeTranslator(['fight guard']);
    await tr.init(VOCAB); // VOCAB の辞書に fight は無い
    const out = await tr.translate('衛兵と戦う', []);
    expect(out).toEqual(['fight guard']);
    expect(calls.length).toBe(1); // 盲目的な再生成をしない
  });

  it('通常行動がハルシネーションで quit になっても発火させない (再現: 衛兵と戦う→quit)', async () => {
    const { tr, calls } = makeTranslator(['quit', 'quit']);
    await tr.init(VOCAB);
    const out = await tr.translate('衛兵と戦う', []);
    expect(out).toEqual([]); // meta ガードで全部落ち → session が日本語エラーを返す
    expect(calls.length).toBe(2); // 1 回目 meta 落ち → 再生成 → また quit → 落ち
  });

  it('明確な終了の意図があれば quit を通す', async () => {
    const { tr } = makeTranslator(['quit']);
    await tr.init(VOCAB);
    expect(await tr.translate('ゲームを終了して', [])).toEqual(['quit']);
  });

  it('retranslate でも meta への退避は許さない', async () => {
    const { tr } = makeTranslator(['quit']);
    await tr.init(VOCAB);
    const out = await tr.retranslate({
      jaInput: '衛兵と戦う',
      failedCommand: 'fight guard',
      parserError: "I don't understand that.",
      triedCommands: ['fight guard'],
      recent: [],
    });
    expect(out).toEqual([]);
  });

  it('全行フィルタ落ちなら 1 回だけ言い直しを要求する', async () => {
    const { tr, calls } = makeTranslator(['すみません', 'take lamp']);
    await tr.init(VOCAB);
    const out = await tr.translate('ランプを取って', []);
    expect(out).toEqual(['take lamp']);
    expect(calls.length).toBe(2);
  });

  it('selectMenuOption: 日本語指示をメニュー番号に変換する', async () => {
    const { tr, calls } = makeTranslator(['2']);
    await tr.init(VOCAB);
    const menu = 'Talk to Rosie about:\n  1: Preparations\n  2: Cora\n\n[ENTER] End conversation';
    const sel = await tr.selectMenuOption('コーラについて聞いて', menu);
    expect(sel).toBe('2');
    const messages = calls[0] as { content: string }[];
    expect(messages[1]!.content).toContain('2: Cora');
    expect(messages[1]!.content).toContain('コーラについて聞いて');
  });

  it('selectMenuOption: 番号入りの饒舌な応答からも番号を拾う', async () => {
    const { tr } = makeTranslator(['選択肢は 3 です。']);
    await tr.init(VOCAB);
    expect(await tr.selectMenuOption('雪嵐の話', 'menu')).toBe('3');
  });

  it('selectMenuOption: END (会話終了) は空文字を返す', async () => {
    const { tr } = makeTranslator(['END']);
    await tr.init(VOCAB);
    expect(await tr.selectMenuOption('もう行くよ', 'menu')).toBe('');
  });

  it('selectMenuOption: 文字キー (A/B/C) も変換できる (小文字応答は大文字化)', async () => {
    const { tr } = makeTranslator(['b']);
    await tr.init(VOCAB);
    expect(await tr.selectMenuOption('衛兵について聞く', 'A. Himself\nB. The guard')).toBe('B');
  });

  it('retranslate: GIVEUP 応答なら空を返す (giveup をコマンドとして送らない)', async () => {
    const { tr } = makeTranslator(['GIVEUP']);
    await tr.init(VOCAB);
    const out = await tr.retranslate({
      jaInput: '衛兵と戦う',
      failedCommand: 'fight guard',
      parserError: "I don't understand that.",
      triedCommands: ['fight guard'],
      recent: [],
    });
    expect(out).toEqual([]);
  });

  it('retranslate: 指示に同一意図の制約と GIVEUP の選択肢を含む', async () => {
    const { tr, calls } = makeTranslator(['x lamp']);
    await tr.init(VOCAB);
    await tr.retranslate({
      jaInput: 'ランプを見る',
      failedCommand: 'inspect lamp',
      parserError: "That's an unknown verb.",
      triedCommands: ['inspect lamp'],
      recent: [],
    });
    const messages = calls[0] as { content: string }[];
    const user = messages[messages.length - 1]!.content;
    expect(user).toContain('動詞の意味を変えてはならない');
    expect(user).toContain('GIVEUP');
  });

  it('retranslate: 失敗コマンドとエラーを渡して言い直させる', async () => {
    const { tr, calls } = makeTranslator(['x lamp']);
    await tr.init(VOCAB);
    const out = await tr.retranslate({
      jaInput: 'ランプを見る',
      failedCommand: 'inspect lamp',
      parserError: "That's an unknown verb.",
      triedCommands: ['inspect lamp'],
      recent: [],
    });
    expect(out).toEqual(['x lamp']);
    const messages = calls[0] as { content: string }[];
    const user = messages[messages.length - 1]!.content;
    expect(user).toContain('inspect lamp');
    expect(user).toContain("That's an unknown verb.");
    expect(user).toContain('再提案禁止');
  });
});

describe('EntryTranslator 入口キャッシュ (決定論)', () => {
  // メモリ CacheStore (永続キャッシュの代用)
  function memCache() {
    const store = new Map<string, string>();
    return {
      cache: {
        get: async (k: string) => store.get(k),
        set: async (k: string, v: string) => void store.set(k, v),
      },
      store,
    };
  }

  function makeWithCache(responses: string[], cache: { get: (k: string) => Promise<string | undefined>; set: (k: string, v: string) => Promise<void> }) {
    let n = 0;
    const transport: LLMTransport = {
      post: async () => {
        const content = responses[Math.min(n, responses.length - 1)] ?? '';
        n++;
        return { choices: [{ message: { content } }] };
      },
      get: async () => ({}),
    };
    const llm = new LLMClient(transport, { model: 'm', entryModel: 'entry-m', temperature: 0, maxTokens: 100, timeoutMs: 1000 });
    const tr = new EntryTranslator(llm, FAKE_PROMPTS, { contextTurns: 2 }, cache);
    return { tr, callCount: () => n };
  }

  it('同じ入力＋同じ文脈は 2 回目以降 LLM を呼ばず同じ英コマンドを返す', async () => {
    const { cache } = memCache();
    const { tr, callCount } = makeWithCache(['take lamp'], cache);
    await tr.init(VOCAB);
    const a = await tr.translate('ランプを取る', []);
    const b = await tr.translate('ランプを取る', []);
    expect(a).toEqual(['take lamp']);
    expect(b).toEqual(a); // 決定論: 同じ結果
    expect(callCount()).toBe(1); // 2 回目はキャッシュヒットで LLM 呼ばない
  });

  it('永続 CacheStore を共有する新インスタンスもキャッシュを引く (LLM 非依存で同じ結果)', async () => {
    const { cache } = memCache();
    const first = makeWithCache(['take lamp'], cache);
    await first.tr.init(VOCAB);
    await first.tr.translate('ランプを取る', []);
    // 別インスタンス (LLM は別応答を返す設定でも、キャッシュが優先される)
    const second = makeWithCache(['open box'], cache);
    await second.tr.init(VOCAB);
    const out = await second.tr.translate('ランプを取る', []);
    expect(out).toEqual(['take lamp']); // 永続キャッシュの値 (LLM の別応答でない)
    expect(second.callCount()).toBe(0);
  });

  it('文脈が違えばキャッシュは別 (文脈依存の変換を保つ)', async () => {
    const { cache } = memCache();
    const { tr, callCount } = makeWithCache(['take lamp', 'take lamp'], cache);
    await tr.init(VOCAB);
    await tr.translate('それを取る', []);
    await tr.translate('それを取る', [{ gameOutput: 'A box is here.', commands: [] }]);
    expect(callCount()).toBe(2); // 文脈違いは別キー → 別 LLM 呼び出し
  });
});

describe('EntryTranslator scope (cross-game 混入防止)', () => {
  function memCacheShared() {
    const store = new Map<string, string>();
    return { get: async (k: string) => store.get(k), set: async (k: string, v: string) => void store.set(k, v) };
  }
  function makeScoped(scope: string, responses: string[], cache: { get: (k: string) => Promise<string | undefined>; set: (k: string, v: string) => Promise<void> }) {
    let n = 0;
    const transport: LLMTransport = {
      post: async () => { const c = responses[Math.min(n, responses.length - 1)] ?? ''; n++; return { choices: [{ message: { content: c } }] }; },
      get: async () => ({}),
    };
    const llm = new LLMClient(transport, { model: 'm', entryModel: 'entry-m', temperature: 0, maxTokens: 100, timeoutMs: 1000 });
    return new EntryTranslator(llm, FAKE_PROMPTS, { contextTurns: 2, scope }, cache);
  }

  it('storyId(scope) が違えば同じ CacheStore でもキーが混ざらない', async () => {
    const cache = memCacheShared(); // 同一の永続ストアを共有 (CLI の単一ファイル相当)
    const gameA = makeScoped('game-A', ['take lamp'], cache);
    const gameB = makeScoped('game-B', ['open box'], cache);
    await gameA.init(VOCAB);
    await gameB.init(VOCAB);
    const a = await gameA.translate('それを操作', []);
    const b = await gameB.translate('それを操作', []); // 同じ入力でも別ゲーム
    expect(a).toEqual(['take lamp']);
    expect(b).toEqual(['open box']); // game-A のキャッシュ値 (take lamp) が混入しない
  });
});
