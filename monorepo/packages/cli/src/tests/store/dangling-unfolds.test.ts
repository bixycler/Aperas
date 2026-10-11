// `removeDanglingUnfolds`' object-bound match against the former per-view scan (step 9c of the legacy
// suite), on a tiny store: one artifact, one view that unfolds two of its blocks. The comparison
// functions are kept in `verifyDanglingUnfolds.ts`, which also runs them against a copy of a real store.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getArtifactsDir } from '@aperas/core/artifacts';
import { allIdsOfKind } from '@aperas/core/apeironNgn/dehydrate';
import { trackArtifact, ingestArtifact } from '@aperas/core/apeironNgn/artifacts';
import { ingestFolderTree } from '@aperas/core/apeironNgn/folders';
import { findByExactPath } from '@aperas/core/apeironNgn/tree';
import { wrap, ensureDefaultView } from '@aperas/core/apeironNgn/node';
import { compareDanglingUnfoldForms, unfoldedIds } from '../../verifyDanglingUnfolds.ts';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';

const walkBlocks = (n: any, out: any[] = []): any[] => { for (const c of n.treeChildren ?? []) { out.push(c); walkBlocks(c, out); } return out; };

describe('dangling unfolds', () => {
  let fx: FixtureStore;
  before(() => { fx = makeFixtureStore('unfold_demo'); });
  after(() => fx.cleanup());

  test('9c: the object-bound match finds and removes the same quads as the per-view scan', () => {
    const path = `${fx.demoDir}/unfolds.md`;
    writeFileSync(join(getArtifactsDir(), path), '# Unfolds\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n', 'utf-8');
    trackArtifact(fx.store, path);
    ingestFolderTree(fx.store);
    ingestArtifact(fx.store, path);
    const blocks = walkBlocks(wrap(fx.store, findByExactPath(fx.store, path)!));
    assert.ok(blocks.length >= 3, `expected at least 3 blocks, got ${blocks.length}`);
    const view = ensureDefaultView(fx.store);
    view.unfold(blocks[0].id);
    view.unfold(blocks[1].id);
    const sample = Array.from(new Set([...unfoldedIds(fx.store).slice(0, 2), ...allIdsOfKind(fx.store, 'BlockNode').slice(0, 1), blocks[2].id]));
    const result = compareDanglingUnfoldForms(fx.store, sample);
    assert.deepEqual(result.mismatches, []);
    assert.ok(result.idsWithHits >= 2, `expected at least 2 ids with a hit, got ${result.idsWithHits}`);
  });
});
