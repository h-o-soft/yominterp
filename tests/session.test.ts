import { describe, expect, it } from 'vitest';
import type { EngineOutput, OutputKind, ZEngine } from '../src/core/engine.js';
import { classifyParserResponse } from '../src/core/selfcorrect.js';
import { Session, sendExhaustingMenus, sendResolvingPauses } from '../src/core/session.js';
import type { EntryTranslator } from '../src/core/translate/entry.js';

const MENU =
  'Talk to Rosie about:\n  1: Preparations\n  2: Cora\n\n[ENTER] End conversation\n\n----';
const PAUSE = 'A spooky cutscene quote.\n\n-- Isaiah 14:12\n';

describe('classifyParserResponse', () => {
  it('ghosts.z5 実機採取のエラー文言を検知する', () => {
    for (const body of [
      "That's an unknown verb. Could you try something else?",
      "You don't see anything like that.",
      'You probably wanted to say "open something"?',
      'I can\'t see who you are referring to.',
      "You won't get very far without input.",
    ]) {
      expect(classifyParserResponse(body).type, body).toBe('error');
    }
  });

  it('Inform 標準のエラー文言を検知する', () => {
    expect(classifyParserResponse("You can't see any such thing.").type).toBe('error');
    expect(classifyParserResponse('I only understood you as far as wanting to take.').type).toBe(
      'error',
    );
  });

  it('曖昧解決の問い返しは clarify', () => {
    expect(classifyParserResponse('What do you want to open?').type).toBe('clarify');
    expect(classifyParserResponse('Which do you mean, the brass key or the iron key?').type).toBe(
      'clarify',
    );
  });

  it('通常の応答は ok (xyzzy への Nice try 返しも含む)', () => {
    expect(classifyParserResponse('Taken.').type).toBe('ok');
    expect(
      classifyParserResponse(
        'You perceive a mysterious whisper. Coming from everywhere and nowhere, yet present, it says "Nice try."',
      ).type,
    ).toBe('ok');
  });

  it('追加パターンを設定で拡張できる', () => {
    expect(classifyParserResponse('CUSTOM REJECT', [/CUSTOM REJECT/]).type).toBe('error');
  });
});

// ---- Session (エンジン・入口ともモック) ----

const out = (body: string, kind: OutputKind = 'turn'): EngineOutput => ({ raw: body, body, kind });

class FakeEngine implements ZEngine {
  alive = true;
  sent: string[] = [];
  constructor(private readonly script: (cmd: string, nth: number) => EngineOutput) {}
  async start(): Promise<EngineOutput> {
    return out('intro');
  }
  async send(cmd: string): Promise<EngineOutput> {
    this.sent.push(cmd);
    return this.script(cmd, this.sent.length);
  }
  async stop(): Promise<void> {
    this.alive = false;
  }
}

function fakeEntry(
  translated: string[],
  retranslations: string[][] = [],
): { entry: EntryTranslator; retranslateCalls: number[] } {
  let n = 0;
  const calls: number[] = [];
  const entry = {
    translate: async () => translated,
    retranslate: async () => {
      calls.push(n);
      return retranslations[n++] ?? [];
    },
  } as unknown as EntryTranslator;
  return { entry, retranslateCalls: calls };
}

const OPTS = { maxRetriesPerCommand: 2, maxLlmCallsPerInput: 8, contextTurns: 2 };

