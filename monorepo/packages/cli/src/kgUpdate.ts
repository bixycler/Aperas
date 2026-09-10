/**
 * `kg:update` — replaces an existing node's text/children (and, for a heading target, its title
 * too) from piped markdown (Aperas-crud-design.md §9), via the shared ApeironNgn service.
 * Generalizes `ArtifactNode.ingestFromDisk`'s own mechanism (parse, then either fresh-hydrate or
 * `reconcileTree`-reconcile) from "artifact root" down to any existing `BlockNode`/`ArtifactNode`.
 * Always requires stdin; `<path>` always names the existing target — no dual-mode ambiguity the way
 * there is for `kg:insert`.
 *
 * `parseMarkdownTree`'s own leading-paragraph "consuming" rule (`astParser.ts` §2) never applies at
 * its own root — only a real heading/listItem container gets it, and the piped markdown is parsed
 * as a standalone root. But `path` here plays exactly the role a heading would: the piped content
 * is the body that would sit directly beneath it. So this replicates that rule manually: if the
 * parsed root's first child is a `paragraph`, its text becomes `path.text` and it's dropped from
 * the child list; everything else is "overflow."
 *
 * When `path` itself is a heading, the piped input's own first child may *also* be a heading —
 * `groupByHeadings` (`astParser.ts`) already parses it into a fully-formed `title`/`text`/
 * `children`/`props` node (anchor-stripped, tree-anchor stashed, same as any real document parse),
 * so that whole node is used as `path`'s new state directly, `title` included — this is what
 * replaces `kg:title` (removed; AperasKG/artifacts/issues/linking.md) for the one block type whose
 * title is actually projected back to disk. The input heading's own `#` depth must match `path`'s
 * current depth (checked below) — this command relabels a heading in place, it doesn't restructure
 * the tree, so a depth change is refused rather than silently reinterpreted. Piping a plain
 * paragraph instead (no leading heading line) still works exactly as before — the title is left
 * untouched, only `text`/`children` update.
 *
 * - Default: overflow reconciles against `path`'s existing children via the full Gestalt-match
 *   machinery (`reconcile.ts`) — matched/moved/changed/removed/added, identical to a real re-ingest.
 * - `--text-only`: overflow still becomes children (never silently dropped), but via a raw prepend
 *   ahead of whatever's already there — no diffing, no identity-matching, the cheap path.
 */

