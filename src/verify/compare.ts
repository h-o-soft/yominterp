/**
 * step 集約比較の正規化・類似度 (run-transcript から分離した純関数)。
 */
import { unwrapParagraphs } from '../core/translate/exit.js';

export function normalizeForCompare(text: string): string {
  return unwrapParagraphs(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenOverlap(a: string, b: string): number {
  const ta = new Set(a.split(' ').filter(Boolean));
  const tb = new Set(b.split(' ').filter(Boolean));
  if (ta.size === 0 && tb.size === 0) return 1;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.max(ta.size, tb.size, 1);
}
