// The view commands before the reads move to the engine (planning/core.md, Batch 11, step 10): the profile and view lifecycle (`runProfile*`), and the
// commands that change a view (`runUnfold` with one, `runFold`, `runZoom`), on a small corpus. Create, list and remove a profile and a view, a view's
// owner, the `default` view and profile a first use makes, the cascade of removing a profile, a refused duplicate, a fold that cascades over what is
// reached from the node and nothing else, and a zoom that moves the one root a view has. The profiles and the views are listed by id and the
// unfolded ids of a view by id too, and the cases compare that order exactly. The cases share one corpus and run in
// order. The store is reached through `fx.store`, `wrap` and the `runX` functions only.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTreeView } from '@aperas/core/shell/node';
import { runProfileCreate, runProfileCreateView, runProfileList, runProfileListView, runProfileRemove, runProfileRemoveView } from '../../kgProfile';
import { runFold } from '../../kgFold';
import { runZoom } from '../../kgZoom';
import { runUnfold } from '../../kgUnfold';
import { runTree } from '../../kgTree';
import { runRemove } from '../../kgRemove';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';
import { buildCorpus, type Corpus } from '../support/commandsCorpus.ts';

const sorted = (xs: readonly string[]): string[] => [...xs].sort();
const refuses = (fn: () => unknown, message: RegExp): void => assert.throws(fn, (e: unknown) => e instanceof Error && message.test(e.message), `expected a refusal matching ${message}`);
const NOT_TRACKED = /isn't a tracked artifact\/folder path, deep path, bare node code, or full node id/;

