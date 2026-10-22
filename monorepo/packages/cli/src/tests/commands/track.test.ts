// `runTrack` and `runReverseTrack` before the writes move to the engine (planning/core.md, Batch 11, step 10): what a track does with a file that is new, edited,
// unchanged, renamed or gone, for the whole corpus and for the paths given (a file, a directory, a README), and the three lists of `track --reverse`
// (never projected, changed since the last projection, removed in the graph and still on disk). A removal a full sweep would make is held back and listed
// until it is forced. The three lists come by id of the node (the artifacts, then the folders). The cases share one store and one scratch folder and run in
// order. The store is reached through `fx.store`, `wrap` and the `runX` functions only.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runTrack, runReverseTrack } from '../../kgTrack';
import { runIngest } from '../../kgIngest';
import { runShow } from '../../kgShow';
import { runUpdate } from '../../kgUpdate';
import { runRemove } from '../../kgRemove';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';
import { idOf, projectToDisk, writeArtifact } from '../support/commandsCorpus.ts';

const sorted = (xs: readonly string[]): string[] => [...xs].sort();
const keyed = (xs: Array<{ path: string; kind: string }>): string[] => sorted(xs.map((e) => `${e.kind}:${e.path}`));

describe('track', () => {
  let fx: FixtureStore;
  const onDisk = (path: string): string => join(fx.artifactsRoot, path);
  const stored = (id: string) => runShow(fx.store, id) as { path?: string; fileHash?: string; ingestedHash?: string; tombstonedAt?: string };
  before(() => {
    fx = makeFixtureStore('trk_demo');
    writeArtifact(fx, 'trk_demo/a.md', '# A\n\nA text.\n');
    writeArtifact(fx, 'trk_demo/b.md', '# B\n\nB text.\n');
    writeArtifact(fx, 'trk_demo/c.md', '# C\n\nC text.\n');
    runIngest(fx.store, ['trk_demo/a.md', 'trk_demo/b.md', 'trk_demo/c.md'], true, false);
  });
  after(() => fx.cleanup());

  describe('what is tracked', () => {
    test('a sweep of unchanged files tracks none and skips each, and removes nothing', () => {
      assert.deepEqual(runTrack(fx.store, []), { trackedCount: 0, skippedCount: 3, skippedReadmes: [], renamed: 0, removed: 0, pendingRemovals: [] });
    });

    test('a path given tracks that file only; an unchanged one is skipped', () => {
      assert.deepEqual(runTrack(fx.store, ['trk_demo/a.md']), { trackedCount: 0, skippedCount: 1, skippedReadmes: [], renamed: 0, removed: 0 });
    });

    test('a new file is tracked by its path, and then a sweep skips it', () => {
      writeArtifact(fx, 'trk_demo/d.md', '# D\n\nD text.\n');
      const r = runTrack(fx.store, ['trk_demo/d.md']);
      assert.equal(r.trackedCount, 1);
      assert.equal(r.skippedCount, 0);
      assert.equal(runTrack(fx.store, []).skippedCount, 4);
    });

    test('a new file is tracked by a sweep, with no path given', () => {
      writeArtifact(fx, 'trk_demo/e.md', '# E\n\nE text.\n');
      const r = runTrack(fx.store, []);
      assert.equal(r.trackedCount, 1);
      assert.equal(r.skippedCount, 4);
      assert.deepEqual(r.pendingRemovals, []);
    });

    test('a directory is expanded to every file under it', () => {
      const r = runTrack(fx.store, ['trk_demo']);
      assert.equal(r.trackedCount + r.skippedCount, 5);
    });

    test('an edited file is tracked again: its hash moves and its ingested hash stays until the next ingest', () => {
      const a = idOf(fx, 'trk_demo/a.md');
      const hashBefore = stored(a).fileHash;
      assert.equal(hashBefore, stored(a).ingestedHash);
      writeArtifact(fx, 'trk_demo/a.md', '# A\n\nA text, edited.\n');
      const r = runTrack(fx.store, []);
      assert.equal(r.trackedCount, 1);
      assert.notEqual(stored(a).fileHash, hashBefore);
      assert.equal(stored(a).ingestedHash, hashBefore, 'track reads the file; it does not ingest it');
      runIngest(fx.store, ['trk_demo/a.md'], false, false);
      assert.equal(stored(a).ingestedHash, stored(a).fileHash);
    });

    test('a README given as a path is reported and not tracked', () => {
      writeArtifact(fx, 'trk_demo/README.md', '# Trk demo\n\nA readme.\n');
      const r = runTrack(fx.store, ['trk_demo/README.md']);
      assert.deepEqual(r.skippedReadmes, ['trk_demo/README.md']);
      assert.equal(r.trackedCount, 0);
      assert.equal(r.skippedCount, 0);
    });
  });

  describe('a file renamed on disk', () => {
    test('a sweep finds the same content at a new path, and the node follows the file with its id', () => {
      const b = idOf(fx, 'trk_demo/b.md');
      renameSync(onDisk('trk_demo/b.md'), onDisk('trk_demo/b2.md'));
      const r = runTrack(fx.store, []);
      assert.equal(r.renamed, 1);
      assert.equal(r.removed, 0);
      assert.deepEqual(r.pendingRemovals, []);
      assert.equal(stored(b).path, 'trk_demo/b2.md');
      assert.equal(idOf(fx, 'trk_demo/b2.md'), b);
      assert.equal(stored(b).tombstonedAt, undefined);
    });

    test('a track of the new path alone finds it too', () => {
      const c = idOf(fx, 'trk_demo/c.md');
      renameSync(onDisk('trk_demo/c.md'), onDisk('trk_demo/c2.md'));
      const r = runTrack(fx.store, ['trk_demo/c2.md']);
      assert.equal(r.renamed, 1);
      assert.equal(r.removed, 0);
      assert.equal(r.pendingRemovals, undefined, 'a track of given paths holds nothing back, it removes nothing');
      assert.equal(stored(c).path, 'trk_demo/c2.md');
    });
  });

  describe('a file gone from disk', () => {
    let d = '';
    before(() => { d = idOf(fx, 'trk_demo/d.md'); });

    test('a track of other paths does not remove it', () => {
      rmSync(onDisk('trk_demo/d.md'));
      const r = runTrack(fx.store, ['trk_demo/a.md']);
      assert.equal(r.removed, 0);
      assert.equal(stored(d).tombstonedAt, undefined);
    });

    test('a sweep lists the removal and holds it back, and the node stays live', () => {
      const r = runTrack(fx.store, []);
      assert.deepEqual(r.pendingRemovals, ['trk_demo/d.md']);
      assert.equal(r.removed, 0);
      assert.equal(stored(d).tombstonedAt, undefined);
    });

    test('a forced sweep applies it: the node is tombstoned, and the other files are untouched', () => {
      const r = runTrack(fx.store, [], true);
      assert.equal(r.removed, 1);
      assert.deepEqual(r.pendingRemovals, []);
      assert.equal(typeof stored(d).tombstonedAt, 'string');
      assert.equal(stored(idOf(fx, 'trk_demo/a.md')).tombstonedAt, undefined);
      assert.equal(stored(idOf(fx, 'trk_demo/b2.md')).tombstonedAt, undefined);
    });

    test('a sweep after that has nothing left to hold back', () => {
      const r = runTrack(fx.store, []);
      assert.equal(r.removed, 0);
      assert.deepEqual(r.pendingRemovals, []);
    });
  });

  describe('track --reverse', () => {
    const listed = () => runReverseTrack(fx.store);

    test('the artifacts with content that were never projected are listed, and a node removed in the graph and still on disk is listed apart', () => {
      const r = listed();
      const artifacts = r.neverProjected.filter((e) => e.kind === 'ArtifactNode').map((e) => `${e.kind}:${e.path}`);
      assert.deepEqual(artifacts, ['ArtifactNode:trk_demo/a.md', 'ArtifactNode:trk_demo/b2.md', 'ArtifactNode:trk_demo/c2.md'], 'e.md is tracked and not ingested, so it has no content to project');
      assert.ok(keyed(r.neverProjected).includes('FolderNode:trk_demo'));
      assert.deepEqual(r.changed, []);
      assert.deepEqual(r.staleOnDisk, [], 'the removed d.md is gone from disk as well');
    });

    test('a projected artifact leaves the list, and an edit in the graph puts it in "changed" until it is projected again', () => {
      projectToDisk(fx, 'trk_demo/a.md');
      let r = listed();
      assert.equal(keyed(r.neverProjected).includes('ArtifactNode:trk_demo/a.md'), false);
      assert.equal(keyed(r.changed).includes('ArtifactNode:trk_demo/a.md'), false);
      runUpdate(fx.store, { path: 'trk_demo/a.md/A', markdown: 'A text, edited in the graph.\n', textOnly: false });
      r = listed();
      assert.ok(keyed(r.changed).includes('ArtifactNode:trk_demo/a.md'));
      assert.equal(keyed(r.neverProjected).includes('ArtifactNode:trk_demo/a.md'), false);
      projectToDisk(fx, 'trk_demo/a.md');
      assert.equal(keyed(listed().changed).includes('ArtifactNode:trk_demo/a.md'), false);
    });

    test('a folder is listed in the same way: never projected, projected, changed by an edit of its frontmatter', () => {
      runIngest(fx.store, [], false, false);
      assert.ok(keyed(listed().neverProjected).includes('FolderNode:trk_demo'));
      projectToDisk(fx, 'trk_demo');
      assert.equal(keyed(listed().neverProjected).includes('FolderNode:trk_demo'), false);
      assert.equal(keyed(listed().changed).includes('FolderNode:trk_demo'), false);
      runUpdate(fx.store, { path: 'trk_demo', markdown: '---\ndescription: A scratch folder\n---\n', textOnly: false });
      assert.ok(keyed(listed().changed).includes('FolderNode:trk_demo'));
    });

    test('an artifact removed in the graph whose file is still on disk is "stale on disk", and it is no longer "changed"', () => {
      runRemove(fx.store, { path: 'trk_demo/a.md' });
      const r = listed();
      assert.deepEqual(r.staleOnDisk, ['trk_demo/a.md']);
      assert.equal(keyed(r.changed).includes('ArtifactNode:trk_demo/a.md'), false);
      assert.equal(keyed(r.neverProjected).includes('ArtifactNode:trk_demo/a.md'), false);
    });

    test('it writes nothing: two calls in a row give the same lists, and the files and hashes are as they were', () => {
      const hash = stored(idOf(fx, 'trk_demo/b2.md')).fileHash;
      const first = listed();
      const second = listed();
      assert.deepEqual(first.neverProjected, second.neverProjected);
      assert.deepEqual(first.changed, second.changed);
      assert.deepEqual(first.staleOnDisk, second.staleOnDisk);
      assert.equal(stored(idOf(fx, 'trk_demo/b2.md')).fileHash, hash);
    });
  });
});
