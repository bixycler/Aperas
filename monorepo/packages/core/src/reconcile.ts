/**
 * Aperas Reconciliation Matching
 *
 * Re-ingesting an already-ingested artifact used to orphan its entire previous BlockNode
 * tree. This module implements the settled design in
 * AperasKG/artifacts/Aperas-reconciliation-matching-design.md: a Gestalt (Ratcliff/Obershelp)
 * tree diff — the same algorithm behind Python's difflib.SequenceMatcher — chosen over
 * Myers/LCS diffing for "natural" matches over "optimal" edit scripts (see the design doc §1
 * for the full rationale).
 *
 * A note on "changed" as a reporting category (design §5): at block level, Stage A matches on
 * exact key equality ("heading XOR text"), so a matched leaf is *usually* unchanged content by
 * construction — an edited paragraph has a different key and surfaces as removed+added, which is
 * the intended "decline rather than guess" behavior (§2), not a gap. Two things fall outside that
 * key and still need checking explicitly (`pairChanged`) rather than assumed away, each counted as
 * `changed` rather than folded into `matched` (named for "matched, not moved, not changed" — not
 * "unchanged", which reads as a claim the `changed` bucket next to it would contradict): a
 * heading's own adopted leading-paragraph `text` (`astParser.ts`), since a heading's key is
 * `title` alone; and any matched pair's `props` (a listItem's `checked`, a run's `orderedList`/
 * `startIndex`), which sits outside every leaf's key regardless of type — a props-only write was
 * otherwise reported as plain `matched`, indistinguishable from no write at all. "Changed" also
 * applies one level up, at ArtifactNode/FolderNode scope, where matching is by exact-key equality
 * over an unordered whole-corpus bag rather than `matchKeyed`'s order-sensitive recursion (see
 * `matchLeftoverByAbstract` and its callers in artifacts.ts/folders.ts) — a separate mechanism
 * from this one, not the same counter.
 */

import { stripInlineAnchors, headingDepth } from './astParser';

const LEAF_TYPES = new Set(['heading', 'paragraph', 'code', 'thematicBreak', 'html', 'table', 'blockquote']);
const CONTAINER_TYPES = new Set(['list', 'listItem']);

export interface MatchingBlock {
  aStart: number;
  bStart: number;
  length: number;
}

/**
 * Ratcliff/Obershelp: finds the single longest common contiguous run (exact equality, ties
 * broken by earliest position in both sequences), then recurses on the remainders either side
 * of it. Natural-over-optimal by construction — unlike Myers/LCS, it never produces a criss-
 * cross match around repeated content, at the cost of not being a minimal edit script (not the
 * goal here).
 */
export function gestaltMatchingBlocks<T>(a: T[], b: T[]): MatchingBlock[] {
  function longestMatch(aLo: number, aHi: number, bLo: number, bHi: number): MatchingBlock | null {
    let best: MatchingBlock = { aStart: aLo, bStart: bLo, length: 0 };
    for (let i = aLo; i < aHi; i++) {
      for (let j = bLo; j < bHi; j++) {
        if (a[i] !== b[j]) continue;
        let len = 1;
        while (i + len < aHi && j + len < bHi && a[i + len] === b[j + len]) len++;
        if (len > best.length) {
          best = { aStart: i, bStart: j, length: len };
        }
      }
    }
    return best.length > 0 ? best : null;
  }

  function recurse(aLo: number, aHi: number, bLo: number, bHi: number, out: MatchingBlock[]): void {
    const match = longestMatch(aLo, aHi, bLo, bHi);
    if (!match) return;
    recurse(aLo, match.aStart, bLo, match.bStart, out);
    out.push(match);
    recurse(match.aStart + match.length, aHi, match.bStart + match.length, bHi, out);
  }

  const out: MatchingBlock[] = [];
  recurse(0, a.length, 0, b.length, out);
  out.sort((x, y) => x.aStart - y.aStart);
  return out;
}

/**
 * Drops length-1 matches whose value also occurs elsewhere among the *other* still-unmatched
 * candidates on both sides — nothing anchors it as "the" match rather than an arbitrary pick
 * (design §2, "let it go"). Runs of length >= 2 are self-anchoring: a matched multi-element
 * sequence isn't ambiguous even if one of its elements repeats elsewhere.
 */
