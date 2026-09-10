/**
 * ApeironNgn implementation of `kg:track`/`kg:ingest`'s artifact half (Aperas-apeironngn-design.md
 * §4 rollout — "the big one"). §4 rollout step 3 folded the per-node work onto `ArtifactNode`
 * (`node.ts`'s `trackFromDisk`/`ingestFromDisk`) — what's left here is the store-wide search/sweep
 * that has no single node to be `this` until *after* it runs: finding an artifact by path,
 * detecting renames across the whole tracked set, and resolving each ingested block's wikilinks
 * (a multi-block sweep, run once per artifact after its own tree write completes).
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from 'oxigraph';
import { wrap, tombstoneLiveSubtree } from './node';
import type { ArtifactNode, BlockNode, TreeNode, Link, ApeironNode, IngestResult } from './node';
import { predIri, encodeLiteral, idFromNodeIri, nodeKindFromId } from './vocab';
import { allIdsOfKind } from './dehydrate';
import { resolveDeepPathDetail } from './resolveCreate';
import { generateNodeId } from '../snowflake';
import { listArtifactFiles, getArtifactsDir, expandArtifactPaths, type PendingLinkCodes } from '../artifacts';
import { parseMarkdownTree, extractAbstract, stripInlineAnchors, WIKILINK_PREDICATE, HEADING_TREE_ANCHOR_PROP } from '../astParser';
import { getProp, getProps, type PropEntry } from '../props';
import { matchLeftoverByAbstract } from '../reconcile';
import { relativeToCanonicalArtifactPath } from '../leadingPart';

const APERAS_TREE_PREFIX = 'aperas://tree/';
const APERAS_ID_PREFIX = 'aperas://id/';

/** Prop key an artifact's own currently-unresolved link codes are stashed under, one entry per
 *  distinct code (`getProps`'s plural form) — `retryDanglingRefs` below is the sole reader, retrying
 *  each on a later ingestion elsewhere in the corpus in case a matching target has since appeared.
 *  Rewritten wholesale by `resolveBlockLinks` on every ingestion (the complete current dangling set,
 *  same "rebuilt from the fresh parse every time" spirit `reconcile.ts` already applies to props),
 *  never appended to — an old entry disappears the moment its code either resolves or is edited out
 *  of the text entirely. */
const DANGLING_REF_PROP = 'danglingRef';

/** Whether `code` is a `requiresAnchorMatch`-style bare `#fragment`/`path#fragment` reference,
 *  re-derived from the code string alone — the same classification `astParser.ts`'s
 *  `collectLinkCodes` used when it first flagged the occurrence, needed again here because
 *  `retryDanglingRefs` only has the bare code string to go on (a `LinkOccurrence`'s own
 *  `requiresAnchorMatch` flag isn't persisted, just the code). */
function isFragmentForm(code: string): boolean {
  return !code.startsWith(APERAS_TREE_PREFIX) && !code.startsWith(APERAS_ID_PREFIX) && code.includes('#');
}

/** The per-code resolution dispatch shared by `resolveBlockLinks`'s own pass and
 *  `retryDanglingRefs`'s later retry of a stashed dangling code — same two branches either way:
 *  a fragment-form code goes through the anchor-matching gate (`resolveFragmentCode`), anything
 *  else through the ordinary deep-path grammar. `basePath`/`artifactPath` are usually the same
 *  value at a retry site (only the referring *artifact's* own path is kept, not which specific
 *  block within it held the code) — sound for every code this corpus actually writes (always an
 *  absolute `/`-rooted path, or `aperas://`, neither of which ever consults `base` at all) and for
 *  every fragment-form code (which only ever needs the artifact's own path); a hand-authored
 *  *relative*, non-absolute `[[code]]`/`aperas://tree/` form relying on one specific block's own
 *  nested position as its base is the one shape this doesn't reproduce exactly on retry — not used
 *  anywhere in the corpus today. */
function resolveOneCode(store: Store, code: string, basePath: string | null, artifactPath: string | null): string | null {
  if (isFragmentForm(code)) return resolveFragmentCode(store, code, artifactPath);
  return resolveDeepPathDetail(store, code, {
    base: basePath ?? undefined,
    createHolder: true,
    titles: titlesFromCode(code),
  })?.id ?? null;
}