describe('profile and view commands', () => {
  let fx: FixtureStore;
  let c: Corpus;
  before(() => { fx = makeFixtureStore('cmd_demo'); c = buildCorpus(fx); });
  after(() => fx.cleanup());

  const profiles = () => (runProfileList(fx.store) as { profiles: Array<{ id: string; handle: string; name?: string; kind?: string; viewCount: number }> }).profiles;
  const views = () => (runProfileListView(fx.store) as { views: Array<{ id: string; name: string; profileHandle?: string; unfoldCount: number }> }).views;
  const unfoldsOf = (name: string): string[] => (runProfileListView(fx.store, name) as { unfolds: string[] }).unfolds;

  describe('profiles', () => {
    test('there are none to start with, and one created has its handle, name and kind', () => {
      assert.deepEqual(profiles(), []);
      const { id } = runProfileCreate(fx.store, 'will', 'Will', 'human');
      assert.ok(id.startsWith('Profile:'), id);
      assert.deepEqual(profiles(), [{ id, handle: 'will', name: 'Will', kind: 'human', viewCount: 0 }]);
    });

    test('a name and a kind are optional', () => {
      const { id } = runProfileCreate(fx.store, 'bare');
      const p = profiles().find((x) => x.id === id)!;
      assert.equal(p.handle, 'bare');
      assert.equal(p.name, undefined);
      assert.equal(p.kind, undefined);
    });

    test('listing one by handle gives its detail: preferences and views', () => {
      const d = runProfileList(fx.store, 'will') as { handle: string; name?: string; preferences: unknown[]; views: unknown[] };
      assert.equal(d.handle, 'will');
      assert.equal(d.name, 'Will');
      assert.deepEqual(d.preferences, []);
      assert.deepEqual(d.views, []);
    });

    test('refused: a second profile with a handle that is taken, and the detail of one that does not exist', () => {
      refuses(() => runProfileCreate(fx.store, 'will'), /Profile 'will' already exists/);
      refuses(() => runProfileList(fx.store, 'nobody'), /Profile 'nobody' not found/);
      assert.equal(profiles().filter((p) => p.handle === 'will').length, 1);
    });
  });

  describe('views', () => {
    test('a view is created under a profile that exists, and it shows in both lists', () => {
      const { id } = runProfileCreateView(fx.store, 'mine', 'will');
      assert.ok(id.startsWith('TreeView:'), id);
      assert.deepEqual(views(), [{ id, name: 'mine', profileHandle: 'will', unfoldCount: 0 }]);
      assert.equal(profiles().find((p) => p.handle === 'will')!.viewCount, 1);
      assert.deepEqual((runProfileList(fx.store, 'will') as { views: unknown[] }).views, [{ id, name: 'mine' }]);
      assert.deepEqual(runProfileListView(fx.store, 'mine'), { id, name: 'mine', profileHandle: 'will', unfoldCount: 0, unfolds: [] });
    });

    test('refused: a name that is taken, an owner that does not exist, and the detail of a view that does not exist', () => {
      refuses(() => runProfileCreateView(fx.store, 'mine', 'bare'), /TreeView 'mine' already exists/);
      refuses(() => runProfileCreateView(fx.store, 'other', 'nobody'), /Profile 'nobody' not found/);
      refuses(() => runProfileListView(fx.store, 'nothing'), /TreeView 'nothing' not found/);
      assert.equal(views().length, 1);
    });

    test('unfold with a view adds exactly that one node to the view, once, and a link as well as a node', () => {
      const view = resolveTreeView(fx.store, 'mine');
      const r = runUnfold(fx.store, 'cmd_demo/alpha.md', view);
      assert.equal(r.id, c.alphaArt);
      assert.deepEqual(unfoldsOf('mine'), [c.alphaArt], 'only the ref itself, not its children');
      runUnfold(fx.store, c.alphaArt, resolveTreeView(fx.store, 'mine'));
      assert.deepEqual(unfoldsOf('mine'), [c.alphaArt], 'unfolding it again adds nothing');
      runUnfold(fx.store, c.alphaLinkToBeta, resolveTreeView(fx.store, 'mine'));
      assert.deepEqual(unfoldsOf('mine'), sorted([c.alphaArt, c.alphaLinkToBeta]), 'listed by id');
      assert.equal(views()[0].unfoldCount, 2);
    });

    test('fold removes the node and what is reached from it that is also unfolded, and leaves the rest', () => {
      const view = () => resolveTreeView(fx.store, 'mine');
      runUnfold(fx.store, c.alpha, view());
      runUnfold(fx.store, c.betaArt, view());
      assert.deepEqual(unfoldsOf('mine'), sorted([c.alphaArt, c.alphaLinkToBeta, c.alpha, c.betaArt]), 'listed by id');
      const r = runFold(fx.store, 'cmd_demo/alpha.md', view());
      assert.deepEqual(r, { id: c.alphaArt });
      assert.deepEqual(unfoldsOf('mine'), [c.betaArt], 'the heading and the link under the artifact went; the target of the link, reached by another path, stayed');
    });

    test('folding a node that is not unfolded changes nothing', () => {
      const view = resolveTreeView(fx.store, 'mine');
      assert.deepEqual(runFold(fx.store, c.itemOne, view), { id: c.itemOne });
      assert.deepEqual(unfoldsOf('mine'), [c.betaArt]);
    });

    test('refused: fold of a path that resolves to nothing and of an id that no node has', () => {
      const view = resolveTreeView(fx.store, 'mine');
      refuses(() => runFold(fx.store, 'cmd_demo/nothing', view), NOT_TRACKED);
      refuses(() => runFold(fx.store, 'BlockNode:0000000000000', view), /Node 'BlockNode:0000000000000' not found/);
      assert.deepEqual(unfoldsOf('mine'), [c.betaArt]);
    });
  });

  describe('zoom', () => {
    test('sets the root of the view and unfolds the node, and answers the node\'s path, label and title', () => {
      const r = runZoom(fx.store, 'cmd_demo/beta.md', resolveTreeView(fx.store, 'mine'));
      assert.deepEqual(r, { id: c.betaArt, view: 'mine', path: 'cmd_demo/beta.md', label: 'ArtifactNode', title: 'beta.md  ║  Beta intro.' });
      assert.ok(unfoldsOf('mine').includes(c.betaArt));
    });

    test('a tree of the view with no path renders from its root, and a second zoom moves the one root', () => {
      const from = (): string => (runTree(fx.store, { noHolders: false, showTombstoned: false, viewRef: 'mine' }) as string[])[0];
      assert.equal(from(), 'aperas://tree/cmd_demo/beta.md');
      const r = runZoom(fx.store, c.alpha, resolveTreeView(fx.store, 'mine'));
      assert.equal(r.label, 'heading');
      assert.equal(r.path, 'cmd_demo/alpha.md/--alpha');
      assert.equal(from(), 'aperas://tree/cmd_demo/alpha.md/--alpha', 'only the current root is kept');
      assert.ok(unfoldsOf('mine').includes(c.alpha) && unfoldsOf('mine').includes(c.betaArt), 'the earlier unfold is not undone');
    });

    test('refused: a path that resolves to nothing, and an id that no node has', () => {
      const view = resolveTreeView(fx.store, 'mine');
      refuses(() => runZoom(fx.store, 'cmd_demo/nothing', view), NOT_TRACKED);
      refuses(() => runZoom(fx.store, 'BlockNode:0000000000000', view), /Node 'BlockNode:0000000000000' not found/);
    });
  });

  describe('the first use of a view', () => {
    test('with no name, or the name default, makes the default view and the default profile that owns it, once', () => {
      assert.equal(views().some((v) => v.name === 'default'), false);
      const view = resolveTreeView(fx.store);
      runZoom(fx.store, c.folder, view);
      assert.equal(resolveTreeView(fx.store, 'default').id, view.id, 'the same view again');
      const v = views().find((x) => x.name === 'default')!;
      assert.equal(v.profileHandle, 'default');
      assert.equal(profiles().filter((p) => p.handle === 'default').length, 1);
      assert.equal(profiles().find((p) => p.handle === 'default')!.viewCount, 1);
      assert.deepEqual(unfoldsOf('default'), [c.folder]);
    });

    test('refused: a view that was never made is not made by naming it', () => {
      refuses(() => resolveTreeView(fx.store, 'never-made'), /TreeView 'never-made' not found/);
      assert.equal(views().some((v) => v.name === 'never-made'), false);
    });
  });

  describe('removal', () => {
    test('removing a view takes that view only, and removing it again says there was none', () => {
      runProfileCreateView(fx.store, 'second', 'will');
      assert.deepEqual(runProfileRemoveView(fx.store, 'second'), { removed: true });
      assert.equal(views().some((v) => v.name === 'second'), false);
      assert.ok(views().some((v) => v.name === 'mine'), 'the other view of the profile stays');
      assert.deepEqual(runProfileRemoveView(fx.store, 'second'), { removed: false });
    });

    test('removing a profile takes the views it owns, and nobody else\'s', () => {
      runProfileCreateView(fx.store, 'second', 'will');
      runProfileCreateView(fx.store, 'bares', 'bare');
      const r = runProfileRemove(fx.store, 'will');
      assert.deepEqual(r, { removed: true, viewsRemoved: 2 });
      assert.equal(profiles().some((p) => p.handle === 'will'), false);
      const left = views();
      assert.deepEqual(left.map((v) => v.id), sorted(left.map((v) => v.id)), 'the views are listed by id');
      assert.deepEqual(sorted(left.map((v) => v.name)), ['bares', 'default']);
      refuses(() => runProfileListView(fx.store, 'mine'), /TreeView 'mine' not found/);
      assert.deepEqual(runProfileRemove(fx.store, 'will'), { removed: false, viewsRemoved: 0 });
    });

    test('a view can be made again under a name that was freed', () => {
      runProfileCreate(fx.store, 'will');
      runProfileCreateView(fx.store, 'mine', 'will');
      assert.deepEqual(unfoldsOf('mine'), [], 'a new view, with nothing unfolded');
    });
  });

  describe('after a removal of a node', () => {
    test('zoom refuses a tombstoned node, and the view keeps the root it had', () => {
      const view = resolveTreeView(fx.store, 'mine');
      runZoom(fx.store, c.betaArt, view);
      runRemove(fx.store, { path: 'cmd_demo/beta.md/Beta/Other' });
      refuses(() => runZoom(fx.store, c.betaOther, resolveTreeView(fx.store, 'mine')), /is tombstoned — zooming a view onto a dead node isn't meaningful/);
      assert.equal((runTree(fx.store, { noHolders: false, showTombstoned: false, viewRef: 'mine' }) as string[])[0], 'aperas://tree/cmd_demo/beta.md');
    });
  });
});
