// Corpus check: `removeDanglingUnfolds`' object-bound match against the former per-view scan, on a COPY of the
// real mirror (`makeCorpusCopy()`): the mirror as it is on disk, which lags the service's memory by up to its
// flush interval. The real mirror is only read. The sample of ids is the one `verifyDanglingUnfolds.ts` takes
// on a real store (ids with a hit and ids without); the tiny-store version is `store/dangling-unfolds.test.ts`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { compareDanglingUnfoldForms, realStoreSampleIds } from '../../verifyDanglingUnfolds.ts';
import { makeCorpusCopy, type CorpusCopy } from '../support/corpus.ts';

describe('corpus: dangling unfolds', () => {
  let copy: CorpusCopy;
  before(() => { copy = makeCorpusCopy(); });
  after(() => copy?.cleanup());

  test('9c: the object-bound match finds and removes the same quads as the per-view scan on the mirror', async () => {
    const ids = realStoreSampleIds(copy.store);
    const sizeBefore = copy.store.size;
    // One id at a time with a turn of the event loop between them: the reference form scans the whole store per
    // id, and the scans' results are only released between turns, so a single synchronous loop over all ids
    // slows with each id (0.5 s for the first, over 2 s by the fourteenth, no end within five minutes), while
    // one turn per id keeps every id at about 0.15 to 0.25 s.
    const result = { ids: 0, idsWithHits: 0, quadsRemoved: 0, mismatches: [] as string[] };
    for (const id of ids) {
      const r = compareDanglingUnfoldForms(copy.store, [id]);
      result.ids += r.ids; result.idsWithHits += r.idsWithHits; result.quadsRemoved += r.quadsRemoved; result.mismatches.push(...r.mismatches);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.deepEqual(result.mismatches, []);
    assert.equal(copy.store.size, sizeBefore, 'every removed quad was put back');
    // new: a sample with no hit would compare two empty results
    assert.ok(ids.length > 10, `the sample is not empty (${ids.length} ids)`);
    assert.ok(result.idsWithHits > 0, `some sampled ids are unfolded by a view (${result.idsWithHits})`);
    assert.ok(result.quadsRemoved > 0, `some unfolds quads were removed and restored (${result.quadsRemoved})`);
  });
});