/** `resolveBlockLinks`'s `titles` computation (below) is a separate, non-resolution pass over
 *  `code` for `--create-holder`'s placeholder-naming — it isn't scheme-aware the way
 *  `resolveDeepPathDetail` itself is, so an `aperas://tree/`/`aperas://id/` prefix has to be
 *  stripped (or, for an id code, skipped entirely — it has zero name-tokens) before splitting, or
 *  the scheme markers themselves get counted as bogus extra segments (AperasKG/artifacts/planning/
 *  linking.md's "Required companion fix"). */
function titlesFromCode(code: string): string[] {
  if (code.startsWith(APERAS_ID_PREFIX)) return [];
  const stripped = code.startsWith(APERAS_TREE_PREFIX) ? code.slice(APERAS_TREE_PREFIX.length) : code;
  return stripped.split('/').filter((s) => s.length > 0 && s !== '.' && s !== '..');
}

/** Walks `.parent` up from `block` to its owning `ArtifactNode`/`FolderNode`, returning that node's
 *  own `path` — deliberately *not* `block.toPath()`, which appends every intervening heading's own
 *  slug segment too (needed for slug-path addressing, wrong here): resolving a compatible-context
 *  fragment link's relative file-path part (`leadingPart.ts`) is anchored to the *artifact's* own
 *  location on disk, regardless of which heading within it the link happens to sit in. */
function artifactPathOfBlock(block: BlockNode): string | null {
  let current: TreeNode = block;
  for (;;) {
    const kind = nodeKindFromId(current.id);
    if (kind === 'ArtifactNode' || kind === 'FolderNode') return (current as unknown as { path?: string }).path ?? null;
    if (kind !== 'BlockNode') return null;
    const parent = (current as unknown as BlockNode).parent;
    if (!parent) return null;
    current = parent;
  }
}

/** The Anchor-Matching Requirement (AperasKG/artifacts/design/linking.md's Topology section):
 *  `candidateId` was found by the ordinary name-token tree-walk (matching `fragment` against
 *  *current* titles, live), which only makes it a *candidate* — accepted only if it also carries a
 *  literal, matching `class="aperas-anchor"` tag, distinguishing a deliberate internal reference
 *  from an ordinary, unrelated same-page anchor link that happens to share the same fragment shape.
 *  A heading's tree-anchor(s) are stashed in a prop at parse time (`astParser.ts`'s
 *  `stripTrailingHeadingAnchors`); a list item/paragraph has no such prop, so its own `text` is
 *  scanned literally instead — either way, only a *tree*-anchor counts here (an `id/...` fragment
 *  never reaches this check at all — see `resolveFragmentCode` below). */
function candidateCarriesAnchor(store: Store, candidateId: string, fragment: string): boolean {
  if (nodeKindFromId(candidateId) !== 'BlockNode') return false;
  const node = wrap(store, candidateId) as unknown as BlockNode;
  const marker = `name='${fragment}' class='aperas-anchor`;
  if (node.type === 'heading') {
    // `getProp` (props.ts) is typed against the pure-parser's plain `PropEntry[]` shape; a live,
    // store-backed node's own `.props` getter returns the same shape at runtime (`project.ts`'s
    // `withFrontmatter` already relies on this for `ArtifactNode`) but under a looser declared
    // type — same `as any` project.ts itself uses (its own `getProp` callers are typed `node: any`).
    return (getProp(node as any, HEADING_TREE_ANCHOR_PROP) ?? '').includes(marker);
  }
  return (node.text ?? '').includes(marker);
}

/**
 * Resolves a `requiresAnchorMatch` code (`astParser.ts`'s `LinkOccurrence`) — a bare `#fragment` or
 * `path#fragment` link, syntactically identical to an ordinary anchor link until proven otherwise.
 * An `id/<ID>` fragment reroutes straight to the direct-id tier, ignoring the file-path part
 * entirely (unambiguous by construction, so no anchor-matching gate applies). Any other fragment:
 * the leading file-path part (empty for a same-document link) is resolved to a concrete artifact
 * path via `leadingPart.ts`'s relative→canonical direction — ordinary OS-relative arithmetic, not
 * `resolveCreate.ts`'s own uniform per-segment `..` (a different counting rule; see `leadingPart.ts`'s
 * own doc comment) — then the fragment's own slug segments are walked from there with
 * `createHolder: false` (a coincidental, non-internal anchor-link match must never mint placeholder
 * structure), and the result must pass `candidateCarriesAnchor` to be accepted at all.
 */
