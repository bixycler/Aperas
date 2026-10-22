// Corpus check: the sweeps of the service on a migrated copy of the real mirror (planning/core.md, Batch 11 piece 10): the boot rule over the containers and the engine's sweep of
// each graph remove the unreachable tombstones and no live node, a second sweep finds nothing, the mirror the flush would write loads again with nothing left to sweep and nothing
// the load refuses, and the service's best-effort release of a replaced handle (`closeDb`) drops at least the views. The copy is made once for the file (`makeCorpusCopy`), the
// real mirror is only read.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, liveIdsOfKind, openDb } from '@aperas/core/shell/db';
import { dumpMirror } from '@aperas/core/shell/mirrorDump';
import { sweepTombstones, tombstoneVacuousContainers } from '@aperas/core/shell/node';
import { VIEWS } from '../support/mirrorFixture.ts';
import { makeCorpusCopy, type CorpusCopy } from '../support/corpus.ts';

const KINDS = ['BlockNode', 'ArtifactNode', 'FolderNode', 'Profile', 'TreeView'];

describe('corpus: the sweeps on a copy of the real mirror', () => {
  let copy: CorpusCopy;
  let live: Record<string, string[]>;
  let swept: ReturnType<typeof sweepTombstones>;
  before(() => {
    copy = makeCorpusCopy();
    live = Object.fromEntries(KINDS.map((k) => [k, liveIdsOfKind(copy.store, k)]));
  });
  after(() => copy.cleanup());

  test('the load of the copy reads it in full', () => {
    assert.deepEqual({ rejected: copy.load.rejected, errors: copy.load.errors.slice(0, 3), dangling: copy.danglingRefs.slice(0, 3) }, { rejected: [], errors: [], dangling: [] });
  });

  test('the boot rule and the sweep of each graph remove unreachable tombstones only: every live node stays, and a second sweep finds nothing', () => {
    const t = Date.now();
    const vacuous = tombstoneVacuousContainers(copy.store);
    swept = sweepTombstones(copy.store);
    console.log(`sweeps: ${Date.now() - t} ms, vacuous ${vacuous.tombstoned}, swept ${JSON.stringify(swept)}`);
    assert.deepEqual(Object.keys(swept.byGraph), copy.store.graphs);
    assert.equal(swept.pruned, Object.values(swept.byGraph).reduce((n, k) => n + k, 0));
    for (const kind of KINDS) {
      const after = liveIdsOfKind(copy.store, kind);
      assert.deepEqual(after.filter((id) => !live[kind]!.includes(id)), [], `${kind}: no node became live`);
      const lost = live[kind]!.filter((id) => !after.includes(id));
      assert.equal(lost.length, kind === 'BlockNode' ? vacuous.tombstoned : 0, `${kind}: the live nodes that left are the vacuous containers the boot rule tombstoned, and no others`);
    }
    assert.deepEqual(tombstoneVacuousContainers(copy.store), { tombstoned: 0 });
    assert.equal(sweepTombstones(copy.store).pruned, 0, 'a second sweep finds nothing');
  });

  test('the mirror the flush would write loads again with nothing to sweep, nothing refused and the same live nodes', () => {
    dumpMirror(copy.store.engine, copy.apeironRoot, copy.store.mapping); // the mapping of the copy names the files of the copy: they are written over
    const reloaded = openDb(copy.apeironRoot);
    assert.deepEqual({ rejected: reloaded.load.rejected, errors: reloaded.load.errors.slice(0, 3) }, { rejected: [], errors: [] });
    assert.deepEqual(tombstoneVacuousContainers(reloaded.db), { tombstoned: 0 });
    assert.equal(sweepTombstones(reloaded.db).pruned, 0);
    for (const kind of KINDS) assert.deepEqual(liveIdsOfKind(reloaded.db, kind), liveIdsOfKind(copy.store, kind), `${kind}: the live nodes`);
    closeDb(reloaded.db);
  });

  test('closeDb drops at least the views graph of the handle it replaces', () => {
    const dropped = closeDb(copy.store);
    console.log(`closeDb: ${JSON.stringify(dropped)}`);
    assert.equal(dropped[0], VIEWS);
  });
});
