// `runProject` before the writes move to the engine (planning/core.md, Batch 11, step 10): what a projection renders for an artifact and for a folder (its
// `README.md`), the hashes a real projection records and a dry run does not, the hold-back of a file that changed on disk since the graph last knew it (and
// the `force` that overrides it), the purity gate (no placeholder anywhere in the subtree), the first projection that makes a placeholder artifact real, and a
// path that does not resolve. `runProject` renders and records; the file is written by the caller, as `aperas project` does, here `projectToDisk`. The cases
// share one store and one scratch folder and run in order. The store is reached through `fx.store`, `wrap` and the `runX` functions only.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runProject } from '../../kgProject';
import { runIngest } from '../../kgIngest';
import { runInsert } from '../../kgInsert';
import { runResolve } from '../../kgResolve';
import { runShow } from '../../kgShow';
import { runTrack, runReverseTrack } from '../../kgTrack';
import { runTree } from '../../kgTree';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';
import { idOf, parseTree, projectToDisk, writeArtifact } from '../support/commandsCorpus.ts';

const refuses = (fn: () => unknown, message: RegExp): void => assert.throws(fn, (e: unknown) => e instanceof Error && message.test(e.message), `expected a refusal matching ${message}`);
const NOT_FOUND = /No ingested ArtifactNode or FolderNode found for/;
const PLACEHOLDER = /still has a placeholder \(holder\) node somewhere in its subtree/;

