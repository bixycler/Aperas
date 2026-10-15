/**
 * Test-only equivalence check for `removeDanglingUnfolds` (node.ts). The function used to find a
 * deleted id's incoming `unfolds` references by listing every `TreeView` (`allIdsOfKind`, a scan of
 * the whole store) and matching `view unfolds <id>` once per view; it now makes one match bound on
 * the object, `store.match(null, unfolds, <id>, null)`. This file keeps the former form as
 * `referenceDanglingUnfoldQuads` so the two can be compared on any store, and holds the
 * comparison used by `tests/store/dangling-unfolds.test.ts` (on a tiny fixture store) and by
 * `tests/corpus/dangling-unfolds.test.ts` (on a copy of the real mirror made by `makeCorpusCopy()`); run directly against a
 * copy of a real `Apeiron/` directory it checks the real data too:
 *
 *   tsx packages/cli/src/verifyDanglingUnfolds.ts <copy of Apeiron dir>
 */

import type { Quad, Store } from 'oxigraph';
import { rehydrateStore } from '@aperas/core/apeironNgn/store';
import { allIdsOfKind } from '@aperas/core/apeironNgn/dehydrate';
import { removeDanglingUnfolds } from '@aperas/core/apeironNgn/node';
import { idFromNodeIri, nodeIri, predIri } from '@aperas/core/apeironNgn/vocab';

/** The previous implementation's lookup: one match per `TreeView` found by a full scan. */
export function referenceDanglingUnfoldQuads(store: Store, deletedId: string): Quad[] {
  const deletedIri = nodeIri(deletedId);
  const found: Quad[] = [];
  for (const viewId of allIdsOfKind(store, 'TreeView')) {
    for (const m of store.match(nodeIri(viewId), predIri('unfolds'), deletedIri, null)) found.push(m);
  }
  return found;
}

const quadKey = (q: Quad): string => `${q.subject.value} ${q.predicate.value} ${q.object.value}`;
const keysOf = (quads: Quad[]): string[] => quads.map(quadKey).sort();

export interface DanglingUnfoldComparison {
  ids: number;
  idsWithHits: number;
  quadsRemoved: number;
  mismatches: string[];
}

/** For each id: the object-bound match must return the same quads as the reference scan;
 *  `removeDanglingUnfolds` must then remove exactly those quads and nothing else (store size drops
 *  by their count, none of them remain); and they are put back so the next id sees the same store. */
export function compareDanglingUnfoldForms(store: Store, ids: string[]): DanglingUnfoldComparison {
  const result: DanglingUnfoldComparison = { ids: ids.length, idsWithHits: 0, quadsRemoved: 0, mismatches: [] };
  const unfolds = predIri('unfolds');
  for (const id of ids) {
    const reference = referenceDanglingUnfoldQuads(store, id);
    const bound = store.match(null, unfolds, nodeIri(id), null);
    if (keysOf(reference).join('\n') !== keysOf(bound).join('\n')) {
      result.mismatches.push(`${id}: reference ${reference.length} quad(s), object-bound match ${bound.length}`);
      continue;
    }
    const sizeBefore = store.size;
    removeDanglingUnfolds(store, id);
    const removed = sizeBefore - store.size;
    const left = store.match(null, unfolds, nodeIri(id), null).length;
    if (removed !== reference.length || left !== 0) {
      result.mismatches.push(`${id}: removeDanglingUnfolds removed ${removed} (expected ${reference.length}), ${left} left`);
    }
    for (const q of reference) store.add(q);
    if (reference.length > 0) result.idsWithHits++;
    result.quadsRemoved += removed;
  }
  return result;
}

/** Every id that some `TreeView` currently unfolds (the ids that have a hit), in a stable order. */
export function unfoldedIds(store: Store): string[] {
  const out = new Set<string>();
  for (const q of store.match(null, predIri('unfolds'), null, null)) {
    if (q.object.termType === 'NamedNode') out.add(idFromNodeIri(q.object.value));
  }
  return [...out].sort();
}

/** The ids the real-store comparison covers: the first 20 unfolded ids (ids with a hit), the
 *  first 30 `BlockNode`s and every 500th of up to 10 more (ids with none). The reference form scans
 *  the whole store once per id, and on the real store each scan costs 0.2 to 0.5 s and slows as
 *  scans accumulate without the event loop turning, so the sample is kept small. */
export function realStoreSampleIds(store: Store): string[] {
  const blocks = allIdsOfKind(store, 'BlockNode');
  const sample = new Set<string>(unfoldedIds(store).slice(0, 20));
  for (const id of blocks.slice(0, 30)) sample.add(id);
  for (const id of blocks.filter((_, i) => i % 500 === 0).slice(0, 10)) sample.add(id);
  return [...sample];
}

if (typeof process !== 'undefined' && process.argv[1]?.endsWith('verifyDanglingUnfolds.ts')) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Usage: tsx packages/cli/src/verifyDanglingUnfolds.ts <copy of an Apeiron directory>');
    process.exit(1);
  }
  const { store, quadCount } = rehydrateStore(dir);
  const ids = realStoreSampleIds(store);
  const t0 = performance.now();
  const r = compareDanglingUnfoldForms(store, ids);
  console.log(
    `[dangling-unfolds] ${quadCount} quads, ${r.ids} ids (${r.idsWithHits} with a hit), ${r.quadsRemoved} unfolds quads removed and restored, ` +
      `${r.mismatches.length} mismatch(es), ${(performance.now() - t0).toFixed(0)} ms`
  );
  for (const m of r.mismatches) console.log('  MISMATCH ' + m);
  process.exit(r.mismatches.length === 0 ? 0 : 1);
}
