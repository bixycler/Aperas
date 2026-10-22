// `runRemove` before the writes move to the engine (planning/core.md, Batch 11, step 10): a removal tombstones the subtree of a block, of an artifact and
// of a folder, and nothing around it; the root of the artifacts is refused, and so is a node that is not a block, an artifact or a folder; the path
// of a removed artifact or folder, taken again by a new file, belongs to a new node; `track --reverse` sees what a removal does to a projected tree.
// The cases share one corpus and run in order, each removing something the later ones do not need. A tombstone leaves the list of its container (the engine
// does it): a case reads `show` and the rendered `tree`, which shows nothing in place for a removed node, with or without the flag, and shows it tagged by its id.
// The store is reached through `fx.store`, `wrap` and the `runX` functions only.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runRemove } from '../../kgRemove';
import { runShow } from '../../kgShow';
import { runTree } from '../../kgTree';
import { runIngest } from '../../kgIngest';
import { runReverseTrack } from '../../kgTrack';
import { dumpMirror } from '@aperas/core/shell/mirrorDump';
import { wrap, type BlockNode } from '@aperas/core/shell/node';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';
import { buildCorpus, idOf, parseTree, projectToDisk, writeArtifact, type Corpus } from '../support/commandsCorpus.ts';
import { tombstonesInLists } from '../support/mirrorLists.ts';

const refuses = (fn: () => unknown, message: RegExp): void => assert.throws(fn, (e: unknown) => e instanceof Error && message.test(e.message), `expected a refusal matching ${message}`);
const NOT_TRACKED = /isn't a tracked artifact\/folder path, deep path, bare node code, or full node id/;

