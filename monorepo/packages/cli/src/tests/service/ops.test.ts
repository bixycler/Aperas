// Every op of the service before the service moves to the engine (planning/core.md, Batch 11, step 10 for step 8): each `case` of `handle()` in
// `service/service.ts` is reached once through `serviceClient`'s `request`, with its result checked, on a real service started from source in a scratch
// directory (`support/serviceHarness.ts`: the runtime directory, the port and both roots are the scratch ones, asserted before anything starts, and the
// service is stopped and found gone in `after`). The last case reads the `case` labels of `handle()` out of the source and fails when one is neither reached
// here nor named in `WAIVED`, so an op added to the service cannot go untested. The cases share the service and the corpus and run in order.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';
import { buildCorpus, type Corpus } from '../support/commandsCorpus.ts';
import { dumpMirror, isolateService, startService, stopService, leftoverProcesses, readMirrorFile, serviceLog, type ServiceIsolation } from '../support/serviceHarness.ts';
import { request } from '../../service/serviceClient';
import type { ServiceRequest } from '../../service/serviceProtocol';

/** The ops of `handle()` that no case here reaches, by name, each with the reason. The three link ops are gone from the service; none is waived. */
const WAIVED: Record<string, string> = {};

/**
 * The branches inside the arms of `handle()` (and the code the arms call in `service.ts`) that no case here or in `lifecycle.test.ts` reaches, by name, each with the
 * reason. They are waived and not tested because a case would not read or write the store differently, or could only be made by waiting past the budget of the group.
 * The last case of the file checks that each name is still in the source, so a waiver cannot outlive its code.
 */
const WAIVED_BRANCHES: Record<string, { marker: string; reason: string }> = {
  idleTimeout: { marker: 'IDLE_TIMEOUT_MS = 30 * 60_000', reason: 'the exit after 30 idle minutes calls the `shutdown` that the stop by SIGTERM reaches (lifecycle.test.ts); only the wait is different, and it is thirty minutes' },
  withLinkCheckThrows: { marker: 'after = checkArtifactLinkIntegrity(store, artifactId);', reason: 'the check of the artifact after a write is wrapped in a `try` that returns the plain result if the check throws; the check does not throw on a folder, on an artifact just removed, or on an id with no node (each was run), so no request reaches the `catch`; it is a guard against a store the write left broken, and it has no case' },
};

