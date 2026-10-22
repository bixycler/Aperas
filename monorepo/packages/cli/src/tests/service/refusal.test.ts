// The service and a mirror the load did not read in full (design/core.md, "The service lifecycle"; planning/core.md, Batch 11 step 8): a flush after such a load would write each file whole
// and remove what was skipped, so the boot refuses to start and says which ids and files, and a reload refuses to replace the graph in memory. The mirror here carries one id in two
// documents (the load rejects both). The service is real, in the scratch directory of `support/serviceHarness.ts`, which asserts the run directory, the port and both roots before
// anything starts; the boot refusal runs `service.ts` directly and waits for its exit, the reload refusal uses a started service and stops it. The start-anyway option (`aperas service start
// --start-anyway`, `aperas reload --start-anyway`) accepts such a load: the documents the load skipped are copied to a side file next to their file before anything flushes, and the
// unaffected parts work.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';
import { buildCorpus, type Corpus } from '../support/commandsCorpus.ts';
import { assertIsolated, dumpMirror, isolateService, leftoverProcesses, rawRequest, readMirrorFile, serviceLog, startService, stopService, writeMirrorFile, type ServiceIsolation } from '../support/serviceHarness.ts';
import { getLockPath, readLock } from '../../service/serviceLock';
import { generateNodeId } from '@aperas/core/snowflake';

const SERVICE = join(import.meta.dirname, '..', '..', 'service', 'service.ts');