function resolveFragmentCode(store: Store, code: string, currentArtifactPath: string | null): string | null {
  const hashIndex = code.indexOf('#');
  const filePath = code.slice(0, hashIndex);
  const fragment = code.slice(hashIndex + 1);

  if (fragment.startsWith('id/')) {
    return resolveDeepPathDetail(store, `${APERAS_ID_PREFIX}${fragment.slice(3)}`)?.id ?? null;
  }

  if (currentArtifactPath === null) return null;
  const baseArtifactPath = relativeToCanonicalArtifactPath(currentArtifactPath, filePath);
  if (baseArtifactPath === null || fragment === '') return null;

  let candidateId: string | null;
  try {
    candidateId = resolveDeepPathDetail(store, fragment, { base: baseArtifactPath, createHolder: false })?.id ?? null;
  } catch {
    // `findChild`'s own ambiguity throw — an unrelated, coincidental multi-match is just "no
    // confident candidate" for a link that was never confirmed to be an internal reference at all.
    return null;
  }
  return candidateId && candidateCarriesAnchor(store, candidateId, fragment) ? candidateId : null;
}

/** A live (non-tombstoned) node of `kind` at `path` — `path` is unique per kind by construction
 *  (a filesystem path is either a file or a directory, never both), but a tombstoned entry keeps
 *  its old `path` value forever, so a plain `path`-literal lookup alone (`tree.ts`'s
 *  `findByExactPath`) isn't enough once a path has been reused after a rename/removal. */
function findLiveByKindAndPath(store: Store, kind: string, path: string): string | null {
  const matches = store
    .match(null, predIri('path'), encodeLiteral(path), null)
    .map((m) => idFromNodeIri(String(m.subject.value)))
    .filter((id) => nodeKindFromId(id) === kind);
  return matches.find((id) => !(wrap(store, id) as unknown as ArtifactNode).tombstonedAt) ?? null;
}

export function findLiveArtifactByPath(store: Store, path: string): string | null {
  return findLiveByKindAndPath(store, 'ArtifactNode', path);
}

function allLiveIdsOfKind(store: Store, kind: string): string[] {
  return allIdsOfKind(store, kind).filter((id) => !(wrap(store, id) as unknown as ArtifactNode).tombstonedAt);
}

export interface TrackResult {
  tracked: boolean;
}

/** Registers or refreshes the lightweight ArtifactNode for a single file, minting a fresh one if
 *  none is tracked yet — `ArtifactNode.trackFromDisk` (`node.ts`) handles both cases uniformly now
 *  that there's no separate `artifactId` to mint (a brand-new node's `fileHash` just reads
 *  `undefined`, so it's unconditionally "changed"). */
export function trackArtifact(store: Store, artifactPath: string): TrackResult {
  const existingId = findLiveArtifactByPath(store, artifactPath);
  const node = (existingId ? wrap(store, existingId) : wrap(store, `ArtifactNode:${generateNodeId()}`)) as unknown as ArtifactNode;
  return node.trackFromDisk(artifactPath);
}

export interface ArtifactSweepStats {
  renamed: number;
  removed: number;
}

/** Registers/refreshes ArtifactNodes for every file under `AperasKG/artifacts/`, first detecting
 *  renames/moves across the whole tracked set via `reconcile.ts`'s Gestalt matcher (same abstract-
 *  text similarity `kg:ingest`'s own reconciliation uses) — a rename mutates the existing node in
 *  place (`trackFromDisk`); an unmatched removal is tombstoned.
 *
 *  `force` (Aperas-crud-design.md §14): same held-back-by-default gate as `ingestFolderTree`'s own
 *  removal step — a real `ArtifactNode` whose file disappeared from disk is left alone (not
 *  tombstoned) and its path reported via `pendingRemovals` instead, unless `force` is true. Renames
 *  are unaffected — only the removal step itself is gated. */
