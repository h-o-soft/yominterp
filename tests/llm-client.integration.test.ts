/**
 * LM Studio 実機での煙テスト。接続できない環境ではスキップ。
 */
import { describe, expect, it } from 'vitest';
import { LLMClient } from '../src/core/llm/client.js';
import { FetchTransport } from '../src/cli/adapters.js';
import { loadConfig, toLLMConfig } from '../src/cli/config.js';

const cfg = loadConfig();
const llmCfg = toLLMConfig(cfg);

async function lmStudioUp(): Promise<boolean> {
  try {
    const res = await fetch(cfg.llm.baseUrl + '/models', {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const available = await lmStudioUp();

describe.skipIf(!available)('LLMClient 結合 (LM Studio)', () => {
  it('疎通チェック: 設定モデルが存在する', async () => {
    const client = new LLMClient(new FetchTransport(cfg.llm.baseUrl, cfg.llm.apiKey), llmCfg);
    const models = await client.listModels();
    expect(models).toContain(cfg.llm.model);
  });

  it('簡単な chat が応答する', async () => {
    const client = new LLMClient(new FetchTransport(cfg.llm.baseUrl, cfg.llm.apiKey), llmCfg);
    const out = await client.chat([
      { role: 'system', content: 'Reply with exactly one word.' },
      { role: 'user', content: 'Say "pong".' },
    ]);
    expect(out.toLowerCase()).toContain('pong');
  }, 120000);
});
