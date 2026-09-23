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
 *
 * Promotion (Aperas-crud-design.md §4.1/§6): `target.holder` is unconditionally cleared before
 * either mode runs, so piping real content onto a placeholder Block/Artifact promotes it in the
 * same motion — no separate verb needed, and a no-op on an already-real target. A bare Folder
 * *holder*'s own promote channel is still `kg:insert`'s anchor-less move mode, not this.
 *
 * A `FolderNode` target (discussion/core.md's 2026-09-20 frontmatter-as-props redesign) is a
 * genuinely separate, much narrower path (`runFolderUpdate` below): frontmatter-only, since a
 * folder's README body is edited on disk and re-ingested, never through this command — reusing all
 * the reconciliation machinery above for a folder makes no sense, since `FolderNode` isn't a
 * `BlockNode` at all (no `.type`, no heading/paragraph shape). Piping any real body content at a
 * FolderNode target is refused outright rather than silently dropped.
 *
 * An `ArtifactNode` target additionally has its own piped `frontmatter` applied to its
 * `description`/`lang`/etc. (`applyArtifactFrontmatter` below) — orthogonal to, and alongside,
 * whichever body-update mode ran.
 */

import type { Store } from 'oxigraph';
import { resolveDeepPath } from '@aperas/core/apeironNgn/resolve';
import {
  wrap, applyTombstone, rejectSlugPathCollisions,
  collectLinkTargetsByBlock, collectOldWikilinksByBlock, findEnclosingArtifactId,
} from '@aperas/core/apeironNgn/node';
import type { BlockNode, FolderNode, TreeNode, ApeironNode } from '@aperas/core/apeironNgn/node';
import { nodeKindFromId } from '@aperas/core/apeironNgn/vocab';
import { parseMarkdownTree, headingDepth, parseFrontmatterFields, collectLinkCodesFromText, type ParsedBlockNode, type LinkOccurrence } from '@aperas/core/astParser';
import { extractLinkCodes, type PendingLinkCodes } from '@aperas/core/artifacts';
import { reconcileTree } from '@aperas/core/reconcile';
import { resolveBlockLinks, type LinkResolutionStats } from '@aperas/core/apeironNgn/artifacts';
import { carryForwardProp, type PropEntry } from '@aperas/core/props';
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
  if (kind !== 'BlockNode' && kind !== 'ArtifactNode' && kind !== 'FolderNode') {
    throw new Error(`'${req.path}' resolves to a ${kind} — kg:update only targets Block/Artifact/Folder nodes.`);
  }
  if (kind === 'FolderNode') return runFolderUpdate(store, targetId, req.markdown);
  const target = wrap(store, targetId) as unknown as BlockNode;

  const { root, frontmatter } = parseMarkdownTree(req.markdown);
  const parsedChildren = root.children ?? [];
  const firstChild = parsedChildren[0];

  let text: string | undefined;
  let title: string | undefined;
  let props: ParsedBlockNode['props'];
  let overflow: ParsedBlockNode[];
  // True only for the single-parsed-item branch below (never for a real heading retitle, which
  // has its own unconditional `props = firstChild.props` already) — gates whether `props` (built
  // there from `firstChild`'s own non-ordering props, merged with `target`'s preserved
  // `orderedList`/`startIndex`) is actually used downstream, instead of `oldShape.props` verbatim.
  let singleItemAdopt = false;
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
  } else if (parsedChildren.length === 1) {
    // A single parsed item — of *any* type, not only a bare paragraph — adopts its full state
    // onto `target`: text, non-ordering props (`checked` in particular), its own nested children
    // (a list directly following a paragraph, or nested under a listItem, already adopts into it
    // — astParser.ts's own adoption rule, §8 — regardless of container, which is why this stays a
    // single parsed child even when it carries a whole sub-list). Generalizes the old
    // paragraph-only special case (discussion/aperas-skill.md's v2.10 delta): that left `checked`,
    // and a genuinely-empty-text-with-children push, with no safe input at all — piping a bullet
    // marker at a *paragraph*-only target fell into the `else` branch below and wiped `target`'s
    // own text as an unintended side effect, confirmed live pushing a checkbox toggle.
    text = firstChild.text;
    overflow = firstChild.children ?? [];
    rootLinkCodes = firstChild.linkCodes;
    // A non-heading target's own title is the lead-in term `astParser.ts` just re-derived from
    // this exact text (`extractLeadInTitle`, already run during `parseMarkdownTree` above) — read
    // it the same way the heading branch above reads its own fresh title, instead of leaving
    // `title` `undefined` here and letting `newShape.title = title ?? target.title` carry the old
    // one forward unconditionally forever, even once the text no longer has that lead-in at all
    // (issues/linking.md's "`aperas update` never re-derives a non-heading block's title" — also
    // confirmed live to tombstone real children when the operator assumes a leaf's `--text` output
    // is its complete content and re-pushes it expecting a title refresh). Skipped when `target`
    // itself is a heading: `firstChild` there is the heading's *adopted leading paragraph*, a
    // different piece of text from the heading's own title, which only the branch above (a real
    // piped heading line) may touch. Also skipped for an `ArtifactNode` target: its `title` is the
    // file basename set once at track time (`trackFromDisk`), never a function of its own leading-
    // paragraph text the way an ordinary block's lead-in is — confirmed live to corrupt
    // `issues/core.md`'s own title (and with it, its own path resolution — `findChild`'s slug match
    // is title-based) by re-deriving it from whatever paragraph text was pushed to the artifact
    // root's own leading-summary convention every concern doc's `ArtifactNode.text` uses.
    if (target.type !== 'heading' && kind !== 'ArtifactNode') {
      // `extractLeadInTitle` never returns a genuinely absent title — with no lead-in it falls
      // back to a throwaway id minted just for *this one parse* (astParser.ts's own `let title =
      // blockId` default). Adopting that value verbatim would give `target` some other node's
      // disposable, unrelated id as its title (confirmed live: a title-losing edit was silently
      // doing exactly this before this check existed) — title is a derived field here, so once
      // nothing can be derived the right fallback is `target`'s *own* id, the same
      // "degrades to an id-fallback title" convention `retype` already documents, not a frozen
      // copy of whatever the title happened to be before this edit.
      title = firstChild.title === firstChild.blockId ? target.key : firstChild.title;
    }
    // `orderedList`/`startIndex` are never adopted here, no matter which marker the piped item
    // used: a lone parsed item always looks like the first item of its own list (astParser.ts's
    // own convention for a standalone parse), so adopting them verbatim would silently turn an
    // existing plain-continuation item into a spurious run-leader mid-run, splitting the render
    // (discussion/aperas-skill.md's v2.10 delta). Every *other* existing prop — `checked` above
    // all — is preserved whenever the parse doesn't itself address it: a bare-text edit (no
    // bullet marker in the input at all, `firstChild.type !== 'listItem'`) parses to a plain
    // paragraph with no `checked` key of its own, and naively adopting `firstChild.props`
    // wholesale would silently clear an existing checkbox's state on every ordinary text-only
    // edit (confirmed live: a follow-up bare-text update wiped a checkbox this same fix had just
    // set). A bullet with no `[x]`/`[ ]` is different: choosing list syntax at all is itself the
    // caller's deliberate statement about checkbox state, so `checked` is always addressed for a
    // `listItem` `firstChild`, whether or not that syntax happened to include a checkbox marker —
    // a bare `- text` (list syntax, no marker) clears an existing checkbox rather than preserving
    // it, distinct from bare text (no list syntax at all), which never touches it.
    const targetProps = (target.props as unknown as PropEntry[] | undefined) ?? [];
    const firstChildProps = (firstChild.props as unknown as PropEntry[] | undefined) ?? [];
    const firstChildKeys = new Set(firstChildProps.map((p) => p.key));
    if (firstChild.type === 'listItem') firstChildKeys.add('checked');
    const preserved = targetProps.filter(
      (p) => p.key === 'orderedList' || p.key === 'startIndex' || !firstChildKeys.has(p.key)
    );
    const adopted = firstChildProps.filter((p) => p.key !== 'orderedList' && p.key !== 'startIndex');
    const mergedProps = [...adopted, ...preserved];
    props = mergedProps.length > 0 ? (mergedProps as unknown as ParsedBlockNode['props']) : undefined;
    singleItemAdopt = true;
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
  // Recursive (the default) only for the reconcile branch below, whose own `pendingLinks` is built
  // from `extractLinkCodes(finalTree)` over `target`'s *entire* post-reconciliation subtree — the
  // same "both maps cover the same population" invariant `collectOldWikilinksByBlock`'s own doc
  // comment names. `--text-only` mode's `pendingLinks` covers only `target` itself plus the freshly
  // parsed `overflow` (brand-new blocks with no "old" wikilinks to speak of) — never `target`'s real
  // *existing* children, which stay completely untouched. Recursing into them here anyway is exactly
  // the bug `repairLinkIntegrity` had (`issues/linking.md`'s Open Issues (3)): `resolveBlockLinks`'s
  // key-union would reprocess each with zero pending codes and wipe its real `.links` to empty.
  // Confirmed live twice on real headings with real children before this fix.
  collectOldWikilinksByBlock(target, oldWikilinksByBlock, !req.textOnly);
  const artifactId = findEnclosingArtifactId(target) ?? undefined;

  // A fresh tree-anchor/props only ever arrives alongside a genuine heading retitle (the piped
  // input's own leading heading line, matched depth and all) — the non-heading title re-derivation
  // above supplies a `title` too, but never a `props`, and must never touch the target's existing
  // ones (a listItem's `orderedList`/`startIndex`, say) just because its title happened to change.
  const retitling = target.type === 'heading' && firstChild?.type === 'heading';

  // Full-slug-path collision rejection (design/linking.md's Full-Path Collisions) — relevant
  // whenever `title` actually changed, heading retitle or non-heading re-derivation alike:
  // `toPath()` walks every `BlockNode` ancestor's own `title`, not only headings. An `ArtifactNode`'s
  // own title never contributes to any `toPath()` (see `toPath()`'s own kind check), so this stays
  // a no-op there regardless. `target.parent` is unchanged by a rename — only `target`'s own final
  // path segment is — so the parent's current `toPath()` is the right prefix to check the renamed
  // title against. Covers the renamed node itself, not the (separately reconciled) `overflow`
  // subtree beneath it — `kg:insert`'s own check is what covers a freshly-introduced multi-level
  // tree.
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
    // `title` updates whenever a fresh one exists (heading retitle or non-heading re-derivation);
    // `props` only during an actual heading retitle or a single-item adopt (`retitling`/
    // `singleItemAdopt`) — a plain multi-item overflow push must never wipe an existing prop (a
    // listItem's `orderedList`/`startIndex`, or `checked`) just because its re-derived title
    // changed too.
    if (title !== undefined) {
      target.title = title;
    }
    if (retitling || singleItemAdopt) {
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
    applyArtifactFrontmatter(kind, target, frontmatter, pendingLinks);
    const linkResolution = resolveBlockLinks(store, pendingLinks, oldLinkTargets, oldWikilinksByBlock, artifactId);
    return { reconciled: false, linkResolution };
  }

  // `props` defaults to `oldShape`'s own (preserving whatever `target` already had, e.g. a
  // heading's tree-anchor, or a listItem's `orderedList`/`startIndex`) unless an actual heading
  // retitle or a single-item adopt (`retitling`/`singleItemAdopt`) explicitly supplied a new value
  // — a plain multi-item overflow push was never asked to touch props, and `carryForwardFields`'s
  // own prop-id-preservation only activates when both sides have props to compare in the first
  // place (leaving it out here, as this used to, silently dropped it).
  const newShape = {
    blockId: target.key,
    type: target.type,
    title: title ?? target.title,
    text,
    children: overflow,
    props: (retitling || singleItemAdopt) ? props : oldShape.props,
    linkCodes: rootLinkCodes,
  };
  const { finalTree, tombstones, stats } = reconcileTree(oldShape, newShape);
  for (const tombstone of tombstones) applyTombstone(store, tombstone);
  // Same extract-before-hydrate ordering as the --text-only branch above — `finalTree` is
  // `newShape`, mutated in place by `reconcileTree` (carried-forward `blockId`s etc.), so it still
  // carries every node's own `linkCodes` from the fresh parse, root included.
  const pendingLinks = extractLinkCodes(finalTree as unknown as ParsedBlockNode);
  target.hydrateFromParsed(finalTree);
  applyArtifactFrontmatter(kind, target, frontmatter, pendingLinks);
  const linkResolution = resolveBlockLinks(store, pendingLinks, oldLinkTargets, oldWikilinksByBlock, artifactId);

  return { reconciled: true, ...stats, linkResolution };
}

