// The engine-side handle of the shell (planning/core.md, Batch 11 steps 1 and 2): `openDb` and `newDb`, the reads `graphOfId`, `nodeExists`,
// `allIdsOfKind`, `liveIdsOfKind`, `backlinksOf` and `isThreadScoped`, and the write layer, function by function. A ghost (an id named by a `children`
// list or a pair and described by no document) is not an existing node; a listing is sorted by id across the graphs; a write the engine refuses leaves the
// maps as they were; a write it takes is told to them, a subtree by the ids collected before the write. The random sequences are in `writeLayer.model.test.ts`.
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Refused } from '@aperas/core/apeironNgn/engine';
import type { Id } from '@aperas/core/apeironNgn/interface';
import { allIdsOfKind, backlinksOf, closeDb, defaultSettings, graphOfId, isThreadScoped, liveIdsOfKind, newDb, nodeExists, openDb, type Db } from '@aperas/core/shell/db';
import { documentsText } from '@aperas/core/shell/mirrorFiles';
import { noNode } from '../support/refusals.ts';
import { A_DESIGN, A_THREAD, B_ONE, B_THREAD, B_TOMB, F_DOCS, F_ROOT, F_THREADS, P_BARE, P_HUMAN, THREADS, TREE, V_MAIN, VIEWS, fixtureDocs, idOf, scratchRoot, testMapping, textsOf, writeTexts } from '../support/mirrorFixture.ts';

const AT = '2026-10-20T00:00:00.000Z';
const art = (n: number): Id => idOf('ArtifactNode', n);
const fol = (n: number): Id => idOf('FolderNode', n);
const blk = (n: number): Id => idOf('BlockNode', n);
const linkOf = (owner: Id, n: number): Id => `${owner}:links:Link:${idOf('Link', n).split(':')[1]}`;

/** A db with an artifact at `path` in the graph its path gives it. */
function withArtifact(db: Db, n: number, path: string): Id {
  const id = art(n);
  db.write.createNode(id, { kind: 'ArtifactNode', path });
  db.write.addPair(graphOfId(db, id)!, id, 'title', `a${n}`);
  db.write.addPair(graphOfId(db, id)!, id, 'path', path);
  return id;
}

let scratch: ReturnType<typeof scratchRoot>;
beforeEach(() => { scratch = scratchRoot(); });
afterEach(() => scratch.cleanup());

describe('newDb', () => {
  test('makes the three graphs, empty, with the maps empty and the mapping of the default layout', () => {
    const db = newDb();
    assert.deepEqual(db.graphs, [TREE, THREADS, VIEWS]);
    assert.deepEqual(db.mapping.map((m) => `${m.graph}:${m.kind}:${m.file}`), [
      `${TREE}:ArtifactNode:Apeiron/ArtifactNode.jsonld`, `${TREE}:FolderNode:Apeiron/FolderNode.jsonld`, `${TREE}:BlockNode:Apeiron/BlockNode.jsonld`, `${TREE}:Profile:Apeiron/Profile.jsonld`,
      `${THREADS}:ArtifactNode:Apeiron/.state/ArtifactNode.jsonld`, `${THREADS}:FolderNode:Apeiron/.state/FolderNode.jsonld`, `${THREADS}:BlockNode:Apeiron/.state/BlockNode.jsonld`,
      `${VIEWS}:TreeView:Apeiron/.state/TreeView.jsonld`,
    ]);
    assert.deepEqual(db.maps.size(), { profiles: 0, views: 0, paths: 0 });
    for (const kind of ['ArtifactNode', 'FolderNode', 'BlockNode', 'Profile', 'TreeView']) assert.deepEqual(allIdsOfKind(db, kind), [], kind);
    assert.equal(nodeExists(db, art(1)), false);
    assert.equal(graphOfId(db, art(1)), undefined);
  });

  test('two handles share nothing', () => {
    const a = newDb();
    const b = newDb();
    withArtifact(a, 1, 'x.md');
    assert.equal(nodeExists(a, art(1)), true);
    assert.equal(nodeExists(b, art(1)), false);
    assert.equal(b.maps.liveAtPath('x.md'), undefined);
  });
});

describe('defaultSettings', () => {
  test('the main graph at the root, the other two under its .state, today\'s intervals', () => {
    assert.deepEqual(defaultSettings('/r/Apeiron'), [
      { graph: TREE, directory: '/r/Apeiron', flushIntervalMs: 10_000 },
      { graph: THREADS, directory: '/r/Apeiron/.state', flushIntervalMs: 3_000 },
      { graph: VIEWS, directory: '/r/Apeiron/.state', flushIntervalMs: 3_000 },
    ]);
  });
});