export function dropAmbiguousSingletons<T>(blocks: MatchingBlock[], a: T[], b: T[]): MatchingBlock[] {
  const matchedA = new Set<number>();
  const matchedB = new Set<number>();
  for (const block of blocks) {
    for (let k = 0; k < block.length; k++) {
      matchedA.add(block.aStart + k);
      matchedB.add(block.bStart + k);
    }
  }

  return blocks.filter((block) => {
    if (block.length !== 1) return true;
    const value = a[block.aStart];
    const aDupe = a.some((v, i) => i !== block.aStart && !matchedA.has(i) && v === value);
    const bDupe = b.some((v, i) => i !== block.bStart && !matchedB.has(i) && v === value);
    return !(aDupe && bDupe);
  });
}

/** Gestalt-match + ambiguity filter in one call — the shared entry point for every level. */
function matchKeyed<T>(aKeys: T[], bKeys: T[]): MatchingBlock[] {
  return dropAmbiguousSingletons(gestaltMatchingBlocks(aKeys, bKeys), aKeys, bKeys);
}

/** Stripped of inline anchors before comparison (`stripInlineAnchors`'s own doc comment): a
 *  heading's `title` is already anchor-free by construction (astParser strips a heading's own
 *  trailing anchor before it ever becomes `title`), but a list item/paragraph's `text` carries its
 *  anchor inline once the block's been through even one `kg:project` cycle — without stripping
 *  here, re-parsing an already-projected file's *unchanged* content off disk would key-mismatch
 *  against its own stored (still anchor-less) node and reconcile as removed+added instead of
 *  matched. */
function leafKey(node: any): string {
  return node.type === 'heading' ? node.title : stripInlineAnchors(node.text ?? '');
}

/**
 * A matched pair (reconcileNode / detectCrossParentMoves) is content-equivalent by construction
 * — Stage A/B only match on exact key equality — so besides `blockId`, every operator/runtime-set
 * field on the old node (`links` via `kg:link`) should survive onto its replacement rather than
 * reset to the fresh parse's defaults. `unfolded` no longer exists as a per-node field to carry
 * forward (Aperas-treeview-design.md — fold state moved to `TreeView.unfolds`, per-view rather
 * than per-node). `links` here is `oldNode`'s already-resolved ref-id strings, carried forward
 * wholesale (this function has no `Store` to check — it's deliberately engine-agnostic, so it
 * can't tell a manual `kg:link` apart from a previously-resolved `[[wikilink]]` by id alone).
 * `node.ts`'s `BlockNode.hydrateFromParsed`, which *does* have a `Store`, is where that split
 * actually happens: it drops every carried-forward wikilink-predicate entry before writing, since
 * `resolveBlockLinks` (`artifacts.ts`) regenerates those fresh right after — only a manual link
 * genuinely survives this carry-forward through to the write. An earlier version of this doc
 * comment claimed `resolveBlockLinks` "merges" its fresh wikilinks onto whatever this function
 * leaves here — it never actually did (plain `BaseNode.addLink` append, no dedup), so every
 * re-ingestion of a block with an unchanged `[[wikilink]]` added one more duplicate `Link`
 * forever; fixed by the drop in `hydrateFromParsed` instead of a merge here.
 *
 * `title` is deliberately *not* carried forward any more — `kg:title` (an out-of-band, graph-only
 * override decoupled from the text) was removed in favor of the explicit lead-in term
 * (`astParser.ts`'s `extractLeadInTitle`/heading `title = rawText`): a title is now always a pure,
 * deterministic function of a block's own current text, recomputed fresh on every parse, the same
 * way `props` already worked below. A matched pair's key is (for non-heading leaves) that very
 * text, so a matched block's freshly-computed title is already identical to what carrying the old
 * one forward would have produced — nothing is lost by not doing it, and there's no more silent,
 * text-independent override to accidentally clobber or accidentally preserve.
 *
 * One real exception to that invariant, found live (issues/core.md, 2026-09-20): `astParser.ts`'s
 * own fallback title for a block with no extractable lead-in term (`let title = blockId`) is *not*
 * a function of the text at all — it's the block's own freshly-minted scratch id, assigned during
 * this parse, before reconciliation ever runs. `newNode.blockId` gets overwritten with the old,
 * carried-forward id two lines below; a `newNode.title` that was only ever mirroring its own
 * about-to-be-discarded scratch id has to be re-pointed at the id it's actually keeping, or it's
 * left naming a value that isn't this node's id at all — confirmed live corrupting `title` on every
 * reconciled fallback-titled block, breaking `toPath()`'s slug-based addressing for each one, the
 * exact same family as the already-fixed `ArtifactNode`-title corruption this doc tracks elsewhere.
 *

 * `props` is different from `links`: it's *rebuilt from the fresh parse every time* (list
 * numbering, checkbox state — genuinely re-derived from the current document, not a separately
 * asserted fact), so the new value always wins, never the old one. What should survive is just
 * the *id*, and only when nothing actually changed — matched by `key` (a block has at most one
 * prop per key today) with an exact value match against `oldNode.props`. A changed value gets a
 * fresh id like any newly-added prop; `oldNode.props[i].id` being absent (the TerminusDB-backed
 * path's own old-tree fetch, `graphql.ts`'s `props { key _json }`, never requests one — TDB's
 * `@key: {"@type": "Random"}` mints its own on every write regardless) leaves this a no-op there,
 * unchanged from before — only ApeironNgn's `toReconcileShape()` populates a real id to carry.
 */