describe('a mirror the load did not read in full', () => {
  let fx: FixtureStore;
  let iso: ServiceIsolation;
  let c: Corpus;
  let good = '';
  let doubled = '';
  let dupId = '';
  const sideFiles = (): string[] => readdirSync(fx.apeironRoot).filter((n) => /^BlockNode\.jsonld\.rejected-.+\.json$/.test(n)).sort();
  const sideDocuments = (): Array<{ '@id': string }> => sideFiles().flatMap((n) => JSON.parse(readFileSync(join(fx.apeironRoot, n), 'utf-8')) as Array<{ '@id': string }>);
  const clearSideFiles = (): void => { for (const n of sideFiles()) rmSync(join(fx.apeironRoot, n)); };
  before(async () => {
    fx = makeFixtureStore('cmd_demo');
    c = buildCorpus(fx);
    dumpMirror(fx);
    iso = await isolateService(fx);
    good = readFileSync(join(fx.apeironRoot, 'BlockNode.jsonld'), 'utf-8');
    const docs = JSON.parse(good) as Array<Record<string, unknown>>;
    doubled = JSON.stringify([...docs, { ...docs[0]! }], null, 2) + '\n'; // one id in two documents
    dupId = docs[0]!['@id'] as string;
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

  test('aperas service start says why from the log when the service refuses, leaves no lock and no process', async () => {
    writeMirrorFile(iso, 'BlockNode', doubled);
    await assert.rejects(startService(iso), (e: unknown) => e instanceof Error && /REFUSING TO START/.test(e.message) && e.message.includes(dupId) && e.message.includes('--start-anyway'), 'the start fails with the reason from the log');
    assert.equal(existsSync(getLockPath()), false, 'no lock is left');
    // the `tsx` process that started the service ends a moment after its child
    for (const deadline = Date.now() + 5_000; Date.now() < deadline && leftoverProcesses(iso).length > 0; ) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(leftoverProcesses(iso), []);
    assert.deepEqual(sideFiles(), [], 'a refused start copies nothing');
    assert.equal(readMirrorFile(iso, 'BlockNode'), doubled, 'and writes nothing');
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

  describe('the start-anyway option', () => {
    test('a reload with the option accepts the load, copies the skipped documents to a side file before anything is flushed, and works on the unaffected parts', async () => {
      writeMirrorFile(iso, 'BlockNode', good);
      await rawRequest({ op: 'reload', discard: true });
      clearSideFiles();
      writeMirrorFile(iso, 'BlockNode', doubled);
      const res = await rawRequest({ op: 'reload', discard: false, startAnyway: true });
      assert.ok(res.ok, JSON.stringify(res));
      assert.equal(readMirrorFile(iso, 'BlockNode'), doubled, 'nothing was flushed by the reload');
      assert.equal(sideFiles().length, 1, sideFiles().join(', '));
      assert.deepEqual(sideDocuments().map((d) => d['@id']), [dupId, dupId], 'both documents that carried the id are in the side file, raw');
      assert.ok(serviceLog(iso).some((l) => l.includes('START-ANYWAY') && l.includes(dupId)), serviceLog(iso).join('\n'));
      assert.ok(serviceLog(iso).some((l) => l.includes('The documents the load skipped are copied to') && l.includes('BlockNode.jsonld.rejected-')));
      const shown = await rawRequest({ op: 'show', pathArg: dupId, reload: false });
      assert.ok(!shown.ok, 'the rejected node is not in memory');
      const made = await rawRequest({ op: 'insert', path: 'cmd_demo/gamma.md', markdown: '## Added After Start Anyway\n', flush: true, reload: false });
      assert.ok(made.ok, JSON.stringify(made));
      const after = readMirrorFile(iso, 'BlockNode');
      assert.ok(after.includes('Added After Start Anyway'), 'the unaffected parts work and flush');
      assert.ok(!after.includes(`"@id": "${dupId}"`), 'the first flush overwrote the file without the rejected documents');
      assert.deepEqual(sideDocuments().map((d) => d['@id']), [dupId, dupId], 'and the side file still holds them');
    });

    test('a second reload that meets the same documents copies nothing again', async () => {
      clearSideFiles();
      writeMirrorFile(iso, 'BlockNode', doubled);
      assert.ok((await rawRequest({ op: 'reload', discard: true, startAnyway: true })).ok);
      const first = sideFiles();
      assert.equal(first.length, 1);
      assert.ok((await rawRequest({ op: 'reload', discard: true, startAnyway: true })).ok);
      assert.deepEqual(sideFiles(), first, 'a copy with the same documents is already there');
      // an older copy of the same documents, under another stamp, counts too
      const older = 'BlockNode.jsonld.rejected-19990101T000000Z.json';
      writeFileSync(join(fx.apeironRoot, older), readFileSync(join(fx.apeironRoot, first[0]!), 'utf-8'));
      rmSync(join(fx.apeironRoot, first[0]!));
      assert.ok((await rawRequest({ op: 'reload', discard: true, startAnyway: true })).ok);
      assert.deepEqual(sideFiles(), [older], 'and no new copy is made beside it');
    });

    test('a document the engine refused is refused likewise, and the option copies it', async () => {
      clearSideFiles();
      const bogusId = `BlockNode:${generateNodeId()}`;
      const withBogus = JSON.stringify([...(JSON.parse(good) as unknown[]), { '@id': bogusId, '@type': 'BlockNode', title: 'Bogus', type: 'paragraph', children: [], notAField: 'x' }], null, 2) + '\n';
      writeMirrorFile(iso, 'BlockNode', good);
      assert.ok((await rawRequest({ op: 'reload', discard: true })).ok);
      writeMirrorFile(iso, 'BlockNode', withBogus);
      const refused = await rawRequest({ op: 'reload', discard: false });
      assert.ok(!refused.ok && refused.error.includes(bogusId) && refused.error.includes('the engine refused'), JSON.stringify(refused));
      assert.deepEqual(sideFiles(), [], 'a refused reload copies nothing');
      assert.ok((await rawRequest({ op: 'reload', discard: false, startAnyway: true })).ok);
      assert.deepEqual(sideDocuments().map((d) => d['@id']), [bogusId]);
      writeMirrorFile(iso, 'BlockNode', good);
      assert.ok((await rawRequest({ op: 'reload', discard: true })).ok);
    });

    test('the start with the option on a mirror the load did not read in full: it starts, copies first, names the ids, and a stop leaves nothing', async () => {
      await stopService(iso);
      clearSideFiles();
      writeMirrorFile(iso, 'BlockNode', doubled);
      await startService(iso, { startAnyway: true });
      assert.equal(readMirrorFile(iso, 'BlockNode'), doubled, 'no flush before the copy: the start flushes nothing');
      assert.deepEqual(sideDocuments().map((d) => d['@id']), [dupId, dupId]);
      const log = serviceLog(iso);
      const started = log.findLastIndex((l) => l.includes('START-ANYWAY'));
      assert.ok(started >= 0 && log[started]!.includes(dupId), log.join('\n'));
      assert.ok(log.slice(started).some((l) => l.includes('The documents the load skipped are copied to')));
      assert.ok(!log.some((l, i) => i > started && l.includes('REFUSING TO START')));
      assert.ok((await rawRequest({ op: 'ping' })).ok);
      await rawRequest({ op: 'flush', clobber: true });
      assert.ok(!readMirrorFile(iso, 'BlockNode').includes(`"@id": "${dupId}"`), 'the first flush removes them from the file');
      assert.deepEqual(sideDocuments().map((d) => d['@id']), [dupId, dupId]);
    });
  });
});