describe('openDb', () => {
  const docs = (): Record<string, unknown[]> => fixtureDocs();
  const put = (files: Record<string, unknown[]>): void => writeTexts(scratch.root, textsOf(testMapping(), files));

  test('loads the fixture mirror into the three graphs and builds the maps; nothing to report', () => {
    put(docs());
    const { db, load, warnings, duplicates } = openDb(scratch.root, newDb().settings);
    assert.deepEqual({ rejected: load.rejected, errors: load.errors, warnings, duplicates }, { rejected: [], errors: [], warnings: [], duplicates: [] });
    assert.deepEqual(db.graphs, [TREE, THREADS, VIEWS]);
    assert.equal(graphOfId(db, A_DESIGN), TREE);
    assert.equal(graphOfId(db, A_THREAD), THREADS);
    assert.equal(graphOfId(db, V_MAIN), VIEWS);
    assert.equal(db.maps.profileByHandle('will'), P_HUMAN);
    assert.equal(db.maps.profileByHandle('default'), P_BARE);
    assert.equal(db.maps.viewByName('main'), V_MAIN);
    assert.equal(db.maps.liveAtPath('docs/design.md'), A_DESIGN);
    assert.equal(db.maps.liveAtPath('.threads/coder.md'), A_THREAD);
    assert.equal(db.maps.liveAtPath('.threads/coder.md', { graph: TREE }), undefined);
  });

  test('with no settings the files are under the root and its .state', () => {
    writeTexts(scratch.root, {
      'ArtifactNode.jsonld': documentsText([{ '@id': art(1), '@type': 'ArtifactNode', title: 'a', path: 'a.md', children: [] }]),
      '.state/ArtifactNode.jsonld': documentsText([{ '@id': art(2), '@type': 'ArtifactNode', title: 't', path: '.threads/t.md', children: [] }]),
    });
    const { db, load } = openDb(scratch.root);
    assert.equal(load.documents, 2);
    assert.equal(graphOfId(db, art(1)), TREE);
    assert.equal(graphOfId(db, art(2)), THREADS);
    assert.equal(db.maps.liveAtPath('a.md'), art(1));
  });

  test('a key held by two live nodes is a warning, and the maps answer the first by id', () => {
    put({
      'Apeiron/Profile.jsonld': [
        { '@id': idOf('Profile', 2), '@type': 'Profile', handle: 'twin' },
        { '@id': idOf('Profile', 1), '@type': 'Profile', handle: 'twin' },
      ],
    });
    const { db, warnings, duplicates } = openDb(scratch.root, newDb().settings);
    assert.deepEqual(duplicates, [{ map: 'handle', key: 'twin', ids: [idOf('Profile', 1), idOf('Profile', 2)] }]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /handle "twin".*Profile:00T5MX0000001, Profile:00T5MX0000002/);
    assert.equal(db.maps.profileByHandle('twin'), idOf('Profile', 1));
  });

  test('the warnings of the load come first, then those of the duplicates', () => {
    put({
      'Apeiron/Profile.jsonld': [
        { '@id': idOf('Profile', 1), '@type': 'Profile', handle: 'twin' },
        { '@id': idOf('Profile', 2), '@type': 'Profile', handle: 'twin' },
      ],
      'Apeiron/BlockNode.jsonld': [{ '@id': blk(1), '@type': 'BlockNode', title: 'b', type: 'paragraph', parent: blk(99), children: [] }],
    });
    const { load, warnings } = openDb(scratch.root, newDb().settings);
    assert.ok(load.warnings.length > 0, 'the load has a warning of its own');
    assert.equal(warnings.length, load.warnings.length + 1);
    assert.deepEqual(warnings.slice(0, load.warnings.length), load.warnings);
    assert.match(warnings.at(-1)!, /handle "twin"/);
  });

  test('a repeated @id and a document the engine refuses are returned to the caller and not thrown; the rest is built', () => {
    put({
      'Apeiron/Profile.jsonld': [
        { '@id': idOf('Profile', 1), '@type': 'Profile', handle: 'dup' },
        { '@id': idOf('Profile', 1), '@type': 'Profile', handle: 'dup2' },
        { '@id': idOf('Profile', 2), '@type': 'Profile', handle: 'fine' },
        { '@id': idOf('Profile', 3), '@type': 'Profile', handle: 'bad', bogus: 'x' },
      ],
    });
    const { db, load } = openDb(scratch.root, newDb().settings);
    assert.deepEqual(load.rejected.map((r) => r.id), [idOf('Profile', 1)]);
    assert.deepEqual(load.errors.map((e) => e.subject), [idOf('Profile', 3)]);
    assert.equal(db.maps.profileByHandle('fine'), idOf('Profile', 2));
    assert.equal(db.maps.profileByHandle('dup'), undefined, 'a rejected document is not kept');
    assert.equal(nodeExists(db, idOf('Profile', 3)), false, 'nor is a document the engine refused');
  });

  test('a mirror with no file is an empty db with the three graphs', () => {
    const { db, load } = openDb(scratch.root);
    assert.equal(load.documents, 0);
    assert.deepEqual(db.graphs, [TREE, THREADS, VIEWS]);
    assert.deepEqual(allIdsOfKind(db, 'BlockNode'), []);
  });
});

