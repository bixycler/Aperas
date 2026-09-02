/**
 * `kg:title`, migrated to ApeironNgn (Aperas-apeironngn-design.md §4 rollout) — interactively
 * prompts for a real title on every still-unlabeled BlockNode in scope (Aperas-interactive-
 * summarization-design.md §3), reading/writing a rehydrated in-process Store instead of
 * TerminusDB. Dehydrates after each accepted answer, mirroring `kgCli.ts`'s own per-answer
 * `updateBlockNode` immediacy — so a mid-session interruption (or, under ApeironNgn, an uncaught
 * throw from a later ambiguous ref) still persists everything gathered up to that point, not just
 * whatever an all-at-the-end write would have caught.
 */

import { createInterface } from 'node:readline/promises';
import { rehydrateStore } from './apeironNgn/store';
import { dehydrateToJsonLd } from './apeironNgn/dehydrate';
import { resolveDeepPath } from './apeironNgn/resolve';
import { collectBlockNodes } from './apeironNgn/collect';
import { createLineReader } from './lineReader';

async function main(): Promise<void> {
  const paths = process.argv.slice(2);
  const recursive = paths.includes('--recursive');
  const [pathArg] = paths.filter((p) => p !== '--recursive');
  if (!pathArg) {
    console.error('Usage: kg:title:ngn -- <path> [--recursive]');
    process.exit(1);
  }

  const { store } = rehydrateStore();
  const id = resolveDeepPath(store, pathArg);
  if (!id) {
    console.error(`[ApeironNgn kg:title] '${pathArg}' isn't a tracked artifact/folder path, deep path, bare node code, or full node id.`);
    process.exit(1);
  }

  const blocks = collectBlockNodes(store, id, recursive);
  const candidates = blocks.filter(({ node }) => !node.title || node.title === node.blockId);
  if (candidates.length === 0) {
    console.log('[ApeironNgn kg:title] No blocks need a title in scope.');
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const lines = createLineReader(rl);
  let set = 0;
  let asked = 0;
  for (const { id: blockId, node } of candidates) {
    console.log(`\n${blockId}  [${node.type}]`);
    console.log((node.text as string) || '(no text)');
    process.stdout.write('Title (blank to skip): ');
    const raw = await lines.next();
    if (raw === null) break; // stdin closed early — stop cleanly, don't crash
    asked++;
    const answer = raw.trim();
    if (answer) {
      node.title = answer;
      dehydrateToJsonLd(store);
      set++;
    }
  }
  rl.close();
  console.log(`[ApeironNgn kg:title] Set ${set} title(s), skipped ${asked - set}${asked < candidates.length ? ` (${candidates.length - asked} unreached — input ended early)` : ''}.`);
}

main().catch((err) => {
  console.error('[ApeironNgn kg:title] Failed:', err.message || err);
  process.exit(1);
});
