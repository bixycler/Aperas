/**
 * `kg:backlinks` — lists every `Link` that targets a given node, via the shared ApeironNgn service
 * (Aperas-apeironngn-design.md §4 rollout step 13). A `Link`'s own id already carries its owning
 * node's id as a prefix (`<ownerId>:links:Link:<snowflake>`), so that id alone tells you both
 * "which link" and "who's referring in" — no separate owner-id field needed.
 */

import type { Store } from 'oxigraph';
import { resolveDeepPath } from './apeironNgn/resolve';
import { backlinks, ownerOfLink, wrap, type TreeNode, type Link } from './apeironNgn/node';
import { displayLabel } from './apeironNgn/tree';
import { nodeAbstract } from './kgUnfold';
import { ensureServiceRunning, request } from './apeironNgn/serviceClient';
import { wantsHelp, printHelp } from './kgHelp';

export interface BacklinkEntry {
  linkId: string;
  label: string;
  title: string;
  text?: string;
}

export function runBacklinks(store: Store, pathArg: string, includeText: boolean): BacklinkEntry[] {
  const id = resolveDeepPath(store, pathArg);
  if (!id) throw new Error(`'${pathArg}' isn't a tracked artifact/folder path, deep path, bare node code, or full node id.`);

  const links = backlinks(store, id, 'target') as unknown as Link[];
  const entries: BacklinkEntry[] = [];
  for (const link of links) {
    const ownerId = ownerOfLink(store, link.id);
    if (!ownerId) continue; // orphaned Link subdocument — shouldn't happen, skip defensively
    const owner = wrap(store, ownerId) as unknown as TreeNode;
    entries.push({
      linkId: link.id,
      label: displayLabel(ownerId, owner),
      title: (owner.title as string) ?? '',
      text: includeText ? nodeAbstract(owner) : undefined,
    });
  }
  return entries;
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (wantsHelp(rawArgs)) {
    printHelp({
      description: "List every Link that targets a given node — the reverse of kg:unfold's forward view.",
      usage: 'kg:backlinks -- <path> [--text] [--reload]',
      args: [
        { name: '<path>', description: 'Tracked artifact/folder path, deep path, bare node code, or full node id whose backlinks to list.' },
      ],
      flags: [
        { name: '--text', description: "Also print each referring node's own capped abstract text." },
        { name: '--reload', description: 'Reload the store from disk first, in case something else (e.g. a git pull) changed it since the service started.' },
      ],
    });
    return;
  }
  const includeText = rawArgs.includes('--text');
  const reload = rawArgs.includes('--reload');
  const [pathArg] = rawArgs.filter((p) => p !== '--text' && p !== '--reload');
  if (!pathArg) {
    console.error('Usage: kg:backlinks -- <path> [--text] [--reload]');
    process.exit(1);
  }

  await ensureServiceRunning();
  const entries = await request<ReturnType<typeof runBacklinks>>({ op: 'backlinks', pathArg, includeText, reload });
  if (entries.length === 0) {
    console.log('[ApeironNgn kg:backlinks] No backlinks found.');
    return;
  }
  for (const { linkId, label, title, text } of entries) {
    console.log(`${linkId}  [${label}]  ${title}${text !== undefined ? `  ║  ${text}` : ''}`);
  }
}

if (process.argv[1]?.endsWith('kgBacklinks.ts')) {
  main().catch((err) => {
    console.error('[ApeironNgn kg:backlinks] Failed:', err.message || err);
    process.exit(1);
  });
}
