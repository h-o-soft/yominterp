import { describe, expect, it } from 'vitest';
import {
  EntryTranslator,
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

  it('selectMenuOption: END (会話終了) は空文字 = ENTER を返す', async () => {
    const { tr } = makeTranslator(['END']);
    await tr.init(VOCAB);
    expect(await tr.selectMenuOption('もう行くよ', 'menu')).toBe('');
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
