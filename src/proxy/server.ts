/**
 * CORS 不可の LLM endpoint 向けローカル中継 (plan.md 段階2)。
 *
 * 脅威モデル (踏み台化防止):
 * - 127.0.0.1 bind 限定 / target は起動時固定 (リクエストから任意 URL 指定不可)
 * - 起動毎のランダムトークンを URL パス先頭に必須 (`/<token>/v1/...`)。
 *   Authorization ヘッダは上流へ素通し (キーの保存・自動注入はしない)
 * - CORS 応答は許可 origin のみ (既定: localhost/127.0.0.1 の任意ポート)
 */
import { randomBytes } from 'node:crypto';
import http from 'node:http';

export interface ProxyOptions {
  /** 上流の base URL (例: http://127.0.0.1:1234)。パスはそのまま中継する */
  target: string;
  host?: string;
  port?: number;
  /** 省略時はランダム生成 */
  token?: string;
  /** 追加の許可 origin (完全一致)。localhost/127.0.0.1 は常に許可 */
  allowOrigins?: string[];
}

export interface ProxyHandle {
  server: http.Server;
  token: string;
  /** アプリの設定に貼る base URL (例: http://127.0.0.1:8787/<token>/v1) */
  baseUrlFor(suffix: string): string;
  close(): Promise<void>;
  port: number;
}

const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/** 公式配布先 (GitHub Pages) は既定で許可 */
const DEFAULT_ALLOWED_ORIGINS = ['https://h-o-soft.github.io'];

export function originAllowed(origin: string | undefined, extra: string[]): boolean {
  if (origin === undefined) return true; // ブラウザ以外 (curl 等)。token で保護される
  return (
    LOCAL_ORIGIN_RE.test(origin) ||
    DEFAULT_ALLOWED_ORIGINS.includes(origin) ||
    extra.includes(origin)
  );
}

export async function startProxy(opts: ProxyOptions): Promise<ProxyHandle> {
  const target = opts.target.replace(/\/$/, '');
  const token = opts.token ?? randomBytes(12).toString('hex');
  const allow = opts.allowOrigins ?? [];

  const server = http.createServer((req, res) => {
    void (async () => {
      const origin = req.headers.origin;
      const cors: Record<string, string> = {};
      if (origin !== undefined && originAllowed(origin, allow)) {
        cors['Access-Control-Allow-Origin'] = origin;
        cors['Access-Control-Allow-Headers'] = 'authorization, content-type';
        cors['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
        cors.Vary = 'Origin';
      }
      if (origin !== undefined && !originAllowed(origin, allow)) {
        res.writeHead(403);
        res.end('origin not allowed');
        return;
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        res.end();
        return;
      }
      const url = req.url ?? '/';
      if (!url.startsWith(`/${token}/`)) {
        // トークン不一致は一切 forward しない
        res.writeHead(404, cors);
        res.end('not found');
        return;
      }
      const upstreamPath = url.slice(token.length + 1);
      try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (typeof req.headers.authorization === 'string') {
          headers.authorization = req.headers.authorization; // 素通し (保存しない)
        }
        const upstream = await fetch(target + upstreamPath, {
          method: req.method ?? 'GET',
          headers,
          body: req.method === 'POST' ? new Uint8Array(Buffer.concat(chunks)) : null,
        });
        const body = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(upstream.status, {
          ...cors,
          'content-type': upstream.headers.get('content-type') ?? 'application/json',
        });
        res.end(body);
      } catch (err) {
        res.writeHead(502, cors);
        res.end(JSON.stringify({ error: `upstream error: ${String(err)}` }));
      }
    })();
  });

  const host = opts.host ?? '127.0.0.1';
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, host, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;

  return {
    server,
    token,
    port,
    baseUrlFor: (suffix: string) => `http://${host}:${port}/${token}${suffix}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