function carryForwardFields(oldNode: any, newNode: any): void {
  // Must run before the reassignment below: `newNode.blockId` here is still the fresh, about-to-
  // be-discarded scratch id `astParser.ts` assigned during this parse — the one value a fallback
  // title (`title === blockId`, no real lead-in found) could actually be mirroring.
  if (newNode.title === newNode.blockId) newNode.title = oldNode.blockId;
  newNode.blockId = oldNode.blockId;
  if (oldNode.links) {
    newNode.links = oldNode.links;
  }
  if (oldNode.props && newNode.props) {
    const oldByKey = new Map<string, any>(oldNode.props.map((p: any) => [p.key, p]));
    newNode.props = newNode.props.map((p: any) => {
      const old = oldByKey.get(p.key);
      return old && old.id !== undefined && old.value === p.value ? { ...p, id: old.id } : p;
    });
  }
}

export interface ChildDiff {
  matched: Array<{ oldIndex: number; newIndex: number }>;
  removedOld: number[];
  addedNew: number[];
  /** Splice target — an index into the final `newChildren` array — for each `removedOld` index
   *  that's `holder`-flagged (Aperas-crud-design.md §5): the segment-derived position immediately
   *  before the next real anchor, keyed by `removedOld`'s own old-index. `reconcileNode` uses this
   *  to preserve an unmatched placeholder in place instead of tombstoning it; every other
   *  `removedOld` index (not present here) still goes to the ordinary tombstone-candidate pool. */
  holderSpliceTargets: Map<number, number>;
}

/**
 * Two-stage per-level diff (design §1). Stage A anchors on leaf/content-bearing nodes; Stage B
 * aligns container nodes by type and relative position within the segments Stage A's anchors
 * define. Indices refer to positions within oldChildren/newChildren; no recursion happens here
 * — the caller recurses into each matched pair's own children.
 */
