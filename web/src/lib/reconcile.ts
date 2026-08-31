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
 * A note on "changed" as a reporting category (design §5): at block level, Stage A only
 * matches on exact key equality ("heading XOR text"), so a matched leaf is by construction
 * unchanged content — an edited paragraph has a different key and surfaces as removed+added,
 * which is the intended "decline rather than guess" behavior (§2), not a gap. "Changed"
 * therefore only applies one level up, at ArtifactNode/FolderNode scope, where matching is by
 * path/abstract rather than exact-content equality (see matchLeftoverByAbstract and its
 * callers in artifacts.ts/folders.ts).
 */

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

function leafKey(node: any): string {
  return node.type === 'heading' ? node.title : (node.text ?? '');
}

/**
 * A matched pair (reconcileNode / detectCrossParentMoves) is content-equivalent by construction
 * — Stage A/B only match on exact key equality — so besides `blockId`, every operator/runtime-
 * set field on the old node (`title` set via `kg:title`, `unfolded` via `kg:fold`/`kg:unfold`,
 * `links` via `kg:link`) should survive onto its replacement rather than reset to the fresh
 * parse's defaults (Aperas-interactive-summarization-design.md §4/§7 — confirmed live as a real
 * regression before this fix: a matched block's title/unfolded/links silently reverted on every
 * re-ingest). Safe unconditionally: for a heading, `oldNode.title` and the fresh parse's title
 * are identical anyway since the heading text itself is the match key; `links` here is `oldNode`'s
 * already-resolved ref-id strings — `resolveBlockLinks` (artifacts.ts) merges freshly-resolved
 * wikilink `Link`s onto whatever this leaves on `newNode.links`, rather than overwriting it.
 */
function carryForwardFields(oldNode: any, newNode: any): void {
  newNode.blockId = oldNode.blockId;
  newNode.title = oldNode.title;
  newNode.unfolded = oldNode.unfolded ?? false;
  if (oldNode.links) {
    newNode.links = oldNode.links;
  }
}

export interface ChildDiff {
  matched: Array<{ oldIndex: number; newIndex: number }>;
  removedOld: number[];
  addedNew: number[];
}

/**
 * Two-stage per-level diff (design §1). Stage A anchors on leaf/content-bearing nodes; Stage B
 * aligns container nodes by type and relative position within the segments Stage A's anchors
 * define. Indices refer to positions within oldChildren/newChildren; no recursion happens here
 * — the caller recurses into each matched pair's own children.
 */
export function diffChildren(oldChildren: any[], newChildren: any[]): ChildDiff {
  const oldLeafIdx = oldChildren.map((_, i) => i).filter((i) => LEAF_TYPES.has(oldChildren[i].type));
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
  anchors.sort((x, y) => x.newIndex - y.newIndex);

  // Stage B: partition both index ranges into segments delimited by the anchors (in new-tree
  // order, since that's the order the reconciled tree follows), then align containers within
  // each segment pair by type and relative position.
  const oldContainerIdx = oldChildren.map((_, i) => i).filter((i) => CONTAINER_TYPES.has(oldChildren[i].type));
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

    for (const { old, new: newer } of byType.values()) {
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

  return { matched, removedOld, addedNew };
}

export interface ReconciliationStats {
  unchanged: number;
  moved: number;
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
    unfolded: oldNode.unfolded ?? false,
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
  // old index) classifies which matched pairs are "in order" (unchanged) vs an inversion (moved).
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
    } else {
      ctx.stats.unchanged++;
    }
  }

  for (const oldIndex of diff.removedOld) {
    ctx.removedCandidates.push(oldNode.children[oldIndex]);
  }
  for (const newIndex of diff.addedNew) {
    ctx.addedCandidates.push(newNode.children[newIndex]);
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
          reconcileNode(oldNode.children[oldIndex], newNode.children[newIndex], ctx);
        }
        ctx.stats.unchanged += subDiff.matched.length;
        for (const oi of subDiff.removedOld) ctx.removedCandidates.push(oldNode.children[oi]);
        for (const ni of subDiff.addedNew) ctx.addedCandidates.push(newNode.children[ni]);
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
 * The root is trivially matched (one root per ArtifactNode). Returns the tree to submit
 * (newRoot, mutated in place so matched nodes reuse their old identity), the tombstone records
 * to write separately (unmatched old nodes, whole subtrees), and block-level stats.
 */
export function reconcileTree(oldRoot: any, newRoot: any, now: string = new Date().toISOString()): ReconciliationResult {
  const ctx: ReconcileContext = {
    stats: { unchanged: 0, moved: 0, added: 0, removed: 0 },
    removedCandidates: [],
    addedCandidates: [],
  };
  reconcileNode(oldRoot, newRoot, ctx);
  const tombstones = detectCrossParentMoves(ctx, now);
  return { finalTree: newRoot, tombstones, stats: ctx.stats };
}

/**
 * Rename/move detection for ArtifactNode/FolderNode leftovers (design §4 — "one mechanism,
 * three fractal layers"): candidates present only on one side (disk-only vs DB-only) are
 * matched by content-abstract similarity using the same Gestalt + ambiguity-decline primitive
 * used for blocks, just at a coarser granularity (one key per whole file/folder instead of per
 * line). A match means "this is a rename," not a delete+create.
 */
export function matchLeftoverByAbstract<T>(
  removed: Array<{ key: string; item: T }>,
  added: Array<{ key: string; item: T }>
): { matched: Array<{ old: T; new: T }>; stillRemoved: T[]; stillAdded: T[] } {
  const removedKeys = removed.map((r) => r.key);
  const addedKeys = added.map((a) => a.key);
  const blocks = matchKeyed(removedKeys, addedKeys);

  const matched: Array<{ old: T; new: T }> = [];
  const matchedRemoved = new Set<number>();
  const matchedAdded = new Set<number>();
  for (const block of blocks) {
    for (let k = 0; k < block.length; k++) {
      const oldIdx = block.aStart + k;
      const newIdx = block.bStart + k;
      matched.push({ old: removed[oldIdx].item, new: added[newIdx].item });
      matchedRemoved.add(oldIdx);
      matchedAdded.add(newIdx);
    }
  }

  return {
    matched,
    stillRemoved: removed.filter((_, i) => !matchedRemoved.has(i)).map((r) => r.item),
    stillAdded: added.filter((_, i) => !matchedAdded.has(i)).map((a) => a.item),
  };
}
