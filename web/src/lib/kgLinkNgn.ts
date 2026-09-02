/**
 * `kg:link`, migrated to ApeironNgn (Aperas-apeironngn-design.md §4 rollout) — interactively
 * prompts for cross-links on BlockNodes in scope, reading/writing a rehydrated in-process Store
 * instead of TerminusDB. Dehydrates after each block's gathered links are committed, mirroring
 * `kgCli.ts`'s own per-block `updateBlockNode` immediacy.
 *
 * §4 rollout step 3: a fresh `Link` is created via `BaseNode.addLink` (`node.ts`) now — no more
 * "mint a `Link/<snowflake>` id, `wrap()` it, set `target`/`predicate`, attach by id" workaround,
 * now that `links` is `storageKind: 'embed'` and the generic embed-mint path handles a fresh
 * `{ predicate, target }` literal correctly on its own (the same path `props` already used).
 */

import { createInterface } from 'node:readline/promises';
import { rehydrateStore } from './apeironNgn/store';
import { dehydrateToJsonLd } from './apeironNgn/dehydrate';
import { resolveDeepPath } from './apeironNgn/resolve';
import { wrap, type TreeNode, type BlockNode } from './apeironNgn/node';
import { createLineReader } from './lineReader';

async function main(): Promise<void> {
  const paths = process.argv.slice(2);
  const recursive = paths.includes('--recursive');
  const all = paths.includes('--all');
  const [pathArg] = paths.filter((p) => p !== '--recursive' && p !== '--all');
  if (!pathArg) {
    console.error('Usage: kg:link:ngn -- <path> [--recursive] [--all]');
    process.exit(1);
  }

  const { store } = rehydrateStore();
  const id = resolveDeepPath(store, pathArg);
  if (!id) {
    console.error(`[ApeironNgn kg:link] '${pathArg}' isn't a tracked artifact/folder path, deep path, bare node code, or full node id.`);
    process.exit(1);
  }

  const blocks = (wrap(store, id) as unknown as TreeNode).collectDescendants(recursive);
  const candidates = all ? blocks : blocks.filter(({ node }) => !(node as unknown as BlockNode).links?.length);
  if (candidates.length === 0) {
    console.log('[ApeironNgn kg:link] No blocks to prompt for links in scope.');
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const lines = createLineReader(rl);
  let linkedBlocks = 0;
  let addedLinks = 0;
  let stdinClosed = false;
  for (const { id: blockId, node } of candidates) {
    if (stdinClosed) break;
    const block = node as unknown as BlockNode;
    console.log(`\n${blockId}  [${block.type}]`);
    console.log(block.text || '(no text)');
    let addedForBlock = 0;
    for (;;) {
      const prompt = addedForBlock === 0 ? 'Link target (blank to skip block): ' : 'Another link target (blank to move on): ';
      process.stdout.write(prompt);
      const raw = await lines.next();
      if (raw === null) { stdinClosed = true; break; }
      const answer = raw.trim();
      if (!answer) break;
      const target = resolveDeepPath(store, answer);
      if (!target) {
        console.log(`  '${answer}' didn't resolve to any node — try again or leave blank.`);
        continue;
      }
      block.addLink('references', target);
      addedForBlock++;
    }
    if (addedForBlock > 0) {
      dehydrateToJsonLd(store);
      linkedBlocks++;
      addedLinks += addedForBlock;
    }
  }
  rl.close();
  console.log(`[ApeironNgn kg:link] Added ${addedLinks} link(s) across ${linkedBlocks} block(s).`);
}

main().catch((err) => {
  console.error('[ApeironNgn kg:link] Failed:', err.message || err);
  process.exit(1);
});
