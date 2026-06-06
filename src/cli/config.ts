/**
 * config.json (なければ config.example.json) ＋ 環境変数の読み込み。
 * 環境変数: YOMINTERP_BASE_URL / YOMINTERP_API_KEY / YOMINTERP_MODEL / YOMINTERP_ENTRY_MODEL /
 *           YOMINTERP_EXIT_MODEL / YOMINTERP_STORY / YOMINTERP_SEED
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
  if (env.YOMINTERP_BASE_URL) cfg.llm.baseUrl = env.YOMINTERP_BASE_URL;
  if (env.YOMINTERP_API_KEY) cfg.llm.apiKey = env.YOMINTERP_API_KEY;
  if (env.YOMINTERP_MODEL) cfg.llm.model = env.YOMINTERP_MODEL;
  if (env.YOMINTERP_ENTRY_MODEL) cfg.llm.entryModel = env.YOMINTERP_ENTRY_MODEL;
  if (env.YOMINTERP_EXIT_MODEL) cfg.llm.exitModel = env.YOMINTERP_EXIT_MODEL;
  if (env.YOMINTERP_STORY) cfg.engine.storyFile = env.YOMINTERP_STORY;
  if (env.YOMINTERP_SEED) cfg.engine.seed = Number(env.YOMINTERP_SEED);
  return cfg;
}
