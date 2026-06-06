/**
 * CORS 中継 CLI:
 *   npm run proxy -- --target http://127.0.0.1:1234 [--port 8787] [--origin https://example.github.io]
 */
import { startProxy } from '../src/proxy/server.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const target = arg('--target');
if (target === undefined) {
  console.error('使い方: npm run proxy -- --target <上流URL 例: http://127.0.0.1:1234> [--port N] [--origin <追加許可origin>]');
  process.exit(1);
}

const origins = process.argv
  .map((a, i) => (a === '--origin' ? process.argv[i + 1] : undefined))
  .filter((x): x is string => x !== undefined);

const handle = await startProxy({
  target,
  port: arg('--port') !== undefined ? Number(arg('--port')) : 8787,
  allowOrigins: origins,
});

console.log('yominterp-proxy 起動 (Ctrl-C で終了)');
console.log(`  上流: ${target}`);
console.log(`  アプリの設定 → Base URL に貼り付け: ${handle.baseUrlFor('/v1')}`);
console.log('  (トークンは起動の度に変わります。許可 origin: localhost/127.0.0.1' + (origins.length ? ', ' + origins.join(', ') : '') + ')');
