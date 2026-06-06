/**
 * CORS 中継 proxy の abuse 防止テスト (plan.md 段階2)。
 */
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ProxyHandle, originAllowed, startProxy } from '../src/proxy/server.js';

let upstreamHits: { url: string; auth: string | undefined }[] = [];
let upstream: http.Server;
let upstreamPort = 0;
let proxy: ProxyHandle;

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    upstreamHits.push({ url: req.url ?? '', auth: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const addr = upstream.address();
  upstreamPort = typeof addr === 'object' && addr !== null ? addr.port : 0;
  proxy = await startProxy({ target: `http://127.0.0.1:${upstreamPort}` });
});

afterAll(async () => {
  await proxy.close();
  await new Promise<void>((r) => upstream.close(() => r()));
});

describe('yominterp-proxy', () => {
  it('正しいトークン: 上流へ中継し Authorization を素通しする', async () => {
    upstreamHits = [];
    const res = await fetch(proxy.baseUrlFor('/v1/models'), {
      headers: { Authorization: 'Bearer user-key', Origin: 'http://localhost:4173' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:4173');
    expect(upstreamHits).toHaveLength(1);
    expect(upstreamHits[0]).toMatchObject({ url: '/v1/models', auth: 'Bearer user-key' });
  });

  it('トークン不一致は 404 で一切 forward しない', async () => {
    upstreamHits = [];
    const res = await fetch(`http://127.0.0.1:${proxy.port}/wrongtoken/v1/models`);
    expect(res.status).toBe(404);
    expect(upstreamHits).toHaveLength(0);
  });

  it('許可外 origin は 403 で一切 forward しない', async () => {
    upstreamHits = [];
    const res = await fetch(proxy.baseUrlFor('/v1/models'), {
      headers: { Origin: 'https://evil.example.com' },
    });
    expect(res.status).toBe(403);
    expect(upstreamHits).toHaveLength(0);
  });

  it('preflight (OPTIONS) は許可 origin にのみ CORS ヘッダを返す', async () => {
    const ok = await fetch(proxy.baseUrlFor('/v1/chat/completions'), {
      method: 'OPTIONS',
      headers: { Origin: 'http://127.0.0.1:5173' },
    });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5173');
    expect(ok.headers.get('access-control-allow-headers')).toContain('authorization');
  });

  it('originAllowed: localhost 系は常に許可、追加 origin は完全一致', () => {
    expect(originAllowed('http://localhost:9999', [])).toBe(true);
    expect(originAllowed('http://127.0.0.1:4173', [])).toBe(true);
    expect(originAllowed('https://foo.github.io', [])).toBe(false);
    expect(originAllowed('https://h-o-soft.github.io', [])).toBe(true); // 公式 Pages は既定許可
    expect(originAllowed('https://foo.github.io', ['https://foo.github.io'])).toBe(true);
    expect(originAllowed(undefined, [])).toBe(true); // 非ブラウザは token で保護
  });
});