describe('closeDb', () => {
  const put = (files: Record<string, unknown[]>): void => writeTexts(scratch.root, textsOf(testMapping(), files));

  test('drops the three graphs of a handle opened from the fixture, the views first, though the root folder of the main graph lists the threads folder and a main block links into the threads graph', () => {
    put(fixtureDocs());
    const { db } = openDb(scratch.root, newDb().settings);
    assert.equal(graphOfId(db, F_THREADS), THREADS, 'the threads folder is in the threads graph, listed by the root folder of the main graph');
    assert.deepEqual(db.engine.items(TREE, F_ROOT, 'children'), [F_DOCS, F_THREADS]);
    const dropped = closeDb(db);
    assert.equal(dropped[0], VIEWS, 'the views, which nothing points into, go first');
    assert.deepEqual([...dropped].sort(), [THREADS, TREE, VIEWS].sort());
    for (const id of [A_DESIGN, A_THREAD, V_MAIN, F_ROOT, F_THREADS, P_HUMAN]) assert.equal(graphOfId(db, id), undefined, `${id} is no longer held`);
    for (const graph of [TREE, THREADS, VIEWS]) assert.deepEqual(db.engine.idsOfKind(graph, 'BlockNode'), [], `${graph} holds nothing`);
    assert.throws(() => db.engine.dropGraph(TREE), /no graph/, 'and the graph is gone');
  });

  test('the pair against the order of the graphs, a container that lists a node of a later graph, is taken out of the list when two graphs wait for each other', () => {
    put(fixtureDocs());
    const { db } = openDb(scratch.root, newDb().settings);
    const owner = blk(9001);
    db.write.createNode(owner, { kind: 'BlockNode', under: A_THREAD });
    const link = linkOf(owner, 9001);
    db.write.addPair(THREADS, owner, 'links', link);
    db.write.createNode(link, { kind: 'Link', under: owner });
    db.write.addPair(THREADS, link, 'target', A_DESIGN); // the threads graph points into the main graph, and the root folder of the main graph lists the threads folder
    db.write.removePair(TREE, B_ONE, 'links', linkOf(B_ONE, 9)); // the fixture's own link from the main graph into the threads graph is not what this case is about
    const dropped = closeDb(db);
    assert.deepEqual([...dropped].sort(), [THREADS, TREE, VIEWS].sort(), `all three go: ${dropped.join(', ')}`);
  });

  test('a handle with nothing in it is closed whole, and a second handle shares nothing with it', () => {
    put(fixtureDocs());
    const first = openDb(scratch.root, newDb().settings).db;
    const second = openDb(scratch.root, newDb().settings).db;
    assert.deepEqual(closeDb(newDb()), [VIEWS, THREADS, TREE]);
    closeDb(first);
    assert.equal(graphOfId(second, A_DESIGN), TREE, 'the other handle still holds its records');
    assert.equal(second.maps.liveAtPath('docs/design.md'), A_DESIGN);
  });

  test('graphs that point into each other through links cannot be dropped: they are kept and still answer, and the views go', () => {
    put(fixtureDocs());
    const { db } = openDb(scratch.root, newDb().settings);
    const owner = blk(9001);
    db.write.createNode(owner, { kind: 'BlockNode', under: A_THREAD });
    const link = linkOf(owner, 9001);
    db.write.addPair(THREADS, owner, 'links', link);
    db.write.createNode(link, { kind: 'Link', under: owner });
    db.write.addPair(THREADS, link, 'target', A_DESIGN);
    assert.deepEqual(closeDb(db), [VIEWS], 'the main graph points into the threads graph (the fixture) and the threads graph into the main graph (this link)');
    assert.equal(graphOfId(db, A_THREAD), THREADS, 'the graphs kept still answer');
  });
});

