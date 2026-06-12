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

  // OpenAI の新モデル (o1/o3/gpt-5 系) は max_tokens を 400 で拒否し
  // max_completion_tokens を要求する (実機で発生)。自動切替して同じ呼び出し内で
  // 成功し、以後の呼び出しは最初から切替後のパラメータを使うことを固定する。
  it('max_tokens 非対応 (400) → max_completion_tokens に切り替えて自動リトライ・以後は学習', async () => {
    const bodies: Record<string, unknown>[] = [];
    const transport: LLMTransport = {
      post: async (_p, body) => {
        bodies.push(body as Record<string, unknown>);
        if ('max_tokens' in (body as Record<string, unknown>)) {
          const err = new Error(
            `HTTP 400: {"error":{"message":"Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.","type":"invalid_request_error","param":"max_tokens","code":"unsupported_parameter"}}`,
          ) as Error & { status: number };
          err.status = 400;
          throw err;
        }
        return chatResponse('ok');
      },
      get: async () => ({}),
    };
    const client = new LLMClient(transport, CFG);
    expect(await client.chat([{ role: 'user', content: 'hi' }])).toBe('ok');
    // 1回目: max_tokens で 400 → 2回目: max_completion_tokens で成功
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toHaveProperty('max_tokens', 100);
    expect(bodies[1]).not.toHaveProperty('max_tokens');
    expect(bodies[1]).toHaveProperty('max_completion_tokens', 100);
    // 同じクライアントの次の呼び出しは最初から max_completion_tokens (学習済み)
    expect(await client.chat([{ role: 'user', content: 'again' }])).toBe('ok');
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).toHaveProperty('max_completion_tokens', 100);
  });

  it('temperature 非対応 (unsupported_value) → temperature を省いて自動リトライ', async () => {
    const bodies: Record<string, unknown>[] = [];
    const transport: LLMTransport = {
      post: async (_p, body) => {
        bodies.push(body as Record<string, unknown>);
        if ('temperature' in (body as Record<string, unknown>)) {
          const err = new Error(
            `HTTP 400: {"error":{"message":"Unsupported value: 'temperature' does not support 0 with this model. Only the default (1) value is supported.","type":"invalid_request_error","param":"temperature","code":"unsupported_value"}}`,
          ) as Error & { status: number };
          err.status = 400;
          throw err;
        }
        return chatResponse('ok');
      },
      get: async () => ({}),
    };
    const client = new LLMClient(transport, CFG);
    expect(await client.chat([{ role: 'user', content: 'hi' }])).toBe('ok');
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toHaveProperty('temperature', 0);
    expect(bodies[1]).not.toHaveProperty('temperature');
  });

  it('パラメータ非互換以外の 400 は従来どおり即エラー (無限リトライしない)', async () => {
    let calls = 0;
    const transport: LLMTransport = {
      post: async () => {
        calls++;
        const err = new Error('HTTP 400: {"error":{"message":"Invalid request"}}') as Error & {
          status: number;
        };
        err.status = 400;
        throw err;
      },
      get: async () => ({}),
    };
    const client = new LLMClient(transport, CFG);
    await expect(client.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(LLMError);
    expect(calls).toBe(1);
  });
});
