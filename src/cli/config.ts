/**
 * config.json (なければ config.example.json) ＋ 環境変数の読み込み。
 * 環境変数: ZLLM_BASE_URL / ZLLM_API_KEY / ZLLM_MODEL / ZLLM_ENTRY_MODEL /
 *           ZLLM_EXIT_MODEL / ZLLM_STORY / ZLLM_SEED
 */
import { existsSync, readFileSync } from 'node:fs';
import type { LLMConfig } from '../core/llm/client.js';

export interface AppConfig {
  llm: {
    baseUrl: string;
    apiKey: string;
    model: string;
    entryModel: string | null;
    exitModel: string | null;
    temperature: number;
    maxTokens: number;
    timeoutMs: number;
  };
  engine: {
    dfrotzPath: string;
    storyFile: string;
    seed: number;
    workDir: string;
    width: number;
    quiescenceMs: number;
    queryTimeoutMs: number;
    hardTimeoutMs: number;
  };
  selfCorrect: {
    maxRetriesPerCommand: number;
    maxLlmCallsPerInput: number;
  };
  context: {
    turns: number;
  };
  cacheDir: string;
  logDir: string;
}

/** AppConfig.llm → core の LLMConfig (null を undefined に正規化) */
export function toLLMConfig(cfg: AppConfig): LLMConfig {
  return {
    model: cfg.llm.model,
    entryModel: cfg.llm.entryModel ?? undefined,
    exitModel: cfg.llm.exitModel ?? undefined,
    temperature: cfg.llm.temperature,
    maxTokens: cfg.llm.maxTokens,
    timeoutMs: cfg.llm.timeoutMs,
  };
}

export function loadConfig(path?: string): AppConfig {
  const file = path ?? (existsSync('config.json') ? 'config.json' : 'config.example.json');
  if (!existsSync(file)) {
    throw new Error(`設定ファイルが見つかりません: ${file}`);
  }
  const cfg = JSON.parse(readFileSync(file, 'utf8')) as AppConfig;
  const env = process.env;
  if (env.ZLLM_BASE_URL) cfg.llm.baseUrl = env.ZLLM_BASE_URL;
  if (env.ZLLM_API_KEY) cfg.llm.apiKey = env.ZLLM_API_KEY;
  if (env.ZLLM_MODEL) cfg.llm.model = env.ZLLM_MODEL;
  if (env.ZLLM_ENTRY_MODEL) cfg.llm.entryModel = env.ZLLM_ENTRY_MODEL;
  if (env.ZLLM_EXIT_MODEL) cfg.llm.exitModel = env.ZLLM_EXIT_MODEL;
  if (env.ZLLM_STORY) cfg.engine.storyFile = env.ZLLM_STORY;
  if (env.ZLLM_SEED) cfg.engine.seed = Number(env.ZLLM_SEED);
  return cfg;
}