export function trackAllArtifacts(store: Store, force: boolean = false): { results: TrackResult[]; sweep: ArtifactSweepStats; pendingRemovals: string[] } {
  const files = listArtifactFiles();
  const diskSet = new Set(files);

  const liveIds = allLiveIdsOfKind(store, 'ArtifactNode');
  const existingByPath = new Map(liveIds.map((id) => [(wrap(store, id) as unknown as ArtifactNode).path as string, id]));

  const diskOnlyPaths = files.filter((f) => !existingByPath.has(f));
  // Aperas-crud-design.md §6: same fix as ingestFolderTree's own dbOnlyPaths — a holder-flagged
  // ArtifactNode not found on disk is never evidence of removal, so it's excluded here before it
  // can ever reach `removedCandidates` below and get tombstoned by this sweep.
  const dbOnlyIds = liveIds.filter((id) => {
    const node = wrap(store, id) as unknown as ArtifactNode;
    return !diskSet.has(node.path as string) && !node.holder;
  });

  const artifactsDir = getArtifactsDir();
  const addedCandidates = diskOnlyPaths.map((path) => {
    const content = readFileSync(join(artifactsDir, path), 'utf-8');
    return { key: extractAbstract(parseMarkdownTree(content).root), item: path };
  });
  const removedCandidates = dbOnlyIds.map((id) => ({ key: ((wrap(store, id) as unknown as ArtifactNode).text as string) ?? '', item: id }));

  const { matched, stillRemoved } = matchLeftoverByAbstract(removedCandidates, addedCandidates);

  const sweep: ArtifactSweepStats = { renamed: 0, removed: 0 };
  const pendingRemovals: string[] = [];

  for (const { old: oldId, new: newPath } of matched as Array<{ old: string; new: string }>) {
    const node = wrap(store, oldId) as unknown as ArtifactNode;
    console.log(`[ApeironNgn Artifacts] Detected rename '${node.path}' -> '${newPath}'`);
    node.trackFromDisk(newPath);
    sweep.renamed++;
  }

  for (const id of stillRemoved as string[]) {
    const node = wrap(store, id) as unknown as ArtifactNode;
    if (!force) {
      console.log(`[ApeironNgn Artifacts] '${node.path}' would be tombstoned as removed — held back pending confirmation (re-run with --force to apply).`);
      pendingRemovals.push(node.path as string);
      continue;
    }
    console.log(`[ApeironNgn Artifacts] Tombstoning removed artifact '${node.path}'`);
    tombstoneLiveSubtree(node, new Date().toISOString());
    sweep.removed++;
  }

  const renamedIntoPaths = new Set((matched as Array<{ new: string }>).map((m) => m.new));
  const results: TrackResult[] = [];
  for (const file of files) {
    if (renamedIntoPaths.has(file)) continue; // already fully handled by the rename write above
    results.push(trackArtifact(store, file));
  }

  return { results, sweep, pendingRemovals };
}

/** Order-independent match by exact key equality, no positional requirement — see
 *  `trackArtifactsScoped`'s own doc comment for why this exists instead of reusing
 *  `matchLeftoverByAbstract`. A key occurring more than once in either list is left unmatched
 *  (nothing anchors which occurrence is "the" one), same "decline rather than guess" spirit as
 *  `dropAmbiguousSingletons`, just without the recursion that makes that algorithm sensitive to
 *  where in each array a value happens to sit. */
function matchByExactKey<T>(
  removed: Array<{ key: string; item: T }>,
  added: Array<{ key: string; item: T }>
): { matched: Array<{ old: T; new: T }> } {
  const countOf = (list: Array<{ key: string }>, key: string) => list.filter((x) => x.key === key).length;
  const matched: Array<{ old: T; new: T }> = [];
  for (const r of removed) {
    if (countOf(removed, r.key) !== 1) continue;
    const onlyAdded = added.filter((a) => a.key === r.key);
    if (onlyAdded.length === 1) matched.push({ old: r.item, new: onlyAdded[0].item });
  }
  return { matched };
}

/** Scoped counterpart to `trackAllArtifacts`'s rename detection, for `kg:track`/`kg:ingest`'s
 *  explicit-`<path>...` branch (`runTrack`, kgTrack.ts): the "old docs migrate one at a time"
 *  plan (AperasKG/artifacts/discussion/cli.md) means a real corpus-wide sweep can't be the answer
 *  here — `trackAllArtifacts`'s own `listArtifactFiles()` walks *everything* under `artifacts/`,
 *  `archive/` included, which is exactly what turned an ordinary rename attempt into a hard,
 *  unrelated failure (a pre-existing slug-path collision inside `archive/Aperas-dev-status.md`).
 *
 *  This never lists a directory at all. The "added" side is only ever the paths the caller
 *  actually gave (already known — no reason to discover more), filtered to ones with no live
 *  ArtifactNode yet; the "removed" side is only already-*tracked* ArtifactNodes whose own recorded
 *  `path` no longer exists on disk (a cheap `existsSync` per already-known path, not a directory
 *  listing) — so untouched, never-yet-tracked territory like `archive/` can never enter either
 *  side of the match, no matter how large it is.
 *
 *  Deliberately does *not* reuse `trackAllArtifacts`'s `matchLeftoverByAbstract` (the Gestalt/
 *  Ratcliff-Obershelp recursion `reconcile.ts` uses everywhere else): that algorithm is
 *  position-sensitive by construction — great for reconciling siblings that share a rough common
 *  order across an edit, wrong for an unordered bag of whole-artifact identities scattered across
 *  different concern folders with no such order at all. Confirmed live: batch-renaming 5 concern
 *  docs at once (their "removed" order being store-iteration order, their "added" order being
 *  argv order) matched only 2 of the 4 pairs that were genuinely exact-content matches — the other
 *  2 sat in a recursive quadrant one of the position-sensitive splits had already discarded, not
 *  because they were ambiguous. `matchByExactKey` below keeps the same "decline rather than guess"
 *  principle (a key occurring more than once on either side is left unmatched) but has no
 *  positional requirement at all — every occurrence of a key is found regardless of where it sits
 *  in either array, so this can't strand a real match the way the recursion can.
 *
 *  Deliberately does not tombstone anything: unlike `trackAllArtifacts`, an unmatched "removed"
 *  candidate here just stays exactly as before (still live, still pointing at its old, now-missing
 *  path) rather than being tombstoned — a scoped call only ever knows about the path(s) it was
 *  given, never enough context to be sure nothing else refers to what's now missing. Removal stays
 *  the full sweep's own decision to make, once that path is safe to run again. */
