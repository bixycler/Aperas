/**
 * `kg:title` — interactively prompts for a real title on every still-unlabeled BlockNode in scope,
 * via the shared ApeironNgn service (Aperas-apeironngn-design.md §4 rollout step 5): candidates
 * are listed in one round trip, then each accepted answer is its own `setBlockTitle` round trip —
 * persistence now follows the service's normal 10s flush timer rather than an immediate dehydrate
 * per answer, same as every other mutating `kg:xxx` script.
 */

import { createInterface } from 'node:readline/promises';
import type { Store } from 'oxigraph';
import { resolveDeepPath } from './apeironNgn/resolve';
import { wrap, type TreeNode } from './apeironNgn/node';
import { createLineReader } from './lineReader';
import { ensureServiceRunning, request } from './apeironNgn/serviceClient';

export function runTitleCandidates(store: Store, pathArg: string, recursive: boolean) {
  const id = resolveDeepPath(store, pathArg);
  if (!id) throw new Error(`'${pathArg}' isn't a tracked artifact/folder path, deep path, bare node code, or full node id.`);
  const blocks = (wrap(store, id) as unknown as TreeNode).collectDescendants(recursive);
  const candidates = blocks.filter(({ node }) => !node.title || node.title === node.key);
  return candidates.map(({ id: blockId, node }) => ({
    blockId,
    type: (node as unknown as { type?: string }).type,
    text: node.text || '(no text)',
  }));
}

export function runSetBlockTitle(store: Store, blockId: string, title: string): void {
  (wrap(store, blockId) as unknown as TreeNode).title = title;
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const recursive = rawArgs.includes('--recursive');
  const [pathArg] = rawArgs.filter((p) => p !== '--recursive');
  if (!pathArg) {
    console.error('Usage: kg:title -- <path> [--recursive]');
    process.exit(1);
  }

  await ensureServiceRunning();
  const candidates = await request<ReturnType<typeof runTitleCandidates>>({ op: 'titleCandidates', pathArg, recursive });
  if (candidates.length === 0) {
    console.log('[ApeironNgn kg:title] No blocks need a title in scope.');
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const lines = createLineReader(rl);
  let set = 0;
  let asked = 0;
  for (const { blockId, type, text } of candidates) {
    console.log(`\n${blockId}  [${type}]`);
    console.log(text);
    process.stdout.write('Title (blank to skip): ');
    const raw = await lines.next();
    if (raw === null) break; // stdin closed early — stop cleanly, don't crash
    asked++;
    const answer = raw.trim();
    if (answer) {
      await request({ op: 'setBlockTitle', blockId, title: answer, flush: false });
      set++;
    }
  }
  rl.close();
  console.log(`[ApeironNgn kg:title] Set ${set} title(s), skipped ${asked - set}${asked < candidates.length ? ` (${candidates.length - asked} unreached — input ended early)` : ''}.`);
}

if (process.argv[1]?.endsWith('kgTitle.ts')) {
  main().catch((err) => {
    console.error('[ApeironNgn kg:title] Failed:', err.message || err);
    process.exit(1);
  });
}
