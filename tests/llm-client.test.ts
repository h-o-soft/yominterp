import { describe, expect, it } from 'vitest';
import { LLMClient, LLMError } from '../src/core/llm/client.js';
import type { LLMTransport } from '../src/core/ports.js';

const CFG = {
  model: 'test-model',
  temperature: 0,
  maxTokens: 100,
  timeoutMs: 1000,
};

function chatResponse(content: string): unknown {
  return { choices: [{ message: { content } }] };
}

describe('LLMClient', () => {
  it('chat: 応答テキストを返し、モデル/温度を body に載せる', async () => {
    const bodies: unknown[] = [];
    const transport: LLMTransport = {
      post: async (_p, body) => {
        bodies.push(body);
        return chatResponse('hello');
      },
      get: async () => ({}),
    };
    const client = new LLMClient(transport, CFG);
    const out = await client.chat([{ role: 'user', content: 'hi' }], { model: 'override' });
    expect(out).toBe('hello');
    expect(bodies[0]).toMatchObject({ model: 'override', temperature: 0, stream: false });
  });

  it('5xx は指数バックオフでリトライして成功する', async () => {
    let calls = 0;
    const transport: LLMTransport = {
      post: async () => {
        calls++;
        if (calls < 3) {
          const err = new Error('HTTP 500') as Error & { status: number };
          err.status = 500;
          throw err;
        }
        return chatResponse('recovered');
      },
      get: async () => ({}),
    };
    const client = new LLMClient(transport, CFG);
    expect(await client.chat([{ role: 'user', content: 'hi' }])).toBe('recovered');
    expect(calls).toBe(3);
  }, 10000);

  it('4xx はリトライせず即エラー', async () => {
    let calls = 0;
    const transport: LLMTransport = {
      post: async () => {
        calls++;
        const err = new Error('HTTP 404') as Error & { status: number };
        err.status = 404;
        throw err;
      },
      get: async () => ({}),
    };
    const client = new LLMClient(transport, CFG);
    await expect(client.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(LLMError);
    expect(calls).toBe(1);
  });

  it('listModels: モデル id 一覧を返す', async () => {
    const transport: LLMTransport = {
      post: async () => ({}),
      get: async () => ({ data: [{ id: 'm1' }, { id: 'm2' }] }),
    };
    const client = new LLMClient(transport, CFG);
    expect(await client.listModels()).toEqual(['m1', 'm2']);
  });
});
