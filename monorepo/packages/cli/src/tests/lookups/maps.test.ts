// The maps of a literal value (planning/core.md, Batch 10; design/core.md, "Lookups by a literal value"): a profile by its handle, a view by its name,
// an artifact or a folder by its stored path. Hand-written cases: the reproduction of the issue of the first node found (the reference copy's reader
// fails it, the primitive does not), the maps built from a loaded fixture (the shared string `default`, the profile named like a view, an absent
// key, the two graphs and the kind filter), a tombstoned and a live node at one path built in each order, a key held by two live nodes, each update
// function, and the update for a write the engine did not take. The random sequences are in `lookups.model.test.ts`.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from 'oxigraph';
import { MIRROR_GRAPHS } from '@aperas/core/graphConfig';
import type { Engine, Id } from '@aperas/core/apeironNgn/interface';
import { createLookups, pathKeyOf, type Lookups } from '@aperas/core/shell/lookups';
import { createMirrorGraphs } from '@aperas/core/shell/mirrorFiles';
import { loadMirror } from '@aperas/core/shell/mirrorLoad';
import { addQuad } from '@aperas/core/shell/storeAccess';
import { freeWasm } from '@aperas/core/shell/vocab';
import { findByExactPath } from '@aperas/core/shell/tree';
import { A_DESIGN, A_EMPTY, A_THREAD, F_DOCS, F_ROOT, F_THREADS, P_BARE, P_HUMAN, THREADS, TREE, V_BARE, V_MAIN, V_THREAD, VIEWS, fixtureDocs, idOf, newEngine, scratchRoot, testMapping, textsOf, writeTexts } from '../support/mirrorFixture.ts';

const AT = '2026-10-19T00:00:00.000Z';

/** A fresh engine with the three graphs, and the maps over it, empty. */
function fresh(): { engine: Engine; maps: Lookups } {
  const engine = newEngine();
  createMirrorGraphs(engine);
  return { engine, maps: createLookups(engine, MIRROR_GRAPHS) };
}
const artifact = (n: number, path: string, extra: Record<string, string> = {}) => ({ id: idOf('ArtifactNode', n), kind: 'ArtifactNode', fields: { title: `a${n}`, path, ...extra } });
const folder = (n: number, path: string) => ({ id: idOf('FolderNode', n), kind: 'FolderNode', fields: { title: `f${n}`, path } });
const profile = (n: number, handle: string, name?: string) => ({ id: idOf('Profile', n), kind: 'Profile', fields: { handle, ...(name !== undefined ? { name } : {}) } });
const view = (n: number, name: string, owner: Id = idOf('Profile', 1)) => ({ id: idOf('TreeView', n), kind: 'TreeView', fields: { profile: owner, name } });

describe('the reproduction of the first node found at a path', () => {
  const live = idOf('ArtifactNode', 1);
  const dead = idOf('ArtifactNode', 2);

  test('the reference copy\'s reader takes the first node found, so it returns the tombstoned one when the live one was stored first (goes with the reference copy, Batch 12)', () => {
    const answers: Record<string, string | null> = {};
    for (const order of ['live first', 'dead first']) {
      const store = new Store();
      for (const id of order === 'live first' ? [live, dead] : [dead, live]) {
        addQuad(store, id, 'path', { lit: 'a/b.md' });
        if (id === dead) addQuad(store, id, 'tombstonedAt', { lit: AT });
      }
      answers[order] = findByExactPath(store, 'a/b.md');
      freeWasm(store);
    }
    assert.deepEqual(answers, { 'live first': dead, 'dead first': live }, 'the answer depends on the order the store lists the nodes in');
  });

  test('the primitive returns the live one under both orders of building, and under both orders of the tombstone', () => {
    for (const [first, second] of [[live, dead], [dead, live]] as const) {
      const { engine, maps } = fresh();
      for (const id of [first, second]) engine.build(TREE, { id, kind: 'ArtifactNode', fields: { title: 't', path: 'a/b.md', ...(id === dead ? { tombstonedAt: AT } : {}) } });
      maps.rebuild();
      assert.equal(maps.liveAtPath('a/b.md'), live, `built ${first === live ? 'live' : 'dead'} first`);
    }
    for (const [first, second] of [[live, dead], [dead, live]] as const) {
      const { engine, maps } = fresh();
      for (const id of [first, second]) { engine.build(TREE, { id, kind: 'ArtifactNode', fields: { title: 't', path: 'a/b.md' } }); maps.built(TREE, id); }
      assert.equal(maps.duplicates().length, 1, 'two live holders to start with');
      engine.tombstone(TREE, dead, AT);
      maps.tombstoned(TREE, dead);
      assert.equal(maps.liveAtPath('a/b.md'), live, `tombstoned after both were built, ${first === live ? 'live' : 'dead'} first`);
      assert.deepEqual(maps.duplicates(), []);
    }
  });

  test('a tombstone alone holds the path for nobody, and a path reused after a removal is the new node\'s', () => {
    const { engine, maps } = fresh();
    engine.build(TREE, artifact(1, 'x.md'));
    maps.built(TREE, idOf('ArtifactNode', 1));
    engine.tombstone(TREE, idOf('ArtifactNode', 1), AT);
    maps.tombstoned(TREE, idOf('ArtifactNode', 1));
    assert.equal(maps.liveAtPath('x.md'), undefined);
    engine.build(TREE, artifact(2, 'x.md'));
    maps.built(TREE, idOf('ArtifactNode', 2));
    assert.equal(maps.liveAtPath('x.md'), idOf('ArtifactNode', 2));
    assert.equal(engine.first(TREE, idOf('ArtifactNode', 1), 'path'), 'x.md', 'the tombstone keeps its stored path');
  });
});

