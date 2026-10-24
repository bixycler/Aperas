// A refused command leaves nothing behind (design/core.md, "A refused command leaves nothing behind"): a command that makes records and then meets a refusal takes the records it made
// with it. After each refusal below the census of live blocks that no container lists is as it was (zero), the graph dump is the one before the call, and a flush to a scratch mirror
// followed by a reload shows the same (the leftover of a refused `insert` was persisted by the next flush). One describe per command that creates records before a step that can refuse.
import { describe, test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { newDb } from '@aperas/core/shell/db';
import type { Db } from '@aperas/core/shell/db';
import { runInsert } from '../../kgInsert';
import { runUpdate } from '../../kgUpdate';
import { runTrack } from '../../kgTrack';
import { runIngest } from '../../kgIngest';
import { runResolve } from '../../kgResolve';
import { runProfileCreate, runProfileCreateView } from '../../kgProfile';
import { runUnfoldOp } from '../../kgUnfold';
import { runFoldOp } from '../../kgFold';
import { runZoomOp } from '../../kgZoom';
import { runTree } from '../../kgTree';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';
import { buildCorpus, writeArtifact, type Corpus } from '../support/commandsCorpus.ts';
import { assertNoRecordsLeft, assertNothingLeft, mark, parentless } from '../support/leftovers.ts';

const refuses = (fn: () => unknown, message: RegExp): void => assert.throws(fn, (e: unknown) => e instanceof Error && message.test(e.message), `expected a refusal matching ${message}`);

/** Makes the engine refuse one write, once: the `nth` call of `method` for which `when` holds throws, as a refusal of the engine would. Gives the restore and the count. */
function refuseWrite<M extends 'insertItem' | 'addPair'>(store: Db, method: M, when: (...args: Parameters<Db['engine'][M]>) => boolean, nth = 1): { restore: () => void; calls: () => number } {
  const original = store.engine[method].bind(store.engine) as (...args: unknown[]) => unknown;
  let calls = 0;
  const faulty = mock.method(store.engine, method, (...args: unknown[]) => {
    if (when(...(args as Parameters<Db['engine'][M]>)) && ++calls === nth) throw new Error(`injected: ${method} refused`);
    return original(...args);
  });
  return { restore: () => faulty.mock.restore(), calls: () => calls };
}

describe('a refused command leaves nothing behind', () => {
  let fx: FixtureStore;
  let c: Corpus;
  before(() => { fx = makeFixtureStore('cmd_demo'); c = buildCorpus(fx); });
  after(() => fx.cleanup());

  describe('insert', () => {
    test('the census of the corpus is zero', () => {
      assert.deepEqual(parentless(fx.store), []);
    });

    test('an anchor that is not a child of the parent: refused before anything is made, whatever the body (one block, several, with children, with a link)', () => {
      for (const markdown of ['## Stray\n\nText.\n', '## S1\n\n## S2\n\nText.\n', '## S1\n\n### S1a\n\nText with [beta]([[' + c.betaArt.split(':')[1] + ']]).\n']) {
        for (const side of ['after', 'before'] as const) {
          const before = mark(fx.store);
          refuses(() => runInsert(fx.store, { path: c.dup, markdown, [side]: c.alphaSec }), /anchor .* is not a child of/);
          assertNothingLeft(fx.store, before, `insert ${side} an anchor of another parent`);
        }
      }
    });

    test('a refusal after the body is hydrated takes the records with it: the engine refuses the second placement, and the first block, listed by the parent, goes too', () => {
      const before = mark(fx.store);
      const insertItem = fx.store.engine.insertItem.bind(fx.store.engine);
      let calls = 0;
      const faulty = mock.method(fx.store.engine, 'insertItem', (...args: Parameters<typeof insertItem>) => {
        if (args[1] === c.dup && ++calls === 2) throw new Error('injected: the second placement is refused');
        return insertItem(...args);
      });
      try {
        refuses(() => runInsert(fx.store, { path: c.dup, markdown: '## T1\n\n### T1a\n\n## T2\n', after: c.itemOne }), /injected/);
        assert.equal(calls, 2, 'the first block was placed in the parent and the second refused');
      } finally { faulty.mock.restore(); }
      assertNothingLeft(fx.store, before, 'insert refused after the first placement');
    });
  });

  describe('update', () => {
    test('a refusal after the overflow is hydrated takes the blocks it made with it: the engine refuses the placement of the new children under the target', () => {
      const before = mark(fx.store);
      const fault = refuseWrite(fx.store, 'insertItem', (_g, host) => host === c.itemTwo, 2);
      try {
        refuses(() => runUpdate(fx.store, { path: c.itemTwo, markdown: 'Two.\n\n- first\n- second\n', textOnly: true }), /injected/);
        assert.equal(fault.calls(), 2, 'the first item was placed under the target and the second refused');
      } finally { fault.restore(); }
      assertNoRecordsLeft(fx.store, before, 'update --text-only refused at the placement of the overflow');
    });

    test('a refusal in the reconcile mode takes the blocks it added with it', () => {
      const before = mark(fx.store);
      const fault = refuseWrite(fx.store, 'insertItem', (_g, host) => host === c.itemTwo);
      try {
        refuses(() => runUpdate(fx.store, { path: c.itemTwo, markdown: 'Two.\n\n- first\n- second\n', textOnly: false }), /injected/);
      } finally { fault.restore(); }
      assertNoRecordsLeft(fx.store, before, 'update refused at the placement of the children');
    });
  });

  describe('track', () => {
    test('a refusal after the artifact is created takes its record with it, and a track that meets it again is whole', () => {
      writeArtifact(fx, 'cmd_demo/tr.md', '# Tr\n\nTr text.\n');
      const before = mark(fx.store);
      const fault = refuseWrite(fx.store, 'addPair', (_g, _s, field) => field === 'fileHash');
      try {
        refuses(() => runTrack(fx.store, ['cmd_demo/tr.md']), /injected/);
      } finally { fault.restore(); }
      assertNothingLeft(fx.store, before, 'track refused after the creation of the artifact');
      assert.equal(runTrack(fx.store, ['cmd_demo/tr.md']).trackedCount, 1);
    });
  });

  describe('ingest', () => {
    test('a refusal in the folder step takes the folder it made with it; the file the command tracked before it stays tracked, as a complete step', () => {
      writeArtifact(fx, 'cmd_demo/fresh/f.md', '# F\n\n## G\n\nG text.\n');
      runTrack(fx.store, ['cmd_demo/fresh/f.md']);
      const before = mark(fx.store);
      const fault = refuseWrite(fx.store, 'insertItem', (_g, _host, _field, item) => String(item).startsWith('FolderNode:'));
      try {
        refuses(() => runIngest(fx.store, ['cmd_demo/fresh/f.md'], false, false), /injected/);
      } finally { fault.restore(); }
      assertNothingLeft(fx.store, before, 'ingest refused in the folder tree');
      rmSync(join(fx.artifactsRoot, 'cmd_demo', 'fresh'), { recursive: true }); // so that the case below finds the folder step with nothing to do
    });

    test('a file whose ingestion fails after its blocks are made is reported in `failed` and leaves none of them', () => {
      writeArtifact(fx, 'cmd_demo/two.md', '# Two\n\n## H1\n\nH1 text.\n\n## H2\n\nH2 text.\n');
      runTrack(fx.store, ['cmd_demo/two.md']);
      const before = mark(fx.store);
      const artifact = fx.store.maps.liveAtPath('cmd_demo/two.md', { kind: 'ArtifactNode' })!;
      const fault = refuseWrite(fx.store, 'insertItem', (_g, host) => host === artifact);
      let failed: Array<{ path: string; error: string }> = [];
      try {
        failed = runIngest(fx.store, ['cmd_demo/two.md'], false, false).failed;
      } finally { fault.restore(); }
      assert.equal(failed.length, 1);
      assert.match(failed[0]!.error, /injected/);
      assertNoRecordsLeft(fx.store, before, 'ingest of a file that fails after its blocks are made');
    });
  });

  describe('resolve --create-holder', () => {
    test('a chain that meets a refusal midway takes the folder and the artifact it made with it', () => {
      const before = mark(fx.store);
      refuses(() => runResolve(fx.store, { paths: ['cmd_demo/newdir/h.md/A/B'], createHolder: true, titles: ['### B'] }), /would need to be created, but no title was supplied/);
      assertNothingLeft(fx.store, before, 'resolve --create-holder refused for a title');
    });
  });

  describe('profile and views', () => {
    test('profile create: a refusal after the profile is made takes it with it', () => {
      const store = newDb();
      const before = mark(store);
      const fault = refuseWrite(store, 'addPair', (_g, _s, field) => field === 'handle');
      try { refuses(() => runProfileCreate(store, 'ghost'), /injected/); } finally { fault.restore(); }
      assertNothingLeft(store, before, 'profile create');
      assert.deepEqual(runProfileCreate(store, 'ghost').id.startsWith('Profile:'), true, 'and the handle is free');
    });

    test('profile create-view: a refusal after the view is made takes it with it', () => {
      const store = newDb();
      runProfileCreate(store, 'owner');
      const before = mark(store);
      const fault = refuseWrite(store, 'addPair', (_g, _s, field) => field === 'profile');
      try { refuses(() => runProfileCreateView(store, 'v', 'owner'), /injected/); } finally { fault.restore(); }
      assertNothingLeft(store, before, 'profile create-view');
    });

    test('unfold, fold, zoom and tree --view on the first use of the default view: a ref that does not resolve takes the profile and the view they minted with it', () => {
      for (const [name, call] of [
        ['unfold', (store: Db) => runUnfoldOp(store, { ref: 'cmd_demo/nothing', showTombstoned: false })],
        ['fold', (store: Db) => runFoldOp(store, { ref: 'cmd_demo/nothing' })],
        ['zoom', (store: Db) => runZoomOp(store, { ref: 'cmd_demo/nothing' })],
        ['tree --view', (store: Db) => runTree(store, { pathArg: 'cmd_demo/nothing', noHolders: false, showTombstoned: false, viewRef: 'default' })],
      ] as const) {
        const store = newDb();
        const before = mark(store);
        refuses(() => call(store), /isn't a tracked artifact\/folder path/);
        assertNothingLeft(store, before, `${name} on a graph with no default view`);
      }
    });
  });
});
