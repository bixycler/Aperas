// The files of the mirror (planning/core.md, Batch 9 steps 1, 2 and 5): the mapping from a graph and a kind to a file is an argument of the dump and
// the load, checked here; the shell's own mapping is made from the table of settings (the file of each of the eight pairs of a graph and a kind);
// the shell creates its three graphs in order and drops `default`; the dump writes whole files, under a root, and makes their directories; the
// file names and the text of an empty file are the ones `kgInit.ts` writes a second time. The table's reader is in `settings.test.ts`.
import { describe, test, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { EMPTY_FILE_TEXT, KINDS_OF_GRAPH, checkMapping, checkMappingKinds, createMirrorGraphs, documentsText, fileNameOfKind, fileOf, graphsOf, mirrorMapping, type MirrorMapping } from '@aperas/core/shell/mirrorFiles';
import { MIRROR_GRAPHS, type GraphSettings } from '@aperas/core/graphConfig';
import { DEFAULT_GRAPH } from '@aperas/core/apeironNgn/interface';
import { dumpMirror } from '@aperas/core/shell/mirrorDump';
import { loadMirror } from '@aperas/core/shell/mirrorLoad';
import { THREADS, TREE, VIEWS, idOf, newEngine, scratchRoot, testMapping } from '../support/mirrorFixture.ts';

let scratch: ReturnType<typeof scratchRoot>;
beforeEach(() => { scratch = scratchRoot(); });
afterEach(() => scratch.cleanup());

describe('the names and the text of a file', () => {
  test('a file is named for its kind, and an empty one is an empty array and a newline', () => {
    assert.equal(fileNameOfKind('BlockNode'), 'BlockNode.jsonld');
    assert.equal(EMPTY_FILE_TEXT, '[]\n');
    assert.equal(documentsText([]), EMPTY_FILE_TEXT);
    assert.equal(documentsText([{ a: 1 }]), '[\n  {\n    "a": 1\n  }\n]\n');
  });
});

describe('a mapping from a graph and a kind to a file', () => {
  const m = testMapping();

  test('gives the graphs it names once each, in order, and the file of a graph and a kind', () => {
    assert.deepEqual(graphsOf(m), [TREE, THREADS, VIEWS]);
    assert.equal(fileOf(m, TREE, 'BlockNode'), 'Apeiron/BlockNode.jsonld');
    assert.equal(fileOf(m, THREADS, 'BlockNode'), 'Apeiron/.state/BlockNode.jsonld');
    assert.equal(fileOf(m, THREADS, 'Nonesuch'), undefined);
  });

  test('is checked: a graph name that fails the grammar, the reserved name id, a graph and kind named twice, a file named twice', () => {
    const bad: [string, MirrorMapping, RegExp][] = [
      ['a name with a capital', [{ graph: 'Tree', kind: 'BlockNode', file: 'a' }], /not a graph name/],
      ['the reserved name', [{ graph: 'id', kind: 'BlockNode', file: 'a' }], /not a graph name/],
      ['a pair twice', [{ graph: TREE, kind: 'BlockNode', file: 'a' }, { graph: TREE, kind: 'BlockNode', file: 'b' }], /named twice/],
      ['a file twice', [{ graph: TREE, kind: 'BlockNode', file: 'a' }, { graph: THREADS, kind: 'BlockNode', file: './a' }], /file .* named twice/],
      ['no file', [{ graph: TREE, kind: 'BlockNode', file: '' }], /needs a kind and a file/],
    ];
    for (const [why, mapping, message] of bad) assert.throws(() => checkMapping(mapping), message, why);
    assert.doesNotThrow(() => checkMapping(m));
    assert.doesNotThrow(() => checkMapping([]), 'a mapping of no file');
  });

  test('is checked against the schema: a kind it does not declare, and a kind that is embedded and has no file', () => {
    const schema = newEngine().schema;
    assert.doesNotThrow(() => checkMappingKinds(schema, m));
    assert.throws(() => checkMappingKinds(schema, [{ graph: TREE, kind: 'Nonesuch', file: 'a' }]), /not a kind of the schema/);
    assert.throws(() => checkMappingKinds(schema, [{ graph: TREE, kind: 'Link', file: 'a' }]), /has no file/);
    assert.throws(() => checkMappingKinds(schema, [{ graph: TREE, kind: 'StringProp', file: 'a' }]), /has no file/);
  });

  test('that is bad stops the dump and the load before anything is written or read', () => {
    const engine = newEngine();
    const dup: MirrorMapping = [{ graph: TREE, kind: 'BlockNode', file: 'a' }, { graph: TREE, kind: 'FolderNode', file: 'a' }];
    assert.throws(() => dumpMirror(engine, scratch.root, dup), /named twice/);
    assert.throws(() => loadMirror(engine, scratch.root, dup), /named twice/);
    assert.throws(() => dumpMirror(engine, scratch.root, [{ graph: TREE, kind: 'Link', file: 'a' }]), /has no file/);
    assert.deepEqual(readdirSync(scratch.root), [], 'nothing was written');
  });
});

describe('the writers of the dump', () => {
  test('write whole files under the root, make their directories, give an empty file to a kind with no record, and report what they wrote', () => {
    const engine = newEngine();
    createMirrorGraphs(engine);
    engine.build(TREE, { id: idOf('BlockNode', 1), kind: 'BlockNode', fields: { title: 'x', type: 'p' } });
    const mapping = testMapping();
    const written = dumpMirror(engine, scratch.root, mapping);
    assert.equal(written.length, mapping.length);
    assert.deepEqual(written.filter((w) => w.documents > 0).map((w) => [w.graph, w.kind, w.documents]), [[TREE, 'BlockNode', 1]]);
    for (const w of written) assert.equal(existsSync(w.path), true, w.path);
    assert.equal(readFileSync(join(scratch.root, 'Apeiron/Profile.jsonld'), 'utf8'), EMPTY_FILE_TEXT);
    assert.equal(readFileSync(join(scratch.root, 'Apeiron/.state/TreeView.jsonld'), 'utf8'), EMPTY_FILE_TEXT);
    assert.equal(statSync(join(scratch.root, 'Apeiron/.state')).isDirectory(), true);
  });

  test('take a path from the root, whatever its place, and an absolute file as it is', () => {
    const engine = newEngine();
    engine.createGraph(TREE);
    const other = scratchRoot();
    try {
      dumpMirror(engine, scratch.root, [{ graph: TREE, kind: 'BlockNode', file: 'deep/er/b.jsonld' }, { graph: TREE, kind: 'FolderNode', file: join(other.root, 'abs.jsonld') }]);
      assert.equal(readFileSync(join(scratch.root, 'deep/er/b.jsonld'), 'utf8'), '[]\n');
      assert.equal(readFileSync(join(other.root, 'abs.jsonld'), 'utf8'), '[]\n');
    } finally {
      other.cleanup();
    }
  });

  test('rewrite a file that is there, whole, and a second dump of the same engine gives the same bytes', () => {
    const engine = newEngine();
    createMirrorGraphs(engine);
    for (let i = 1; i <= 5; i++) engine.build(TREE, { id: idOf('BlockNode', i), kind: 'BlockNode', fields: { title: `t${i}`, type: 'p' } });
    const mapping = testMapping();
    dumpMirror(engine, scratch.root, mapping);
    const file = join(scratch.root, 'Apeiron/BlockNode.jsonld');
    const first = readFileSync(file, 'utf8');
    utimesSync(file, 1, 1);
    engine.removeNode(TREE, idOf('BlockNode', 3));
    dumpMirror(engine, scratch.root, mapping);
    assert.equal((JSON.parse(readFileSync(file, 'utf8')) as unknown[]).length, 4, 'the whole file is the engine\'s records now');
    engine.build(TREE, { id: idOf('BlockNode', 3), kind: 'BlockNode', fields: { title: 't3', type: 'p' } });
    dumpMirror(engine, scratch.root, mapping);
    assert.equal(readFileSync(file, 'utf8'), first);
  });
});

describe('the shell\'s mapping, made from the table of settings', () => {
  const settings = (directory: Record<string, string>): GraphSettings[] => MIRROR_GRAPHS.map((graph) => ({ graph, directory: directory[graph]!, flushIntervalMs: 1000 }));
  const defaults = settings({ [TREE]: '/r/Apeiron', [THREADS]: '/r/Apeiron/.state', [VIEWS]: '/r/Apeiron/.state' });

  test('gives the file of each of the eight pairs of a graph and a kind, in the order of the graphs, and the file is a function of the graph alone', () => {
    const m = mirrorMapping(defaults);
    assert.deepEqual(m.map((x) => [x.graph, x.kind, x.file]), [
      [TREE, 'ArtifactNode', '/r/Apeiron/ArtifactNode.jsonld'],
      [TREE, 'FolderNode', '/r/Apeiron/FolderNode.jsonld'],
      [TREE, 'BlockNode', '/r/Apeiron/BlockNode.jsonld'],
      [TREE, 'Profile', '/r/Apeiron/Profile.jsonld'],
      [THREADS, 'ArtifactNode', '/r/Apeiron/.state/ArtifactNode.jsonld'],
      [THREADS, 'FolderNode', '/r/Apeiron/.state/FolderNode.jsonld'],
      [THREADS, 'BlockNode', '/r/Apeiron/.state/BlockNode.jsonld'],
      [VIEWS, 'TreeView', '/r/Apeiron/.state/TreeView.jsonld'],
    ]);
    assert.deepEqual(Object.fromEntries(MIRROR_GRAPHS.map((g) => [g, KINDS_OF_GRAPH[g]])), { [TREE]: ['ArtifactNode', 'FolderNode', 'BlockNode', 'Profile'], [THREADS]: ['ArtifactNode', 'FolderNode', 'BlockNode'], [VIEWS]: ['TreeView'] });
    const moved = mirrorMapping(settings({ [TREE]: '/r/Apeiron', [THREADS]: '/elsewhere', [VIEWS]: '/r/Apeiron/.state' }));
    assert.equal(fileOf(moved, THREADS, 'BlockNode'), '/elsewhere/BlockNode.jsonld', 'a directory changes the files of its graph');
    assert.equal(fileOf(moved, TREE, 'BlockNode'), '/r/Apeiron/BlockNode.jsonld', 'and no other');
    assert.equal(fileOf(m, VIEWS, 'Profile'), undefined, 'a Profile is in the main graph only');
    assert.equal(fileOf(m, THREADS, 'Profile'), undefined);
    assert.equal(fileOf(m, TREE, 'TreeView'), undefined, 'and a TreeView in the graph of the views only');
  });

  test('passes the checks of a mapping and of the schema', () => {
    const m = mirrorMapping(defaults);
    assert.doesNotThrow(() => checkMapping(m));
    assert.doesNotThrow(() => checkMappingKinds(newEngine().schema, m));
  });

  test('refuses two graphs given one directory, through the file names of the kinds they share', () => {
    const same = mirrorMapping(settings({ [TREE]: '/r/Apeiron', [THREADS]: '/r/Apeiron', [VIEWS]: '/r/Apeiron/.state' }));
    assert.throws(() => checkMapping(same), /file \/r\/Apeiron\/ArtifactNode.jsonld is named twice/);
    assert.throws(() => dumpMirror(newEngine(), scratch.root, same), /named twice/);
    assert.doesNotThrow(() => checkMapping(mirrorMapping(settings({ [TREE]: '/r/Apeiron', [THREADS]: '/r/Apeiron/.state', [VIEWS]: '/r/Apeiron' }))), 'the views share no kind with the main graph');
  });

  test('needs the settings of all three graphs', () => {
    assert.throws(() => mirrorMapping(defaults.slice(0, 2)), /no entry for the graph treeviews/);
  });
});

describe('the graphs the shell creates at start', () => {
  /** An engine that records the order of its `createGraph` calls and the names it was asked to drop. */
  function watched(): { engine: ReturnType<typeof newEngine>; created: string[]; dropped: string[] } {
    const engine = newEngine();
    const created: string[] = []; const dropped: string[] = [];
    const wrap = Object.create(engine) as typeof engine;
    wrap.createGraph = (g) => { engine.createGraph(g); created.push(g); };
    wrap.dropGraph = (g) => { engine.dropGraph(g); dropped.push(g); };
    return { engine: wrap, created, dropped };
  }

  test('are tree, threads.tree and treeviews, created in that order, and the engine\'s default is dropped', () => {
    const { engine, created, dropped } = watched();
    assert.deepEqual(createMirrorGraphs(engine), []);
    assert.deepEqual(created, ['tree', 'threads.tree', 'treeviews']);
    assert.deepEqual(dropped, [DEFAULT_GRAPH]);
    for (const g of created) assert.throws(() => engine.createGraph(g), /exists/, `${g} is there`);
    assert.throws(() => engine.dropGraph(DEFAULT_GRAPH), /no graph default/, 'and default is gone');
  });

  test('are made again on a fresh engine, which shares nothing with the first', () => {
    const a = newEngine(); const b = newEngine();
    createMirrorGraphs(a);
    a.build(TREE, { id: idOf('BlockNode', 1), kind: 'BlockNode', fields: { title: 'x', type: 'p' } });
    createMirrorGraphs(b);
    assert.deepEqual(b.idsOfKind(TREE, 'BlockNode'), []);
  });

  test('keep the default graph when it holds a record, with a warning', () => {
    const engine = newEngine();
    engine.build(DEFAULT_GRAPH, { id: idOf('BlockNode', 1), kind: 'BlockNode', fields: { title: 'x', type: 'p' } });
    assert.deepEqual(createMirrorGraphs(engine), ['the graph default holds records and is not dropped']);
    assert.deepEqual(engine.idsOfKind(DEFAULT_GRAPH, 'BlockNode'), [idOf('BlockNode', 1)]);
  });

  test('hold a dump that loads back to the same graphs and the same bytes', () => {
    const engine = newEngine();
    createMirrorGraphs(engine);
    engine.build(TREE, { id: idOf('FolderNode', 1), kind: 'FolderNode', fields: { title: 'root', path: '.', children: [idOf('FolderNode', 2)] } });
    engine.build(THREADS, { id: idOf('FolderNode', 2), kind: 'FolderNode', fields: { title: '.threads', path: '.threads', children: [idOf('ArtifactNode', 3)] } });
    engine.build(THREADS, { id: idOf('ArtifactNode', 3), kind: 'ArtifactNode', fields: { title: 'coder', path: '.threads/coder.md', children: [idOf('BlockNode', 4)] } });
    engine.build(THREADS, { id: idOf('BlockNode', 4), kind: 'BlockNode', fields: { title: 'a turn', type: 'heading' } });
    engine.build(TREE, { id: idOf('Profile', 5), kind: 'Profile', fields: { handle: 'will' } });
    engine.build(VIEWS, { id: idOf('TreeView', 6), kind: 'TreeView', fields: { profile: idOf('Profile', 5), name: 'main', unfolds: [idOf('BlockNode', 4)], root: idOf('ArtifactNode', 3) } });
    const mapping = testMapping();
    dumpMirror(engine, scratch.root, mapping);
    const again = scratchRoot();
    try {
      const loaded = newEngine();
      const result = loadMirror(loaded, scratch.root, mapping);
      assert.deepEqual({ graphs: result.graphs, errors: result.errors, warnings: result.warnings, dangling: result.dangling }, { graphs: [TREE, THREADS, VIEWS], errors: [], warnings: [], dangling: [] });
      assert.deepEqual([TREE, THREADS, VIEWS].map((g) => loaded.graphOf(g === TREE ? idOf('FolderNode', 1) : g === THREADS ? idOf('FolderNode', 2) : idOf('TreeView', 6))), [TREE, THREADS, VIEWS]);
      assert.equal(loaded.graphOf(idOf('Profile', 5)), TREE);
      dumpMirror(loaded, again.root, mapping);
      for (const m of mapping) assert.equal(readFileSync(join(again.root, m.file), 'utf8'), readFileSync(join(scratch.root, m.file), 'utf8'), m.file);
    } finally {
      again.cleanup();
    }
  });
});