describe('the maps built from a loaded mirror', () => {
  function loaded(extra?: (docs: Record<string, unknown[]>) => void): { engine: Engine; maps: Lookups } {
    const docs = fixtureDocs();
    extra?.(docs);
    const { root, cleanup } = scratchRoot();
    try {
      const mapping = testMapping();
      writeTexts(root, textsOf(mapping, docs));
      const engine = newEngine();
      const result = loadMirror(engine, root, mapping);
      assert.deepEqual({ errors: result.errors, rejected: result.rejected }, { errors: [], rejected: [] });
      const maps = createLookups(engine, MIRROR_GRAPHS);
      assert.deepEqual(maps.rebuild(), []);
      return { engine, maps };
    } finally {
      cleanup();
    }
  }

  test('a profile by its handle, a view by its name, an artifact or a folder by its stored path', () => {
    const { maps } = loaded();
    assert.equal(maps.profileByHandle('will'), P_HUMAN);
    assert.equal(maps.profileByHandle('default'), P_BARE);
    assert.equal(maps.viewByName('main'), V_MAIN);
    assert.equal(maps.viewByName('bare'), V_BARE);
    assert.equal(maps.viewByName('thread view'), V_THREAD);
    assert.deepEqual(['.', 'docs', 'docs/design.md', 'docs/empty.md', '.threads', '.threads/coder.md'].map((p) => maps.liveAtPath(p)), [F_ROOT, F_DOCS, A_DESIGN, A_EMPTY, F_THREADS, A_THREAD]);
    assert.deepEqual(maps.size(), { profiles: 2, views: 3, paths: 6 });
  });

  test('an absent key is nothing, whatever it looks like', () => {
    const { maps } = loaded();
    for (const key of ['', 'nobody', 'WILL', 'will ', 'constructor', '__proto__', 'toString', 'docs/', './docs', 'docs/design.MD']) {
      assert.equal(maps.profileByHandle(key), undefined, `handle ${key}`);
      assert.equal(maps.viewByName(key), undefined, `name ${key}`);
      assert.equal(maps.liveAtPath(key), undefined, `path ${key}`);
    }
  });

  test('a string shared by a profile and a view is told apart: the view map is over views, the profile map over profiles', () => {
    const { maps } = loaded((docs) => {
      docs['Apeiron/.state/TreeView.jsonld']!.push({ '@id': idOf('TreeView', 60), '@type': 'TreeView', profile: P_BARE, name: 'default' }, { '@id': idOf('TreeView', 61), '@type': 'TreeView', profile: P_BARE, name: 'Will' });
    });
    assert.equal(maps.viewByName('default'), idOf('TreeView', 60), 'the view `default`, with a profile whose handle is `default`');
    assert.equal(maps.profileByHandle('default'), P_BARE);
    assert.equal(maps.viewByName('Will'), idOf('TreeView', 61), 'a view named like the name of a profile');
    assert.equal(maps.viewByName('main'), V_MAIN);
    assert.equal(maps.profileByHandle('main'), undefined, 'a view name is no handle');
    assert.equal(maps.viewByName('will'), undefined, 'a handle is no view name');
  });

  test('a profile\'s own name is not in any map', () => {
    const { maps } = loaded();
    assert.equal(maps.viewByName('Will'), undefined);
    assert.equal(maps.profileByHandle('Will'), undefined);
  });

  test('one path map over the graphs, with the graph and the kind as optional filters', () => {
    const { maps } = loaded();
    assert.equal(maps.liveAtPath('.threads/coder.md', { graph: THREADS }), A_THREAD);
    assert.equal(maps.liveAtPath('.threads/coder.md', { graph: TREE }), undefined, 'the node is in the other graph');
    assert.equal(maps.liveAtPath('docs/design.md', { graph: TREE }), A_DESIGN);
    assert.equal(maps.liveAtPath('docs/design.md', { graph: THREADS }), undefined);
    assert.equal(maps.liveAtPath('docs', { kind: 'FolderNode' }), F_DOCS);
    assert.equal(maps.liveAtPath('docs', { kind: 'ArtifactNode' }), undefined, 'a path is a directory or a file');
    assert.equal(maps.liveAtPath('docs/design.md', { kind: 'ArtifactNode', graph: TREE }), A_DESIGN);
    assert.equal(maps.liveAtPath('.threads', { kind: 'FolderNode', graph: THREADS }), F_THREADS);
    assert.equal(maps.liveAtPath('.threads', { kind: 'FolderNode', graph: TREE }), undefined);
  });

  test('a tombstoned artifact keeps its stored path and holds it for nobody', () => {
    const { engine, maps } = loaded((docs) => {
      docs['Apeiron/ArtifactNode.jsonld']!.push({ '@id': idOf('ArtifactNode', 62), '@type': 'ArtifactNode', tombstonedAt: AT, title: 'Gone', path: 'docs/gone.md' });
    });
    assert.equal(engine.first(TREE, idOf('ArtifactNode', 62), 'path'), 'docs/gone.md');
    assert.equal(maps.liveAtPath('docs/gone.md'), undefined);
    assert.equal(maps.size().paths, 6);
  });

  test('a rebuild forgets what it held', () => {
    const { engine, maps } = loaded();
    engine.build(TREE, artifact(70, 'later.md'));
    maps.built(TREE, idOf('ArtifactNode', 70));
    assert.equal(maps.liveAtPath('later.md'), idOf('ArtifactNode', 70));
    engine.removeNode(TREE, idOf('ArtifactNode', 70));
    assert.equal(maps.liveAtPath('later.md'), idOf('ArtifactNode', 70), 'no update was called: the map still holds it');
    maps.rebuild();
    assert.equal(maps.liveAtPath('later.md'), undefined);
    assert.equal(maps.size().paths, 6);
  });
});