export function diffChildren(oldChildren: any[], newChildren: any[]): ChildDiff {
  // A tombstoned old child is excluded from every matching pool below (Stage A's leaves and
  // heading buckets, Stage B's containers) — never a candidate live new content can land on.
  // Without this, fresh content can silently bind to an already-dead id without reviving it
  // (issues/core.md's "silently match onto an already-tombstoned node" item): the id stays
  // tombstoned, so the content becomes invisible even though the reconcile summary reports a
  // clean match. A dead slot is simply never reused; new content always gets a fresh id instead.
  const isLiveOld = (i: number) => !oldChildren[i]?.tombstonedAt;
  const oldLeafIdx = oldChildren.map((_, i) => i).filter((i) => LEAF_TYPES.has(oldChildren[i].type) && isLiveOld(i));
  const newLeafIdx = newChildren.map((_, i) => i).filter((i) => LEAF_TYPES.has(newChildren[i].type));
  const oldLeafKeys = oldLeafIdx.map((i) => leafKey(oldChildren[i]));
  const newLeafKeys = newLeafIdx.map((i) => leafKey(newChildren[i]));

  const leafBlocks = matchKeyed(oldLeafKeys, newLeafKeys);

  const matched: Array<{ oldIndex: number; newIndex: number }> = [];
  const matchedOld = new Set<number>();
  const matchedNew = new Set<number>();
  const anchors: Array<{ oldIndex: number; newIndex: number }> = [];
  for (const block of leafBlocks) {
    for (let k = 0; k < block.length; k++) {
      const oldIndex = oldLeafIdx[block.aStart + k];
      const newIndex = newLeafIdx[block.bStart + k];
      matched.push({ oldIndex, newIndex });
      anchors.push({ oldIndex, newIndex });
      matchedOld.add(oldIndex);
      matchedNew.add(newIndex);
    }
  }

  // Stage A2: headings still unmatched after Stage A's exact-title match get one more chance —
  // retitled in place, not moved/restructured. `leafKey` keys a heading on `title` alone (its own
  // doc comment), so an edited title is an exact-key miss with nothing else to fall back on; left
  // there, a whole subtree under a retitled section heading reconciles as wholesale removed+added
  // (discussion/cli-packaging.md's "Resolved (partially): retitling a heading..." incident — the
  // *targeted* retitle-in-place `kg:update` offers has no equivalent when the change arrives via a
  // whole-document/whole-tree push instead). Bucketed by depth (title's own leading `#` run) so a
  // `##` can never fool-match a `#`, then paired in original relative order within each bucket —
  // the same "position is the anchor" trade-off Stage B below already accepts for containers.
  // Unlike Stage A's key match, this doesn't decline on ambiguity (`dropAmbiguousSingletons`): once
  // title itself is out as a key, position is the only signal left, so there's nothing to be
  // ambiguous *about* — same reasoning Stage B's own container alignment already relies on.
  const oldHeadingByDepth = new Map<number, number[]>();
  for (const i of oldLeafIdx) {
    // `oldLeafIdx` already excludes tombstoned candidates (see above); `matchedOld` excludes
    // whatever Stage A's exact-key pass already claimed.
    if (oldChildren[i].type !== 'heading' || matchedOld.has(i)) continue;
    const depth = headingDepth(oldChildren[i].title);
    const bucket = oldHeadingByDepth.get(depth);
    if (bucket) bucket.push(i); else oldHeadingByDepth.set(depth, [i]);
  }
  const newHeadingByDepth = new Map<number, number[]>();
  for (const i of newLeafIdx) {
    if (newChildren[i].type !== 'heading' || matchedNew.has(i)) continue;
    const depth = headingDepth(newChildren[i].title);
    const bucket = newHeadingByDepth.get(depth);
    if (bucket) bucket.push(i); else newHeadingByDepth.set(depth, [i]);
  }
  for (const [depth, oldIdxs] of oldHeadingByDepth) {
    const newIdxs = newHeadingByDepth.get(depth);
    if (!newIdxs) continue;
    const n = Math.min(oldIdxs.length, newIdxs.length);
    for (let k = 0; k < n; k++) {
      const oldIndex = oldIdxs[k];
      const newIndex = newIdxs[k];
      matched.push({ oldIndex, newIndex });
      anchors.push({ oldIndex, newIndex });
      matchedOld.add(oldIndex);
      matchedNew.add(newIndex);
    }
  }

  anchors.sort((x, y) => x.newIndex - y.newIndex);

  // Stage B: partition both index ranges into segments delimited by the anchors (in new-tree
  // order, since that's the order the reconciled tree follows), then align containers within
  // each segment pair by type and relative position.
  const oldContainerIdx = oldChildren.map((_, i) => i).filter((i) => CONTAINER_TYPES.has(oldChildren[i].type) && isLiveOld(i));
  const newContainerIdx = newChildren.map((_, i) => i).filter((i) => CONTAINER_TYPES.has(newChildren[i].type));

  const segments: Array<{ oldRange: [number, number]; newRange: [number, number] }> = [];
  let oldCursor = 0;
  let newCursor = 0;
  for (const anchor of anchors) {
    segments.push({ oldRange: [oldCursor, anchor.oldIndex], newRange: [newCursor, anchor.newIndex] });
    oldCursor = anchor.oldIndex + 1;
    newCursor = anchor.newIndex + 1;
  }
  segments.push({ oldRange: [oldCursor, oldChildren.length], newRange: [newCursor, newChildren.length] });

  for (const segment of segments) {
    const oldInSeg = oldContainerIdx.filter((i) => i >= segment.oldRange[0] && i < segment.oldRange[1]);
    const newInSeg = newContainerIdx.filter((i) => i >= segment.newRange[0] && i < segment.newRange[1]);

    const byType = new Map<string, { old: number[]; new: number[] }>();
    for (const i of oldInSeg) {
      const t = oldChildren[i].type;
      if (!byType.has(t)) byType.set(t, { old: [], new: [] });
      byType.get(t)!.old.push(i);
    }
    for (const i of newInSeg) {
      const t = newChildren[i].type;
      if (!byType.has(t)) byType.set(t, { old: [], new: [] });
      byType.get(t)!.new.push(i);
    }

    for (const [type, { old, new: newer }] of byType) {
      // `listItem` gets a real content key to match on (its own text, same as any Stage A leaf) —
      // a plain positional zip silently reassigns live content onto the wrong id the moment a
      // skipped/reordered sibling shifts everything after it by one slot (issues/core.md's
      // "reconciles children by array position... contradicts what both the skill and the code's
      // own doc comments claim" item, and the "silently match onto an already-tombstoned id" item
      // right below it — reproduced directly: a 4-item list missing its 2nd, already-tombstoned
      // item put every later item's content one slot to the left of its own id). A bare `list`
      // wrapper (the other member of `CONTAINER_TYPES`, effectively unused since the list-
      // consumption migration removed every live one) has no comparable single-line text to key
      // on, so it keeps the positional fallback below.
      if (type === 'listItem') {
        const oldKeys = old.map((i) => leafKey(oldChildren[i]));
        const newKeys = newer.map((i) => leafKey(newChildren[i]));
        for (const block of matchKeyed(oldKeys, newKeys)) {
          for (let k = 0; k < block.length; k++) {
            matched.push({ oldIndex: old[block.aStart + k], newIndex: newer[block.bStart + k] });
            matchedOld.add(old[block.aStart + k]);
            matchedNew.add(newer[block.bStart + k]);
          }
        }
        continue;
      }
      const n = Math.min(old.length, newer.length);
      for (let k = 0; k < n; k++) {
        matched.push({ oldIndex: old[k], newIndex: newer[k] });
        matchedOld.add(old[k]);
        matchedNew.add(newer[k]);
      }
    }
  }

  const removedOld = oldChildren.map((_, i) => i).filter((i) => !matchedOld.has(i));
  const addedNew = newChildren.map((_, i) => i).filter((i) => !matchedNew.has(i));

  // Aperas-crud-design.md §5: a holder-flagged removedOld child necessarily falls inside exactly
  // one of the segments computed above (they partition the whole [0, oldChildren.length) range) —
  // its splice target is that segment's own newRange upper bound, immediately before the next real
  // anchor. Every other removedOld index gets no entry here and stays destined for the ordinary
  // tombstone-candidate pool, unaffected.
  const holderSpliceTargets = new Map<number, number>();
  for (const oldIndex of removedOld) {
    if (!oldChildren[oldIndex]?.holder) continue;
    const segment = segments.find((s) => oldIndex >= s.oldRange[0] && oldIndex < s.oldRange[1]);
    if (segment) holderSpliceTargets.set(oldIndex, segment.newRange[1]);
  }

  return { matched, removedOld, addedNew, holderSpliceTargets };
}