/** The piped input's own `frontmatter` (`parseMarkdownTree` already separates it out) applied to an
 *  `ArtifactNode` target's own `description`/`lang`/etc. — a no-op for a `BlockNode` target (only an
 *  artifact/folder root carries frontmatter at all) or when none was piped. One `StringProp` per
 *  key, replacing whatever was there, same `carryForwardProp` id-preservation as
 *  `ArtifactNode.ingestFromDisk` (discussion/core.md's 2026-09-20 redesign) — orthogonal to
 *  `target`'s own body-content update above, so it runs regardless of which mode (`--text-only` or
 *  reconcile) got there. `description`'s own link codes are appended to the caller's `pendingLinks`
 *  (never a separate `resolveBlockLinks` call) under `target`'s own key — safe as the *only* entry
 *  for that key in the ordinary case (a heading/non-paragraph leading child never gives `target`'s
 *  own key a `pendingLinks` entry from body content at all); see `fullIdForKey`'s own doc
 *  comment in `apeironNgn/artifacts.ts` for the matching resolver-side fix this depends on. */
function applyArtifactFrontmatter(kind: string, target: BlockNode, frontmatter: string | undefined, pendingLinks: PendingLinkCodes[]): void {
  if (kind !== 'ArtifactNode' || frontmatter === undefined) return;
  const fields = parseFrontmatterFields(frontmatter);
  const oldProps = target.props as unknown as PropEntry[] | undefined;
  target.props = Object.keys(fields).length > 0
    ? (Object.entries(fields).map(([key, value]) => carryForwardProp(oldProps, key, value)) as unknown as ApeironNode[])
    : undefined;
  const descriptionLinkCodes = collectLinkCodesFromText(fields.description ?? '');
  if (descriptionLinkCodes.length > 0) pendingLinks.push({ blockId: target.key, codes: descriptionLinkCodes });
}