describe('nodeExists and graphOfId', () => {
  test('a node exists when a document stands for it; a ghost named by a list or by a pair does not', () => {
    const db = newDb();
    const a = withArtifact(db, 1, 'a.md');
    const ghost = blk(7);
    db.write.insertItem(TREE, a, 'children', ghost);
    assert.equal(nodeExists(db, a), true);
    assert.equal(graphOfId(db, a), TREE);
    assert.equal(nodeExists(db, ghost), false, 'listed by the children of a');
    assert.equal(graphOfId(db, ghost), undefined);
    const link = linkOf(a, 1);
    db.write.createNode(link, { kind: 'Link', under: a });
    db.write.addPair(TREE, a, 'links', link);
    const named = blk(8);
    db.write.addPair(TREE, link, 'target', named);
    assert.equal(nodeExists(db, named), false, 'named by a pair');
    assert.deepEqual(allIdsOfKind(db, 'BlockNode'), [], 'and listed nowhere');
    db.write.createNode(ghost, { kind: 'BlockNode', under: a });
    assert.equal(nodeExists(db, ghost), true, 'the document makes the node');
    assert.equal(graphOfId(db, ghost), TREE);
  });

  test('a node in a graph other than the one asked is found by its id alone', () => {
    const db = newDb();
    const t = withArtifact(db, 1, '.threads/t.md');
    assert.equal(nodeExists(db, t), true);
    assert.equal(graphOfId(db, t), THREADS);
    assert.equal(nodeExists(db, linkOf(t, 1)), false, 'an id nobody built');
  });

  test('a removed node no longer exists', () => {
    const db = newDb();
    const a = withArtifact(db, 1, 'a.md');
    db.write.removeNode(TREE, a);
    assert.equal(nodeExists(db, a), false);
  });
});

describe('allIdsOfKind and liveIdsOfKind', () => {
  test('all the graphs of the mapping, sorted by id whatever order the nodes were made in and whichever graph holds them', () => {
    const db = newDb();
    for (const [n, path] of [[5, 'e.md'], [2, '.threads/b.md'], [9, 'i.md'], [1, '.threads/a.md'], [7, 'g.md']] as const) withArtifact(db, n, path);
    assert.deepEqual(allIdsOfKind(db, 'ArtifactNode'), [1, 2, 5, 7, 9].map(art));
    assert.deepEqual(db.engine.idsOfKind(TREE, 'ArtifactNode'), [5, 9, 7].map(art), 'the engine lists a graph in insertion order');
  });

  test('a graph other than the main one is read: the views are a graph of the mapping', () => {
    const db = newDb();
    db.write.createNode(idOf('TreeView', 2), { kind: 'TreeView' });
    db.write.createNode(idOf('TreeView', 1), { kind: 'TreeView' });
    assert.deepEqual(allIdsOfKind(db, 'TreeView'), [idOf('TreeView', 1), idOf('TreeView', 2)]);
  });

  test('the live ids drop a tombstone, in every graph; all the ids keep it', () => {
    const db = newDb();
    const a = withArtifact(db, 1, 'a.md');
    const t = withArtifact(db, 2, '.threads/t.md');
    const b = withArtifact(db, 3, 'b.md');
    db.write.tombstone(TREE, a, AT);
    db.write.tombstone(THREADS, t, AT);
    assert.deepEqual(allIdsOfKind(db, 'ArtifactNode'), [a, t, b]);
    assert.deepEqual(liveIdsOfKind(db, 'ArtifactNode'), [b]);
  });

  test('the live ids are sorted by id too, whatever order the nodes were made in and whichever graph holds them', () => {
    const db = newDb();
    for (const [n, path] of [[5, 'e.md'], [2, '.threads/b.md'], [9, 'i.md'], [1, '.threads/a.md'], [7, 'g.md']] as const) withArtifact(db, n, path);
    db.write.tombstone(TREE, art(7), AT);
    assert.deepEqual(liveIdsOfKind(db, 'ArtifactNode'), [1, 2, 5, 9].map(art));
  });

  test('a kind with no tombstone marker has all its nodes live', () => {
    const db = newDb();
    const p = idOf('Profile', 1);
    db.write.createNode(p, { kind: 'Profile' });
    assert.deepEqual(liveIdsOfKind(db, 'Profile'), [p]);
  });

  test('the fixture: the tombstoned block is listed in all and not in live', () => {
    writeTexts(scratch.root, textsOf(testMapping(), fixtureDocs()));
    const { db } = openDb(scratch.root, newDb().settings);
    assert.ok(allIdsOfKind(db, 'BlockNode').includes(B_TOMB));
    assert.ok(!liveIdsOfKind(db, 'BlockNode').includes(B_TOMB));
    assert.deepEqual(liveIdsOfKind(db, 'BlockNode'), [...liveIdsOfKind(db, 'BlockNode')].sort());
    assert.deepEqual(liveIdsOfKind(db, 'FolderNode'), [F_ROOT, F_DOCS, F_THREADS].sort(), 'the threads folder is read with the others');
  });
});