export function trackArtifactsScoped(store: Store, paths: string[]): { results: TrackResult[]; sweep: ArtifactSweepStats } {
  const artifactsDir = getArtifactsDir();
  const newPaths = paths.filter((p) => !findLiveArtifactByPath(store, p));

  const addedCandidates = newPaths.map((path) => {
    const content = readFileSync(join(artifactsDir, path), 'utf-8');
    return { key: extractAbstract(parseMarkdownTree(content).root), item: path };
  });
  const removedCandidates = allLiveIdsOfKind(store, 'ArtifactNode')
    .filter((id) => {
      const node = wrap(store, id) as unknown as ArtifactNode;
      return !node.holder && !existsSync(join(artifactsDir, node.path as string));
    })
    .map((id) => ({ key: stripInlineAnchors(((wrap(store, id) as unknown as ArtifactNode).text as string) ?? ''), item: id }));

  const { matched } = matchByExactKey(removedCandidates, addedCandidates);

  const sweep: ArtifactSweepStats = { renamed: 0, removed: 0 };
  const renamedIntoPaths = new Set<string>();
  for (const { old: oldId, new: newPath } of matched as Array<{ old: string; new: string }>) {
    const node = wrap(store, oldId) as unknown as ArtifactNode;
    console.log(`[ApeironNgn Artifacts] Detected rename '${node.path}' -> '${newPath}' (scoped)`);
    node.trackFromDisk(newPath);
    sweep.renamed++;
    renamedIntoPaths.add(newPath);
  }

  const results = paths.map((p) => (renamedIntoPaths.has(p) ? { tracked: true } : trackArtifact(store, p)));
  return { results, sweep };
}

/** Whether a block's resolved link outcome actually differs — this is *not* the same question as
 *  "did its text change" (`reconcile.ts`'s own `changed`): the same `[[wikilink]]` code can
 *  resolve differently across two separate ingestions purely because the *target*'s existence
 *  changed elsewhere in the graph in between (a forward reference that was dangling now resolves,
 *  or vice versa) — reconciling this artifact's own tree can never see that, since it's a property
 *  of the rest of the graph, not of this artifact's content. */
function targetSetsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export interface LinkResolutionStats {
  /** Total `[[wikilink]]` codes across every pending block that resolved to a live target. */
  resolved: number;
  /** Total codes that didn't resolve to anything (logged individually as they're hit). */
  dangling: number;
  /** Blocks whose resolved target *set* differs from before this ingestion — the gained/lost
   *  distinction `reconciliation`'s own `changed` can't make, reported as its own line rather than
   *  folded into that count (Aperas-apeironngn-design.md's ingest rollout notes — a link's
   *  resolution outcome and a block's own authored content are orthogonal facts). */
  changed: number;
}

/** Whether two position lists are the same occurrence-for-occurrence, not just the same set —
 *  purely a "does the stored `props` need rewriting at all" check, *not* an identity-match
 *  condition (`resolveBlockLinks` matches wikilink `Link` identity on `target` alone; see its own
 *  doc comment for why). Order-sensitive rather than set-equality on purpose: a target mentioned
 *  twice, with its two occurrences having swapped order between ingestions, is still a real change
 *  to what the `Link`'s `position` props should say, even though the target — the identity key —
 *  hasn't moved. */
