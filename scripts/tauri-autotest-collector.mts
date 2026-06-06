/**
 * Tauri 直結実験の結果回収サーバ。
 * - GET /story  → ローカル素材 (refs/darkzil/darkpit.z3) を返す
 * - POST /result → アプリの自動検証 (VITE_AUTOTEST) からの結果を表示して終了
 *
 *   npx tsx scripts/tauri-autotest-collector.mts [--port N]
 */
import { readFileSync } from 'node:fs';
import http from 'node:http';

const STORY = 'refs/darkzil/darkpit.z3';
const portArg = process.argv.indexOf('--port');
const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : 0;

const story = readFileSync(STORY);
const server = http.createServer((req, res) => {
  // ローカルテストハーネスのため CORS は全許可
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Private-Network': 'true',
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  if (req.method === 'GET' && req.url === '/story') {
    res.writeHead(200, { ...cors, 'content-type': 'application/octet-stream' });
    res.end(story);
    return;
  }
  if (req.method === 'POST' && req.url === '/result') {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      res.writeHead(200, cors);
      res.end('ok');
      const result = JSON.parse(Buffer.concat(chunks).toString());
      console.log('===== AUTOTEST RESULT =====');
      console.log(JSON.stringify(result, null, 1));
      console.log('===========================');
      setTimeout(() => process.exit(result.ok === true ? 0 : 1), 100);
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(port, '127.0.0.1', () => {
  const addr = server.address();
  const p = typeof addr === 'object' && addr !== null ? addr.port : 0;
  console.log(`COLLECTOR_URL=http://127.0.0.1:${p}`);
});

// タイムアウト (10 分)
setTimeout(() => {
  console.error('autotest timeout');
  process.exit(2);
}, 600000);