describe('backlinksOf', () => {
  test('crosses graphs: the links of a tree artifact and of a threads artifact to one node, sorted by id', () => {
    const db = newDb();
    const target = withArtifact(db, 1, 'target.md');
    const inThreads = withArtifact(db, 2, '.threads/threads.md');
    const inTree = withArtifact(db, 3, 'tree.md');
    // The tree's link has the higher id, so a union in the order of the graphs is not the order by id.
    for (const [owner, n] of [[inTree, 4], [inThreads, 9]] as const) {
      const link = linkOf(owner, n);
      db.write.createNode(link, { kind: 'Link', under: owner });
      db.write.addPair(graphOfId(db, owner)!, owner, 'links', link);
      db.write.addPair(graphOfId(db, owner)!, link, 'target', target);
    }
    assert.deepEqual(backlinksOf(db, target, 'target'), [linkOf(inThreads, 9), linkOf(inTree, 4)]);
    assert.deepEqual(db.engine.subjectsOf(TREE, 'target', target), [linkOf(inTree, 4)], 'the engine names one graph');
  });

  test('a node no one points at, an unknown field and a ghost have none', () => {
    const db = newDb();
    const a = withArtifact(db, 1, 'a.md');
    assert.deepEqual(backlinksOf(db, a, 'target'), []);
    assert.deepEqual(backlinksOf(db, a, 'nofield'), []);
    assert.deepEqual(backlinksOf(db, blk(5), 'target'), []);
  });

  test('the container of a node is its backlink by children; the views of a profile by profile', () => {
    writeTexts(scratch.root, textsOf(testMapping(), fixtureDocs()));
    const { db } = openDb(scratch.root, newDb().settings);
    assert.deepEqual(backlinksOf(db, B_ONE, 'children'), [A_DESIGN]);
    assert.deepEqual(backlinksOf(db, P_HUMAN, 'profile'), [...backlinksOf(db, P_HUMAN, 'profile')].sort());
    assert.equal(backlinksOf(db, P_HUMAN, 'profile').length, 2);
    assert.deepEqual(backlinksOf(db, A_THREAD, 'children'), [F_THREADS], 'a container in the threads graph');
  });
});

describe('isThreadScoped', () => {
  test('an artifact under .threads, the block built under it and the link it owns are; their counterparts in the main graph are not', () => {
    const db = newDb();
    const t = withArtifact(db, 1, '.threads/t.md');
    const a = withArtifact(db, 2, 'a.md');
    const tb = blk(1);
    const ab = blk(2);
    const tl = linkOf(t, 1);
    db.write.createNode(tb, { kind: 'BlockNode', under: t });
    db.write.createNode(ab, { kind: 'BlockNode', under: a });
    db.write.createNode(tl, { kind: 'Link', under: t });
    assert.deepEqual([t, tb, tl].map((id) => isThreadScoped(db, id)), [true, true, true]);
    assert.deepEqual([a, ab].map((id) => isThreadScoped(db, id)), [false, false]);
  });

  test('a profile, a view and a ghost are not', () => {
    const db = newDb();
    db.write.createNode(idOf('Profile', 1), { kind: 'Profile' });
    db.write.createNode(idOf('TreeView', 1), { kind: 'TreeView' });
    assert.deepEqual([idOf('Profile', 1), idOf('TreeView', 1), blk(77)].map((id) => isThreadScoped(db, id)), [false, false, false]);
  });

  test('the threads node of the fixture is, the tree node is not', () => {
    writeTexts(scratch.root, textsOf(testMapping(), fixtureDocs()));
    const { db } = openDb(scratch.root, newDb().settings);
    assert.deepEqual([A_THREAD, B_THREAD, F_THREADS].map((id) => isThreadScoped(db, id)), [true, true, true]);
    assert.deepEqual([A_DESIGN, B_ONE, F_ROOT].map((id) => isThreadScoped(db, id)), [false, false, false]);
  });
});