export interface ReconciliationStats {
  /** Matched, same position, same content — the ordinary case. Named `matched`, not `unchanged`,
   *  since a matched-but-different-content heading falls into `changed` instead (`headingChanged`
   *  below); calling this bucket `unchanged` would read as a claim `changed` next to it contradicts. */
  matched: number;
  moved: number;
  changed: number;
  added: number;
  removed: number;
}

export interface ReconciliationResult {
  finalTree: any;
  tombstones: any[];
  stats: ReconciliationStats;
}

/** Recursively collects an old subtree (already fully ingested, oldNode ⊇ persisted fields) into tombstone records. */
function tombstoneSubtree(oldNode: any, now: string, out: any[]): void {
  out.push({
    blockId: oldNode.blockId,
    type: oldNode.type,
    title: oldNode.title,
    ...(oldNode.text ? { text: oldNode.text } : {}),
    children: [], // detached from the tree, but `children` is a required List, not Optional
    tombstonedAt: now,
  });
  for (const child of oldNode.children ?? []) {
    tombstoneSubtree(child, now, out);
  }
}

function countNodes(node: any): number {
  return 1 + (node.children ?? []).reduce((sum: number, c: any) => sum + countNodes(c), 0);
}

interface ReconcileContext {
  stats: ReconciliationStats;
  /** Old nodes unmatched at their own parent level — candidates for tombstoning, unless a
   *  cross-parent move match later revives one. */
  removedCandidates: any[];
  /** New nodes unmatched at their own parent level — candidates for "added", unless a
   *  cross-parent move match later claims one. */
  addedCandidates: any[];
}

