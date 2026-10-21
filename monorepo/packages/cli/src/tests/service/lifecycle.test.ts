// The life of the service before the service moves to the engine (planning/core.md, Batch 11, step 10 for step 8): the start on a mirror with something to
// sweep, the sweeps (a vacuous container, an unreachable tombstone, a stale unfold) at boot, reload, clobber and shutdown, the standing link warning at boot
// and reload, the divergence guard (a flush refused when a file of the mirror changed outside, `flush --clobber` and `reload --discard` as the two ways out),
// the thread size cap, and the stop. The service is real, started from source in a scratch directory (`support/serviceHarness.ts`); the runtime directory, the port
// and both roots are asserted to be scratch ones before anything starts, and the last case finds no process left. The cases share the service and run in order;
// the shutdowns and the second boot come last. The timers (a flush every 10 s, the state flush every 3 s, the idle exit after 30 minutes) are not reached
// here: the file runs in a few seconds, and `ops.test.ts` names them as waived. A stale unfold that a sweep clears after the boot is a file of the state mirror
// written from outside and read by a reload first (a sweep runs on the memory, before the read).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';
import { buildCorpus, writeArtifact, type Corpus } from '../support/commandsCorpus.ts';
import {
  assertIsolated, dumpMirror, isolateService, leftoverProcesses, rawRequest, readMirrorFile, serviceLog, startService, stopService, withStderr, writeMirrorFile,
  type ServiceIsolation,
} from '../support/serviceHarness.ts';
import { runIngest } from '../../kgIngest';
import { runStart } from '../../kgService';
import { request, ping } from '../../service/serviceClient';
import { CONFLICT_RESOLUTION_HINT, type ServiceRequest } from '../../service/serviceProtocol';
import { readLock } from '../../service/serviceLock';
import { wrap, tombstoneVacuousContainers, pruneUnreachableTombstones, pruneStaleUnfolds, resolveTreeView, type BlockNode } from '@aperas/core/shell/node';
import { nodeIri, predIri } from '@aperas/core/shell/vocab';
import { dehydrateToJsonLd, dehydrateStateToJsonLd } from '@aperas/core/shell/dehydrate';
import { rehydrateStore } from '@aperas/core/shell/store';
import { generateNodeId } from '@aperas/core/snowflake';
import { runUnfold } from '../../kgUnfold';
import { findByExactPath } from '@aperas/core/shell/tree';
import type { Store } from 'oxigraph';

const THREAD_CAP = 3;
/** What the sweep prunes once a fodder artifact is removed: its heading. The removal tombstones the artifact and its blocks; the artifact stays (its folder still reaches it), the heading is unreachable. */
const FODDER_PRUNED = 1;

interface Fodder { artifactPath: string; list: string; item: string }
interface Seed {
  c: Corpus;
  /** A tombstoned block nothing live reaches: the boot prunes it. */
  orphan: string;
  /** A list whose only item is tombstoned: the boot tombstones the list. */
  vacuous: string;
  /** An id a view unfolds that has no node: the boot clears the unfold. */
  ghost: string;
  /** One artifact and one list with a live item per sweep that runs after the boot: remove both and the sweep has something to count. */
  fodder: Fodder[];
  /** The thread artifact `.threads/t.md`, over the cap. */
  thread: string;
  /** The `BlockNode.jsonld` of the mirror as it is after the boot sweeps with the dropped link restored: what a repair of the mirror outside would leave. */
  goodBytes: string;
  /** The `.state/TreeView.jsonld` of the mirror before the boot sweeps: the view unfolds the ghost. Written over the file, it gives a reload a stale unfold to read. */
  staleState: string;
}

/** Adds a `list` block under `parentId` holding one `listItem`, built directly on the store; `tombstoned` tombstones the item. */
function addList(store: Store, parentId: string, text: string, tombstoned: boolean): { list: string; item: string } {
  const list = wrap(store, `BlockNode:${generateNodeId()}`) as unknown as BlockNode;
  list.type = 'list';
  const item = wrap(store, `BlockNode:${generateNodeId()}`) as unknown as BlockNode;
  item.type = 'listItem';
  item.text = text;
  if (tombstoned) item.tombstonedAt = new Date().toISOString();
  list.children = [item] as unknown as typeof list.children;
  const parent = wrap(store, parentId) as unknown as BlockNode;
  parent.children = [...(parent.children ?? []), list] as unknown as typeof parent.children;
  return { list: list.id, item: item.id };
}

