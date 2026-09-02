/**
 * `kg:link`, migrated to ApeironNgn (Aperas-apeironngn-design.md §4 rollout) — interactively
 * prompts for cross-links on BlockNodes in scope, reading/writing a rehydrated in-process Store
 * instead of TerminusDB. Dehydrates after each block's gathered links are committed, mirroring
 * `kgCli.ts`'s own per-block `updateBlockNode` immediacy.
 *
 * A fresh `Link` is created directly here (mint an id, `wrap()` it, set `target`/`predicate`) and
 * attached to the owning block's `links` by id — not by handing a `{"@type": "Link", ...}`
 * literal to `node.ts`'s `set` trap, since `writeField`'s auto-minting path (`mintEmbedded`) always
 * shapes a fresh id as `${parentId}/props/${type}/...`, correct for `props`' `StringProp`
 * subdocuments but wrong for a `Link` (a top-level entity, `Link/<snowflake>`, not nested under
 * anything). Creating it by hand and attaching by id is the same "create then attach" pattern
 * `resolveCreate.ts`'s holder creation already uses, and sidesteps the mismatch entirely rather
 * than needing a wider fix to `writeField` itself for a single call site.
 */

import { createInterface } from 'node:readline/promises';
import { rehydrateStore } from './apeironNgn/store';
import { dehydrateToJsonLd } from './apeironNgn/dehydrate';
import { resolveDeepPath } from './apeironNgn/resolve';
import { collectBlockNodes } from './apeironNgn/collect';
import { wrap, type ApeironNode } from './apeironNgn/node';
import { generateNodeId } from './snowflake';
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

  const blocks = collectBlockNodes(store, id, recursive);
  const candidates = all ? blocks : blocks.filter(({ node }) => !(node.links as ApeironNode[])?.length);
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
    console.log(`\n${blockId}  [${node.type}]`);
    console.log((node.text as string) || '(no text)');
    const existing = (node.links as ApeironNode[]) ?? [];
    const newLinkIds: string[] = [];
    for (;;) {
      const prompt = newLinkIds.length === 0 ? 'Link target (blank to skip block): ' : 'Another link target (blank to move on): ';
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
      const linkId = `Link/${generateNodeId()}`;
      const link = wrap(store, linkId);
      link.target = target;
      link.predicate = 'references';
      newLinkIds.push(linkId);
    }
    if (newLinkIds.length > 0) {
      node.links = [...existing, ...newLinkIds];
      dehydrateToJsonLd(store);
      linkedBlocks++;
      addedLinks += newLinkIds.length;
    }
  }
  rl.close();
  console.log(`[ApeironNgn kg:link] Added ${addedLinks} link(s) across ${linkedBlocks} block(s).`);
}

main().catch((err) => {
  console.error('[ApeironNgn kg:link] Failed:', err.message || err);
  process.exit(1);
});
