// A refused command leaves nothing behind, through the service (design/core.md, "A refused command leaves nothing behind"): the case that was seen live, `insert` under a parent with an anchor that is
// not its child, refused after the body was hydrated, and the leftover written by the next flush. The service is real, in the scratch directory of `support/serviceHarness.ts`. After each refusal the
// files of the mirror are as they were, a `flush` writes the same files, and a `reload` that reads them gives the same count of records. The command-level cases of every command are in
// `commands/refusedLeavesNothing.test.ts`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';
import { buildCorpus, type Corpus } from '../support/commandsCorpus.ts';
import { dumpMirror, isolateService, leftoverProcesses, rawRequest, startService, stopService, type ServiceIsolation } from '../support/serviceHarness.ts';

describe('a refused request leaves nothing behind in the service', () => {
  let fx: FixtureStore;
  let iso: ServiceIsolation;
  let c: Corpus;
  /** The text of every file of the mirror (the main graph and `.state/`), by name. */
  const mirror = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const dir of [fx.apeironRoot, join(fx.apeironRoot, '.state')]) {
      for (const name of readdirSync(dir).filter((n) => n.endsWith('.jsonld'))) out[join(dir, name)] = readFileSync(join(dir, name), 'utf-8');
    }
    return out;
  };
  const records = async (): Promise<number> => {
    const res = await rawRequest({ op: 'reload', discard: true });
    assert.ok(res.ok, JSON.stringify(res));
    return (res.result as { recordCount: number }).recordCount;
  };

  before(async () => {
    fx = makeFixtureStore('cmd_demo');
    c = buildCorpus(fx);
    dumpMirror(fx);
    iso = await isolateService(fx);
    await startService(iso);
  });
  after(async () => {
    try { await stopService(iso); } finally {
      try { assert.deepEqual(leftoverProcesses(iso), [], 'no process of the test service is left'); } finally { fx.cleanup(); }
    }
  });

  test('an insert whose anchor is not a child of the parent is refused, a later flush writes the files as they were, and a reload finds the same records', async () => {
    const files = mirror();
    const count = await records();
    const refusal = await rawRequest({ op: 'insert', path: c.dup, markdown: '## Stray\n\nText.\n', after: c.alphaSec, flush: false, reload: false });
    assert.ok(!refusal.ok && /is not a child of/.test(refusal.error), JSON.stringify(refusal));
    assert.ok((await rawRequest({ op: 'flush', clobber: true })).ok);
    assert.deepEqual(mirror(), files, 'the files of the mirror are as they were');
    assert.equal(await records(), count, 'and a reload of them gives the same records');
  });

  test('an unfold on the first use of the default view with a ref that does not resolve is refused, and no profile or view is written', async () => {
    const files = mirror();
    const refusal = await rawRequest({ op: 'unfold', ref: 'cmd_demo/nothing', showTombstoned: false, flush: true, reload: false });
    assert.ok(!refusal.ok && /isn't a tracked artifact/.test(refusal.error), JSON.stringify(refusal));
    assert.ok((await rawRequest({ op: 'flush', clobber: true })).ok);
    assert.deepEqual(mirror(), files);
  });
});
