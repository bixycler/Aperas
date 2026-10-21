// Dehydrate -> rehydrate round trip (step 7 of the legacy suite) on a tiny store: one ingested artifact and
// one tree view, dehydrated into a scratch directory (content mirror and state mirror) and rehydrated from
// there. The same round trip of the real mirror is a corpus check and stays out of this file.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rehydrateStore } from '@aperas/core/shell/store';
import { dehydrateToJsonLd, dehydrateStateToJsonLd } from '@aperas/core/shell/dehydrate';
import { ensureDefaultView } from '@aperas/core/shell/node';
import { firstLiteralOf } from '@aperas/core/shell/storeAccess';
import type { Store } from 'oxigraph';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';
import { ingestLinkedDemo, type LinkedDemo } from '../support/linkedDemo.ts';
import { oldStoreOf } from '../support/oldFixture.ts';

describe('dehydrate and rehydrate', () => {
  let fx: FixtureStore;
  let demo: LinkedDemo;
  /** The data of the fixture as the old engine holds it (`support/oldFixture.ts`): the frozen dehydrate and rehydrate act on a raw `Store`. */
  let store: Store;
  before(() => {
    fx = makeFixtureStore('roundtrip_demo');
    demo = ingestLinkedDemo(fx);
    // A tree view lives in the state mirror, which the content mirror alone does not carry; the old step ran
    // against a store that had one (the real mirror's), so the fixture has one too.
    ensureDefaultView(fx.store).unfold(demo.linkBlockId);
    store = oldStoreOf(fx);
  });
  after(() => fx.cleanup());

  test('7: a round trip through a scratch directory keeps every quad and the artifact identity', () => {
    const scratchDir = mkdtempSync(join(tmpdir(), 'apeironngn-verify-'));
    try {
      const { counts } = dehydrateToJsonLd(store, scratchDir);
      // The state mirror needs the same pass into the same directory, or the rehydrated side undercounts the
      // quads of any TreeView or Profile in the store.
      const { counts: stateCounts } = dehydrateStateToJsonLd(store, join(scratchDir, '.state'));
      const { store: rehydrated, quadCount, danglingRefs } = rehydrateStore(scratchDir);
      // new: the old step printed the counts; with a tiny store a round trip of nothing would pass, so check there is something
      assert.ok(Object.keys(counts).length > 0 && store.size > 0, `something was dehydrated: ${JSON.stringify(counts)}`);
      assert.ok(Object.values(stateCounts).some((n) => Number(n) > 0), `the tree view reached the state mirror: ${JSON.stringify(stateCounts)}`); // new
      assert.deepEqual(danglingRefs, [], 'zero dangling references after a round trip');
      assert.equal(quadCount, store.size, 'the round-tripped store has the same quad count as the original');
      assert.equal(firstLiteralOf(rehydrated, demo.demoId, 'title'), firstLiteralOf(store, demo.demoId, 'title'), 'the demo artifact keeps its title');
      assert.equal(firstLiteralOf(rehydrated, demo.demoId, 'path'), firstLiteralOf(store, demo.demoId, 'path'), 'the demo artifact keeps its path, and its id');
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});
