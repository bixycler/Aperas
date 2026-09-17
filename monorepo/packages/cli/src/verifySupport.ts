/**
 * Shared between `verify.ts` (fast — AST/ingestion/reconciliation/FolderNode/tombstone-GC unit-
 * style checks, ~1 minute) and `verifyExtended.ts` (slow — Linking Slice ingestion scenarios plus
 * the corpus-wide link-integrity sweeps, ~4-5 minutes). Split so an ordinary `npm run verify`
 * during iterative work doesn't pay for the slow half's own cost every single time; `npm run
 * verify:slow` still runs it, for whenever the full picture actually matters. See `issues/core.md`
 * for why the slow half costs what it does — a process-lifetime effect neither half's own code is
 * responsible for, confirmed by ruling out two credible causes rather than by guessing.
 */

import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getArtifactsDir } from '@aperas/core/artifacts';

export const DEMO_DIR = '__verify_apeironngn_demo';

/** Removes the demo subfolder from disk, if present — safe to call before starting (cleans up a
 *  previous crashed run, from either half) and in each half's own final `finally`. Both halves
 *  share this one directory; they are not meant to run concurrently against the same artifacts
 *  root, only sequentially (the normal case: `verify` during iteration, `verify:slow` occasionally)
 *  — each cleans up fully after itself before the other would ever look. */
export function resetDemoState(): void {
  const demoDir = join(getArtifactsDir(), DEMO_DIR);
  if (existsSync(demoDir)) rmSync(demoDir, { recursive: true, force: true });
}

export function findHeadingByTitle(node: any, needle: string): any {
  if (node.type === 'heading' && node.title?.includes(needle)) return node;
  for (const child of node.children ?? []) {
    const found = findHeadingByTitle(child, needle);
    if (found) return found;
  }
  return null;
}

export function findByText(node: any, needle: string): any {
  if (typeof node.text === 'string' && node.text.includes(needle)) return node;
  for (const child of node.children ?? []) {
    const found = findByText(child, needle);
    if (found) return found;
  }
  return null;
}

/** Per-step wall-clock timing — each half installs its own instance for the duration of its own
 *  run. Wraps `console.log` and watches for a step's own `"N[letter]. Testing ..."` header line
 *  (every step already announces itself this way, so no call site needs touching), attributing the
 *  time *since the previous marker* to the *previous* step — a step's own cost is everything
 *  between its header printing and the next header printing. The first entry is therefore a
 *  synthetic "(setup)" bucket for whatever ran before the first real step's own header. Call the
 *  returned function once, from a `finally`, so a crash mid-step still reports where the time went. */
export function instrumentStepTiming(): () => void {
  const original = console.log;
  const timings: Array<{ label: string; ms: number }> = [];
  let lastLabel = '(setup, before step 1)';
  let lastTime = Date.now();
  console.log = (...args: unknown[]): void => {
    const first = args[0];
    if (typeof first === 'string' && /^\d+[a-z]?\.\s/.test(first)) {
      const now = Date.now();
      timings.push({ label: lastLabel, ms: now - lastTime });
      lastLabel = first;
      lastTime = now;
    }
    original(...(args as []));
  };
  return function stopAndReport(): void {
    timings.push({ label: lastLabel, ms: Date.now() - lastTime });
    console.log = original;
    const total = timings.reduce((sum, t) => sum + t.ms, 0);
    console.log('\n=== Step timing (slowest first; each step\'s cost is its own work, not cumulative) ===');
    for (const t of [...timings].sort((a, b) => b.ms - a.ms)) {
      console.log(`  ${String(t.ms).padStart(6)}ms  ${t.label}`);
    }
    console.log(`  ${String(total).padStart(6)}ms  TOTAL`);
  };
}