/**
 * `leafKey`'s exceptions to "matched implies content-identical" (its own doc comment above): a
 * heading matches Stage A by `title` alone, but its adopted leading-paragraph `text`
 * (`astParser.ts`'s "leading paragraph" — real, independently-editable content, not derived from
 * `title`) isn't part of that key, so a matched pair can still differ in `text`. Stage A2 (this
 * file's own heading positional fallback, above) adds a second way: a pair matched there can
 * differ in `title` itself — that's the whole point of it, catching a retitle Stage A's exact-key
 * match would otherwise treat as a wholesale removal. Every other leaf type's key *is* its own
 * `text`, so a changed leaf there can never end up "matched" in the first place (`leafKey`'s doc
 * comment). Checked, not assumed, so `matched`/`changed` stay a true statement about what the
 * reconciler actually saw. */
function headingChanged(oldNode: any, newNode: any): boolean {
  return oldNode.type === 'heading' && ((oldNode.text ?? '') !== (newNode.text ?? '') || oldNode.title !== newNode.title);
}

/** Order-independent key/value comparison of a matched pair's `props` — a matched pair is
 *  content-identical by *text* (`leafKey`'s own guarantee) but `props` (a listItem's `checked`,
 *  a run's `orderedList`/`startIndex`) sits entirely outside that key, so a real prop-only write
 *  otherwise reports as plain `matched`, indistinguishable from no write at all having happened
 *  (issues/core.md's "a props-only change reports as `0 changed`"). Both empty/absent counts as
 *  unchanged, not as a difference in shape. */
function propsChanged(oldNode: any, newNode: any): boolean {
  const oldProps = oldNode.props ?? [];
  const newProps = newNode.props ?? [];
  if (oldProps.length !== newProps.length) return true;
  const oldByKey = new Map<string, unknown>(oldProps.map((p: any) => [p.key, p.value]));
  return newProps.some((p: any) => oldByKey.get(p.key) !== p.value);
}

/** `headingChanged`'s heading-only text/title check, generalized to any matched pair via
 *  `propsChanged` too — the two are independent axes (a heading can be retitled *and* its props
 *  can differ; a non-heading leaf can only ever differ in props, its text being its own match
 *  key) so either one alone is enough to report `changed` rather than `matched`. */
function pairChanged(oldNode: any, newNode: any): boolean {
  return headingChanged(oldNode, newNode) || propsChanged(oldNode, newNode);
}

/**
 * Recurses only into matched pairs (Stage A/B within diffChildren). Unmatched children are
 * collected into ctx.removedCandidates/addedCandidates rather than finalized immediately —
 * cross-parent moves (a leaf relocated to a different section) are only distinguishable from a
 * genuine delete+add after the whole tree has been walked and every level's leftovers are known
 * (see reconcileTree's move-detection pass below).
 */
function reconcileNode(oldNode: any, newNode: any, ctx: ReconcileContext): void {
  carryForwardFields(oldNode, newNode);

  const diff = diffChildren(oldNode.children ?? [], newNode.children ?? []);

  // Same-parent reordering: Stage B's type-grouped container zipping can produce inversions
  // (e.g. a list and a blockquote swapping places within a segment) even though every element
  // individually matched — a greedy longest-increasing-run scan over new-index order (sorted by
  // old index) classifies which matched pairs are "in order" (not moved) vs an inversion (moved).
  const byOldIndex = [...diff.matched].sort((a, b) => a.oldIndex - b.oldIndex);
  let runningMaxNew = -1;
  const movedPairs = new Set<number>(); // keyed by oldIndex
  for (const { oldIndex, newIndex } of byOldIndex) {
    if (newIndex > runningMaxNew) {
      runningMaxNew = newIndex;
    } else {
      movedPairs.add(oldIndex);
    }
  }

  for (const { oldIndex, newIndex } of diff.matched) {
    const oldChild = oldNode.children[oldIndex];
    const newChild = newNode.children[newIndex];
    reconcileNode(oldChild, newChild, ctx);
    if (movedPairs.has(oldIndex)) {
      ctx.stats.moved++;
    } else if (pairChanged(oldChild, newChild)) {
      ctx.stats.changed++;
    } else {
      ctx.stats.matched++;
    }
  }

  // Order matters below: every read of `newNode.children[newIndex]` by *original* array position
  // (the matched-pairs loop above, and `addedNew` here) must finish before the holder splice at the
  // bottom mutates that same array — splicing any earlier would shift those indices out from under
  // them (Aperas-crud-design.md §5).
  for (const newIndex of diff.addedNew) {
    ctx.addedCandidates.push(newNode.children[newIndex]);
  }

  for (const oldIndex of diff.removedOld) {
    if (diff.holderSpliceTargets.has(oldIndex)) continue; // preserved below, not tombstoned
    ctx.removedCandidates.push(oldNode.children[oldIndex]);
  }

  newNode.children = newNode.children ?? [];
  spliceHolders(newNode.children, oldNode.children, diff);
}