/**
 * The mirror the first boot reads: the corpus of the command tests; a vacuous list, an unreachable tombstone and a stale unfold for the boot to sweep; four
 * fodder pairs for the later sweeps; a thread artifact over the cap; and one dropped link, which the boot's link sweep reports.
 */
function buildSeed(fx: FixtureStore): Seed {
  const c = buildCorpus(fx);
  const fodder: Fodder[] = [];
  for (const k of [1, 2, 3, 4]) {
    const artifactPath = `cmd_demo/f${k}.md`;
    writeArtifact(fx, artifactPath, `# F${k}\n\nFodder ${k}.\n`);
    runIngest(fx.store, [artifactPath], true, false);
    fodder.push({ artifactPath, ...addList(fx.store, c.alpha, `fodder ${k}`, false) });
  }
  writeArtifact(fx, '.threads/t.md', '# T\n\n- a\n- b\n- c\n');
  runIngest(fx.store, ['.threads/t.md'], true, false);
  const thread = findByExactPath(fx.store, '.threads/t.md');
  if (!thread) throw new Error('The thread artifact was not ingested.');

  const vacuous = addList(fx.store, c.alpha, 'gone', true).list;
  const orphanNode = wrap(fx.store, `BlockNode:${generateNodeId()}`) as unknown as BlockNode;
  orphanNode.type = 'heading'; orphanNode.title = 'Orphan'; orphanNode.children = []; orphanNode.tombstonedAt = new Date().toISOString();
  const ghostNode = wrap(fx.store, `BlockNode:${generateNodeId()}`) as unknown as BlockNode;
  ghostNode.type = 'paragraph'; ghostNode.text = 'ghost';
  runUnfold(fx.store, ghostNode.id, resolveTreeView(fx.store)); // the view now unfolds the ghost
  for (const q of [...fx.store.match(nodeIri(ghostNode.id), null, null, null)]) fx.store.delete(q); // and the ghost has no node

  const variants = join(fx.root, 'variants');
  mkdirSync(join(variants, '.state'), { recursive: true });
  dehydrateToJsonLd(fx.store, variants);
  dehydrateStateToJsonLd(fx.store, join(variants, '.state'));

  // The dropped link: the block keeps its text, loses the pointer to one of its two links.
  for (const q of [...fx.store.match(nodeIri(c.alpha), predIri('links'), nodeIri(c.alphaLinkToBeta), null)]) fx.store.delete(q);
  dumpMirror(fx);

  // What the mirror looks like after the boot sweeps, with the link intact: the variants (link intact) rehydrated and swept in process.
  const g = rehydrateStore(variants, join(variants, '.state')).store;
  tombstoneVacuousContainers(g); pruneUnreachableTombstones(g); pruneStaleUnfolds(g);
  const clean = join(fx.root, 'clean');
  mkdirSync(join(clean, '.state'), { recursive: true });
  dehydrateToJsonLd(g, clean);
  return {
    c, orphan: orphanNode.id, vacuous, ghost: ghostNode.id, fodder, thread, goodBytes: readFileSync(join(clean, 'BlockNode.jsonld'), 'utf-8'),
    staleState: readFileSync(join(variants, '.state', 'TreeView.jsonld'), 'utf-8'),
  };
}