function positionsEqual(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Resolves each block's raw `linkCodes` into real `Link` subdocuments, run *after* the tree's own
 * write (the implicit `[[wikilink]]` base needs an already-persisted `.parent` chain) — a
 * multi-block sweep over the union of every block with pending codes *and* every block that had
 * wikilink `Link`s before this ingestion (`oldWikilinksByBlock`) — a block whose `[[wikilink]]`s
 * were all removed has no entry in `pending` at all (`extractLinkCodes` only records blocks with at
 * least one code), so it would never get its now-stale `Link`s cleaned up if the sweep only walked
 * `pending`. `oldLinkTargets` (`ingestFromDisk`'s own doc comment) is this same artifact's per-block
 * resolved target sets from *before* this ingestion — diffed against each block's freshly-resolved
 * set here to compute `changed`, the one comparison only possible at this point in the pipeline
 * (not during reconciliation, before any of this ran).
 *
 * One `Link` per distinct target per block, not per raw occurrence (Aperas-apeironngn-design.md §4
 * Step 8). `oldWikilinksByBlock` (id/target/positions, captured by `ingestFromDisk` before
 * `hydrateFromParsed` touched anything) is what makes a wikilink `Link`'s identity stable across a
 * re-ingestion that doesn't actually change it (§5's "tractable half" of the Link-tombstone open
 * question): a freshly-resolved target reuses an old `Link`'s id whenever some old entry names the
 * *same target* — `target` is the real identity key for a wikilink edge, not the position list, so
 * matching is on target alone. `position` drifting (an edit earlier in the same block's text shifts
 * every later occurrence's offset, with no change to the wikilink itself) is deliberately *not*
 * grounds to mint a fresh `Link` — a matched `Link`'s `props` are instead rewritten in place to the
 * fresh position list when they differ, keeping its id (and anything referencing it, e.g.
 * `TreeView.unfolds`) stable. A target with no old match at all mints a fresh `Link`. `block.links`
 * is written exactly once at the end with the full surviving set (manual `kg:link`s untouched,
 * wikilink `Link`s either reused-and-repositioned or freshly minted) — `writeField`'s own embed-diff
 * cleanup deletes whatever old wikilink `Link` isn't in that final set, i.e. one whose target
 * disappeared from this block's text entirely.
 */
export function resolveBlockLinks(
  store: Store,
  pending: PendingLinkCodes[],
  oldLinkTargets: Map<string, Set<string>> = new Map(),
  oldWikilinksByBlock: Map<string, Array<{ id: string; target: string; positions: number[] }>> = new Map(),
  artifactId?: string
): LinkResolutionStats {
  let resolved = 0;
  let dangling = 0;
  let changed = 0;
  const danglingCodes = new Set<string>();
  const codesByBlock = new Map(pending.map((p) => [p.blockId, p.codes]));
  const blockIds = new Set([...codesByBlock.keys(), ...oldWikilinksByBlock.keys()]);
  for (const blockId of blockIds) {
    const codes = codesByBlock.get(blockId) ?? [];
    const fullId = `BlockNode:${blockId}`;
    const block = wrap(store, fullId) as unknown as BlockNode;
    const basePath = block.toPath();
    const artifactPath = artifactPathOfBlock(block);
    const newTargets = new Set<string>();
    const positionsByTarget = new Map<string, number[]>();
    for (const { code, position, requiresAnchorMatch } of codes) {
      let target: string | null = null;
      try {
        target = resolveOneCode(store, code, basePath, artifactPath);
      } catch (err: any) {
        console.warn(`[ApeironNgn Artifacts] Link target '[[${code}]]' in block ${blockId} failed to resolve: ${err.message || err}`);
      }
      if (target) {
        newTargets.add(target);
        resolved++;
        const positions = positionsByTarget.get(target);
        if (positions) positions.push(position);
        else positionsByTarget.set(target, [position]);
      } else {
        // Stashed for `retryDanglingRefs` either way — a matching target minted elsewhere later
        // should get picked back up regardless of which form the code takes. Only a non-fragment
        // code (an explicit `[[code]]`/`aperas://` reference, always meant as internal) is actually
        // *warned* about here, though: a `#fragment` that never resolves is routine, not dangling —
        // most such links are ordinary anchors, never meant as an internal reference at all (see
        // `LinkOccurrence.requiresAnchorMatch`'s own doc comment) — so it stays silent.
        danglingCodes.add(code);
        if (!requiresAnchorMatch) {
          console.warn(`[ApeironNgn Artifacts] Link target '[[${code}]]' in block ${blockId} didn't resolve to any live node — skipping.`);
          dangling++;
        }
      }
    }

    const oldWikilinks = oldWikilinksByBlock.get(blockId) ?? [];
    const manualLinkIds = ((block.links as unknown as Link[] | undefined) ?? [])
      .filter((l) => l.predicate !== WIKILINK_PREDICATE)
      .map((l) => l.id);
    const wikilinkIds = [...positionsByTarget.entries()].map(([target, positions]) => {
      const reused = oldWikilinks.find((w) => w.target === target);
      if (!reused) return block.mintWikilink(target, positions);
      if (!positionsEqual(reused.positions, positions)) {
        // Same edge (same target), just re-anchored — an unrelated edit earlier in this block's
        // own text shifts every later occurrence's offset without the wikilink itself having
        // "changed" in any sense a reader would recognize, so position drift alone must not churn
        // the `Link`'s id (Aperas-apeironngn-design.md §5 — target is the real identity key here,
        // `position` is metadata *on* that identity, not part of it). Updates in place: `Link.
        // props` is itself `storageKind: 'embed'` (Step 8), so this assignment's own embed-diff
        // (`writeField`) deletes the stale position `StringProp`s and mints the fresh ones, without
        // touching the `Link`'s own id or its `target`/`predicate`.
        (wrap(store, reused.id) as unknown as Link).props = positions.map(
          (position) => ({ '@type': 'StringProp', key: 'position', value: String(position) })
        ) as unknown as ApeironNode[];
      }
      return reused.id;
    });
    const finalLinkIds = [...manualLinkIds, ...wikilinkIds];
    block.links = finalLinkIds.length ? (finalLinkIds as unknown as ApeironNode[]) : undefined;

    if (!targetSetsEqual(oldLinkTargets.get(blockId) ?? new Set(), newTargets)) changed++;
  }

  // Rewrite the artifact's own `danglingRef` props wholesale to exactly the current set — an old
  // entry not reproduced here either resolved just now or its code was edited out of the text
  // entirely, either way no longer worth retrying. `artifactId` is only absent for a caller with no
  // real artifact context (none exist today; kept optional so this stays a pure addition).
  if (artifactId) {
    const artifact = wrap(store, artifactId) as unknown as { props?: ApeironNode[] };
    const survivingProps = ((artifact.props as unknown as PropEntry[] | undefined) ?? []).filter((p) => p.key !== DANGLING_REF_PROP);
    const freshDanglingProps = [...danglingCodes].map((code) => ({ '@type': 'StringProp' as const, key: DANGLING_REF_PROP, value: code }));
    const merged = [...survivingProps, ...freshDanglingProps];
    artifact.props = merged.length ? (merged as unknown as ApeironNode[]) : undefined;
  }

  return { resolved, dangling, changed };
}

/**
 * Retries every currently-stashed `danglingRef` across every live artifact, against the graph's
 * *current* state — the fix for a real gap: an artifact's own text not changing means it never gets
 * re-ingested, so a link it couldn't resolve when it was last ingested stays exactly that stale
 * forever, even after whatever it was looking for genuinely comes into existence somewhere else in
 * the corpus (a new anchor, a renamed heading, an artifact ingested for the first time). Called once
 * per `kg:ingest` invocation (`kgIngest.ts`'s `runIngest`), after the explicitly-requested artifacts
 * and the folder tree are both already settled, so retried resolutions see the fullest possible
 * picture. An artifact with at least one now-resolvable code is force-reingested via
 * `bypassUnchangedCheck` (`node.ts`'s `ingestFromDisk`) — its own text is unchanged, so this isn't a
 * real re-parse, just a fresh run of link resolution against a tree that didn't need rebuilding;
 * `resolveBlockLinks` running again is what actually mints the newly-resolvable `Link`s and clears
 * the now-stale `danglingRef` entries. One pass, not a fixed-point loop to a cascade's own end — a
 * chain of three or more artifacts each newly unblocking the next is vanishingly unlikely in
 * practice, and not worth the added complexity to cover today.
 */
export function retryDanglingRefs(store: Store, force: boolean = false): string[] {
  const reingested: string[] = [];
  for (const id of allLiveIdsOfKind(store, 'ArtifactNode')) {
    const artifact = wrap(store, id) as unknown as ArtifactNode;
    const danglingCodes = getProps(artifact as unknown as any, DANGLING_REF_PROP);
    if (danglingCodes.length === 0) continue;
    const artifactPath = artifact.path as string;
    const hasNewlyResolvable = danglingCodes.some((code) => {
      try {
        return resolveOneCode(store, code, artifactPath, artifactPath) !== null;
      } catch {
        return false;
      }
    });
    if (!hasNewlyResolvable) continue;
    const result = ingestArtifact(store, artifactPath, force, true);
    if (result && !result.pendingConfirmation) reingested.push(artifactPath);
  }
  return reingested;
}

/** AST-parses and commits a tracked artifact into a fractal tree of BlockNodes, delegating the
 *  actual work to `ArtifactNode.ingestFromDisk` (`node.ts`) — this wrapper only finds the node and
 *  resolves the wikilinks it turned up, once its own tree write has finished.
 *
 *  `force` (Aperas-crud-design.md §14): passed straight through to `ingestFromDisk`. When it comes
 *  back with `pendingConfirmation` set, nothing was actually committed — no wikilinks to resolve
 *  either, since `pendingLinks` is empty in that case by construction.
 *
 *  `bypassUnchangedCheck`: passed straight through to `ingestFromDisk` — see its own doc comment
 *  (`node.ts`); `retryDanglingRefs` below is the one caller that ever passes `true`. */
export function ingestArtifact(store: Store, artifactPath: string, force: boolean = false, bypassUnchangedCheck: boolean = false): (IngestResult & { linkResolution: LinkResolutionStats; pendingConfirmation?: Array<{ blockId: string; type?: string; title?: string }> }) | null {
  const existingId = findLiveArtifactByPath(store, artifactPath);
  if (!existingId) {
    throw new Error(`Artifact '${artifactPath}' is not tracked yet — run track first.`);
  }
  const record = wrap(store, existingId) as unknown as ArtifactNode;
  const result = record.ingestFromDisk(force, bypassUnchangedCheck);
  if (!result) return null;
  if (result.pendingConfirmation) {
    return { ...result, linkResolution: { resolved: 0, dangling: 0, changed: 0 } };
  }
  const { pendingLinks, oldLinkTargets, oldWikilinksByBlock, ...rest } = result;
  const linkResolution = resolveBlockLinks(store, pendingLinks, oldLinkTargets, oldWikilinksByBlock, existingId);
  return { ...rest, linkResolution };
}

/** `ingestArtifact`'s own non-null result shape, incl. `linkResolution` — named once here so
 *  `ingestAllArtifacts`/`ingestArtifacts` don't each separately (and driftably) redeclare it. */
type SingleIngestResult = NonNullable<ReturnType<typeof ingestArtifact>>;

/** Ingests every already-tracked artifact whose file hash has changed since its last ingestion.
 *  A file on disk with no `ArtifactNode` yet is skipped (reported via `untracked`, not thrown)
 *  rather than aborting the whole sweep — run `kg:track` (or pass the path directly to
 *  `kg:ingest`) to pick it up. `untracked` is returned rather than logged directly because this
 *  runs inside the shared service process, spawned with `stdio: 'ignore'` (`serviceClient.ts`) —
 *  anything printed here is discarded; only the CLI client that issued the request can surface it. */
export function ingestAllArtifacts(store: Store, force: boolean = false): { ingested: Array<{ path: string } & SingleIngestResult>; untracked: string[] } {
  const files = listArtifactFiles();
  const ingested: Array<{ path: string } & SingleIngestResult> = [];
  const untracked: string[] = [];
  for (const file of files) {
    if (!findLiveArtifactByPath(store, file)) {
      untracked.push(file);
      continue;
    }
    const result = ingestArtifact(store, file, force);
    if (result) ingested.push({ path: file, ...result });
  }
  return { ingested, untracked };
}

/** Ingests exactly the given artifact paths (`expandArtifactPaths` turns any directory among them
 *  into every artifact file under it, recursively — `kg:ingest archive` ingests the whole folder).
 *  Assumes every path is already tracked — `kgIngest.ts`'s `runIngest` tracks each one first (and
 *  rebuilds the folder tree) *before* calling this, specifically so a brand-new file's own folder
 *  is already attached by the time this ingests it and resolves its wikilinks against it. */
export function ingestArtifacts(store: Store, paths: string[], force: boolean = false): Array<{ path: string } & SingleIngestResult> {
  const results: Array<{ path: string } & SingleIngestResult> = [];
  for (const path of expandArtifactPaths(paths)) {
    const result = ingestArtifact(store, path, force);
    if (result) results.push({ path, ...result });
  }
  return results;
}
