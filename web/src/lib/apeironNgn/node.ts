/**
 * ApeironNgn's `a.b.c` prop-access interface (Aperas-apeironngn-design.md §3-4).
 *
 * A note on "lazy," now that the engine is real rather than hypothetical: the design's caveat
 * about needing `valueOf`/`Symbol.toPrimitive`-style deferred forcing was framed against a
 * still-open question of whether Oxigraph's Node binding would be sync or async. It's confirmed
 * sync (`oxigraph` skill) — there's no I/O gap for a Promise-like wrapper to hide, so no such
 * wrapper exists here. The laziness that actually matters survives anyway, at the right
 * granularity: wrapping a neighbor as a Node proxy (this file) touches only the one `parent`/
 * `siblingIndex`/reference triple needed to name that neighbor — none of *its* other fields are
 * read until something actually asks for them. `a.b.c` costs exactly 2 `store.match()` calls
 * (one for `.b`, one for `.c`), not a subtree's worth.
 */

import type { Store } from 'oxigraph';
import {
  nodeIri,
  idFromNodeIri,
  predIri,
  decodeLiteral,
  isLiteralTerm,
  isNamedNodeTerm,
  PARENT_PRED,
  SIBLING_INDEX_PRED,
} from './vocab';

export interface ApeironNode {
  /** Escape hatch: the raw node id (e.g. `"BlockNode/00C..."`), never proxied further. */
  readonly id: string;
  /** Reified containment (Aperas-apeironngn-design.md §3): reverse-queries the `parent` index,
   *  sorted by `siblingIndex`. Each returned child is itself a fresh, unmaterialized Node — only
   *  `parent`/`siblingIndex` were read to produce this list. */
  readonly children: ApeironNode[];
  [field: string]: unknown;
}

function fieldValue(store: Store, id: string, field: string): unknown {
  const matches = store.match(nodeIri(id), predIri(field), null, null);
  if (matches.length === 0) return undefined;

  const decode = (m: (typeof matches)[number]) => {
    const obj = m.object;
    if (isLiteralTerm(obj)) return decodeLiteral(obj);
    if (isNamedNodeTerm(obj)) return wrapNode(store, idFromNodeIri(obj.value));
    return undefined;
  };

  return matches.length === 1 ? decode(matches[0]) : matches.map(decode);
}

function childrenOf(store: Store, id: string): ApeironNode[] {
  const parentMatches = store.match(null, PARENT_PRED, nodeIri(id), null);
  const withIndex = parentMatches.map((m) => {
    const childId = idFromNodeIri(String(m.subject.value));
    const idxMatches = store.match(nodeIri(childId), SIBLING_INDEX_PRED, null, null);
    const idx = idxMatches.length > 0 && isLiteralTerm(idxMatches[0].object) ? Number(idxMatches[0].object.value) : 0;
    return { childId, idx };
  });
  withIndex.sort((a, b) => a.idx - b.idx);
  return withIndex.map(({ childId }) => wrapNode(store, childId));
}

/** Wraps one node id as a lazy `a.b.c`-navigable proxy over `store`. */
export function wrapNode(store: Store, id: string): ApeironNode {
  return new Proxy({} as ApeironNode, {
    get(_target, prop: string | symbol) {
      if (prop === 'id') return id;
      if (prop === 'children') return childrenOf(store, id);
      if (typeof prop !== 'string') return undefined;
      return fieldValue(store, id, prop);
    },
  });
}

/** The general backlink pattern (Aperas-kg-foundational-design.md §3.2): every subject with
 *  `field` pointing at this node, regardless of whether `field` is reified containment or a plain
 *  reference — the one query shape `parentId`/`resolveIdToPath`'s reverse-lookup gap under
 *  TerminusDB had no equivalent for. */
export function backlinks(store: Store, id: string, field: string): ApeironNode[] {
  return store.match(null, predIri(field), nodeIri(id), null).map((m) => wrapNode(store, idFromNodeIri(String(m.subject.value))));
}
