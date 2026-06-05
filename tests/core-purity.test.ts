/**
 * src/core/ は段階2 でブラウザ/レンダラへ持ち込むため、
 * Node 固有 API (node: モジュール等) への依存を禁止する。
 * (plan.md: "lint レベルで強制" — 専用 linter の代わりにテストで強制)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listTsFiles(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('core 純粋性', () => {
  it('src/core/ は node:* / fs / child_process 等を import しない', () => {
    const files = listTsFiles('src/core');
    expect(files.length).toBeGreaterThan(0);
    const forbidden = /from\s+['"](node:|fs|path|child_process|os|http|https|net|crypto|stream|util|events)['"]/;
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(forbidden.test(src), `${f} が Node API を import している`).toBe(false);
    }
  });
});