describe('a key held by two live nodes', () => {
  test('answers the first holder in compareIds order, whichever was built first, and is listed', () => {
    for (const order of [[1, 2, 3], [3, 2, 1], [2, 3, 1]]) {
      const { engine, maps } = fresh();
      for (const n of order) engine.build(TREE, artifact(n, 'dup.md'));
      maps.rebuild();
      assert.equal(maps.liveAtPath('dup.md'), idOf('ArtifactNode', 1), `built ${order}`);
      assert.deepEqual(maps.duplicates(), [{ map: 'path', key: 'dup.md', ids: [1, 2, 3].map((n) => idOf('ArtifactNode', n)) }]);
    }
  });

  test('is listed per map and by key, a profile handle and a view name too, and leaves the list when a holder is tombstoned', () => {
    const { engine, maps } = fresh();
    for (const r of [profile(2, 'dup'), profile(1, 'dup'), profile(3, 'solo'), view(5, 'v'), view(4, 'v'), artifact(8, 'z.md'), artifact(7, 'z.md'), artifact(9, 'a.md'), artifact(10, 'a.md')]) engine.build(r.kind === 'TreeView' ? VIEWS : TREE, r);
    assert.deepEqual(maps.rebuild(), [
      { map: 'handle', key: 'dup', ids: [idOf('Profile', 1), idOf('Profile', 2)] },
      { map: 'name', key: 'v', ids: [idOf('TreeView', 4), idOf('TreeView', 5)] },
      { map: 'path', key: 'a.md', ids: [idOf('ArtifactNode', 9), idOf('ArtifactNode', 10)] },
      { map: 'path', key: 'z.md', ids: [idOf('ArtifactNode', 7), idOf('ArtifactNode', 8)] },
    ]);
    assert.equal(maps.profileByHandle('dup'), idOf('Profile', 1));
    assert.equal(maps.viewByName('v'), idOf('TreeView', 4));
    engine.tombstone(TREE, idOf('ArtifactNode', 9), AT);
    maps.tombstoned(TREE, idOf('ArtifactNode', 9));
    assert.equal(maps.liveAtPath('a.md'), idOf('ArtifactNode', 10));
    assert.deepEqual(maps.duplicates().map((d) => d.key), ['dup', 'v', 'z.md']);
  });

  test('with the graph filter the first holder in that graph is the answer', () => {
    const { engine, maps } = fresh();
    engine.build(TREE, artifact(2, 'both.md'));
    engine.build(THREADS, artifact(1, 'both.md'));
    maps.rebuild();
    assert.equal(maps.liveAtPath('both.md'), idOf('ArtifactNode', 1));
    assert.equal(maps.liveAtPath('both.md', { graph: TREE }), idOf('ArtifactNode', 2));
    assert.equal(maps.liveAtPath('both.md', { graph: THREADS }), idOf('ArtifactNode', 1));
  });
});