describe('remove', () => {
  let fx: FixtureStore;
  let c: Corpus;
  before(() => { fx = makeFixtureStore('cmd_demo'); c = buildCorpus(fx); });
  after(() => fx.cleanup());

  const deadAt = (id: string): unknown => runShow(fx.store, id).tombstonedAt;
  const isDead = (id: string): boolean => typeof deadAt(id) === 'string' && !Number.isNaN(Date.parse(deadAt(id) as string));
  const isLive = (id: string): boolean => deadAt(id) === undefined;
  const tree = (path: string, showTombstoned: boolean) => parseTree(runTree(fx.store, { pathArg: path, noHolders: false, showTombstoned }) as string[]);

  describe('refused', () => {
    test('the root of the artifacts, and nothing is removed', () => {
      refuses(() => runRemove(fx.store, { path: '.' }), /Refusing to remove the artifacts root/);
      const rootId = idOf(fx, '.');
      assert.ok(isLive(rootId) && isLive(c.folder) && isLive(c.alphaArt));
    });

    test('a path that resolves to nothing', () => {
      refuses(() => runRemove(fx.store, { path: 'cmd_demo/nothing' }), NOT_TRACKED);
      refuses(() => runRemove(fx.store, { path: 'cmd_demo/alpha.md/Alpha/Nothing' }), NOT_TRACKED);
      assert.ok(isLive(c.alpha));
    });

    test('a node that is not a block, an artifact or a folder: a link', () => {
      refuses(() => runRemove(fx.store, { path: c.alphaLinkToBeta }), /doesn't resolve to a removable node/);
      assert.ok(isLive(c.alpha));
      assert.equal(runShow(fx.store, c.alphaLinkToBeta).target, c.betaArt, 'the link is untouched');
    });
  });

  describe('a block', () => {
    test('takes the block and everything under it, and leaves the parent, the siblings and the other artifacts live', () => {
      const r = runRemove(fx.store, { path: 'cmd_demo/alpha.md/Alpha' });
      assert.deepEqual(r, { id: c.alpha });
      assert.ok(isDead(c.alpha), 'the block');
      assert.ok(isDead(c.alphaSec), 'its child');
      assert.ok(isLive(c.alphaArt), 'the artifact it was in');
      for (const id of [c.betaArt, c.beta, c.betaSec, c.betaOther, c.gammaArt, c.gamma, c.dupArt, c.itemOne, c.folder]) assert.ok(isLive(id), `${id} is live`);
    });

    test('tree hides the removed subtree, and shows it tagged with showTombstoned', () => {
      const hidden = tree('cmd_demo/alpha.md', false);
      assert.deepEqual(hidden.map((e) => e.id), [c.alphaArt]);
      const shown = tree('cmd_demo/alpha.md', true);
      assert.deepEqual(shown.map((e) => e.id), [c.alphaArt], 'a removed block left its container: nothing in place, with the flag too');
      assert.equal(shown.find((e) => e.id === c.alphaArt)!.rest.endsWith('(tombstoned)'), false);
      const byId = tree(c.alpha, true);
      assert.ok(byId[0].rest.endsWith('(tombstoned)'), 'the removed block, by its id');
    });

    test('a path is taken by a deep path, a bare code or a full id, and `base` shifts a relative path', () => {
      assert.deepEqual(runRemove(fx.store, { path: c.betaOther.split(':')[1] }), { id: c.betaOther });
      assert.deepEqual(runRemove(fx.store, { path: 'Beta/Beta Section', base: 'cmd_demo/beta.md' }), { id: c.betaSec });
      assert.deepEqual(runRemove(fx.store, { path: `aperas://id/${c.itemOne}` }), { id: c.itemOne });
      for (const id of [c.betaOther, c.betaSec, c.itemOne]) assert.ok(isDead(id), id);
      assert.ok(isLive(c.beta) && isLive(c.itemTwo) && isLive(c.dup));
    });

    test('a removed block has no container and no place: toPath() is null for it and for the block under it, and the container it left has no trace of it', () => {
      for (const id of [c.alpha, c.alphaSec]) {
        assert.ok(isDead(id), id);
        assert.equal((wrap(fx.store, id) as unknown as BlockNode).toPath(), null, `${id} has no path`);
        assert.equal((wrap(fx.store, id) as unknown as BlockNode).parent, undefined, `${id} has no parent`);
      }
      assert.equal((wrap(fx.store, c.alphaArt) as unknown as BlockNode).treeChildren.some((k) => k.id === c.alpha), false, 'it left the list of its container');
      assert.equal(typeof (wrap(fx.store, c.alphaArt) as unknown as BlockNode).toPath(), 'string', 'a live node of the same document still has one');
    });

    test('removing a node that is already removed is not refused, and it stays dead', () => {
      assert.deepEqual(runRemove(fx.store, { path: c.alpha }), { id: c.alpha });
      assert.ok(isDead(c.alpha) && isDead(c.alphaSec));
      assert.ok(isLive(c.alphaArt));
    });

    test('the mirror a flush writes holds the tombstones of the block, and none of them is in a `children` list of a live container', () => {
      dumpMirror(fx.store.engine, fx.root, fx.store.mapping);
      const { tombstones, inLists, listed } = tombstonesInLists(fx.apeironRoot);
      for (const id of [c.alpha, c.alphaSec, c.betaOther, c.betaSec, c.itemOne]) assert.ok(tombstones.includes(id), `${id} is in the file, a tombstone`);
      assert.ok(listed > 5, 'the lists of the live nodes are in the files');
      assert.deepEqual(inLists, [], 'no tombstone is named by a list');
    });
  });

  describe('an artifact', () => {
    test('takes the artifact and every block under it, and leaves the folder and the other artifacts live', () => {
      const r = runRemove(fx.store, { path: 'cmd_demo/gamma.md' });
      assert.deepEqual(r, { id: c.gammaArt });
      assert.ok(isDead(c.gammaArt) && isDead(c.gamma));
      for (const id of [c.folder, c.alphaArt, c.betaArt, c.dupArt, c.dup, c.itemTwo, c.beta]) assert.ok(isLive(id), `${id} is live`);
    });

    test('tree of the folder hides it, and shows it tagged with showTombstoned', () => {
      const hidden = tree('cmd_demo', false).map((e) => e.id);
      assert.equal(hidden.includes(c.gammaArt), false);
      assert.ok(hidden.includes(c.alphaArt) && hidden.includes(c.betaArt) && hidden.includes(c.dupArt));
      const shown = tree('cmd_demo', true);
      assert.equal(shown.some((e) => e.id === c.gammaArt), false, 'a removed artifact left its folder');
      assert.ok(tree(c.gammaArt, true)[0].rest.endsWith('(tombstoned)'), 'by its id');
    });

    test('the file is still on disk: it is the one that `track --reverse` lists as stale', () => {
      assert.deepEqual(runReverseTrack(fx.store).staleOnDisk, ['cmd_demo/gamma.md']);
    });

    test('a new ingest of the path makes a new artifact with new blocks, and the old ones stay dead', () => {
      const r = runIngest(fx.store, ['cmd_demo/gamma.md'], true, false);
      assert.deepEqual(r.ingested.map((i) => i.path), ['cmd_demo/gamma.md']);
      const fresh = idOf(fx, 'cmd_demo/gamma.md');
      const freshBlock = idOf(fx, 'cmd_demo/gamma.md/Gamma');
      assert.notEqual(fresh, c.gammaArt);
      assert.notEqual(freshBlock, c.gamma);
      assert.ok(isLive(fresh) && isLive(freshBlock));
      assert.ok(isDead(c.gammaArt) && isDead(c.gamma));
      assert.ok(tree('cmd_demo', false).some((e) => e.id === fresh));
    });
  });

  describe('track --reverse after a removal', () => {
    test('a block removed from a projected artifact makes the artifact changed; the artifact removed is no longer listed as changed, and its file is stale', () => {
      projectToDisk(fx, 'cmd_demo/dup.md');
      const names = (xs: Array<{ path: string }>) => xs.map((e) => e.path);
      assert.equal(names(runReverseTrack(fx.store).changed).includes('cmd_demo/dup.md'), false, 'projected and unchanged');
      assert.equal(names(runReverseTrack(fx.store).neverProjected).includes('cmd_demo/dup.md'), false);
      runRemove(fx.store, { path: 'cmd_demo/dup.md/Dup/Item-Two' });
      assert.ok(names(runReverseTrack(fx.store).changed).includes('cmd_demo/dup.md'), 'the render no longer matches what was projected');
      runRemove(fx.store, { path: 'cmd_demo/dup.md' });
      const after = runReverseTrack(fx.store);
      assert.equal(names(after.changed).includes('cmd_demo/dup.md'), false);
      assert.ok(after.staleOnDisk.includes('cmd_demo/dup.md'));
    });
  });

  describe('a folder', () => {
    test('takes the folder, its artifacts and their blocks, and leaves the root live', () => {
      const rootId = idOf(fx, '.');
      const r = runRemove(fx.store, { path: 'cmd_demo' });
      assert.deepEqual(r, { id: c.folder });
      for (const id of [c.folder, c.alphaArt, c.betaArt, c.beta, c.dupArt, c.dup]) assert.ok(isDead(id), `${id} is dead`);
      assert.ok(isLive(rootId));
      const hidden = tree('.', false).map((e) => e.id);
      assert.deepEqual(hidden, [rootId], 'nothing of the folder is shown');
      assert.deepEqual(tree('.', true).map((e) => e.id), [rootId], 'a removed folder left the root: nothing in place, with the flag too');
      assert.ok(tree(c.folder, true)[0].rest.endsWith('(tombstoned)'), 'by its id');
    });

    test('a file at the same folder path makes a new folder and a new artifact', () => {
      writeArtifact(fx, 'cmd_demo/again.md', '# Again\n\nA new file in a folder of the same name.\n');
      runIngest(fx.store, ['cmd_demo/again.md'], true, false);
      const folder = idOf(fx, 'cmd_demo');
      assert.notEqual(folder, c.folder);
      assert.ok(isLive(folder) && isLive(idOf(fx, 'cmd_demo/again.md')));
      assert.ok(isDead(c.folder) && isDead(c.alphaArt));
      assert.deepEqual(tree('cmd_demo', false).map((e) => e.label), ['FolderNode', 'ArtifactNode', 'heading']);
    });
  });
});