/** `kg:update` on a `FolderNode` target is frontmatter-only — a folder's README *body* is edited on
 *  disk and re-ingested (`kg:ingest`'s FolderNode half), same as always; this only ever touches its
 *  own `description`/`lang`/etc., the same "update as scoped reconciliation" pattern the
 *  Block/Artifact path above already uses, just narrower (discussion/core.md's 2026-09-20
 *  frontmatter-as-props redesign — a `FolderNode` was previously refused outright by `kg:update`).
 *  Piped body content beyond frontmatter is refused rather than silently dropped: this was never
 *  the README-content edit path, and a caller expecting it to be one deserves a clear error, not
 *  quiet data loss. */
function runFolderUpdate(store: Store, targetId: string, markdown: string): UpdateResult {
  const { root, frontmatter } = parseMarkdownTree(markdown);
  if ((root.children ?? []).length > 0) {
    throw new Error(
      `'${targetId}' is a FolderNode — kg:update only edits its frontmatter (description, lang, ...), never its README body. ` +
      'Edit the README.md file on disk and re-ingest instead.'
    );
  }
  if (frontmatter === undefined) {
    throw new Error('No frontmatter found in the piped input — nothing for kg:update to change on a FolderNode target.');
  }
  const target = wrap(store, targetId) as unknown as FolderNode;
  const oldLinkTargets = new Map<string, Set<string>>();
  const oldWikilinksByBlock = new Map<string, Array<{ id: string; target: string; positions: number[] }>>();
  collectLinkTargetsByBlock(target, oldLinkTargets);
  collectOldWikilinksByBlock(target, oldWikilinksByBlock, false);

  const fields = parseFrontmatterFields(frontmatter);
  const oldProps = target.props as unknown as PropEntry[] | undefined;
  target.props = Object.keys(fields).length > 0
    ? (Object.entries(fields).map(([key, value]) => carryForwardProp(oldProps, key, value)) as unknown as ApeironNode[])
    : undefined;

  const descriptionLinkCodes = collectLinkCodesFromText(fields.description ?? '');
  const pendingLinks: PendingLinkCodes[] = descriptionLinkCodes.length > 0
    ? [{ blockId: target.key, codes: descriptionLinkCodes }]
    : [];
  const linkResolution = resolveBlockLinks(store, pendingLinks, oldLinkTargets, oldWikilinksByBlock);
  return { reconciled: false, linkResolution };
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
    throw new Error('No markdown was piped to stdin — did you forget to pipe content? (e.g. `cat file.md | npm run aperas update ...`)');
  }
  return content;
}

export async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (wantsHelp(rawArgs)) {
    printHelp({
      description: "Replace an existing node's text/children (and, for a heading target, its title) from piped markdown.",
      usage: 'cat content.md | aperas update [--base <path>] <path> [--text-only]',
      args: [
        { name: '<path>', description: "Existing Block/Artifact/Folder node to update. A FolderNode target is frontmatter-only (description, lang, ...) — its README body is edited on disk and re-ingested instead. For a Block/Artifact target: if it's a heading, piping a leading heading line (e.g. '## New Title') also renames it — '#' depth must match; a plain paragraph leaves the title untouched. Piped frontmatter is also applied when the target is an ArtifactNode. Unconditionally clears the target's own '.holder' flag, promoting a placeholder Block/Artifact the same way real content landing on it always would — a no-op if it was already real." },
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
    console.error('Usage: cat content.md | aperas update [--base <path>] <path> [--text-only]');
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