describe('Session 自己修正ループ', () => {
  it('一発成功: 全コマンド確定・履歴更新', async () => {
    const engine = new FakeEngine((cmd) => out(`did ${cmd}`));
    const { entry } = fakeEntry(['take lamp', 'north']);
    const session = new Session(engine, entry, OPTS);
    const turn = await session.handleUserInput('ランプを取って北へ');
    expect(turn.results.map((r) => r.command)).toEqual(['take lamp', 'north']);
    expect(turn.results.every((r) => !r.corrected)).toBe(true);
    expect(turn.error).toBeUndefined();
    expect(session.history).toHaveLength(1);
    expect(session.history[0]!.commands).toEqual(['take lamp', 'north']);
  });

  it('パーサエラー → 言い直しで成功 (corrected=true)', async () => {
    const engine = new FakeEngine((cmd) =>
      cmd === 'inspect lamp' ? out("That's an unknown verb.") : out('It shines.'),
    );
    const { entry } = fakeEntry(['inspect lamp'], [['x lamp']]);
    const session = new Session(engine, entry, OPTS);
    const turn = await session.handleUserInput('ランプを調べて');
    expect(turn.results).toHaveLength(1);
    expect(turn.results[0]!.command).toBe('x lamp');
    expect(turn.results[0]!.corrected).toBe(true);
    expect(turn.results[0]!.retries).toBe(1);
  });

  it('同一案の再提案は棄却して打ち切る (無限ループ防止)', async () => {
    const engine = new FakeEngine(() => out("That's an unknown verb."));
    const { entry, retranslateCalls } = fakeEntry(['bad cmd'], [['bad cmd'], ['bad cmd']]);
    const session = new Session(engine, entry, OPTS);
    const turn = await session.handleUserInput('何か');
    expect(turn.error?.message).toContain('unknown verb');
    expect(turn.error?.source).toBe('game');
    expect(retranslateCalls).toHaveLength(1); // 同一案で即打ち切り
    expect(engine.sent).toEqual(['bad cmd']);
  });

  it('リトライ上限で打ち切り、残りコマンドを破棄する', async () => {
    const engine = new FakeEngine((cmd) =>
      cmd.startsWith('ok') ? out('fine') : out("You don't see anything like that."),
    );
    const { entry } = fakeEntry(['ok one', 'bad thing', 'ok two'], [['bad alt1'], ['bad alt2']]);
    const session = new Session(engine, entry, OPTS);
    const turn = await session.handleUserInput('複合動作');
    expect(turn.results.map((r) => r.command)).toEqual(['ok one']);
    expect(turn.aborted).toBe(true);
    expect(turn.error).toBeDefined();
    // bad thing → alt1 → alt2 で maxRetries=2 を消費
    expect(engine.sent).toEqual(['ok one', 'bad thing', 'bad alt1', 'bad alt2']);
  });

  it('累計 LLM 呼び出し上限で暴走を防ぐ', async () => {
    const engine = new FakeEngine(() => out("That's an unknown verb."));
    const { entry, retranslateCalls } = fakeEntry(
      ['a1'],
      [['a2'], ['a3'], ['a4'], ['a5'], ['a6']],
    );
    const session = new Session(engine, entry, {
      ...OPTS,
      maxRetriesPerCommand: 99,
      maxLlmCallsPerInput: 3,
    });
    await session.handleUserInput('何か');
    // translate=1 + retranslate 2 回で上限 3
    expect(retranslateCalls.length).toBe(2);
  });

  it('文字選択メニュー (turn として届く) でも残りコマンドを破棄して上位層に委ねる', async () => {
    const LETTERED_MENU =
      'Ask the old man about:\n  A. Himself\n  B. The guard\n  C. End conversation';
    const engine = new FakeEngine((cmd) =>
      cmd === 'talk to man' ? out(LETTERED_MENU, 'turn') : out('fine'),
    );
    const { entry } = fakeEntry(['talk to man', 'north']);
    const session = new Session(engine, entry, OPTS);
    const turn = await session.handleUserInput('老人と話してから北へ');
    expect(turn.results).toHaveLength(1);
    expect(turn.results[0]!.output.body).toContain('A. Himself');
    expect(engine.sent).toEqual(['talk to man']); // north はメニューに吸われない
    expect(turn.aborted).toBe(true);
  });

  it('会話メニューは自動消化せず query としてユーザーに返す (対話プレイ)', async () => {
    const engine = new FakeEngine((cmd) =>
      cmd === 'talk to rosie' ? out(MENU, 'query') : out('fine'),
    );
    const { entry } = fakeEntry(['talk to rosie', 'look']);
    const session = new Session(engine, entry, OPTS);
    const turn = await session.handleUserInput('ロージーと話す');
    expect(turn.results).toHaveLength(1);
    expect(turn.results[0]!.output.kind).toBe('query');
    expect(turn.results[0]!.output.body).toContain('[ENTER] End conversation');
    // メニュー選択 ('1') は送られていない
    expect(engine.sent).toEqual(['talk to rosie']);
    expect(turn.aborted).toBe(true); // 残り 'look' は破棄
  });

  it('autoExhaustMenus=true (検証用) ならメニューを全消化して 1 結果に集約する', async () => {
    const engine = new FakeEngine((cmd, nth) => {
      if (cmd === 'talk to rosie') return out(MENU, 'query');
      if (cmd === '1' && nth === 2) return out('Topic A.\n\n' + MENU, 'query');
      if (cmd === '1' && nth === 3) return out('Rosie waves goodbye.');
      return out('fine');
    });
    const { entry } = fakeEntry(['talk to rosie']);
    const session = new Session(engine, entry, { ...OPTS, autoExhaustMenus: true });
    const turn = await session.handleUserInput('ロージーと話す');
    expect(engine.sent).toEqual(['talk to rosie', '1', '1']);
    expect(turn.results).toHaveLength(1);
    expect(turn.results[0]!.output.kind).toBe('turn');
    expect(turn.results[0]!.output.body).toContain('Rosie waves goodbye.');
  });

  it('pause 画面は対話プレイでも空行で自動続行する', async () => {
    const engine = new FakeEngine((cmd, nth) => {
      if (cmd === 'read sign') return out(PAUSE, 'query');
      if (cmd === '' && nth === 2) return out('After the pause.');
      return out('fine');
    });
    const { entry } = fakeEntry(['read sign']);
    const session = new Session(engine, entry, OPTS);
    const turn = await session.handleUserInput('看板を読む');
    expect(engine.sent).toEqual(['read sign', '']);
    expect(turn.results[0]!.output.kind).toBe('turn');
    expect(turn.results[0]!.output.body).toContain('After the pause.');
  });

  it('query (quit 確認等) はそのまま返し、残りは破棄', async () => {
    const engine = new FakeEngine((cmd) =>
      cmd === 'quit' ? out('Are you sure you want to quit?', 'query') : out('fine'),
    );
    const { entry } = fakeEntry(['quit', 'look']);
    const session = new Session(engine, entry, OPTS);
    const turn = await session.handleUserInput('終了して見る');
    expect(turn.results).toHaveLength(1);
    expect(turn.results[0]!.output.kind).toBe('query');
    expect(turn.aborted).toBe(true);
  });

  it('gameover で停止する', async () => {
    const engine = new FakeEngine(() => out('*** You have died ***', 'gameover'));
    const { entry } = fakeEntry(['jump', 'look']);
    const session = new Session(engine, entry, OPTS);
    const turn = await session.handleUserInput('飛べ');
    expect(turn.gameOver).toBe(true);
    expect(engine.sent).toEqual(['jump']);
  });

  it('コマンドが生成できなければ日本語エラーを返す', async () => {
    const engine = new FakeEngine(() => out('fine'));
    const { entry } = fakeEntry([]);
    const session = new Session(engine, entry, OPTS);
    const turn = await session.handleUserInput('意味不明な入力');
    expect(turn.error?.message).toContain('コマンドを生成できません');
    expect(turn.error?.source).toBe('app');
    expect(engine.sent).toEqual([]);
  });
});

