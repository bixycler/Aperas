// The flush of each graph of the service (planning/core.md, Batch 11, step 8 and piece 10): the service reads the flush interval of every graph from the table of settings
// and runs one timer for each, and a graph is flushed when it was written and not otherwise. The intervals here are set through the table (`aperas.config.json` above the
// scratch mirror: the main graph and the views every 60 s, the threads graph every 150 ms), so a timer is reached by the setting and the case waits for the file, never for a default
// interval; the file that must not change is checked for its bytes and its modification time at the moment the written one is seen. The cases are the defect of the old
// service (an `update` of a thread node marked only the content mirror, so `.state/` was not written until something else marked it), and they share the service and run in order.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';
import { buildCorpus, writeArtifact, type Corpus } from '../support/commandsCorpus.ts';
import { dumpMirror, isolateService, leftoverProcesses, serviceLog, startService, stopService, writeGraphIntervals, type ServiceIsolation } from '../support/serviceHarness.ts';
import { runIngest } from '../../kgIngest';
import { request } from '../../service/serviceClient';
import type { ServiceRequest } from '../../service/serviceProtocol';

const THREADS_MS = 150;
const SLOW_MS = 60_000;

/** Waits for a condition by polling every 20 ms, for at most `ms`; the wait ends at once when it holds. */
async function until(condition: () => boolean, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return condition();
}

describe('the flush of each graph', () => {
  let fx: FixtureStore;
  let iso: ServiceIsolation;
  let c: Corpus;
  let thread = '';
  const req = <T>(r: ServiceRequest): Promise<T> => request<T>(r);
  const mainFile = (): string => join(fx.apeironRoot, 'BlockNode.jsonld');
  const threadsFile = (): string => join(fx.apeironRoot, '.state', 'BlockNode.jsonld');
  const viewsFile = (): string => join(fx.apeironRoot, '.state', 'TreeView.jsonld');
  const text = (file: string): string => readFileSync(file, 'utf-8');
  const stamp = (file: string): string => `${statSync(file).mtimeMs}:${text(file).length}`;

  before(async () => {
    fx = makeFixtureStore('cmd_demo');
    c = buildCorpus(fx);
    writeArtifact(fx, '.threads/t.md', '# T\n\n- a\n- b\n');
    runIngest(fx.store, ['.threads/t.md'], true, false);
    thread = fx.store.maps.liveAtPath('.threads/t.md') ?? '';
    assert.ok(thread, 'the thread artifact was ingested');
    dumpMirror(fx);
    writeGraphIntervals(fx, { tree: SLOW_MS, 'threads.tree': THREADS_MS, treeviews: SLOW_MS });
    iso = await isolateService(fx);
    await startService(iso);
  });
  after(async () => {
    try { await stopService(iso); } finally {
      try { assert.deepEqual(leftoverProcesses(iso), [], 'no process of the test service is left'); } finally { fx.cleanup(); }
    }
  });

  test('the service reads the interval of each graph from the table of settings and says so in its log', () => {
    assert.ok(serviceLog(iso).some((l) => l.includes(`Flush intervals: tree ${SLOW_MS} ms, threads.tree ${THREADS_MS} ms, treeviews ${SLOW_MS} ms.`)), serviceLog(iso).join('\n'));
  });

  test('an update of a thread node alone reaches .state/ at the interval of the threads graph, and writes no other file', async () => {
    const before = { main: stamp(mainFile()), views: stamp(viewsFile()), threads: text(threadsFile()) };
    await req({ op: 'insert', path: thread, markdown: '## Timed Heading\n', flush: false, reload: false });
    await req({ op: 'update', path: 'Timed Heading', base: thread, markdown: 'Timed text of the thread.', textOnly: true, flush: false, reload: false });
    assert.ok(await until(() => text(threadsFile()).includes('Timed text of the thread.')), 'the timer of the threads graph wrote the update');
    assert.notEqual(text(threadsFile()), before.threads);
    assert.equal(stamp(mainFile()), before.main, 'the main graph was not written: its interval is 60 s');
    assert.equal(stamp(viewsFile()), before.views, 'the views graph was not written either');
  });

  test('an update of a thread node alone is written by flush: true, which is what the old service did not do', async () => {
    const before = { main: stamp(mainFile()), views: stamp(viewsFile()) };
    await req({ op: 'update', path: 'Timed Heading', base: thread, markdown: 'Flushed text of the thread.', textOnly: true, flush: true, reload: false });
    assert.ok(text(threadsFile()).includes('Flushed text of the thread.'), 'the file of the threads graph holds the update when the request answers');
    assert.equal(stamp(mainFile()), before.main, 'and the main graph was not written for it');
    assert.equal(stamp(viewsFile()), before.views);
  });

  test('a write of the main graph waits for its own interval, and the flush op writes it without touching the graphs that were not written', async () => {
    const before = { threads: stamp(threadsFile()), views: stamp(viewsFile()), main: text(mainFile()) };
    await req({ op: 'update', path: 'Item One', base: c.dup, markdown: 'Main graph text.', textOnly: true, flush: false, reload: false });
    await req({ op: 'update', path: 'Timed Heading', base: thread, markdown: 'Second text of the thread.', textOnly: true, flush: false, reload: false });
    assert.ok(await until(() => text(threadsFile()).includes('Second text of the thread.')), 'the threads graph is written by its timer');
    assert.equal(text(mainFile()), before.main, 'the main graph, written too, waits for its own interval of 60 s');
    assert.deepEqual(await req({ op: 'flush', clobber: false }), { clobbered: false });
    assert.ok(text(mainFile()).includes('Main graph text.'), 'the flush op writes the main graph');
    assert.equal(stamp(viewsFile()), before.views, 'the views graph was not written in all this');
    const threadsAfter = stamp(threadsFile());
    assert.notEqual(threadsAfter, before.threads);
    assert.deepEqual(await req({ op: 'flush', clobber: false }), { clobbered: false });
    assert.equal(stamp(threadsFile()), threadsAfter, 'a flush of a graph that was not written writes nothing');
  });

  test('a graph whose file changed outside refuses its flush and the others are flushed all the same, each on its own', async () => {
    await req({ op: 'update', path: 'Item One', base: c.dup, markdown: 'Refused main text.', textOnly: true, flush: false, reload: false });
    await req({ op: 'update', path: 'Timed Heading', base: thread, markdown: 'Third text of the thread.', textOnly: true, flush: false, reload: false });
    writeFileSync(mainFile(), text(mainFile()) + '\n'); // the main graph's file changes outside
    await assert.rejects(req({ op: 'flush', clobber: false }), /Refusing to flush: BlockNode\.jsonld changed on disk/);
    assert.ok(text(threadsFile()).includes('Third text of the thread.'), 'the threads graph was flushed though the main graph was refused');
    assert.ok(!text(mainFile()).includes('Refused main text.'), 'and the file changed outside is as the outside left it');
    assert.equal((await req<{ clobbered: boolean }>({ op: 'flush', clobber: true })).clobbered, true, 'flush --clobber is the way out');
    assert.ok(text(mainFile()).includes('Refused main text.'));
  });

  test('a view op writes the views graph (and the main graph, where a first-use profile is made), and not the threads graph', async () => {
    const before = { threads: stamp(threadsFile()) };
    await req({ op: 'unfold', ref: c.alphaArt, showTombstoned: false, flush: true, reload: false });
    assert.ok(text(viewsFile()).includes(c.alphaArt), 'the view unfolds the artifact in the views file');
    assert.equal(stamp(threadsFile()), before.threads, 'the threads graph was not written by a view op');
  });
});