describe('the write layer', () => {
  test('createNode gives the graph the rule gives, and the node is there', () => {
    const db = newDb();
    const a = art(1);
    assert.equal(db.write.createNode(idOf('Profile', 1), { kind: 'Profile' }), TREE);
    assert.equal(db.write.createNode(idOf('TreeView', 1), { kind: 'TreeView' }), VIEWS);
    assert.equal(db.write.createNode(a, { kind: 'ArtifactNode', path: '.threads/a.md' }), THREADS);
    assert.equal(db.write.createNode(art(2), { kind: 'ArtifactNode', path: 'a.md' }), TREE);
    assert.equal(db.write.createNode(blk(1), { kind: 'BlockNode', under: a }), THREADS);
    assert.deepEqual([idOf('Profile', 1), idOf('TreeView', 1), a, art(2), blk(1)].map((id) => graphOfId(db, id)), [TREE, VIEWS, THREADS, TREE, THREADS]);
  });

  test('a key is in its map after addPair, and out after clearField, removePair and a tombstone', () => {
    const db = newDb();
    const a = art(1);
    db.write.createNode(a, { kind: 'ArtifactNode', path: 'a.md' });
    assert.equal(db.maps.liveAtPath('a.md'), undefined, 'created and not keyed');
    db.write.addPair(TREE, a, 'path', 'a.md');
    assert.equal(db.maps.liveAtPath('a.md'), a);
    db.write.clearField(TREE, a, 'path');
    assert.equal(db.maps.liveAtPath('a.md'), undefined, 'cleared');
    db.write.addPair(TREE, a, 'path', 'b.md');
    assert.equal(db.maps.liveAtPath('b.md'), a);
    db.write.removePair(TREE, a, 'path', 'b.md');
    assert.equal(db.maps.liveAtPath('b.md'), undefined, 'a pair removed');
    db.write.addPair(TREE, a, 'path', 'c.md');
    db.write.tombstone(TREE, a, AT);
    assert.equal(db.maps.liveAtPath('c.md'), undefined, 'tombstoned');
    assert.deepEqual(db.maps.size(), { profiles: 0, views: 0, paths: 0 });
  });

  test('a profile by handle and a view by name follow their writes', () => {
    const db = newDb();
    const p = idOf('Profile', 1);
    const v = idOf('TreeView', 1);
    db.write.createNode(p, { kind: 'Profile' });
    db.write.addPair(TREE, p, 'handle', 'will');
    db.write.createNode(v, { kind: 'TreeView' });
    db.write.addPair(VIEWS, v, 'name', 'main');
    assert.deepEqual([db.maps.profileByHandle('will'), db.maps.viewByName('main')], [p, v]);
    db.write.removeNode(TREE, p);
    db.write.removeNode(VIEWS, v);
    assert.deepEqual([db.maps.profileByHandle('will'), db.maps.viewByName('main')], [undefined, undefined]);
  });

  test('removeNode takes the node out of the map; the embedded link goes with its owner\'s pair', () => {
    const db = newDb();
    const a = withArtifact(db, 1, 'a.md');
    const link = linkOf(a, 1);
    db.write.createNode(link, { kind: 'Link', under: a });
    db.write.addPair(TREE, a, 'links', link);
    assert.equal(nodeExists(db, link), true);
    db.write.removePair(TREE, a, 'links', link);
    assert.equal(nodeExists(db, link), false, 'the embedded node goes with the pair');
    db.write.removeNode(TREE, a);
    assert.equal(db.maps.liveAtPath('a.md'), undefined);
    assert.equal(nodeExists(db, a), false);
  });

  test('tombstoneSubtree tells the maps of every member by id, though the write empties their lists', () => {
    const db = newDb();
    const root = fol(1);
    db.write.createNode(root, { kind: 'FolderNode', path: 'd' });
    db.write.addPair(TREE, root, 'path', 'd');
    const sub = fol(2);
    db.write.createNode(sub, { kind: 'FolderNode', path: 'd/s' });
    db.write.addPair(TREE, sub, 'path', 'd/s');
    db.write.insertItem(TREE, root, 'children', sub);
    const leaf = withArtifact(db, 3, 'd/s/leaf.md');
    db.write.insertItem(TREE, sub, 'children', leaf);
    const outside = withArtifact(db, 4, 'e.md');
    assert.equal(db.maps.liveAtPath('d/s/leaf.md'), leaf);
    db.write.tombstoneSubtree(TREE, root, AT);
    assert.deepEqual(['d', 'd/s', 'd/s/leaf.md'].map((p) => db.maps.liveAtPath(p)), [undefined, undefined, undefined]);
    assert.equal(db.maps.liveAtPath('e.md'), outside, 'a node outside the subtree stays');
    assert.deepEqual(db.maps.size(), { profiles: 0, views: 0, paths: 1 });
  });

  test('tombstoneSubtree leaves a threads folder that the root of the main graph lists: it is not in the subtree', () => {
    const db = newDb();
    const root = fol(1);
    db.write.createNode(root, { kind: 'FolderNode', path: '.' });
    db.write.addPair(TREE, root, 'path', '.');
    const threads = fol(2);
    db.write.createNode(threads, { kind: 'FolderNode', path: '.threads' });
    db.write.addPair(THREADS, threads, 'path', '.threads');
    db.write.insertItem(TREE, root, 'children', threads);
    db.write.tombstoneSubtree(TREE, root, AT);
    assert.equal(db.maps.liveAtPath('.'), undefined);
    assert.equal(db.maps.liveAtPath('.threads'), threads, 'live in its own graph');
    assert.equal(db.engine.first(THREADS, threads, 'tombstonedAt'), undefined);
    assert.equal(liveIdsOfKind(db, 'FolderNode').includes(threads), true);
  });

  test('sweep gives the ids the engine removed, sorted, and they are gone', () => {
    const db = newDb();
    const a = withArtifact(db, 1, 'a.md');
    const b = blk(1);
    db.write.createNode(b, { kind: 'BlockNode', under: a });
    db.write.insertItem(TREE, a, 'children', b);
    db.write.tombstone(TREE, b, AT);
    db.write.tombstone(TREE, a, AT);
    assert.deepEqual(db.write.sweep(TREE), [a, b]);
    assert.deepEqual([nodeExists(db, a), nodeExists(db, b)], [false, false]);
    assert.deepEqual(db.write.sweep(TREE), [], 'nothing the second time');
  });

  test('the items of an ordered field are inserted, moved and removed', () => {
    const db = newDb();
    const a = withArtifact(db, 1, 'a.md');
    for (const n of [1, 2, 3]) db.write.createNode(blk(n), { kind: 'BlockNode', under: a });
    db.write.insertItem(TREE, a, 'children', blk(1));
    db.write.insertItem(TREE, a, 'children', blk(2));
    db.write.insertItem(TREE, a, 'children', blk(3), 0);
    assert.deepEqual(db.engine.items(TREE, a, 'children'), [blk(3), blk(1), blk(2)]);
    db.write.moveItem(TREE, a, 'children', blk(2), 0);
    assert.deepEqual(db.engine.items(TREE, a, 'children'), [blk(2), blk(3), blk(1)]);
    db.write.removeItem(TREE, a, 'children', blk(3));
    assert.deepEqual(db.engine.items(TREE, a, 'children'), [blk(2), blk(1)]);
    assert.equal(nodeExists(db, blk(3)), true, 'detached and not deleted');
  });
});