/**
 * Preserves every holder-flagged `removedOld` child in place instead of tombstoning it (Aperas-
 * crud-design.md §5) — mutates `newChildren` directly. Groups by splice target first: two holders
 * landing in the *same* gap must be spliced together, in their original relative order, in one call
 * — inserting them one at a time at the same index would reverse their order (each subsequent
 * insert pushes the previous one one slot further right). Distinct targets are then applied
 * highest-index-first so an earlier splice never shifts a later target's own position.
 */
function spliceHolders(newChildren: any[], oldChildren: any[], diff: ChildDiff): void {
  const byTarget = new Map<number, number[]>(); // spliceAt -> oldIndexes, in original (ascending) order
  for (const oldIndex of diff.removedOld) {
    const target = diff.holderSpliceTargets.get(oldIndex);
    if (target === undefined) continue;
    const group = byTarget.get(target);
    if (group) group.push(oldIndex);
    else byTarget.set(target, [oldIndex]);
  }
  const targets = [...byTarget.keys()].sort((a, b) => b - a);
  for (const target of targets) {
    const group = byTarget.get(target)!;
    newChildren.splice(target, 0, ...group.map((oldIndex) => oldChildren[oldIndex]));
  }
}

/**
 * Cross-parent move detection (design §5's "block moved to a different section" — the same
 * mechanism as an ArtifactNode rename, applied to leaves left over after every parent level's
 * own Stage A/B matching). Only leaf-type nodes participate (containers have no content key to
 * match on). A matched leaf's identity is reused on its new counterpart in place, and — if both
 * sides have children (a moved heading carrying its own section along) — its own subtree is
 * reconciled too, one level, via the same Stage A/B diff (not a further move-search beneath it,
 * to keep this bounded).
 */
function detectCrossParentMoves(ctx: ReconcileContext, now: string): any[] {
  const removedLeaves = ctx.removedCandidates.filter((n) => LEAF_TYPES.has(n.type));
  const addedLeaves = ctx.addedCandidates.filter((n) => LEAF_TYPES.has(n.type));
  const removedKeys = removedLeaves.map(leafKey);
  const addedKeys = addedLeaves.map(leafKey);
  const blocks = matchKeyed(removedKeys, addedKeys);

  const movedOld = new Set<any>();
  const movedNew = new Set<any>();
  for (const block of blocks) {
    for (let k = 0; k < block.length; k++) {
      const oldNode = removedLeaves[block.aStart + k];
      const newNode = addedLeaves[block.bStart + k];
      carryForwardFields(oldNode, newNode);
      if ((oldNode.children?.length ?? 0) > 0 && (newNode.children?.length ?? 0) > 0) {
        const subDiff = diffChildren(oldNode.children, newNode.children);
        for (const { oldIndex, newIndex } of subDiff.matched) {
          const oldChild = oldNode.children[oldIndex];
          const newChild = newNode.children[newIndex];
          reconcileNode(oldChild, newChild, ctx);
          if (pairChanged(oldChild, newChild)) ctx.stats.changed++;
          else ctx.stats.matched++;
        }
        for (const ni of subDiff.addedNew) ctx.addedCandidates.push(newNode.children[ni]);
        for (const oi of subDiff.removedOld) {
          if (subDiff.holderSpliceTargets.has(oi)) continue; // preserved below, not tombstoned
          ctx.removedCandidates.push(oldNode.children[oi]);
        }
        // Same holder-preservation splice as reconcileNode's own (Aperas-crud-design.md §5),
        // needed here too since a cross-parent-moved node's own children get their own one-level
        // sub-diff, independent of whatever ran at its old and new parents.
        newNode.children = newNode.children ?? [];
        spliceHolders(newNode.children, oldNode.children, subDiff);
      }
      movedOld.add(oldNode);
      movedNew.add(newNode);
      ctx.stats.moved++;
    }
  }

  ctx.removedCandidates = ctx.removedCandidates.filter((n) => !movedOld.has(n));
  ctx.addedCandidates = ctx.addedCandidates.filter((n) => !movedNew.has(n));

  const tombstones: any[] = [];
  for (const node of ctx.removedCandidates) {
    tombstoneSubtree(node, now, tombstones);
  }
  ctx.stats.removed += ctx.removedCandidates.reduce((sum, n) => sum + countNodes(n), 0);
  ctx.stats.added += ctx.addedCandidates.reduce((sum, n) => sum + countNodes(n), 0);
  return tombstones;
}