describe('service: every op of handle()', () => {
  let fx: FixtureStore;
  let iso: ServiceIsolation;
  let c: Corpus;
  const reached = new Set<string>();
  const call = <T>(req: ServiceRequest): Promise<T> => { reached.add(req.op); return request<T>(req); };
  const refused = async (req: ServiceRequest, message: RegExp): Promise<void> => {
    reached.add(req.op);
    await assert.rejects(request(req), (e: unknown) => e instanceof Error && message.test(e.message), `expected a refusal matching ${message}`);
  };
  const onDisk = (path: string): string => join(fx.artifactsRoot, path);
  const treeLines = (path: string): Promise<string[]> => call<string[]>({ op: 'tree', pathArg: path, noHolders: false, showTombstoned: false, reload: false });

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

  describe('the service itself', () => {
    test('ping answers with the fingerprint of the code it runs', async () => {
      const r = await call<{ pong: boolean; codeFingerprint: string }>({ op: 'ping' });
      assert.equal(r.pong, true);
      assert.match(r.codeFingerprint, /^[0-9a-f]{12}$/);
    });

    test('flush without clobber has nothing to flush on a fresh service', async () => {
      assert.deepEqual(await call({ op: 'flush', clobber: false }), { clobbered: false });
    });

    test('reload reads the mirror again and sweeps nothing from a clean one', async () => {
      const r = await call<{ recordCount: number; documentCount: number; prunedTombstones: number; tombstonedContainers: number; freedGraphs: number }>({ op: 'reload', discard: false });
      assert.ok(r.recordCount > 20 && r.documentCount > 10, JSON.stringify(r));
      assert.deepEqual([r.prunedTombstones, r.tombstonedContainers], [0, 0]);
      assert.equal(r.freedGraphs, 3, 'the three graphs of the old store are freed');
    });
  });

  describe('the reads', () => {
    test('tree renders a subtree as lines, and the same after a reload asked for in the request', async () => {
      const lines = await treeLines('cmd_demo/dup.md');
      assert.equal(lines[0], 'aperas://tree/cmd_demo/dup.md');
      assert.ok(lines.some((l) => l.includes(c.itemOne) && l.includes('## Item One')), lines.join('\n'));
      assert.deepEqual(await call({ op: 'tree', pathArg: 'cmd_demo/dup.md', noHolders: false, showTombstoned: false, reload: true }), lines);
    });

    test('path gives the deep path of an id', async () => {
      assert.equal(await call({ op: 'path', idArg: c.betaSec, reload: false }), 'cmd_demo/beta.md/--beta/---beta-section');
    });

    test('backlinks lists the blocks that cite a node, with their text when asked', async () => {
      const withText = await call<Array<{ ownerId: string; text?: string }>>({ op: 'backlinks', pathArg: c.betaSec, includeText: true, reload: false });
      assert.deepEqual(withText.map((e) => e.ownerId), [c.alpha, c.gamma], 'by the id of the link, which starts with its owner\'s');
      assert.ok(withText.every((e) => typeof e.text === 'string' && e.text.includes(c.betaSec.split(':')[1])));
      const bare = await call<Array<{ ownerId: string; text?: string }>>({ op: 'backlinks', pathArg: c.betaSec, includeText: false, reload: false });
      assert.deepEqual(bare.map((e) => e.ownerId), [c.alpha, c.gamma]);
      assert.ok(bare.every((e) => e.text === undefined));
    });

    test('show gives the stored record of a node', async () => {
      const doc = await call<{ '@id': string; title?: string; type?: string; text?: string; parent?: string }>({ op: 'show', pathArg: c.betaSec, reload: false });
      assert.deepEqual([doc['@id'], doc.title, doc.type, doc.text, doc.parent], [c.betaSec, '## Beta Section', 'heading', 'Beta section text.', c.beta]);
    });

    test('resolve gives the id of each segment of a path, and refuses one it cannot place', async () => {
      const r = await call<{ lines: string[] }>({ op: 'resolve', paths: ['cmd_demo/beta.md/Beta', 'cmd_demo/beta.md/Beta/Beta Section'], createHolder: false, flush: false, reload: false });
      assert.deepEqual(r.lines.map((l) => l.split('  ')[0]), [`aperas://id/${c.beta}`, `aperas://id/${c.betaSec}`]);
      await refused({ op: 'resolve', paths: ['cmd_demo/nothing.md'], createHolder: false, flush: false, reload: false }, /isn't a tracked artifact\/folder path/);
    });

    test('resolve with createHolder mints the missing title as a holder and marks the store for a flush', async () => {
      const r = await call<{ lines: string[] }>({ op: 'resolve', paths: ['cmd_demo/gamma.md/Gamma/Later'], titles: ['Later'], createHolder: true, flush: true, reload: false });
      assert.ok(r.lines[r.lines.length - 1].endsWith('Later  (created holder)'), r.lines.join('\n'));
      assert.ok(readMirrorFile(iso, 'BlockNode').includes('"Later"'), 'flush: true wrote the holder to the mirror');
    });
  });

  describe('the files on disk', () => {
    test('track notices a file that changed on disk', async () => {
      writeFileSync(onDisk('cmd_demo/beta.md'), readFileSync(onDisk('cmd_demo/beta.md'), 'utf-8') + '\nAn appended paragraph.\n', 'utf-8');
      const r = await call<{ trackedCount: number; skippedCount: number }>({ op: 'track', paths: ['cmd_demo/beta.md'], flush: false, reload: false, force: false });
      assert.deepEqual([r.trackedCount, r.skippedCount], [1, 0]);
      assert.deepEqual(await call({ op: 'track', paths: ['cmd_demo/beta.md'], flush: true, reload: false, force: false }), { trackedCount: 0, skippedCount: 1, skippedReadmes: [], renamed: 0, removed: 0 });
    });

    test('trackReverse reports the artifacts never projected, and writes nothing', async () => {
      const r = await call<{ neverProjected: Array<{ path: string }>; changed: unknown[]; staleOnDisk: unknown[] }>({ op: 'trackReverse', reload: false });
      // By the id of the node, the artifacts before the folders; the corpus builds beta, dup, alpha and gamma in that order.
      assert.deepEqual(r.neverProjected.map((e) => e.path), ['cmd_demo/beta.md', 'cmd_demo/dup.md', 'cmd_demo/alpha.md', 'cmd_demo/gamma.md', '.', 'cmd_demo']);
      assert.deepEqual([r.changed, r.staleOnDisk], [[], []]);
    });

    test('ingest takes the changed file into the graph, and a new file with a track of its own', async () => {
      const first = await call<{ ingested: Array<{ path: string; blockCount: number; reconciliation: { added: number } | null }> }>({ op: 'ingest', paths: ['cmd_demo/beta.md'], flush: false, reload: false, track: false, force: false });
      assert.deepEqual(first.ingested.map((i) => [i.path, i.blockCount, i.reconciliation?.added]), [['cmd_demo/beta.md', 4, 1]]);
      writeFileSync(onDisk('cmd_demo/new.md'), '# New\n\nNew text.\n', 'utf-8');
      const second = await call<{ trackResult: { trackedCount: number } | null; ingested: Array<{ path: string; blockCount: number }> }>({ op: 'ingest', paths: ['cmd_demo/new.md'], flush: true, reload: false, track: true, force: false });
      assert.equal(second.trackResult?.trackedCount, 1);
      assert.deepEqual(second.ingested.map((i) => [i.path, i.blockCount]), [['cmd_demo/new.md', 1]]);
      assert.ok(readMirrorFile(iso, 'ArtifactNode').includes('new.md'), 'flush: true wrote the new artifact');
    });

    test('track of every file holds back the removal of a file gone from disk, and force applies it', async () => {
      writeFileSync(onDisk('cmd_demo/gone.md'), '# Gone\n\nSoon gone.\n', 'utf-8');
      await call({ op: 'ingest', paths: ['cmd_demo/gone.md'], flush: false, reload: false, track: true, force: false });
      rmSync(onDisk('cmd_demo/gone.md'));
      const goneId = (await call<{ lines: string[] }>({ op: 'resolve', paths: ['cmd_demo/gone.md'], createHolder: false, flush: false, reload: false })).lines[0].split('  ')[0].replace('aperas://id/', '');
      const held = await call<{ removed?: number; pendingRemovals?: string[] }>({ op: 'track', paths: [], flush: false, reload: false, force: false });
      assert.deepEqual([held.removed, held.pendingRemovals], [0, ['cmd_demo/gone.md']]);
      assert.equal((await call<{ tombstonedAt?: string }>({ op: 'show', pathArg: goneId, reload: false })).tombstonedAt, undefined, 'the artifact is still live');
      const done = await call<{ removed?: number; pendingRemovals?: string[] }>({ op: 'track', paths: [], flush: false, reload: false, force: true });
      assert.deepEqual([done.removed, done.pendingRemovals], [1, []]);
      assert.equal(typeof (await call<{ tombstonedAt?: string }>({ op: 'show', pathArg: goneId, reload: false })).tombstonedAt, 'string', 'the artifact is tombstoned');
    });

    test('ingest holds back a section removed from the file, and force applies it', async () => {
      writeFileSync(onDisk('cmd_demo/shrink.md'), '# Shrink\n\n## Keep\n\nKeep text.\n\n## Drop\n\nDrop text.\n', 'utf-8');
      await call({ op: 'ingest', paths: ['cmd_demo/shrink.md'], flush: false, reload: false, track: true, force: false });
      assert.ok((await treeLines('cmd_demo/shrink.md')).some((l) => l.includes('## Drop')));
      writeFileSync(onDisk('cmd_demo/shrink.md'), '# Shrink\n\n## Keep\n\nKeep text.\n', 'utf-8');
      const held = await call<{ ingested: Array<{ pendingConfirmation?: Array<{ title?: string }> }> }>({ op: 'ingest', paths: ['cmd_demo/shrink.md'], flush: false, reload: false, track: true, force: false });
      assert.deepEqual(held.ingested.map((i) => i.pendingConfirmation?.map((p) => p.title)), [['## Drop']]);
      assert.ok((await treeLines('cmd_demo/shrink.md')).some((l) => l.includes('## Drop')), 'held back: the section is still live');
      const done = await call<{ ingested: Array<{ pendingConfirmation?: unknown; reconciliation: { removed: number } | null }> }>({ op: 'ingest', paths: ['cmd_demo/shrink.md'], flush: false, reload: false, track: true, force: true });
      assert.deepEqual(done.ingested.map((i) => [i.pendingConfirmation, i.reconciliation?.removed]), [[undefined, 1]]);
      assert.ok(!(await treeLines('cmd_demo/shrink.md')).some((l) => l.includes('## Drop')), 'forced: the section is gone');
    });
  });

  describe('the profiles and the views', () => {
    let view = '';
    const unfoldCount = async (): Promise<number> => (await call<{ views: Array<{ name: string; unfoldCount: number }> }>({ op: 'profileListView', reload: false })).views.find((v) => v.name === 'mine')!.unfoldCount;

    test('profileCreate and profileCreateView make a profile and a view of it', async () => {
      const p = await call<{ id: string }>({ op: 'profileCreate', handle: 'will', name: 'Will', kind: 'human', flush: false, reload: false });
      assert.match(p.id, /^Profile:/);
      view = (await call<{ id: string }>({ op: 'profileCreateView', name: 'mine', profileHandle: 'will', flush: false, reload: false })).id;
      assert.match(view, /^TreeView:/);
      await refused({ op: 'profileCreate', handle: 'will', flush: false, reload: false }, /Profile 'will' already exists/);
    });

    test('profileList and profileListView read them back', async () => {
      const p = await call<{ handle: string; name: string; kind: string; viewCount: number; views: Array<{ id: string; name: string }> }>({ op: 'profileList', handle: 'will', reload: false });
      assert.deepEqual([p.handle, p.name, p.kind, p.viewCount, p.views], ['will', 'Will', 'human', 1, [{ id: view, name: 'mine' }]]);
      assert.deepEqual(await call({ op: 'profileListView', name: 'mine', reload: false }), { id: view, name: 'mine', profileHandle: 'will', unfoldCount: 0, unfolds: [] });
    });

    test('unfold with peek reads without touching any view; unfold into a view records it, and flush: true writes the view state', async () => {
      const peek = await call<{ id: string; path: string; children: unknown[] }>({ op: 'unfold', ref: 'cmd_demo/alpha.md', peek: true, showTombstoned: false, flush: false, reload: false });
      assert.deepEqual([peek.id, peek.path, peek.children.length], [c.alphaArt, 'cmd_demo/alpha.md', 1]);
      assert.equal(await unfoldCount(), 0);
      const r = await call<{ id: string }>({ op: 'unfold', ref: 'cmd_demo/alpha.md', viewRef: 'mine', showTombstoned: false, flush: true, reload: false });
      assert.equal(r.id, c.alphaArt);
      assert.equal(await unfoldCount(), 1);
      assert.ok(readFileSync(join(fx.apeironRoot, '.state', 'TreeView.jsonld'), 'utf-8').includes(c.alphaArt), 'the unfold reached the state mirror');
    });

    test('fold takes it out again', async () => {
      assert.deepEqual(await call({ op: 'fold', ref: 'cmd_demo/alpha.md', viewRef: 'mine', flush: false, reload: false }), { id: c.alphaArt });
      assert.equal(await unfoldCount(), 0);
    });

    test('zoom roots the view, and tree with that view renders its structured form from the root', async () => {
      const z = await call<{ id: string; view: string; path: string }>({ op: 'zoom', ref: 'cmd_demo/beta.md', viewRef: 'mine', flush: false, reload: false });
      assert.deepEqual([z.id, z.view, z.path], [c.betaArt, 'mine', 'cmd_demo/beta.md']);
      const t = await call<{ path: string; tree: { id: string; found: boolean; tier: string; children: unknown[] } }>({ op: 'tree', viewRef: 'mine', noHolders: false, showTombstoned: false, format: 'render-tree', reload: false });
      assert.deepEqual([t.path, t.tree.id, t.tree.found, t.tree.tier], ['cmd_demo/beta.md', c.betaArt, true, 'unfolded']);
      assert.ok(t.tree.children.length > 0);
    });

    test('profileRemoveView drops one view, profileRemove drops a profile and the views it owns', async () => {
      assert.deepEqual(await call({ op: 'profileRemoveView', name: 'mine', flush: true, reload: false }), { removed: true });
      assert.deepEqual(await call({ op: 'profileRemoveView', name: 'mine', flush: false, reload: false }), { removed: false });
      await call({ op: 'profileCreateView', name: 'second', profileHandle: 'will', flush: false, reload: false });
      assert.deepEqual(await call({ op: 'profileRemove', handle: 'will', flush: true, reload: false }), { removed: true, viewsRemoved: 1 });
      await refused({ op: 'profileListView', name: 'second', reload: false }, /TreeView 'second' not found/);
    });
  });

  describe('the writes', () => {
    test('insert makes a block under a node; it reaches the mirror at the next flush, not before', async () => {
      const r = await call<{ lines: string[] }>({ op: 'insert', path: 'cmd_demo/dup.md/Dup', markdown: '## Item Three\n\nThree.\n', flush: false, reload: false });
      assert.match(r.lines[0], /^aperas:\/\/id\/BlockNode:\S+  \[heading\]  ## Item Three  \(created\)$/);
      assert.ok((await treeLines('cmd_demo/dup.md')).some((l) => l.includes('## Item Three')));
      assert.ok(!readMirrorFile(iso, 'BlockNode').includes('Item Three'), 'not flushed yet');
      assert.deepEqual(await call({ op: 'flush', clobber: false }), { clobbered: false });
      assert.ok(readMirrorFile(iso, 'BlockNode').includes('Item Three'), 'flushed');
    });

    test('update changes the text of a node, and the same write with reload and flush in one request lands in the mirror', async () => {
      const r = await call<{ reconciled: boolean }>({ op: 'update', path: c.itemOne, markdown: 'Changed one.', textOnly: true, flush: true, reload: true });
      assert.equal(r.reconciled, false);
      assert.equal((await call<{ text?: string }>({ op: 'show', pathArg: c.itemOne, reload: false })).text, 'Changed one.');
      assert.ok(readMirrorFile(iso, 'BlockNode').includes('Changed one.'));
    });

    test('retype changes the type of a node and keeps its id', async () => {
      const r = await call<{ id: string; fromType: string; toType: string; toTitle: string }>({ op: 'retype', path: c.itemTwo, to: 'h3', flush: false, reload: false });
      assert.deepEqual([r.id, r.fromType, r.toType, r.toTitle], [c.itemTwo, 'heading', 'heading', '### Item Two']);
    });

    test('remove tombstones a node: it leaves the tree, and shows by its id with showTombstoned', async () => {
      assert.deepEqual(await call({ op: 'remove', path: c.betaOther, flush: false, reload: false }), { id: c.betaOther });
      assert.ok(!(await treeLines('cmd_demo/beta.md')).some((l) => l.includes(c.betaOther)));
      // A tombstone leaves the list of its container: nothing in place with the flag, and the tombstone shown by its id.
      const withFlag = await call<string[]>({ op: 'tree', pathArg: 'cmd_demo/beta.md', noHolders: false, showTombstoned: true, reload: false });
      assert.ok(!withFlag.some((l) => l.includes(c.betaOther)));
      const byId = await call<string[]>({ op: 'tree', pathArg: c.betaOther, noHolders: false, showTombstoned: true, reload: false });
      assert.ok(byId.some((l) => l.includes(c.betaOther) && l.includes('(tombstoned)')));
    });

    test('a write the engine refuses is an error to the caller and changes nothing', async () => {
      await refused({ op: 'remove', path: '.', flush: false, reload: false }, /Refusing to remove the artifacts root/);
      await refused({ op: 'update', path: 'cmd_demo/nothing', markdown: 'x', textOnly: true, flush: false, reload: false }, /isn't a tracked artifact\/folder path/);
    });

    test('a write relative to a base that names nothing is refused, and the link check has no artifact to look at', async () => {
      await refused({ op: 'insert', path: 'Gamma', base: 'cmd_demo/nothing.md', markdown: 'x\n', flush: false, reload: false }, /Parent 'Gamma'/);
      await refused({ op: 'retype', path: 'Gamma', base: 'cmd_demo/nothing.md', to: 'h2', flush: false, reload: false }, /Target 'Gamma'/);
    });
  });

  describe('project', () => {
    test('a dry run renders the markdown and the file it would write; a real run records the hashes, so trackReverse stops listing the file', async () => {
      const dry = await call<{ markdown: string; targetFile: string }>({ op: 'project', path: 'cmd_demo/alpha.md', dryRun: true, force: false, flush: false, reload: false });
      assert.equal(dry.targetFile, onDisk('cmd_demo/alpha.md'));
      assert.ok(dry.markdown.startsWith('# Alpha <a name=\'id/'));
      const isNeverProjected = async (): Promise<boolean> => (await call<{ neverProjected: Array<{ path: string }> }>({ op: 'trackReverse', reload: false })).neverProjected.some((e) => e.path === 'cmd_demo/alpha.md');
      assert.equal(await isNeverProjected(), true);
      const real = await call<{ markdown: string; targetFile: string }>({ op: 'project', path: 'cmd_demo/alpha.md', dryRun: false, force: false, flush: true, reload: false });
      assert.equal(real.markdown, dry.markdown);
      assert.equal(await isNeverProjected(), false);
    });

    test('a file changed on disk since the graph last knew it is held back, and force projects over it', async () => {
      writeFileSync(onDisk('cmd_demo/alpha.md'), '# Alpha\n\nHand edited.\n', 'utf-8');
      assert.deepEqual(
        await call({ op: 'project', path: 'cmd_demo/alpha.md', dryRun: false, force: false, flush: false, reload: false }),
        { conflict: true, path: 'cmd_demo/alpha.md', targetFile: onDisk('cmd_demo/alpha.md') },
      );
      const forced = await call<{ markdown?: string }>({ op: 'project', path: 'cmd_demo/alpha.md', dryRun: false, force: true, flush: false, reload: false });
      assert.ok(forced.markdown?.startsWith('# Alpha <a name=\'id/'));
    });
  });

  describe('checkLinks', () => {
    test('checks the links of the whole graph and reports no discrepancy on the corpus', async () => {
      const r = await call<{ totalLiveBlocks: number; blocksWithLinkText: number; discrepancies: unknown[]; unresolvedTargets: unknown[] }>({ op: 'checkLinks', repair: false, reload: false, flush: false });
      assert.ok(r.totalLiveBlocks > 10 && r.blocksWithLinkText >= 2, JSON.stringify(r));
      assert.deepEqual(r.discrepancies, []);
    });

    test('repair re-resolves, reports before and after, and flushes when asked', async () => {
      const r = await call<{ reportBefore: { discrepancies: unknown[] }; repairedArtifacts: unknown[]; reportAfter: { discrepancies: unknown[] } }>({ op: 'checkLinks', repair: true, reload: false, flush: true });
      assert.deepEqual([r.reportBefore.discrepancies, r.repairedArtifacts, r.reportAfter.discrepancies], [[], [], []]);
    });
  });

  describe('reload: true on every arm that takes it', () => {
    const reloads = (): number => serviceLog(iso).filter((l) => l.includes('] Reloaded ')).length;
    /** Asks for `req` with `reload: true` and checks that the service read the mirror again, once, and then answered. */
    const reloaded = async <T>(req: ServiceRequest): Promise<T> => {
      const before = reloads();
      const result = await call<T>({ ...req, reload: true } as ServiceRequest);
      assert.equal(reloads() - before, 1, `${req.op} with reload: true read the mirror once`);
      return result;
    };

    test('each of the 23 arms with a reload flag reads the mirror before it works, and a write pending before it is not lost to the read', async () => {
      const p = await reloaded<{ id: string }>({ op: 'profileCreate', handle: 'rl', name: 'Reload', kind: 'human', flush: false, reload: false });
      assert.match(p.id, /^Profile:/);
      await reloaded({ op: 'profileCreateView', name: 'rlv', profileHandle: 'rl', flush: false, reload: false });
      const listed = await reloaded<{ viewCount: number }>({ op: 'profileList', handle: 'rl', reload: false });
      assert.equal(listed.viewCount, 1, 'the profile and its view written before the reload are still there');
      assert.equal((await reloaded<{ unfoldCount: number }>({ op: 'profileListView', name: 'rlv', reload: false })).unfoldCount, 0);
      assert.equal((await reloaded<{ id: string }>({ op: 'unfold', ref: 'cmd_demo/alpha.md', viewRef: 'rlv', showTombstoned: false, flush: false, reload: false })).id, c.alphaArt);
      assert.equal((await reloaded<{ id: string }>({ op: 'zoom', ref: 'cmd_demo/beta.md', viewRef: 'rlv', flush: false, reload: false })).id, c.betaArt);
      assert.equal((await reloaded<{ id: string }>({ op: 'fold', ref: 'cmd_demo/alpha.md', viewRef: 'rlv', flush: false, reload: false })).id, c.alphaArt);
      assert.equal((await reloaded<string[]>({ op: 'tree', pathArg: 'cmd_demo/dup.md', noHolders: false, showTombstoned: false, reload: false }))[0], 'aperas://tree/cmd_demo/dup.md');
      assert.equal(await reloaded({ op: 'path', idArg: c.betaSec, reload: false }), 'cmd_demo/beta.md/--beta/---beta-section');
      assert.equal((await reloaded<unknown[]>({ op: 'backlinks', pathArg: c.betaSec, includeText: false, reload: false })).length, 2);
      assert.equal((await reloaded<{ '@id': string }>({ op: 'show', pathArg: c.betaSec, reload: false }))['@id'], c.betaSec);
      assert.equal((await reloaded<{ lines: string[] }>({ op: 'resolve', paths: ['cmd_demo/beta.md'], createHolder: false, flush: false, reload: false })).lines.length, 1);
      assert.ok(Array.isArray((await reloaded<{ neverProjected: unknown[] }>({ op: 'trackReverse', reload: false })).neverProjected));
      assert.equal((await reloaded<{ trackedCount: number; skippedCount: number }>({ op: 'track', paths: ['cmd_demo/beta.md'], flush: false, reload: false, force: false })).skippedCount, 1);
      assert.deepEqual((await reloaded<{ ingested: unknown[] }>({ op: 'ingest', paths: ['cmd_demo/beta.md'], flush: false, reload: false, track: false, force: false })).ingested, []);
      assert.equal((await reloaded<{ targetFile: string }>({ op: 'project', path: 'cmd_demo/dup.md', dryRun: true, force: false, flush: false, reload: false })).targetFile, onDisk('cmd_demo/dup.md'));
      assert.deepEqual((await reloaded<{ discrepancies: unknown[] }>({ op: 'checkLinks', repair: false, reload: false, flush: false })).discrepancies, []);

      const made = await reloaded<{ lines: string[] }>({ op: 'insert', path: 'cmd_demo/dup.md/Dup', markdown: '## Reload Probe\n\nProbe.\n', flush: false, reload: false });
      const probe = made.lines[0].split('  ')[0].replace('aperas://id/', '');
      await reloaded({ op: 'update', path: probe, markdown: 'Probe, changed.', textOnly: true, flush: false, reload: false });
      assert.equal((await reloaded<{ toTitle: string }>({ op: 'retype', path: probe, to: 'h3', flush: false, reload: false })).toTitle, '### Reload Probe');
      assert.deepEqual(await reloaded({ op: 'remove', path: probe, flush: false, reload: false }), { id: probe });
      assert.deepEqual(await reloaded({ op: 'profileRemoveView', name: 'rlv', flush: false, reload: false }), { removed: true });
      assert.deepEqual(await reloaded({ op: 'profileRemove', handle: 'rl', flush: false, reload: false }), { removed: true, viewsRemoved: 0 });
    });
  });

  describe('flush: true on every arm that takes it', () => {
    const blockDoc = (id: string): { title?: string; type?: string; tombstonedAt?: string } | undefined => (JSON.parse(readMirrorFile(iso, 'BlockNode')) as Array<{ '@id': string; title?: string; type?: string; tombstonedAt?: string }>).find((d) => d['@id'] === id);
    const stateText = (): string => readFileSync(join(fx.apeironRoot, '.state', 'TreeView.jsonld'), 'utf-8');

    test('insert, retype and remove each write the mirror before they answer', async () => {
      const made = await call<{ lines: string[] }>({ op: 'insert', path: 'cmd_demo/dup.md/Dup', markdown: '## Flushed\n', flush: true, reload: false });
      const id = made.lines[0].split('  ')[0].replace('aperas://id/', '');
      assert.equal(blockDoc(id)?.title, '## Flushed');
      await call({ op: 'retype', path: id, to: 'h3', flush: true, reload: false });
      assert.equal(blockDoc(id)?.title, '### Flushed');
      await call({ op: 'remove', path: id, flush: true, reload: false });
      assert.equal(typeof blockDoc(id)?.tombstonedAt, 'string');
    });

    test('a profile with no view is made and removed with the mirror written each time, and removing one that is not there removes nothing', async () => {
      await call({ op: 'profileCreate', handle: 'solo', name: 'Solo', kind: 'human', flush: true, reload: false });
      assert.ok(readMirrorFile(iso, 'Profile').includes('"solo"'), 'made: in the mirror');
      assert.deepEqual(await call({ op: 'profileRemove', handle: 'nobody', flush: true, reload: false }), { removed: false, viewsRemoved: 0 });
      assert.ok(readMirrorFile(iso, 'Profile').includes('"solo"'), 'a removal of nobody leaves the profile');
      assert.deepEqual(await call({ op: 'profileRemove', handle: 'solo', flush: true, reload: false }), { removed: true, viewsRemoved: 0 });
      assert.ok(!readMirrorFile(iso, 'Profile').includes('"solo"'), 'removed: out of the mirror');
    });

    test('a view, an unfold, a fold and a zoom each write the state mirror before they answer; the flush arm writes what is pending in it', async () => {
      await call({ op: 'profileCreate', handle: 'fl', name: 'Flush', kind: 'human', flush: true, reload: false });
      await call({ op: 'profileCreateView', name: 'flv', profileHandle: 'fl', flush: true, reload: false });
      assert.ok(stateText().includes('"flv"'), 'the view is in the state mirror');
      await call({ op: 'unfold', ref: 'cmd_demo/alpha.md', viewRef: 'flv', showTombstoned: false, flush: true, reload: false });
      assert.ok(stateText().includes(c.alphaArt), 'the unfold is in the state mirror');
      await call({ op: 'fold', ref: 'cmd_demo/alpha.md', viewRef: 'flv', flush: true, reload: false });
      assert.ok(!stateText().includes(c.alphaArt), 'the fold took it out');
      await call({ op: 'zoom', ref: 'cmd_demo/beta.md', viewRef: 'flv', flush: true, reload: false });
      assert.ok(stateText().includes(c.betaArt), 'the zoom root is in the state mirror');
      await call({ op: 'unfold', ref: 'cmd_demo/alpha.md', viewRef: 'flv', showTombstoned: false, flush: false, reload: false });
      assert.deepEqual(await call({ op: 'flush', clobber: false }), { clobbered: false });
      assert.ok(stateText().includes(c.alphaArt), 'the flush arm wrote the pending unfold');
      await call({ op: 'profileRemove', handle: 'fl', flush: true, reload: false });
      assert.ok(!stateText().includes('"flv"'), 'the removal of the profile took its view out of the state mirror');
    });

    test('unfold into no view does not list a removed child, with the flag or without it', async () => {
      const kinds = async (showTombstoned: boolean): Promise<string[]> => (await call<{ children: Array<{ id: string }> }>({ op: 'unfold', ref: 'cmd_demo/beta.md/Beta', peek: true, showTombstoned, flush: false, reload: false })).children.map((k) => k.id);
      assert.ok(!(await kinds(false)).includes(c.betaOther), 'removed above: not listed');
      assert.ok(!(await kinds(true)).includes(c.betaOther), 'it has left its container: not listed with the flag either');
    });
  });

  describe('what a write breaks', () => {
    const idOfLine = (line: string): string => line.split('  ')[0].replace('aperas://id/', '');
    let citing = '';

    test('a write that makes a link code resolvable in a block that holds no link for it comes back with linkBreakage', async () => {
      const first = await call<{ lines: string[]; linkResolution: { dangling: number }; linkBreakage?: unknown }>({ op: 'insert', path: 'cmd_demo/gamma.md/Gamma', markdown: 'Citing [late]([[#late]]).\n', flush: true, reload: false });
      citing = idOfLine(first.lines[0]);
      assert.deepEqual([first.linkResolution.dangling, first.linkBreakage], [1, undefined], 'the code resolves to nothing yet, which is not a breakage');
      const second = await call<{ lines: string[]; linkBreakage?: Array<{ blockId: string; code: string }> }>({ op: 'insert', path: 'cmd_demo/gamma.md', markdown: "# Late <a name='late' class='aperas-anchor aperas-tree'></a>\n", flush: true, reload: false });
      assert.deepEqual(second.linkBreakage?.map((b) => [b.blockId, b.code]), [[citing, '#late']]);
    });

    test('the sweep of the whole graph finds it, a repair without flush leaves the file as it is, and the flush arm writes the repair', async () => {
      const found = await call<{ discrepancies: Array<{ blockId: string }> }>({ op: 'checkLinks', repair: false, reload: false, flush: false });
      assert.deepEqual(found.discrepancies.map((d) => d.blockId), [citing]);
      const before = readMirrorFile(iso, 'BlockNode');
      const r = await call<{ reportBefore: { discrepancies: unknown[] }; repairedArtifacts: unknown[]; reportAfter: { discrepancies: unknown[] } }>({ op: 'checkLinks', repair: true, reload: false, flush: false });
      assert.deepEqual([r.reportBefore.discrepancies.length, r.repairedArtifacts.length, r.reportAfter.discrepancies.length], [1, 1, 0]);
      assert.equal(readMirrorFile(iso, 'BlockNode'), before, 'not flushed');
      assert.deepEqual(await call({ op: 'flush', clobber: false }), { clobbered: false });
      assert.notEqual(readMirrorFile(iso, 'BlockNode'), before, 'flushed');
      assert.deepEqual((await call<{ discrepancies: unknown[] }>({ op: 'checkLinks', repair: false, reload: true, flush: false })).discrepancies, [], 'and it holds after a read of the mirror');
    });

    test('a repair with flush: true writes the file before it answers', async () => {
      await call({ op: 'insert', path: 'cmd_demo/gamma.md/Gamma', markdown: 'Citing [again]([[#again]]).\n', flush: true, reload: false });
      const broken = await call<{ linkBreakage?: unknown[] }>({ op: 'insert', path: 'cmd_demo/gamma.md', markdown: "# Again <a name='again' class='aperas-anchor aperas-tree'></a>\n", flush: true, reload: false });
      assert.equal(broken.linkBreakage?.length, 1);
      const before = readMirrorFile(iso, 'BlockNode');
      const r = await call<{ repairedArtifacts: unknown[]; reportAfter: { discrepancies: unknown[] } }>({ op: 'checkLinks', repair: true, reload: false, flush: true });
      assert.deepEqual([r.repairedArtifacts.length, r.reportAfter.discrepancies.length], [1, 0]);
      assert.notEqual(readMirrorFile(iso, 'BlockNode'), before, 'written at once');
    });
  });

  describe('the default arm', () => {
    test('an op the service does not know is an error naming it', async () => {
      await assert.rejects(request({ op: 'bogus' } as unknown as ServiceRequest), /ApeironNgn service: unknown op 'bogus'/);
    });
  });

  describe('coverage', () => {
    test('every case of handle() is reached above or waived by name', () => {
      const source = readFileSync(fileURLToPath(new URL('../../service/service.ts', import.meta.url)), 'utf-8');
      const start = source.indexOf('async function handle(');
      const end = source.indexOf('function handleConnection(');
      assert.ok(start > 0 && end > start, 'handle() was found in the source');
      const arms = [...source.slice(start, end).matchAll(/^\s*case '(\w+)':/gm)].map((m) => m[1]);
      assert.ok(arms.length >= 20, `the arms were read out of the source: ${arms.join(', ')}`);
      assert.equal(new Set(arms).size, arms.length, 'no arm is listed twice');
      assert.deepEqual(arms.filter((a) => !reached.has(a) && !(a in WAIVED)), [], 'arms of handle() that no case reaches and nothing waives');
      assert.deepEqual(Object.keys(WAIVED).filter((a) => !arms.includes(a) || reached.has(a)), [], 'waived names that are not an arm, or are reached after all');
      assert.deepEqual([...reached].filter((op) => !arms.includes(op) && op !== 'bogus'), [], 'ops asked for that handle() has no arm for');
    });

    test('every waived branch is still in the source, with its reason', () => {
      const source = readFileSync(fileURLToPath(new URL('../../service/service.ts', import.meta.url)), 'utf-8');
      assert.deepEqual(Object.entries(WAIVED_BRANCHES).filter(([, w]) => !source.includes(w.marker) || w.reason.length < 40).map(([name]) => name), [], 'waivers whose code is gone or that give no reason');
    });
  });
});
