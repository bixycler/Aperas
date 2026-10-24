// The refusal of a mirror the load did not read in full, when many documents are refused (the packaging fixes before 0.3.0): the refusal printed by `aperas service start` and by `aperas reload` names at most
// 20 ids and says how many there are, and where the full list is (`service.log` in the run directory), instead of one id after another for a whole unmigrated mirror (72.8 KB for this project's own). The service
// log holds the full list. The mirror here carries 35 refused documents in all: ids in two documents each (the load rejects both; as many as the fixture holds, up to 30) and, for the rest, documents the engine refuses. The service is real, in the scratch directory of
// `support/serviceHarness.ts`, which asserts the run directory, the port and both roots before anything starts.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';
import { buildCorpus } from '../support/commandsCorpus.ts';
import { dumpMirror, isolateService, leftoverProcesses, rawRequest, serviceLog, startService, stopService, writeMirrorFile, type ServiceIsolation } from '../support/serviceHarness.ts';
import { getLockPath } from '../../service/serviceLock';
import { generateNodeId } from '@aperas/core/snowflake';

describe('a refusal that names many documents', () => {
  let fx: FixtureStore;
  let iso: ServiceIsolation;
  let good = '';
  let many = '';
  let doubledIds: string[] = [];
  let bogusIds: string[] = [];
  before(async () => {
    fx = makeFixtureStore('cmd_demo');
    buildCorpus(fx);
    dumpMirror(fx);
    iso = await isolateService(fx);
    good = readFileSync(join(fx.apeironRoot, 'BlockNode.jsonld'), 'utf-8');
    const docs = JSON.parse(good) as Array<Record<string, unknown>>;
    doubledIds = docs.slice(0, 30).map((d) => d['@id'] as string); // as many as the fixture holds, up to 30
    bogusIds = Array.from({ length: 35 - doubledIds.length }, () => `BlockNode:${generateNodeId()}`);
    const bogus = bogusIds.map((id) => ({ '@id': id, '@type': 'BlockNode', title: 'Bogus', type: 'paragraph', children: [], notAField: 'x' }));
    many = JSON.stringify([...docs, ...docs.slice(0, doubledIds.length).map((d) => ({ ...d })), ...bogus], null, 2) + '\n';
  });
  after(async () => {
    try { await stopService(iso); } finally {
      try { assert.deepEqual(leftoverProcesses(iso), [], 'no process of the test service is left'); } finally { fx.cleanup(); }
    }
  });

  /** How many of `ids` the text names. */
  const named = (text: string, ids: string[]): number => ids.filter((id) => text.includes(id)).length;

  test('the start names 20 ids at most and the count, says where the full list is, and the log holds them all', async () => {
    writeMirrorFile(iso, 'BlockNode', many);
    let message = '';
    await assert.rejects(startService(iso), (e: unknown) => { message = (e as Error).message; return e instanceof Error; });
    assert.match(message, /REFUSING TO START/);
    // the ids of the embedded links and props of a doubled document are refused with it, so the total is more than the 35 documents
    const [, shown, total] = /(\d+) of (\d+) named, (\d+) more not shown/.exec(message)!.map(Number) as [number, number, number];
    assert.equal(shown, 20);
    assert.ok(total >= 35, `${total} refused`);
    assert.match(message, new RegExp(`${total - 20} more not shown`));
    assert.match(message, /id\(s\) carried by more than one document/);
    assert.ok(message.includes(join(iso.runDir, 'service.log')), 'names the log');
    assert.match(message, /--start-anyway/);
    const all = [...doubledIds, ...bogusIds];
    assert.ok(named(message, all) <= 20, 'at most 20 ids are named');
    assert.ok(named(message, all) >= 10, 'and the refusal does name some');
    assert.ok(message.length < 8_000, `the refusal is ${message.length} characters`);
    const full = serviceLog(iso).find((l) => l.includes('Refused documents, the full list'));
    assert.ok(full, serviceLog(iso).join('\n'));
    assert.equal(named(full!, all), 35, 'the log names all 35 documents');
    assert.equal(existsSync(getLockPath()), false, 'no lock is left');
  });

  test('a refused reload says the same, in the same few lines, and keeps the graph', async () => {
    writeMirrorFile(iso, 'BlockNode', good);
    await startService(iso);
    writeMirrorFile(iso, 'BlockNode', many);
    const res = await rawRequest({ op: 'reload', discard: false });
    assert.ok(!res.ok);
    if (res.ok) return;
    assert.match(res.error, /^Refusing to reload: the mirror was not read in full/);
    assert.match(res.error, /20 of \d+ named, \d+ more not shown; the full list is in .*service\.log/);
    assert.ok(named(res.error, [...doubledIds, ...bogusIds]) <= 20);
    const full = serviceLog(iso).find((l) => l.includes('Reload refused, the graph in memory is kept'));
    assert.equal(named(full ?? '', [...doubledIds, ...bogusIds]), 35, 'the log holds the full list');
    writeMirrorFile(iso, 'BlockNode', good);
  });
});