describe('service lifecycle', () => {
  let fx: FixtureStore;
  let iso: ServiceIsolation;
  let seed: Seed;
  let brokenBytes = '';
  const req = <T>(r: ServiceRequest): Promise<T> => request<T>(r);
  const stateFile = (kind: string): string => readFileSync(join(fx.apeironRoot, '.state', `${kind}.jsonld`), 'utf-8');
  const writeStateFile = (kind: string, text: string): void => writeFileSync(join(fx.apeironRoot, '.state', `${kind}.jsonld`), text, 'utf-8');
  const hasGcLine = (counts: string): boolean => serviceLog(iso).some((l) => l.includes(`Startup GC: cleaned ${counts}.`));
  const fail = async (r: ServiceRequest): Promise<string> => {
    const res = await rawRequest(r);
    assert.equal(res.ok, false, `expected the request to be refused: ${JSON.stringify(res)}`);
    return res.ok ? '' : res.error;
  };
  /** Removes a fodder artifact and the item of a fodder list: the list becomes vacuous and the artifact's nodes unreachable tombstones. Nothing is flushed. */
  const removeFodder = async (f: Fodder): Promise<void> => {
    await req({ op: 'remove', path: f.artifactPath, flush: false, reload: false });
    await req({ op: 'remove', path: f.item, flush: false, reload: false });
  };

  before(async () => {
    fx = makeFixtureStore('cmd_demo');
    seed = buildSeed(fx);
    iso = await isolateService(fx, { threadSizeCap: THREAD_CAP });
    assert.deepEqual(leftoverProcesses(iso), [], 'no service of this scratch directory runs before the test starts one');
  });
  after(async () => {
    try { await stopService(iso); } finally {
      try { assert.deepEqual(leftoverProcesses(iso), [], 'no process of the test service is left'); } finally { fx.cleanup(); }
    }
  });

  describe('the isolation', () => {
    test('the checks refuse a run directory, a port or a root that is not the scratch one, and pass the scratch ones', () => {
      assertIsolated(iso);
      assert.throws(() => assertIsolated({ ...iso, port: 2736 }), /working service|not the scratch/);
      assert.throws(() => assertIsolated({ ...iso, runDir: iso.ambient.runDir }), /not the scratch|working one/);
      assert.throws(() => assertIsolated({ ...iso, ambient: { ...iso.ambient, port: iso.port } }), /working service's/);
      const saved = process.env.APERAS_APEIRON_ROOT;
      try {
        process.env.APERAS_APEIRON_ROOT = join(fx.root, '..', 'elsewhere');
        assert.throws(() => assertIsolated(iso), /not the scratch ones/);
      } finally { process.env.APERAS_APEIRON_ROOT = saved; }
      assertIsolated(iso);
    });

    test('nothing answers or is locked on the scratch socket before the start', async () => {
      assert.equal(readLock(), null);
      assert.equal(await ping(), false);
    });
  });

  describe('the start, on a mirror with something to sweep', () => {
    test('start spawns one service bound to the scratch roots and leaves a ready lock', async () => {
      const pid = await startService(iso);
      const lock = readLock()!;
      assert.deepEqual([lock.pid, lock.status, lock.apeironRoot, lock.artifactsRoot, lock.httpPort], [pid, 'ready', fx.apeironRoot, fx.artifactsRoot, iso.port]);
      assert.ok(leftoverProcesses(iso).includes(pid), 'the pid of the lock is among the processes of the scratch service');
      assert.equal(await ping(), true);
    });

    test('the boot sweeps the three kinds, counts them in the log, and flushes at once', () => {
      assert.ok(serviceLog(iso).some((l) => /Rehydrated \d+ quad\(s\) from /.test(l) && l.includes(fx.apeironRoot)), serviceLog(iso).join('\n'));
      assert.ok(hasGcLine('1 unreachable tombstone(s), 1 vacuous container(s), 1 stale unfold(s)'), serviceLog(iso).join('\n'));
      const blocks = readMirrorFile(iso, 'BlockNode');
      assert.ok(!blocks.includes(seed.orphan), 'the unreachable tombstone is pruned from the file');
      const vacuous = (JSON.parse(blocks) as Array<{ '@id': string; tombstonedAt?: string }>).find((d) => d['@id'] === seed.vacuous);
      assert.ok(vacuous?.tombstonedAt, 'the vacuous list is tombstoned in the file');
      assert.ok(!stateFile('TreeView').includes(seed.ghost), 'the stale unfold is cleared from the state file');
      brokenBytes = blocks;
    });

    test('nothing is left pending after the boot flush: a flush has nothing to write', async () => {
      const before = readMirrorFile(iso, 'BlockNode');
      assert.deepEqual(await req({ op: 'flush', clobber: false }), { clobbered: false });
      assert.equal(readMirrorFile(iso, 'BlockNode'), before);
    });

    test('start again finds the service and starts nothing', async () => {
      assertIsolated(iso);
      const lockBefore = readLock()!;
      const processes = leftoverProcesses(iso);
      const log = console.log;
      const lines: string[] = [];
      console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
      try { await runStart(); } finally { console.log = log; }
      assert.ok(lines.some((l) => l.includes(`Already running (pid ${lockBefore.pid})`)), lines.join('\n'));
      assert.deepEqual(readLock(), lockBefore);
      assert.deepEqual(leftoverProcesses(iso), processes);
    });
  });

  describe('the standing link warning', () => {
    test('the boot sweep found the dropped link: the warning rides on a response of any op, and the client prints it', async () => {
      const res = await rawRequest({ op: 'ping' });
      assert.ok(res.ok && res.linkWarning !== undefined, JSON.stringify(res));
      const warning = res.ok ? res.linkWarning! : '';
      assert.match(warning, /^1 live block\(s\) cite a resolvable target that's missing from their own '\.links' \(found at startup\): /);
      assert.ok(warning.includes(seed.c.alpha), warning);
      assert.ok(serviceLog(iso).some((l) => l.includes('LINK INTEGRITY:') && l.includes(seed.c.alpha)));
      const { stderr } = await withStderr(() => req({ op: 'path', idArg: seed.c.betaSec, reload: false }));
      assert.ok(stderr.some((l) => l.startsWith('[ApeironNgn service] LINK INTEGRITY: 1 live block(s)') && l.includes(seed.c.alpha)), stderr.join('\n'));
    });

    test('reload sweeps again: the warning clears when the mirror outside has the link, and comes back (found at reload) when it loses it', async () => {
      writeMirrorFile(iso, 'BlockNode', seed.goodBytes);
      await req({ op: 'reload', discard: false });
      let res = await rawRequest({ op: 'ping' });
      assert.ok(res.ok && res.linkWarning === undefined, JSON.stringify(res));
      const { stderr: quiet } = await withStderr(() => req({ op: 'ping' }));
      assert.deepEqual(quiet.filter((l) => l.includes('LINK INTEGRITY')), []);

      writeMirrorFile(iso, 'BlockNode', brokenBytes);
      await req({ op: 'reload', discard: false });
      res = await rawRequest({ op: 'ping' });
      assert.ok(res.ok && res.linkWarning?.includes('(found at reload)') && res.linkWarning.includes(seed.c.alpha), JSON.stringify(res));

      writeMirrorFile(iso, 'BlockNode', seed.goodBytes);
      await req({ op: 'reload', discard: false });
      res = await rawRequest({ op: 'ping' });
      assert.ok(res.ok && res.linkWarning === undefined, JSON.stringify(res));
    });
  });

  describe('the thread size cap', () => {
    test('a write to a thread artifact over the cap carries the warning, and the client prints it; the same size outside the threads does not', async () => {
      const plain = await req<{ threadSize?: unknown }>({ op: 'insert', path: 'cmd_demo/dup.md/Dup', markdown: '## Item Three\n', flush: true, reload: false });
      assert.equal(plain.threadSize, undefined, 'cmd_demo/dup.md is over the cap too, but is not a thread');
      const { result, stderr } = await withStderr(() => req<{ lines: string[]; threadSize?: { count: number; cap: number; artifactPath: string | null } }>({ op: 'insert', path: seed.thread, markdown: '# Four\n', flush: true, reload: false }));
      assert.equal(result.threadSize?.cap, THREAD_CAP);
      assert.equal(result.threadSize?.artifactPath, '.threads/t.md');
      assert.ok(result.threadSize!.count > THREAD_CAP, JSON.stringify(result.threadSize));
      assert.ok(stderr.some((l) => l.startsWith(`[ApeironNgn service] THREAD SIZE: '.threads/t.md' has ${result.threadSize!.count} live block(s), over its cap of ${THREAD_CAP}`)), stderr.join('\n'));
    });
  });

  describe('the divergence guard', () => {
    let external = '';
    test('a file of the mirror changed outside refuses the flush, keeps the file as it is and keeps the local change pending', async () => {
      await req({ op: 'insert', path: 'cmd_demo/dup.md/Dup', markdown: '## Pending One\n', flush: false, reload: false });
      external = readMirrorFile(iso, 'BlockNode') + '\n';
      writeMirrorFile(iso, 'BlockNode', external);
      const error = await fail({ op: 'flush', clobber: false });
      assert.ok(error.includes('Refusing to flush: BlockNode.jsonld changed on disk since this service last read it'), error);
      assert.ok(error.includes(CONFLICT_RESOLUTION_HINT), 'the refusal says how to resolve it');
      assert.equal(readMirrorFile(iso, 'BlockNode'), external, 'the file the outside wrote is untouched');
      const lines = await req<string[]>({ op: 'tree', pathArg: 'cmd_demo/dup.md', noHolders: false, showTombstoned: false, reload: false });
      assert.ok(lines.some((l) => l.includes('## Pending One')), 'the local change is still in memory');
    });

    test('a write with flush: true is refused the same way, and the conflict rides on the next response of any op, which the client prints', async () => {
      const error = await fail({ op: 'insert', path: 'cmd_demo/dup.md/Dup', markdown: '## Pending Two\n', flush: true, reload: false });
      assert.ok(error.startsWith('Refusing to flush: BlockNode.jsonld changed on disk'), error);
      const res = await rawRequest({ op: 'ping' });
      assert.ok(res.ok && res.conflict?.content?.startsWith('BlockNode.jsonld changed on disk since this service last read it'), JSON.stringify(res));
      assert.equal(res.ok ? res.conflict?.state : 'x', undefined);
      const { stderr } = await withStderr(() => req({ op: 'ping' }));
      assert.ok(stderr.some((l) => l.startsWith('[ApeironNgn service] UNRESOLVED CONFLICT (content mirror): BlockNode.jsonld')), stderr.join('\n'));
      assert.ok(stderr.includes(`[ApeironNgn service] ${CONFLICT_RESOLUTION_HINT}`));
    });

    test('a reload that is not a discard refuses too, for it would flush first', async () => {
      assert.match(await fail({ op: 'reload', discard: false }), /^Refusing to flush: BlockNode\.jsonld changed on disk/);
      assert.equal(readMirrorFile(iso, 'BlockNode'), external);
    });

    test('flush --clobber writes the local state over the file and clears the conflict', async () => {
      const r = await req<{ clobbered: boolean }>({ op: 'flush', clobber: true });
      assert.equal(r.clobbered, true);
      const file = readMirrorFile(iso, 'BlockNode');
      assert.notEqual(file, external);
      assert.ok(file.includes('Pending One') && file.includes('Pending Two'), 'both local changes reached the file');
      const res = await rawRequest({ op: 'ping' });
      assert.ok(res.ok && res.conflict === undefined, JSON.stringify(res));
    });

    test('reload --discard takes the file as it is and drops the pending local change, and clears the conflict', async () => {
      await req({ op: 'insert', path: 'cmd_demo/dup.md/Dup', markdown: '## Pending Three\n', flush: false, reload: false });
      external = readMirrorFile(iso, 'BlockNode') + '\n';
      writeMirrorFile(iso, 'BlockNode', external);
      await fail({ op: 'flush', clobber: false });
      const r = await req<{ prunedTombstones: number; tombstonedContainers: number; prunedUnfolds: number }>({ op: 'reload', discard: true });
      assert.deepEqual([r.prunedTombstones, r.tombstonedContainers, r.prunedUnfolds], [0, 0, 0], 'a discard sweeps nothing');
      const lines = await req<string[]>({ op: 'tree', pathArg: 'cmd_demo/dup.md', noHolders: false, showTombstoned: false, reload: false });
      assert.ok(lines.some((l) => l.includes('## Pending One')), 'what the file held is the state now');
      assert.ok(!lines.some((l) => l.includes('## Pending Three')), 'the pending change is gone');
      assert.equal(readMirrorFile(iso, 'BlockNode'), external, 'and the file is as the outside left it');
      const res = await rawRequest({ op: 'ping' });
      assert.ok(res.ok && res.conflict === undefined, JSON.stringify(res));
    });

    test('a file of the state mirror changed outside refuses the flush of the state alone, names it, and flush --clobber is the way out', async () => {
      await req({ op: 'unfold', ref: 'cmd_demo/alpha.md', showTombstoned: false, flush: false, reload: false }); // the default view: the state mirror is pending
      const external = stateFile('TreeView') + '\n';
      writeStateFile('TreeView', external);
      const error = await fail({ op: 'flush', clobber: false });
      assert.ok(error.startsWith('Refusing to flush: .state/TreeView.jsonld changed on disk since this service last read it'), error);
      assert.ok(error.includes(CONFLICT_RESOLUTION_HINT));
      assert.equal(stateFile('TreeView'), external, 'the file the outside wrote is untouched');
      const res = await rawRequest({ op: 'ping' });
      assert.ok(res.ok && res.conflict?.state?.startsWith('.state/TreeView.jsonld changed on disk') && res.conflict.content === undefined, JSON.stringify(res));
      const { stderr } = await withStderr(() => req({ op: 'ping' }));
      assert.ok(stderr.some((l) => l.startsWith('[ApeironNgn service] UNRESOLVED CONFLICT (.state mirror): .state/TreeView.jsonld')), stderr.join('\n'));
      assert.equal((await req<{ clobbered: boolean }>({ op: 'flush', clobber: true })).clobbered, true);
      assert.notEqual(stateFile('TreeView'), external);
      const after = await rawRequest({ op: 'ping' });
      assert.ok(after.ok && after.conflict === undefined, JSON.stringify(after));
    });
  });

  describe('the sweeps after the boot', () => {
    test('flush --clobber sweeps first, counts what it swept, and writes the result', async () => {
      await removeFodder(seed.fodder[0]);
      const r = await req<{ clobbered: boolean; prunedTombstones: number; tombstonedContainers: number; prunedUnfolds: number }>({ op: 'flush', clobber: true });
      assert.equal(r.clobbered, true);
      assert.deepEqual([r.prunedTombstones, r.tombstonedContainers, r.prunedUnfolds], [FODDER_PRUNED, 1, 0]);
      assert.ok(!readMirrorFile(iso, 'BlockNode').includes('Fodder 1.'), 'the heading is gone from the mirror, not only tombstoned');
      const artifact = (JSON.parse(readMirrorFile(iso, 'ArtifactNode')) as Array<{ path?: string; tombstonedAt?: string }>).find((d) => d.path === seed.fodder[0].artifactPath);
      assert.ok(artifact?.tombstonedAt, 'the artifact itself stays, tombstoned');
      assert.ok(readMirrorFile(iso, 'BlockNode').includes(seed.fodder[0].list), 'the vacuous list is kept, tombstoned');
    });

    test('reload sweeps first, counts what it swept, flushes it, and reads the result back', async () => {
      await removeFodder(seed.fodder[1]);
      const r = await req<{ prunedTombstones: number; tombstonedContainers: number; prunedUnfolds: number }>({ op: 'reload', discard: false });
      assert.deepEqual([r.prunedTombstones, r.tombstonedContainers, r.prunedUnfolds], [FODDER_PRUNED, 1, 0]);
      assert.ok(serviceLog(iso).some((l) => l.includes('Reloaded') && l.includes(`GC: ${FODDER_PRUNED} unreachable tombstone(s) pruned, 1 vacuous container(s) tombstoned.`)), serviceLog(iso).join('\n'));
      assert.ok(!readMirrorFile(iso, 'BlockNode').includes('Fodder 2.'));
      const lines = await req<string[]>({ op: 'tree', pathArg: seed.fodder[1].artifactPath, noHolders: false, showTombstoned: true, reload: false });
      assert.ok(lines.some((l) => l.includes('f2.md') && l.includes('(tombstoned)')) && !lines.some((l) => l.includes('# F2')), lines.join('\n'));
    });

    test('a divergence also stops a reload that has something to sweep, and the file stays as the outside wrote it', async () => {
      await removeFodder(seed.fodder[2]);
      const external = readMirrorFile(iso, 'BlockNode') + '\n';
      writeMirrorFile(iso, 'BlockNode', external);
      assert.match(await fail({ op: 'reload', discard: false }), /^Refusing to flush: BlockNode\.jsonld changed on disk/);
      assert.equal(readMirrorFile(iso, 'BlockNode'), external);
      await req({ op: 'flush', clobber: true }); // the way out
    });

    test('a stale unfold that arrives with the mirror is cleared and counted by the next reload (the one that reads it sweeps the memory it replaces)', async () => {
      await req({ op: 'flush', clobber: false });
      writeStateFile('TreeView', seed.staleState);
      const first = await req<{ prunedUnfolds: number }>({ op: 'reload', discard: false });
      assert.equal(first.prunedUnfolds, 0);
      assert.ok(stateFile('TreeView').includes(seed.ghost), 'the reload that read it left the file as it was');
      const second = await req<{ prunedTombstones: number; tombstonedContainers: number; prunedUnfolds: number }>({ op: 'reload', discard: false });
      assert.deepEqual([second.prunedTombstones, second.tombstonedContainers, second.prunedUnfolds], [0, 0, 1]);
      assert.ok(serviceLog(iso).some((l) => l.includes('Reloaded') && l.includes('GC: 1 stale unfold(s) cleared.')), serviceLog(iso).join('\n'));
      assert.ok(!stateFile('TreeView').includes(seed.ghost), 'and the state file is written without it');
    });

    test('flush --clobber clears and counts a stale unfold the same way', async () => {
      writeStateFile('TreeView', seed.staleState);
      await req({ op: 'reload', discard: false });
      const r = await req<{ prunedTombstones: number; tombstonedContainers: number; prunedUnfolds: number }>({ op: 'flush', clobber: true });
      assert.deepEqual([r.prunedTombstones, r.tombstonedContainers, r.prunedUnfolds], [0, 0, 1]);
      assert.ok(!stateFile('TreeView').includes(seed.ghost));
    });
  });

  describe('the thread size cap on every write arm that checks the links', () => {
    const warned = (r: { threadSize?: { cap: number; artifactPath: string | null } }): unknown => (r.threadSize ? [r.threadSize.cap, r.threadSize.artifactPath] : undefined);
    const expected = [THREAD_CAP, '.threads/t.md'];

    test('update, retype, remove and insert by a path relative to a base all carry the warning for a node in the thread; the base reaches the link check, not only the write', async () => {
      await req({ op: 'insert', path: seed.thread, markdown: '## Five\n', flush: false, reload: false });
      assert.deepEqual(warned(await req({ op: 'update', path: 'Five', base: seed.thread, markdown: 'Five text.', textOnly: true, flush: false, reload: false })), expected);
      assert.deepEqual(warned(await req({ op: 'retype', path: 'Five', base: seed.thread, to: 'h3', flush: false, reload: false })), expected);
      assert.deepEqual(warned(await req({ op: 'insert', path: 'T', base: seed.thread, markdown: '## Six\n', flush: false, reload: false })), expected);
      assert.deepEqual(warned(await req({ op: 'remove', path: 'Five', base: seed.thread, flush: false, reload: false })), expected);
    });
  });

  describe('the stop and the second boot', () => {
    test('a stop sweeps and flushes what is pending, then the process is gone and the lock with it', async () => {
      writeStateFile('TreeView', seed.staleState);
      await req({ op: 'reload', discard: false }); // the service now holds a stale unfold; the fodder is removed after, so the stop is what sweeps both
      await removeFodder(seed.fodder[3]);
      const before = serviceLog(iso).length;
      assert.equal(await stopService(iso), true);
      assert.equal(readLock(), null);
      assert.equal(await ping(), false);
      assert.deepEqual(leftoverProcesses(iso), []);
      assert.ok(!serviceLog(iso).slice(before).some((l) => /Shutdown WARNING|tombstone GC failed/.test(l)), serviceLog(iso).slice(before).join('\n'));
      assert.ok(!readMirrorFile(iso, 'BlockNode').includes('Fodder 4.'), 'the heading of the last fodder artifact was pruned at the stop and the mirror written without it');
      const list = (JSON.parse(readMirrorFile(iso, 'BlockNode')) as Array<{ '@id': string; tombstonedAt?: string }>).find((d) => d['@id'] === seed.fodder[3].list);
      assert.ok(list?.tombstonedAt, 'and its list, vacuous now, is tombstoned at the stop and kept');
      assert.ok(!stateFile('TreeView').includes(seed.ghost), 'and the stale unfold the service held is cleared from the state file at the stop');
    });

    test('the next boot finds a clean mirror and has nothing to sweep', async () => {
      const gcLines = serviceLog(iso).filter((l) => l.includes('Startup GC')).length;
      await startService(iso);
      assert.equal(serviceLog(iso).filter((l) => l.includes('Startup GC')).length, gcLines, 'no new Startup GC line');
      assert.equal(serviceLog(iso).filter((l) => l.includes('Rehydrated')).length, 2);
    });

    test('a stop with a pending change and a mirror changed outside refuses the flush in the log, keeps the file as it is, and still ends the process', async () => {
      await req({ op: 'insert', path: 'cmd_demo/dup.md/Dup', markdown: '## Lost At Stop\n', flush: false, reload: false });
      const external = readMirrorFile(iso, 'BlockNode') + '\n';
      writeMirrorFile(iso, 'BlockNode', external);
      const before = serviceLog(iso).length;
      await stopService(iso);
      assert.ok(serviceLog(iso).slice(before).some((l) => l.includes('Shutdown WARNING: content mirror flush refused') && l.includes('BlockNode.jsonld changed on disk')), serviceLog(iso).slice(before).join('\n'));
      assert.equal(readMirrorFile(iso, 'BlockNode'), external);
      assert.equal(readLock(), null);
    });

    test('no process of the test is left', () => {
      assert.deepEqual(leftoverProcesses(iso), []);
    });
  });
});