describe('a write the engine refuses leaves the maps as they were', () => {
  const snapshot = (db: Db): unknown => ({ size: db.maps.size(), duplicates: db.maps.duplicates(), ids: allIdsOfKind(db, 'ArtifactNode') });

  test('a second value of a one-valued field is refused, and the key stays the first', () => {
    const db = newDb();
    const a = withArtifact(db, 1, 'a.md');
    const before = snapshot(db);
    assert.throws(() => db.write.addPair(TREE, a, 'path', 'b.md'), Refused);
    assert.equal(db.maps.liveAtPath('b.md'), undefined, 'the refused key is not in the map');
    assert.equal(db.maps.liveAtPath('a.md'), a);
    assert.deepEqual(snapshot(db), before);
  });

  test('a tombstone of a node that does not exist is refused, the removal of one changes nothing, and nothing is told', () => {
    const db = newDb();
    const a = withArtifact(db, 1, 'a.md');
    const before = snapshot(db);
    assert.throws(() => db.write.tombstone(TREE, art(9), AT), noNode);
    assert.throws(() => db.write.tombstoneSubtree(TREE, art(9), AT), noNode);
    db.changed.clear();
    db.write.removeNode(TREE, art(9)); // no record: nothing changes
    assert.equal(db.changed.size, 0, 'and no graph is marked for a flush');
    assert.equal(db.maps.liveAtPath('a.md'), a);
    assert.deepEqual(snapshot(db), before);
  });

  test('a tombstone in a graph that does not hold the node: refused as a missing node, and the node stays in its map', () => {
    const db = newDb();
    const a = withArtifact(db, 1, 'a.md');
    assert.throws(() => db.write.tombstone(THREADS, a, AT), noNode);
    assert.throws(() => db.write.tombstoneSubtree(THREADS, a, AT), noNode);
    assert.equal(db.maps.liveAtPath('a.md'), a);
    assert.equal(db.engine.first(TREE, a, 'tombstonedAt'), undefined);
  });

  test('a node of a kind that has no tombstone marker is refused, the whole subtree with it', () => {
    const db = newDb();
    const a = withArtifact(db, 1, 'a.md');
    const p = idOf('Profile', 1);
    db.write.createNode(p, { kind: 'Profile' });
    db.write.addPair(TREE, p, 'handle', 'will');
    assert.throws(() => db.write.tombstone(TREE, p, AT), (e: unknown) => e instanceof Refused);
    assert.equal(db.maps.profileByHandle('will'), p);
    assert.equal(db.maps.liveAtPath('a.md'), a);
  });

  test('an id taken, a kind that is not the id\'s, and a graph the rule cannot give: nothing is created, nothing told', () => {
    const db = newDb();
    const a = withArtifact(db, 1, 'a.md');
    const before = snapshot(db);
    assert.throws(() => db.write.createNode(a, { kind: 'ArtifactNode', path: 'x.md' }), (e: unknown) => e instanceof Refused, 'the id is taken');
    assert.throws(() => db.write.createNode(art(2), { kind: 'FolderNode', path: 'x' }), (e: unknown) => e instanceof Refused, 'the kind is not the id\'s');
    assert.throws(() => db.write.createNode(art(3), { kind: 'ArtifactNode' }), /needs its path/);
    assert.throws(() => db.write.createNode(blk(1), { kind: 'BlockNode', under: blk(40) }), /is in no graph/);
    assert.deepEqual(snapshot(db), before);
    assert.equal(nodeExists(db, art(2)), false);
    assert.equal(db.maps.liveAtPath('a.md'), a);
  });

  test('an item already in the list: Refused, and the list is as it was', () => {
    const db = newDb();
    const a = withArtifact(db, 1, 'a.md');
    db.write.createNode(blk(1), { kind: 'BlockNode', under: a });
    db.write.insertItem(TREE, a, 'children', blk(1));
    assert.throws(() => db.write.insertItem(TREE, a, 'children', blk(1)), (e: unknown) => e instanceof Refused);
    assert.deepEqual(db.engine.items(TREE, a, 'children'), [blk(1)]);
  });
});