describe('sendExhaustingMenus / sendResolvingPauses (自動応答ヘルパ)', () => {
  it('sendExhaustingMenus: メニューを「1」連打で全トピック消化し出力を連結する (検証用)', async () => {
    const engine = new FakeEngine((cmd, nth) => {
      if (cmd === 'talk to rosie') return out(MENU, 'query');
      if (cmd === '1' && nth === 2) return out('Topic A.\n\n' + MENU, 'query');
      if (cmd === '1' && nth === 3) return out('Topic B. Rosie waves goodbye.');
      return out('fine');
    });
    const result = await sendExhaustingMenus(engine, 'talk to rosie');
    expect(engine.sent).toEqual(['talk to rosie', '1', '1']);
    expect(result.kind).toBe('turn');
    expect(result.body).toContain('Topic A.');
    expect(result.body).toContain('Rosie waves goodbye.');
  });

  it('sendResolvingPauses: メニューは自動応答せず query のまま返す (対話用)', async () => {
    const engine = new FakeEngine(() => out(MENU, 'query'));
    const result = await sendResolvingPauses(engine, 'talk to rosie');
    expect(engine.sent).toEqual(['talk to rosie']);
    expect(result.kind).toBe('query');
  });

  it('sendResolvingPauses: pause は空行で続行、真の質問では停止する', async () => {
    const engine = new FakeEngine((cmd, nth) => {
      if (nth === 1) return out(PAUSE, 'query');
      if (nth === 2) return out('Do you want to proceed? Please answer YES or NO.', 'query');
      return out('fine');
    });
    const result = await sendResolvingPauses(engine, 'enter door');
    expect(engine.sent).toEqual(['enter door', '']);
    expect(result.kind).toBe('query');
    expect(result.body).toContain('YES or NO');
  });

  it('暴走防止: maxAutoReplies で打ち切る', async () => {
    const engine = new FakeEngine(() => out(MENU, 'query'));
    await sendExhaustingMenus(engine, 'talk', 5);
    expect(engine.sent).toHaveLength(6); // talk + 自動応答 5
  });
});