describe('the update functions', () => {
  test('built files a node of the four kinds and ignores another', () => {
    const { engine, maps } = fresh();
    const records: [string, ReturnType<typeof artifact>][] = [[TREE, artifact(1, 'a.md')], [TREE, folder(2, 'd')], [TREE, profile(3, 'h') as never], [VIEWS, view(4, 'v') as never]];
    for (const [graph, r] of records) { engine.build(graph, r); maps.built(graph, r.id); }
    engine.build(TREE, { id: idOf('BlockNode', 5), kind: 'BlockNode', fields: { title: 'b', type: 'paragraph' } });
    maps.built(TREE, idOf('BlockNode', 5));
    assert.deepEqual([maps.liveAtPath('a.md'), maps.liveAtPath('d'), maps.profileByHandle('h'), maps.viewByName('v')], [idOf('ArtifactNode', 1), idOf('FolderNode', 2), idOf('Profile', 3), idOf('TreeView', 4)]);
    assert.deepEqual(maps.size(), { profiles: 1, views: 1, paths: 2 });
  });

  test('fieldWritten moves a node to the key its field was written, cleared or removed to', () => {
    const { engine, maps } = fresh();
    const a = idOf('ArtifactNode', 1); const p = idOf('Profile', 2); const v = idOf('TreeView', 3);
    engine.build(TREE, artifact(1, 'old.md')); engine.build(TREE, profile(2, 'old') as never); engine.build(VIEWS, view(3, 'old') as never);
    maps.rebuild();
    engine.clearField(TREE, a, 'path'); engine.addPair(TREE, a, 'path', 'new.md'); maps.fieldWritten(TREE, a, 'path');
    engine.clearField(TREE, p, 'handle'); engine.addPair(TREE, p, 'handle', 'new'); maps.fieldWritten(TREE, p, 'handle');
    engine.clearField(VIEWS, v, 'name'); engine.addPair(VIEWS, v, 'name', 'new'); maps.fieldWritten(VIEWS, v, 'name');
    assert.deepEqual([maps.liveAtPath('old.md'), maps.profileByHandle('old'), maps.viewByName('old')], [undefined, undefined, undefined], 'the old keys are gone');
    assert.deepEqual([maps.liveAtPath('new.md'), maps.profileByHandle('new'), maps.viewByName('new')], [a, p, v]);
    engine.removePair(TREE, a, 'path', 'new.md'); maps.fieldWritten(TREE, a, 'path');
    assert.equal(maps.liveAtPath('new.md'), undefined, 'a path removed leaves the map');
    engine.clearField(TREE, p, 'handle'); maps.fieldWritten(TREE, p, 'handle');
    assert.equal(maps.profileByHandle('new'), undefined, 'a handle cleared leaves it');
  });

  test('fieldWritten of a field no map is keyed by does not read the engine', () => {
    const { engine, maps } = fresh();
    engine.build(TREE, artifact(1, 'a.md'));
    maps.rebuild();
    engine.removeNode(TREE, idOf('ArtifactNode', 1));
    maps.fieldWritten(TREE, idOf('ArtifactNode', 1), 'title');
    assert.equal(maps.liveAtPath('a.md'), idOf('ArtifactNode', 1), 'a write of the title is not the maps\' business');
    maps.fieldWritten(TREE, idOf('ArtifactNode', 1), 'path');
    assert.equal(maps.liveAtPath('a.md'), undefined);
  });

  test('tombstoned, removed and swept drop a node; the sweep gives the ids and the map drops those', () => {
    const { engine, maps } = fresh();
    for (const n of [1, 2, 3, 4]) engine.build(TREE, artifact(n, `p${n}.md`));
    maps.rebuild();
    engine.tombstone(TREE, idOf('ArtifactNode', 1), AT); maps.tombstoned(TREE, idOf('ArtifactNode', 1));
    engine.removeNode(TREE, idOf('ArtifactNode', 2)); maps.removed(TREE, idOf('ArtifactNode', 2));
    assert.deepEqual([1, 2, 3, 4].map((n) => maps.liveAtPath(`p${n}.md`)), [undefined, undefined, idOf('ArtifactNode', 3), idOf('ArtifactNode', 4)]);
    const gone = engine.sweep(TREE);
    assert.deepEqual(gone, [idOf('ArtifactNode', 1)], 'the tombstone, which no live root reaches');
    maps.swept(TREE, gone);
    assert.deepEqual(maps.size(), { profiles: 0, views: 0, paths: 2 });
  });

  test('swept drops the ids it is given, though a sweep removes tombstones only and a told tombstone is out of the map already', () => {
    const { engine, maps } = fresh();
    engine.build(TREE, artifact(1, 'a.md'));
    maps.rebuild();
    engine.tombstone(TREE, idOf('ArtifactNode', 1), AT); // not told
    assert.equal(maps.liveAtPath('a.md'), idOf('ArtifactNode', 1));
    maps.swept(TREE, engine.sweep(TREE));
    assert.equal(maps.liveAtPath('a.md'), undefined);
  });

  test('subtreeTombstoned drops the nodes of a tombstoned subtree, which have left the containment, and no other', () => {
    const { engine, maps } = fresh();
    const [root, mid, leaf, other] = [1, 2, 3, 4].map((n) => idOf('FolderNode', n));
    for (const [n, path] of [[1, 'r'], [2, 'r/m'], [3, 'r/m/l'], [4, 'o']] as const) engine.build(TREE, folder(n, path));
    engine.addPair(TREE, root!, 'children', mid!); engine.addPair(TREE, mid!, 'children', leaf!);
    maps.rebuild();
    engine.tombstoneSubtree(TREE, mid!, AT);
    assert.deepEqual(engine.items(TREE, mid!, 'children'), [], 'the walk from the root would find nothing');
    maps.subtreeTombstoned(TREE);
    assert.deepEqual(['r', 'r/m', 'r/m/l', 'o'].map((p) => maps.liveAtPath(p)), [root, undefined, undefined, other]);
  });

  test('graphDropped drops the nodes of the graph and no other', () => {
    const { engine, maps } = fresh();
    engine.build(TREE, artifact(1, 'a.md')); engine.build(THREADS, artifact(2, '.threads/b.md'));
    maps.rebuild();
    engine.dropGraph(THREADS);
    maps.graphDropped(THREADS);
    assert.deepEqual([maps.liveAtPath('a.md'), maps.liveAtPath('.threads/b.md')], [idOf('ArtifactNode', 1), undefined]);
  });

  test('an update for a write the engine did not take leaves the map as the engine is', () => {
    const { engine, maps } = fresh();
    const a = idOf('ArtifactNode', 1);
    engine.build(TREE, artifact(1, 'a.md'));
    maps.rebuild();
    for (const [write, call] of [
      [() => engine.removeNode(TREE, idOf('ArtifactNode', 99)), () => maps.removed(TREE, a)],
      [() => engine.tombstone(THREADS, a, AT), () => maps.tombstoned(TREE, a)],
      [() => engine.addPair(TREE, a, 'path', 'second.md'), () => maps.fieldWritten(TREE, a, 'path')],
      [() => engine.addPair(TREE, a, 'nonesuch', 'x'), () => maps.fieldWritten(TREE, a, 'path')],
    ] as const) {
      try { write(); } catch { /* the engine did not take it */ }
      call();
      const held = engine.first(TREE, a, 'path');
      assert.equal(maps.liveAtPath('a.md'), held === 'a.md' ? a : undefined, 'the node is where the engine says');
      if (typeof held === 'string') assert.equal(maps.liveAtPath(held), a);
    }
  });
});

describe('the key of the path map', () => {
  test('is made by one function, over the record: the stored path', () => {
    const { engine } = fresh();
    engine.build(TREE, artifact(1, 'docs/design.md'));
    engine.build(TREE, { id: idOf('BlockNode', 2), kind: 'BlockNode', fields: { title: 'x', type: 'paragraph' } });
    assert.equal(pathKeyOf(engine.record(TREE, idOf('ArtifactNode', 1))!), 'docs/design.md');
    assert.equal(pathKeyOf(engine.record(TREE, idOf('BlockNode', 2))!), undefined, 'a block has no stored path');
  });
});
