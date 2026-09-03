/**
 * `kg:link` — interactively prompts for cross-links on BlockNodes in scope, via the shared
 * ApeironNgn service (Aperas-apeironngn-design.md §4 rollout step 5): candidates are listed in one
 * round trip, then each attempted answer is its own `addBlockLink` round trip (resolved server-side
 * against the live store, so an unresolvable answer can be re-prompted without a wasted mutation).
 * Persistence follows the service's normal 10s flush timer, same as every other mutator.
 */

import { createInterface } from 'node:readline/promises';
import type { Store } from 'oxigraph';
import { resolveDeepPath } from './apeironNgn/resolve';
import { wrap, type TreeNode, type BlockNode } from './apeironNgn/node';
import { createLineReader } from './lineReader';
import { ensureServiceRunning, request } from './apeironNgn/serviceClient';

export function runLinkCandidates(store: Store, pathArg: string, recursive: boolean, all: boolean) {
  const id = resolveDeepPath(store, pathArg);
  if (!id) throw new Error(`'${pathArg}' isn't a tracked artifact/folder path, deep path, bare node code, or full node id.`);
  const blocks = (wrap(store, id) as unknown as TreeNode).collectDescendants(recursive);
  const candidates = all ? blocks : blocks.filter(({ node }) => !(node as unknown as BlockNode).links?.length);
  return candidates.map(({ id: blockId, node }) => ({
    blockId,
    type: (node as unknown as BlockNode).type,
    text: (node as unknown as BlockNode).text || '(no text)',
  }));
}

export function runAddBlockLink(store: Store, blockId: string, targetRef: string): { resolved: boolean } {
  const target = resolveDeepPath(store, targetRef);
  if (!target) return { resolved: false };
  (wrap(store, blockId) as unknown as BlockNode).addLink('references', target);
  return { resolved: true };
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const recursive = rawArgs.includes('--recursive');
  const all = rawArgs.includes('--all');
  const [pathArg] = rawArgs.filter((p) => p !== '--recursive' && p !== '--all');
  if (!pathArg) {
    console.error('Usage: kg:link -- <path> [--recursive] [--all]');
    process.exit(1);
  }

  await ensureServiceRunning();
  const candidates = await request<ReturnType<typeof runLinkCandidates>>({ op: 'linkCandidates', pathArg, recursive, all });
  if (candidates.length === 0) {
    console.log('[ApeironNgn kg:link] No blocks to prompt for links in scope.');
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const lines = createLineReader(rl);
  let linkedBlocks = 0;
  let addedLinks = 0;
  let stdinClosed = false;
  for (const { blockId, type, text } of candidates) {
    if (stdinClosed) break;
    console.log(`\n${blockId}  [${type}]`);
    console.log(text);
    let addedForBlock = 0;
    for (;;) {
      const prompt = addedForBlock === 0 ? 'Link target (blank to skip block): ' : 'Another link target (blank to move on): ';
      process.stdout.write(prompt);
      const raw = await lines.next();
      if (raw === null) { stdinClosed = true; break; }
      const answer = raw.trim();
      if (!answer) break;
      const { resolved } = await request<ReturnType<typeof runAddBlockLink>>({ op: 'addBlockLink', blockId, targetRef: answer, flush: false });
      if (!resolved) {
        console.log(`  '${answer}' didn't resolve to any node — try again or leave blank.`);
        continue;
      }
      addedForBlock++;
    }
    if (addedForBlock > 0) {
      linkedBlocks++;
      addedLinks += addedForBlock;
    }
  }
  rl.close();
  console.log(`[ApeironNgn kg:link] Added ${addedLinks} link(s) across ${linkedBlocks} block(s).`);
}

if (process.argv[1]?.endsWith('kgLink.ts')) {
  main().catch((err) => {
    console.error('[ApeironNgn kg:link] Failed:', err.message || err);
    process.exit(1);
  });
}