describe('project', () => {
  let fx: FixtureStore;
  const onDisk = (path: string): string => join(fx.artifactsRoot, path);
  const read = (path: string): string => readFileSync(onDisk(path), 'utf-8');
  const stored = (id: string) => runShow(fx.store, id) as { fileHash?: string; ingestedHash?: string; projectedHash?: string; lastIngestedAt?: string; text?: string; props?: Array<{ key: string; value: string }> };
  const entry = (ref: string, id: string) => parseTree(runTree(fx.store, { pathArg: ref, noHolders: false, showTombstoned: false }) as string[]).find((e) => e.id === id);
  const rendered = (r: ReturnType<typeof runProject>): { markdown: string; targetFile: string } => {
    if (r.markdown === undefined) assert.fail(`a projection was held back: ${JSON.stringify(r)}`);
    return { markdown: r.markdown, targetFile: r.targetFile };
  };
  before(() => {
    fx = makeFixtureStore('proj_demo');
    writeArtifact(fx, 'proj_demo/README.md', '---\ndescription: A folder\n---\n\n# Proj demo\n\nFolder readme body.\n');
    writeArtifact(fx, 'proj_demo/a.md', '# A\n\nA text.\n\n## A Sec\n\nSec text.\n');
    writeArtifact(fx, 'proj_demo/b.md', '# B\n\nB text.\n');
    runIngest(fx.store, [], true, false);
    runIngest(fx.store, ['proj_demo/a.md', 'proj_demo/b.md'], true, false);
  });
  after(() => fx.cleanup());

  describe('an artifact', () => {
    let a = '';
    before(() => { a = idOf(fx, 'proj_demo/a.md'); });

    test('a dry run renders the markdown with the id anchors and the file it would write, and records nothing', () => {
      const r = rendered(runProject(fx.store, 'proj_demo/a.md', true));
      assert.equal(r.targetFile, onDisk('proj_demo/a.md'));
      assert.ok(r.markdown.startsWith('# A <a name=\'id/'), r.markdown);
      assert.ok(r.markdown.includes('\n\nA text.\n'));
      assert.ok(r.markdown.includes('## A Sec <a name=\'id/'));
      assert.equal(stored(a).projectedHash, undefined);
      assert.ok(runReverseTrack(fx.store).neverProjected.some((e) => e.path === 'proj_demo/a.md'));
    });

    test('a real projection renders the same markdown and records the hash of it as the projected, tracked and ingested hash', () => {
      const dry = rendered(runProject(fx.store, 'proj_demo/a.md', true));
      const r = projectToDisk(fx, 'proj_demo/a.md');
      assert.ok('markdown' in r);
      assert.equal(r.markdown, dry.markdown);
      assert.equal(read('proj_demo/a.md'), dry.markdown);
      const s = stored(a);
      assert.ok(s.projectedHash && s.projectedHash.length > 0);
      assert.equal(s.fileHash, s.projectedHash);
      assert.equal(s.ingestedHash, s.projectedHash);
      assert.equal(typeof s.lastIngestedAt, 'string');
      assert.equal(runReverseTrack(fx.store).neverProjected.some((e) => e.path === 'proj_demo/a.md'), false);
    });

    test('the file the caller writes is what the graph recorded: a track finds nothing to do', () => {
      assert.deepEqual(runTrack(fx.store, ['proj_demo/a.md']), { trackedCount: 0, skippedCount: 1, skippedReadmes: [], renamed: 0, removed: 0 });
    });

    test('a file edited on disk since the graph last knew it is held back, and nothing is recorded', () => {
      const hashes = stored(a);
      writeFileSync(onDisk('proj_demo/a.md'), '# A\n\nHand edited.\n', 'utf-8');
      const r = runProject(fx.store, 'proj_demo/a.md', false);
      assert.deepEqual(r, { conflict: true, path: 'proj_demo/a.md', targetFile: onDisk('proj_demo/a.md') });
      assert.equal(read('proj_demo/a.md'), '# A\n\nHand edited.\n');
      assert.deepEqual(stored(a), hashes);
    });

    test('force projects over it, and the hashes follow', () => {
      const before = stored(a).projectedHash;
      const r = projectToDisk(fx, 'proj_demo/a.md', true);
      assert.ok('markdown' in r);
      assert.equal(read('proj_demo/a.md'), r.markdown);
      assert.equal(stored(a).fileHash, stored(a).projectedHash);
      assert.equal(stored(a).projectedHash, before, 'the graph content is the same, so the render and its hash are too');
    });

    test('a dry run is never held back, and a file that is the same as the render is not a conflict', () => {
      writeFileSync(onDisk('proj_demo/a.md'), '# A\n\nHand edited again.\n', 'utf-8');
      assert.ok('markdown' in runProject(fx.store, 'proj_demo/a.md', true));
      projectToDisk(fx, 'proj_demo/a.md', true);
      assert.ok('markdown' in runProject(fx.store, 'proj_demo/a.md', false));
    });
  });

  describe('a folder', () => {
    let folder = '';
    before(() => { folder = idOf(fx, 'proj_demo'); });

    test('a dry run renders the README with the frontmatter and the body, and records nothing', () => {
      const r = rendered(runProject(fx.store, 'proj_demo', true));
      assert.equal(r.targetFile, onDisk('proj_demo/README.md'));
      assert.ok(r.markdown.startsWith('---\ndescription: A folder\n---\n\n# Proj demo <a name=\'id/'), r.markdown);
      assert.ok(r.markdown.endsWith('\n\nFolder readme body.\n'));
      assert.equal(stored(folder).projectedHash, undefined);
    });

    test('the first real projection over a README the graph has not projected is not a conflict, and records the hash of the render', () => {
      assert.notEqual(read('proj_demo/README.md'), rendered(runProject(fx.store, 'proj_demo', true)).markdown, 'the README on disk is the hand-written one');
      const r = projectToDisk(fx, 'proj_demo');
      assert.ok('markdown' in r);
      assert.equal(read('proj_demo/README.md'), r.markdown);
      assert.ok(stored(folder).projectedHash);
    });

    test('a README edited on disk since is held back, and force projects over it', () => {
      const hash = stored(folder).projectedHash;
      writeFileSync(onDisk('proj_demo/README.md'), 'Hand edited README.\n', 'utf-8');
      assert.deepEqual(runProject(fx.store, 'proj_demo', false), { conflict: true, path: 'proj_demo', targetFile: onDisk('proj_demo/README.md') });
      assert.equal(stored(folder).projectedHash, hash);
      const r = projectToDisk(fx, 'proj_demo', true);
      assert.ok('markdown' in r);
      assert.equal(read('proj_demo/README.md'), r.markdown);
    });

    test('the root of the artifacts projects to its README path', () => {
      const r = rendered(runProject(fx.store, '.', true));
      assert.equal(r.targetFile, onDisk('README.md'));
    });
  });

  describe('the purity gate', () => {
    test('a placeholder in the subtree holds back the artifact and the folders above it, and nothing is recorded', () => {
      runResolve(fx.store, { paths: ['proj_demo/b.md/B/Ghost'], createHolder: true, titles: ['Ghost'] });
      const b = idOf(fx, 'proj_demo/b.md');
      const folder = idOf(fx, 'proj_demo');
      const before = [stored(b), stored(folder)];
      for (const dry of [true, false]) {
        refuses(() => runProject(fx.store, 'proj_demo/b.md', dry), PLACEHOLDER);
        refuses(() => runProject(fx.store, 'proj_demo', dry), PLACEHOLDER);
        refuses(() => runProject(fx.store, '.', dry), PLACEHOLDER);
      }
      assert.deepEqual([stored(b), stored(folder)], before);
      assert.ok('markdown' in runProject(fx.store, 'proj_demo/a.md', true), 'an artifact without a placeholder is not affected');
    });

    test('once the placeholder is promoted the artifact projects, and its block shows in the render', () => {
      runInsert(fx.store, { path: idOf(fx, 'proj_demo/b.md/B/Ghost') });
      const r = rendered(runProject(fx.store, 'proj_demo/b.md', true));
      assert.ok(r.markdown.includes('\nGhost <a name=\'id/'), r.markdown);
    });
  });

  describe('a placeholder artifact', () => {
    test('its first projection makes it real, and a file already at its path is a conflict until forced', () => {
      runResolve(fx.store, { paths: ['proj_demo/hold.md/Hold'], createHolder: true, titles: ['hold.md', 'Hold'] });
      const hold = idOf(fx, 'proj_demo/hold.md');
      assert.ok(entry('proj_demo/hold.md', hold)!.rest.endsWith('(holder)'));
      refuses(() => runProject(fx.store, 'proj_demo/hold.md', false), PLACEHOLDER);
      runInsert(fx.store, { path: idOf(fx, 'proj_demo/hold.md/Hold') });

      writeArtifact(fx, 'proj_demo/hold.md', '# Hold\n\nA file the graph never read.\n');
      assert.deepEqual(runProject(fx.store, 'proj_demo/hold.md', false), { conflict: true, path: 'proj_demo/hold.md', targetFile: onDisk('proj_demo/hold.md') });
      assert.ok(entry('proj_demo/hold.md', hold)!.rest.endsWith('(holder)'), 'a held-back projection promotes nothing');

      const r = projectToDisk(fx, 'proj_demo/hold.md', true);
      assert.ok('markdown' in r);
      assert.equal(entry('proj_demo/hold.md', hold)!.rest.endsWith('(holder)'), false);
      assert.equal(stored(hold).fileHash, stored(hold).projectedHash);
    });
  });

  describe('refused', () => {
    test('a path that resolves to nothing, to a block, or by id', () => {
      refuses(() => runProject(fx.store, 'proj_demo/nothing.md', true), NOT_FOUND);
      refuses(() => runProject(fx.store, 'proj_demo/a.md/A', true), NOT_FOUND);
      refuses(() => runProject(fx.store, idOf(fx, 'proj_demo/a.md'), true), NOT_FOUND);
      refuses(() => runProject(fx.store, 'nothing', false), NOT_FOUND);
    });
  });
});