import type { Store } from 'oxigraph';
import { resolveDeepPath } from '@aperas/core/apeironNgn/resolve';
import {
  wrap, applyTombstone, rejectSlugPathCollisions,
  collectLinkTargetsByBlock, collectOldWikilinksByBlock, findEnclosingArtifactId,
} from '@aperas/core/apeironNgn/node';
import type { BlockNode, TreeNode, ApeironNode } from '@aperas/core/apeironNgn/node';
import { nodeKindFromId } from '@aperas/core/apeironNgn/vocab';
import { parseMarkdownTree, headingDepth, type ParsedBlockNode, type LinkOccurrence } from '@aperas/core/astParser';
import { extractLinkCodes } from '@aperas/core/artifacts';
import { reconcileTree } from '@aperas/core/reconcile';
import { resolveBlockLinks, type LinkResolutionStats } from '@aperas/core/apeironNgn/artifacts';
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
  linkResolution: LinkResolutionStats;
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
  const firstChild = parsedChildren[0];

  let text: string | undefined;
  let title: string | undefined;
  let props: ParsedBlockNode['props'];
  let overflow: ParsedBlockNode[];
  // Whichever branch below supplies `text`/`title` does so from a real parsed node (`firstChild`)
  // that may itself carry `linkCodes` for wikilinks inside that very text — captured separately
  // here since `text`/`title` themselves are plain strings once destructured out, with nowhere
  // left to hang the codes off of. Stays `undefined` in the plain-overflow (`else`) branch, where
  // `target`'s own text isn't changing at all.
  let rootLinkCodes: LinkOccurrence[] | undefined;
  if (target.type === 'heading' && firstChild?.type === 'heading') {
    // The piped input's own leading heading is `target`'s new state in full, title included —
    // already a fully-formed node (anchor-stripped, tree-anchor stashed) via the same
    // `groupByHeadings`/`convertAstNode` machinery a real document parse uses.
    const oldDepth = headingDepth(target.title);
    const newDepth = headingDepth(firstChild.title);
    if (oldDepth !== newDepth) {
      throw new Error(
        `'${req.path}' is a depth-${oldDepth} heading — the piped input's own heading is depth-${newDepth}. ` +
        `kg:update relabels a heading in place, it doesn't change its depth/position; fix the input's '#' count.`
      );
    }
    title = firstChild.title;
    text = firstChild.text;
    props = firstChild.props;
    overflow = firstChild.children ?? [];
    rootLinkCodes = firstChild.linkCodes;
  } else if (firstChild?.type === 'paragraph') {
    // A list directly following a paragraph adopts into it (astParser.ts's own adoption rule,
    // §8) *regardless* of whether the paragraph sits under a heading/listItem container — this
    // module's own top doc comment only checked the *text*-consuming rule (correctly root-exempt),
    // not this separate one. Confirmed live: piping "paragraph\n\n- item\n- item" produced a
    // single root child (the paragraph, with the list already adopted as its own `children`) —
    // silently dropping the whole list on the floor when only `firstChild.text` was read here.
    text = firstChild.text;
    overflow = [...(firstChild.children ?? []), ...parsedChildren.slice(1)];
    rootLinkCodes = firstChild.linkCodes;
  } else {
    text = undefined;
    overflow = parsedChildren;
  }

  // `oldShape` is captured *before* any mutation below — it feeds `reconcileTree`'s prop-id-
  // preservation (an unchanged prop value keeps its stored id), which only works by comparing
  // against `target`'s real prior state; mutating `target.props` first would make `oldShape`
  // already reflect the *new* props, quietly defeating that comparison on every heading edit.
  const oldShape = target.toReconcileShape();

  // Snapshot of `target`'s own current live tree, taken before any of the mutations below —
  // `resolveBlockLinks` (`apeironNgn/artifacts.ts`) needs each touched block's *previous* resolved
  // targets/wikilinks to decide what changed and which `Link` ids can be reused, the same snapshot
  // `ingestArtifact` takes of a whole artifact before its own tree write. `kg:update`/`kg:insert`
  // never called `resolveBlockLinks` at all until this fix (`discussion/cli-packaging.md`,
  // "Resolved (partially): retitling a heading, and a deeper wikilink gap it exposed") — a block
  // reconciled as changed/added here would otherwise get no wikilink resolution whatsoever.
  const oldLinkTargets = new Map<string, Set<string>>();
  const oldWikilinksByBlock = new Map<string, Array<{ id: string; target: string; positions: number[] }>>();
  collectLinkTargetsByBlock(target, oldLinkTargets);
  collectOldWikilinksByBlock(target, oldWikilinksByBlock);
  const artifactId = findEnclosingArtifactId(target) ?? undefined;

  // Full-slug-path collision rejection (design/linking.md's Full-Path Collisions) — only relevant
  // when the heading-replacement branch above actually supplied a new `title`: an `ArtifactNode`'s
  // own title never contributes to any `toPath()` (see `toPath()`'s own kind check), and neither
  // does a plain text/children-only update that never touches `title` at all. `target.parent` is
  // unchanged by a rename — only `target`'s own final path segment is — so the parent's current
  // `toPath()` is the right prefix to check the renamed title against. Covers the renamed heading
  // itself, not the (separately reconciled) `overflow` subtree beneath it — `kg:insert`'s own check
  // is what covers a freshly-introduced multi-level tree.
  if (title !== undefined && target.parent) {
    const parentPath = target.parent.toPath();
    if (parentPath) {
      rejectSlugPathCollisions(store, parentPath, [
        { '@type': 'BlockNode', blockId: target.key, type: target.type, title, children: [] } as ParsedBlockNode,
      ]);
    }
  }

  target.text = text;
  // Real content just arrived at `target` regardless of which mode runs below — promoting a holder
  // is orthogonal to how carefully the overflow gets merged in. The reconcile branch below gets
  // this for free via `hydrateFromParsed`'s own unconditional clear (confirmed live); --text-only
  // never calls that, so it needs the same clear spelled out here explicitly.
  target.holder = undefined;

  if (req.textOnly) {
    // Only touch `title`/`props` at all when the heading-replacement branch above actually ran —
    // an ordinary text-only update (piped input starts with a plain paragraph, or nothing heading-
    // shaped) must never wipe an existing tree-anchor prop it was never asked to change.
    if (title !== undefined) {
      target.title = title;
      target.props = props?.length ? (props as unknown as ApeironNode[]) : undefined;
    }
    // Extracted *before* `hydrateFromParsed` runs on any of `overflow` below — `extractLinkCodes`
    // strips the (schema-unknown) `linkCodes` field off each node as it walks, in place, the same
    // order `ingestFromDisk` uses (extract first, hydrate after).
    const pendingLinks = extractLinkCodes({
      blockId: target.key,
      type: target.type,
      children: overflow,
      linkCodes: rootLinkCodes,
    } as unknown as ParsedBlockNode);
    const overflowIds = overflow.map((c) => {
      const id = `BlockNode:${c.blockId}`;
      (wrap(store, id) as unknown as BlockNode).hydrateFromParsed(c);
      return id as unknown as TreeNode;
    });
    const existing = (target.children as TreeNode[] | undefined) ?? [];
    target.children = [...overflowIds, ...existing];
    const linkResolution = resolveBlockLinks(store, pendingLinks, oldLinkTargets, oldWikilinksByBlock, artifactId);
    return { reconciled: false, linkResolution };
  }

  // `props` defaults to `oldShape`'s own (preserving whatever `target` already had, e.g. a
  // heading's tree-anchor) unless the heading-replacement branch above explicitly supplied a new
  // value to replace it with — an ordinary text/children-only update was never asked to touch it,
  // and `carryForwardFields`'s own prop-id-preservation only activates when both sides have props
  // to compare in the first place (leaving it out here, as this used to, silently dropped it).
  const newShape = {
    blockId: target.key,
    type: target.type,
    title: title ?? target.title,
    text,
    children: overflow,
    props: title !== undefined ? props : oldShape.props,
    linkCodes: rootLinkCodes,
  };
  const { finalTree, tombstones, stats } = reconcileTree(oldShape, newShape);
  for (const tombstone of tombstones) applyTombstone(store, tombstone);
  // Same extract-before-hydrate ordering as the --text-only branch above — `finalTree` is
  // `newShape`, mutated in place by `reconcileTree` (carried-forward `blockId`s etc.), so it still
  // carries every node's own `linkCodes` from the fresh parse, root included.
  const pendingLinks = extractLinkCodes(finalTree as unknown as ParsedBlockNode);
  target.hydrateFromParsed(finalTree);
  const linkResolution = resolveBlockLinks(store, pendingLinks, oldLinkTargets, oldWikilinksByBlock, artifactId);

  return { reconciled: true, ...stats, linkResolution };
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
      description: "Replace an existing node's text/children (and, for a heading target, its title) from piped markdown.",
      usage: 'cat content.md | kg:update -- [--base <path>] <path> [--text-only]',
      args: [
        { name: '<path>', description: "Existing Block/Artifact node to update. If it's a heading, piping a leading heading line (e.g. '## New Title') also renames it — '#' depth must match; a plain paragraph leaves the title untouched." },
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
  const links = result.linkResolution;
  if (links.resolved + links.dangling > 0) {
    console.log(`[ApeironNgn kg:update]   Links: ${links.resolved} resolved, ${links.dangling} dangling, ${links.changed} changed.`);
  }
}

if (process.argv[1]?.endsWith('kgUpdate.ts')) {
  main().catch((err) => {
    console.error('[ApeironNgn kg:update] Failed:', err.message || err);
    process.exit(1);
  });
}