/**
 * Reconciles a freshly-parsed tree against the previously-ingested tree for the same artifact.
 * The top level is trivially paired — `oldRoot`/`newRoot` are each artifact's own current vs.
 * freshly-parsed state, one call per artifact, nothing to search for. Returns the tree to submit
 * (newRoot, mutated in place so matched nodes reuse their old identity), the tombstone records
 * to write separately (unmatched old nodes, whole subtrees), and block-level stats.
 */
export function reconcileTree(oldRoot: any, newRoot: any, now: string = new Date().toISOString()): ReconciliationResult {
  const ctx: ReconcileContext = {
    stats: { matched: 0, moved: 0, changed: 0, added: 0, removed: 0 },
    removedCandidates: [],
    addedCandidates: [],
  };
  reconcileNode(oldRoot, newRoot, ctx);
  const tombstones = detectCrossParentMoves(ctx, now);
  return { finalTree: newRoot, tombstones, stats: ctx.stats };
}

/**
 * Rename/move detection for ArtifactNode/FolderNode leftovers (design §4 — "one mechanism,
 * three fractal layers"): candidates present only on one side (disk-only vs DB-only) are matched
 * by exact content-key equality, with no positional requirement at all — every occurrence of a
 * key is found regardless of where it sits in either array. A match means "this is a rename," not
 * a delete+create. A key occurring more than once on either side is left unmatched (nothing
 * anchors which occurrence is "the" one — "decline rather than guess," same spirit as
 * `dropAmbiguousSingletons`).
 *
 * Order-independent by construction, unlike `matchKeyed`'s Gestalt/Ratcliff-Obershelp recursion
 * (used above for reconciling one artifact's own children, where sibling order really is
 * meaningful): removed/added candidates here are a whole-corpus bag of file/folder identities
 * scattered across unrelated concern folders, with no shared order to exploit. This function used
 * to be that same recursion at file/folder granularity instead of per-line, and it broke on
 * exactly that mismatch — confirmed live batch-renaming 5 concern docs at once (removed side in
 * store-iteration order, added side in argv order): only 2 of the 4 genuinely exact-content
 * matches were found, the other 2 sitting in a recursive quadrant an earlier split had already
 * discarded, not because they were ambiguous.
 */
export function matchLeftoverByAbstract<T>(
  removed: Array<{ key: string; item: T }>,
  added: Array<{ key: string; item: T }>
): { matched: Array<{ old: T; new: T }>; stillRemoved: T[]; stillAdded: T[] } {
  const countOf = (list: Array<{ key: string }>, key: string) => list.filter((x) => x.key === key).length;
  const matched: Array<{ old: T; new: T }> = [];
  const matchedRemoved = new Set<number>();
  const matchedAdded = new Set<number>();
  removed.forEach((r, i) => {
    if (countOf(removed, r.key) !== 1) return;
    const addedIdx = added.findIndex((a) => a.key === r.key);
    if (addedIdx === -1 || countOf(added, r.key) !== 1) return;
    matched.push({ old: r.item, new: added[addedIdx].item });
    matchedRemoved.add(i);
    matchedAdded.add(addedIdx);
  });

  return {
    matched,
    stillRemoved: removed.filter((_, i) => !matchedRemoved.has(i)).map((r) => r.item),
    stillAdded: added.filter((_, i) => !matchedAdded.has(i)).map((a) => a.item),
  };
}
