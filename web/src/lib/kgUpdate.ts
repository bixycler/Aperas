/**
 * `kg:update` — replaces an existing node's text/children from piped markdown (Aperas-crud-
 * design.md §9), via the shared ApeironNgn service. Generalizes `ArtifactNode.ingestFromDisk`'s own
 * mechanism (parse, then either fresh-hydrate or `reconcileTree`-reconcile) from "artifact root"
 * down to any existing `BlockNode`/`ArtifactNode`. Always requires stdin; `<path>` always names the
 * existing target — no dual-mode ambiguity the way there is for `kg:insert`.
 *
 * `parseMarkdownTree`'s own leading-paragraph "consuming" rule (`astParser.ts` §2) never applies at
 * its own root — only a real heading/listItem container gets it, and the piped markdown is parsed
 * as a standalone root. But `path` here plays exactly the role a heading would: the piped content
 * is the body that would sit directly beneath it. So this replicates that rule manually: if the
 * parsed root's first child is a `paragraph`, its text becomes `path.text` and it's dropped from
 * the child list; everything else is "overflow." `path`'s own `type`/`title` are never touched —
 * only `text`/`children`.
 *
 * - Default: overflow reconciles against `path`'s existing children via the full Gestalt-match
 *   machinery (`reconcile.ts`) — matched/moved/changed/removed/added, identical to a real re-ingest.
 * - `--text-only`: overflow still becomes children (never silently dropped), but via a raw prepend
 *   ahead of whatever's already there — no diffing, no identity-matching, the cheap path.
 */

import type { Store } from 'oxigraph';
import { resolveDeepPath } from './apeironNgn/resolve';
import { wrap, applyTombstone } from './apeironNgn/node';
import type { BlockNode, TreeNode } from './apeironNgn/node';
import { nodeKindFromId } from './apeironNgn/vocab';
import { parseMarkdownTree, type ParsedBlockNode } from './astParser';
import { reconcileTree } from './reconcile';
import { ensureServiceRunning, request } from './apeironNgn/serviceClient';
import { wantsHelp, printHelp } from './kgHelp';

export interface UpdateReq {
  path: string;
  base?: string;
  markdown: string;
  textOnly: boolean;
}

export interface UpdateResult {
  reconciled: boolean;
  matched?: number;
  moved?: number;
  changed?: number;
  added?: number;
  removed?: number;
}

export function runUpdate(store: Store, req: UpdateReq): UpdateResult {
  let targetId: string | null;
  try {
    targetId = resolveDeepPath(store, req.path, { base: req.base });
  } catch (err: any) {
    throw new Error(`Target '${req.path}': ${err.message || err}`);
  }
  if (!targetId) {
    throw new Error(`Target '${req.path}' isn't a tracked artifact/folder path, deep path, bare node code, or full node id.`);
  }
  const kind = nodeKindFromId(targetId);
  if (kind !== 'BlockNode' && kind !== 'ArtifactNode') {
    throw new Error(`'${req.path}' resolves to a ${kind} — kg:update only targets Block/Artifact nodes.`);
  }
  const target = wrap(store, targetId) as unknown as BlockNode;

  const { root } = parseMarkdownTree(req.markdown);
  const parsedChildren = root.children ?? [];

  let text: string | undefined;
  let overflow: ParsedBlockNode[];
  if (parsedChildren[0]?.type === 'paragraph') {
    text = parsedChildren[0].text;
    overflow = parsedChildren.slice(1);
  } else {
    text = undefined;
    overflow = parsedChildren;
  }

  target.text = text;
  // Real content just arrived at `target` regardless of which mode runs below — promoting a holder
  // is orthogonal to how carefully the overflow gets merged in. The reconcile branch below gets
  // this for free via `hydrateFromParsed`'s own unconditional clear (confirmed live); --text-only
  // never calls that, so it needs the same clear spelled out here explicitly.
  target.holder = undefined;

  if (req.textOnly) {
    const overflowIds = overflow.map((c) => {
      const id = `BlockNode:${c.blockId}`;
      (wrap(store, id) as unknown as BlockNode).hydrateFromParsed(c);
      return id as unknown as TreeNode;
    });
    const existing = (target.children as TreeNode[] | undefined) ?? [];
    target.children = [...overflowIds, ...existing];
    return { reconciled: false };
  }

  const oldShape = target.toReconcileShape();
  const newShape = { blockId: target.key, type: target.type, title: target.title, text, children: overflow };
  const { finalTree, tombstones, stats } = reconcileTree(oldShape, newShape);
  for (const tombstone of tombstones) applyTombstone(store, tombstone);
  target.hydrateFromParsed(finalTree);

  return { reconciled: true, ...stats };
}

/** Refuses on empty input rather than silently proceeding — confirmed live this matters: unlike
 *  `kg:insert` (which falls back to a different mode on empty stdin), `kg:update` always mutates
 *  `path`, so an accidentally-missing pipe would otherwise clear `.text` and reconcile against zero
 *  overflow children — in the default (non `--text-only`) mode, that tombstones every existing
 *  child. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const content = Buffer.concat(chunks).toString('utf-8');
  if (content.length === 0) {
    throw new Error('No markdown was piped to stdin — did you forget to pipe content? (e.g. `cat file.md | npm run kg:update -- ...`)');
  }
  return content;
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (wantsHelp(rawArgs)) {
    printHelp({
      description: "Replace an existing node's text/children from piped markdown.",
      usage: 'cat content.md | kg:update -- [--base <path>] <path> [--text-only]',
      args: [
        { name: '<path>', description: 'Existing Block/Artifact node to update.' },
      ],
      flags: [
        { name: '--base <path>', description: 'Base path deep-path resolution is relative to.' },
        { name: '--text-only', description: "Overflow content (past the leading paragraph) is prepended raw instead of reconciled against existing children." },
        { name: '--flush', description: 'Force an immediate sync to disk after this call, instead of waiting for the normal flush timer.' },
        { name: '--reload', description: 'Reload the store from disk first, in case something else (e.g. a git pull) changed it since the service started.' },
      ],
    });
    return;
  }
  const flush = rawArgs.includes('--flush');
  const reload = rawArgs.includes('--reload');
  const textOnly = rawArgs.includes('--text-only');
  const args = rawArgs.filter((a) => a !== '--flush' && a !== '--reload' && a !== '--text-only');

  const baseIdx = args.indexOf('--base');
  const base = baseIdx !== -1 ? args[baseIdx + 1] : undefined;
  const consumed = new Set<number>();
  if (baseIdx !== -1) { consumed.add(baseIdx); consumed.add(baseIdx + 1); }
  const [path] = args.filter((_, i) => !consumed.has(i));

  if (!path) {
    console.error('Usage: cat content.md | kg:update -- [--base <path>] <path> [--text-only]');
    process.exit(1);
  }

  const markdown = await readStdin();

  await ensureServiceRunning();
  const result = await request<ReturnType<typeof runUpdate>>({ op: 'update', path, base, markdown, textOnly, flush, reload });

  if (result.reconciled) {
    console.log(`[ApeironNgn kg:update] Reconciled '${path}': ${result.matched} matched, ${result.moved} moved, ${result.changed} changed, ${result.added} added, ${result.removed} removed.`);
  } else {
    console.log(`[ApeironNgn kg:update] Updated '${path}' (--text-only: overflow prepended, no reconciliation).`);
  }
}

if (process.argv[1]?.endsWith('kgUpdate.ts')) {
  main().catch((err) => {
    console.error('[ApeironNgn kg:update] Failed:', err.message || err);
    process.exit(1);
  });
}
