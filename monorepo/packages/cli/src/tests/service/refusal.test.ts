// The service and a mirror the load did not read in full (design/core.md, "The service lifecycle"; planning/core.md, Batch 11 step 8): a flush after such a load would write each file whole
// and remove what was skipped, so the boot refuses to start and says which ids and files, and a reload refuses to replace the graph in memory. The mirror here carries one id in two
// documents (the load rejects both). The service is real, in the scratch directory of `support/serviceHarness.ts`, which asserts the run directory, the port and both roots before
// anything starts; the boot refusal runs `service.ts` directly and waits for its exit, the reload refusal uses a started service and stops it.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';
import { buildCorpus, type Corpus } from '../support/commandsCorpus.ts';
import { assertIsolated, dumpMirror, isolateService, leftoverProcesses, rawRequest, readMirrorFile, serviceLog, startService, stopService, writeMirrorFile, type ServiceIsolation } from '../support/serviceHarness.ts';
import { getLockPath, readLock } from '../../service/serviceLock';

const SERVICE = join(import.meta.dirname, '..', '..', 'service', 'service.ts');

describe('a mirror the load did not read in full', () => {
  let fx: FixtureStore;
  let iso: ServiceIsolation;
  let c: Corpus;
  let good = '';
  let doubled = '';
  before(async () => {
    fx = makeFixtureStore('cmd_demo');
    c = buildCorpus(fx);
    dumpMirror(fx);
    iso = await isolateService(fx);
    good = readFileSync(join(fx.apeironRoot, 'BlockNode.jsonld'), 'utf-8');
    const docs = JSON.parse(good) as Array<Record<string, unknown>>;
    doubled = JSON.stringify([...docs, { ...docs[0]! }], null, 2) + '\n'; // one id in two documents
  });
  after(async () => {
    try { await stopService(iso); } finally {
      try { assert.deepEqual(leftoverProcesses(iso), [], 'no process of the test service is left'); } finally { fx.cleanup(); }
    }
  });

  test('the boot refuses to start: it exits with a status, names the id in the log, and leaves no lock', () => {
    assertIsolated(iso);
    writeMirrorFile(iso, 'BlockNode', doubled);
    const dup = (JSON.parse(doubled) as Array<{ '@id': string }>)[0]!['@id'];
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), SERVICE], { encoding: 'utf8', env, timeout: 30_000, killSignal: 'SIGKILL' });
    assert.equal(r.status, 1, `${r.signal ?? ''} ${r.stdout}${r.stderr.slice(-500)}`);
    const refusal = serviceLog(iso).find((l) => l.includes('REFUSING TO START'));
    assert.ok(refusal && refusal.includes(dup) && refusal.includes('BlockNode.jsonld'), serviceLog(iso).join('\n'));
    assert.equal(existsSync(getLockPath()), false, 'no lock is left');
    assert.deepEqual(leftoverProcesses(iso), []);
  });

  test('a reload refuses to replace the graph: the error names the id, the memory is kept and the service answers', async () => {
    writeMirrorFile(iso, 'BlockNode', good);
    await startService(iso);
    const before = await rawRequest({ op: 'tree', pathArg: 'cmd_demo/alpha.md', noHolders: false, showTombstoned: false, reload: false });
    assert.ok(before.ok);
    writeMirrorFile(iso, 'BlockNode', doubled);
    const dup = (JSON.parse(doubled) as Array<{ '@id': string }>)[0]!['@id'];
    for (const discard of [false, true]) {
      const res = await rawRequest({ op: 'reload', discard });
      assert.ok(!res.ok && /^Refusing to reload: the mirror was not read in full/.test(res.error) && res.error.includes(dup), JSON.stringify(res));
    }
    assert.ok(serviceLog(iso).some((l) => l.includes('Reload refused, the graph in memory is kept')), serviceLog(iso).join('\n'));
    const after = await rawRequest({ op: 'tree', pathArg: 'cmd_demo/alpha.md', noHolders: false, showTombstoned: false, reload: false });
    assert.deepEqual(after.ok && after.result, before.ok && before.result, 'the graph in memory is the one before');
    assert.equal(readMirrorFile(iso, 'BlockNode'), doubled, 'and the file is as the outside wrote it');
    assert.ok(readLock() && c.alpha);
    writeFileSync(join(fx.apeironRoot, 'BlockNode.jsonld'), good); // so that the stop's flush finds the file it knows
  });
});