describe('guard', () => {
  const asRefused = (e: unknown): boolean => e instanceof Refused;

  test('a function that throws takes the nodes it created with it: out of the list that held one, out of the graph, out of the maps; the error passes on unchanged', () => {
    const db = newDb();
    const a = withArtifact(db, 1, 'a.md');
    const before = [db.engine.items(TREE, a, 'children'), allIdsOfKind(db, 'BlockNode'), db.maps.size()];
    const p = idOf('Profile', 1);
    assert.throws(() => db.write.guard(() => {
      db.write.createNode(blk(1), { kind: 'BlockNode', under: a });
      db.write.insertItem(TREE, a, 'children', blk(1));
      db.write.createNode(blk(2), { kind: 'BlockNode', under: a });
      db.write.createNode(p, { kind: 'Profile' });
      db.write.addPair(TREE, p, 'handle', 'will');
      db.write.insertItem(TREE, a, 'children', blk(1)); // refused: already in the list
    }), asRefused);
    assert.deepEqual([db.engine.items(TREE, a, 'children'), allIdsOfKind(db, 'BlockNode'), db.maps.size()], before);
    assert.equal(db.maps.profileByHandle('will'), undefined);
    assert.equal(nodeExists(db, blk(1)) || nodeExists(db, blk(2)) || nodeExists(db, p), false);
    assert.deepEqual(db.engine.subjectsOf(TREE, 'children', blk(1)), [], 'no list names a node taken out');
    assert.ok(db.changed.has(TREE), 'and the service flushes the graph');
  });

  test('a function that returns keeps what it created, and gives what it gave', () => {
    const db = newDb();
    const a = withArtifact(db, 1, 'a.md');
    const given = db.write.guard(() => {
      db.write.createNode(blk(1), { kind: 'BlockNode', under: a });
      db.write.insertItem(TREE, a, 'children', blk(1));
      return 'done';
    });
    assert.equal(given, 'done');
    assert.deepEqual(db.engine.items(TREE, a, 'children'), [blk(1)]);
  });

  test('a node that was there before the guard stays, with what the function wrote to it', () => {
    const db = newDb();
    const a = withArtifact(db, 1, 'a.md');
    assert.throws(() => db.write.guard(() => {
      db.write.createNode(blk(1), { kind: 'BlockNode', under: a });
      db.write.addPair(TREE, a, 'text', 'written');
      throw new Error('stop');
    }), /stop/);
    assert.equal(nodeExists(db, a), true);
    assert.equal(db.engine.first(TREE, a, 'text'), 'written', 'a change to an existing node is not undone');
    assert.equal(nodeExists(db, blk(1)), false);
  });

  test('a guard inside a guard: an inner throw that the outer function catches takes only the inner nodes; an outer throw takes both', () => {
    const db = newDb();
    const a = withArtifact(db, 1, 'a.md');
    assert.throws(() => db.write.guard(() => {
      db.write.createNode(blk(1), { kind: 'BlockNode', under: a });
      try {
        db.write.guard(() => { db.write.createNode(blk(2), { kind: 'BlockNode', under: a }); throw new Error('inner'); });
      } catch { /* the outer function goes on */ }
      assert.equal(nodeExists(db, blk(1)), true);
      assert.equal(nodeExists(db, blk(2)), false);
      throw new Error('outer');
    }), /outer/);
    assert.equal(nodeExists(db, blk(1)), false);
  });
});
