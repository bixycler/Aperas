// Dehydrate -> rehydrate round trip (step 7 of the legacy suite) on a tiny store: one ingested artifact and
// one tree view, dehydrated into a scratch directory (content mirror and state mirror) and rehydrated from
// there. The same round trip of the real mirror is a corpus check and stays out of this file.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rehydrateStore } from '@aperas/core/apeironNgn/store';
import { dehydrateToJsonLd, dehydrateStateToJsonLd } from '@aperas/core/apeironNgn/dehydrate';
import { wrap, ensureDefaultView, type ArtifactNode } from '@aperas/core/apeironNgn/node';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';
import { ingestLinkedDemo, type LinkedDemo } from '../support/linkedDemo.ts';

describe('dehydrate and rehydrate', () => {
  let fx: FixtureStore;
  let demo: LinkedDemo;
  before(() => {
    fx = makeFixtureStore('roundtrip_demo');
    demo = ingestLinkedDemo(fx);
    // A tree view lives in the state mirror, which the content mirror alone does not carry; the old step ran
    // against a store that had one (the real mirror's), so the fixture has one too.
    ensureDefaultView(fx.store).unfold(demo.linkBlockId);
  });
  after(() => fx.cleanup());

  test('7: a round trip through a scratch directory keeps every quad and the artifact identity', () => {
    const scratchDir = mkdtempSync(join(tmpdir(), 'apeironngn-verify-'));
    try {
      const { counts } = dehydrateToJsonLd(fx.store, scratchDir);
      // The state mirror needs the same pass into the same directory, or the rehydrated side undercounts the
      // quads of any TreeView or Profile in the store.
      const { counts: stateCounts } = dehydrateStateToJsonLd(fx.store, join(scratchDir, '.state'));
      const { store: rehydrated, quadCount, danglingRefs } = rehydrateStore(scratchDir);
      // new: the old step printed the counts; with a tiny store a round trip of nothing would pass, so check there is something
      assert.ok(Object.keys(counts).length > 0 && fx.store.size > 0, `something was dehydrated: ${JSON.stringify(counts)}`);
      assert.ok(Object.values(stateCounts).some((n) => Number(n) > 0), `the tree view reached the state mirror: ${JSON.stringify(stateCounts)}`); // new
      assert.deepEqual(danglingRefs, [], 'zero dangling references after a round trip');
      assert.equal(quadCount, fx.store.size, 'the round-tripped store has the same quad count as the original');
      const artifact = wrap(fx.store, demo.demoId) as unknown as ArtifactNode;
      const rehydratedArtifact = wrap(rehydrated, demo.demoId) as unknown as ArtifactNode;
      assert.equal(rehydratedArtifact.title, artifact.title, 'the demo artifact keeps its title');
      assert.equal(rehydratedArtifact.id, artifact.id, 'the demo artifact keeps its id');
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});
