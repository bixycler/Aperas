// The load (planning/core.md, Batch 9 step 3; design/core.md, "A repeated `@id` at load", "A file whose `parent` and `children` disagree",
// "Persistence"): the graph of a record is the graph of the file it is read from, an embedded entry is built as a node of its own, a reference
// to a node not built yet is accepted, a repeated `@id` rejects every document that carries it, `parent` wins over `children`, a file that is
// absent is not an error, what the engine refuses for a document is reported with its id and class, and the ids referenced and never defined
// are returned. The two reproductions (the repeated id and the disagreeing `parent`) are shown against the reference copy's `rehydrateStore`
// too, in the last block: it merges the repeated id and holds two containers for the node. That block goes with the reference copy (Batch 12).
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_GRAPH } from '@aperas/core/apeironNgn/interface';
import { MirrorFileError, loadMirror, problemOf, skippedDocuments, startGraphs } from '@aperas/core/shell/mirrorLoad';
import { documentsText, type MirrorMapping } from '@aperas/core/shell/mirrorFiles';
import { dumpDocuments } from '@aperas/core/shell/mirrorDump';
import { rehydrateStore } from '@aperas/core/shell/store';
import { objectsOf } from '@aperas/core/shell/storeAccess';
import { freeWasm } from '@aperas/core/shell/vocab';
import { Refused, Undecided } from '@aperas/core/apeironNgn/engine';
import { THREADS, TREE, idOf, newEngine, scratchRoot, writeTexts } from '../support/mirrorFixture.ts';

const MAPPING: MirrorMapping = [
  { graph: TREE, kind: 'FolderNode', file: 'Apeiron/FolderNode.jsonld' },
  { graph: TREE, kind: 'BlockNode', file: 'Apeiron/BlockNode.jsonld' },
  { graph: THREADS, kind: 'BlockNode', file: 'Apeiron/.state/BlockNode.jsonld' },
];
const blk = (n: number): string => idOf('BlockNode', n);
const fld = (n: number): string => idOf('FolderNode', n);
const block = (n: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ '@id': blk(n), '@type': 'BlockNode', title: `b${n}`, type: 'paragraph', children: [], ...extra });
const folder = (n: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ '@id': fld(n), '@type': 'FolderNode', title: `f${n}`, path: `p${n}`, children: [], ...extra });

let scratch: ReturnType<typeof scratchRoot>;
beforeEach(() => { scratch = scratchRoot(); });
afterEach(() => scratch.cleanup());
const write = (files: Record<string, unknown[]>): void => writeTexts(scratch.root, Object.fromEntries(Object.entries(files).map(([f, docs]) => [f, documentsText(docs)])));
const load = (mapping: MirrorMapping = MAPPING) => { const engine = newEngine(); return { engine, result: loadMirror(engine, scratch.root, mapping) }; };

describe('the graph and the kind of a record', () => {
  test('a record is in the graph of the file it is read from, with the kind of its @type, and a document holds no graph field', () => {
    write({ 'Apeiron/BlockNode.jsonld': [block(1)], 'Apeiron/.state/BlockNode.jsonld': [block(2)], 'Apeiron/FolderNode.jsonld': [folder(3)] });
    const { engine, result } = load();
    assert.deepEqual(result.graphs, [TREE, THREADS]);
    assert.equal(result.documents, 3);
    assert.deepEqual(engine.idsOfKind(TREE, 'BlockNode'), [blk(1)]);
    assert.deepEqual(engine.idsOfKind(THREADS, 'BlockNode'), [blk(2)]);
    assert.deepEqual(engine.idsOfKind(TREE, 'FolderNode'), [fld(3)]);
    assert.equal(engine.graphOf(blk(2)), THREADS);
    assert.equal(engine.record(TREE, blk(2)), undefined, 'and in no other graph');
    assert.deepEqual(engine.record(TREE, blk(1))!.fields.map((f) => f.name), ['title', 'type'], 'a field the file does not state is not there, and an empty children holds nothing');
  });

  test('the shell creates the graphs of the mapping and drops the one the engine starts with', () => {
    write({ 'Apeiron/BlockNode.jsonld': [block(1)] });
    const { engine } = load();
    assert.throws(() => engine.createGraph(TREE), (e: unknown) => e instanceof Refused, 'the graph exists');
    assert.doesNotThrow(() => engine.createGraph(DEFAULT_GRAPH), 'and the starting graph is gone: its name is free again');
  });

  test('a document in the file of another kind is built as its @type says, and warned of', () => {
    write({ 'Apeiron/FolderNode.jsonld': [block(1)] });
    const { engine, result } = load();
    assert.deepEqual(engine.idsOfKind(TREE, 'BlockNode'), [blk(1)]);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0]!, new RegExp(`${blk(1)} is of the type BlockNode and stands in the file of FolderNode`));
  });
});

describe('an embedded entry', () => {
  test('is built as a node of its own, with the id it carries, in the graph of its owner; its id is the value of the owner\'s field', () => {
    const link = `${blk(1)}:links:Link:00T5MX0000100`;
    const prop = `${link}:props:StringProp:00T5MX0000101`;
    write({ 'Apeiron/.state/BlockNode.jsonld': [block(1, { links: [{ '@id': link, '@type': 'Link', target: blk(9), props: [{ '@id': prop, '@type': 'StringProp', key: 'position', value: '5' }] }] })] });
    const { engine, result } = load();
    assert.equal(result.documents, 1);
    assert.equal(result.embedded, 2);
    assert.deepEqual(engine.values(THREADS, blk(1), 'links'), [link]);
    assert.deepEqual(engine.record(THREADS, link), { id: link, kind: 'Link', fields: [{ name: 'target', values: [blk(9)] }, { name: 'props', values: [prop] }] });
    assert.deepEqual(engine.record(THREADS, prop), { id: prop, kind: 'StringProp', fields: [{ name: 'key', values: ['position'] }, { name: 'value', values: ['5'] }] });
    assert.equal(engine.graphOf(prop), THREADS);
    assert.deepEqual(engine.idsOfKind(THREADS, 'Link'), [link], 'and a Link has no file of its own');
  });

  test('a String is a string and an id-like string in a literal field stays one', () => {
    write({ 'Apeiron/BlockNode.jsonld': [block(1, { title: blk(2), text: 'BlockNode:NOTANID' })] });
    const { engine, result } = load();
    assert.deepEqual(result.errors, []);
    assert.deepEqual(engine.values(TREE, blk(1), 'title'), [blk(2)]);
    assert.deepEqual(engine.values(TREE, blk(1), 'text'), ['BlockNode:NOTANID']);
  });
});

describe('a reference to a node not built yet', () => {
  test('is accepted, in either order of the documents, and the container keeps the order of its list', () => {
    const container = block(1, { children: [blk(4), blk(2), blk(3)] });
    const kids = [block(2, { parent: blk(1) }), block(3, { parent: blk(1) }), block(4, { parent: blk(1) })];
    for (const order of [[container, ...kids], [...kids, container], [kids[2]!, container, kids[0]!, kids[1]!]]) {
      write({ 'Apeiron/BlockNode.jsonld': order });
      const { engine, result } = load();
      assert.deepEqual(result.errors, []);
      assert.deepEqual(result.warnings, []);
      assert.deepEqual(engine.items(TREE, blk(1), 'children'), [blk(4), blk(2), blk(3)]);
      assert.deepEqual(engine.values(TREE, blk(2), 'parent'), [blk(1)]);
    }
  });

  test('is returned as dangling when no graph ever defines it: the ghost folder', () => {
    const ghost = fld(77);
    write({ 'Apeiron/FolderNode.jsonld': [folder(1, { children: [ghost] })] });
    const { result } = load();
    assert.deepEqual(result.dangling, [ghost]);
    assert.deepEqual(result.errors, []);
  });

  test('is not dangling when another graph defines it: the folder of the threads graph that the root folder lists', () => {
    write({ 'Apeiron/FolderNode.jsonld': [folder(1, { children: [blk(2)] })], 'Apeiron/.state/BlockNode.jsonld': [block(2, { parent: fld(1) })] });
    const { engine, result } = load();
    assert.deepEqual(result.dangling, []);
    assert.deepEqual(engine.items(TREE, fld(1), 'children'), [blk(2)]);
    const dumped = dumpDocuments(engine, THREADS, 'BlockNode', [TREE, THREADS]);
    assert.equal(dumped[0]!.parent, fld(1), 'and the dump states the parent that only the other graph holds');
  });
});

describe('a repeated @id (the first reproduction)', () => {
  const two = { 'Apeiron/BlockNode.jsonld': [block(1, { title: 'first' }), block(1, { title: 'second' }), block(2)] };

  test('rejects every document that carries it, keeps none, names the id, and goes on with the others', () => {
    write(two);
    const { engine, result } = load();
    assert.deepEqual(result.rejected, [{ id: blk(1), files: [join(scratch.root, 'Apeiron/BlockNode.jsonld')] }]);
    assert.equal(engine.record(TREE, blk(1)), undefined, 'neither of the two is kept');
    assert.deepEqual(engine.idsOfKind(TREE, 'BlockNode'), [blk(2)], 'the other document is');
    assert.equal(result.documents, 1);
    assert.equal(result.warnings.filter((w) => w.includes(blk(1)) && /carried 2 times/.test(w)).length, 1);
  });

  test('across the files together: a main-graph document and a threads-graph document of one id', () => {
    write({ 'Apeiron/BlockNode.jsonld': [block(1), block(3)], 'Apeiron/.state/BlockNode.jsonld': [block(1, { title: 'other' }), block(4)] });
    const { engine, result } = load();
    assert.deepEqual(result.rejected.map((r) => r.id), [blk(1)]);
    assert.equal(result.rejected[0]!.files.length, 2);
    assert.deepEqual(engine.idsOfKind(TREE, 'BlockNode'), [blk(3)]);
    assert.deepEqual(engine.idsOfKind(THREADS, 'BlockNode'), [blk(4)]);
  });

  test('an embedded id repeated rejects the documents that carry it, and a top-level id met inside another document does as well', () => {
    const shared = `${blk(1)}:props:StringProp:00T5MX0000200`;
    const entry = { '@id': shared, '@type': 'StringProp', key: 'k', value: 'v' };
    write({ 'Apeiron/BlockNode.jsonld': [block(1, { props: [entry] }), block(1, { title: 'twin' }), block(2), block(3, { props: [{ ...entry, '@id': `${blk(3)}:props:StringProp:00T5MX0000201` }, { ...entry, '@id': `${blk(3)}:props:StringProp:00T5MX0000201` }] })] });
    const { engine, result } = load();
    assert.deepEqual(result.rejected.map((r) => r.id).sort(), [blk(1), `${blk(3)}:props:StringProp:00T5MX0000201`].sort());
    assert.deepEqual(engine.idsOfKind(TREE, 'BlockNode'), [blk(2)]);
    assert.equal(engine.record(TREE, shared), undefined, 'what the rejected documents embedded is not built either');
  });

  test('a container whose child is rejected holds the child as a reference that nothing defines', () => {
    write({ 'Apeiron/BlockNode.jsonld': [block(1, { children: [blk(2)] }), block(2), block(2, { title: 'twin' })] });
    const { result } = load();
    assert.deepEqual(result.dangling, [blk(2)]);
  });
});

describe('a file whose parent and children disagree (the second reproduction)', () => {
  test('parent wins: the node is at the end of the children of the container its parent names, and the other entry is dropped with a warning that names both', () => {
    write({ 'Apeiron/BlockNode.jsonld': [block(1, { children: [blk(2)] }), block(2, { parent: blk(3) }), block(3, { children: [blk(4)] }), block(4, { parent: blk(3) })] });
    const { engine, result } = load();
    assert.deepEqual(result.errors, []);
    assert.deepEqual(engine.items(TREE, blk(1), 'children'), []);
    assert.deepEqual(engine.items(TREE, blk(3), 'children'), [blk(4), blk(2)], 'appended at the end');
    assert.deepEqual(engine.values(TREE, blk(2), 'parent'), [blk(3)]);
    const dropped = result.warnings.filter((w) => w.includes('is listed in the children of'));
    assert.equal(dropped.length, 1);
    assert.ok(dropped[0]!.includes(blk(2)) && dropped[0]!.includes(blk(1)) && dropped[0]!.includes(blk(3)), `names the node and both containers: ${dropped[0]}`);
    const appended = result.warnings.filter((w) => w.includes('appended at the end'));
    assert.equal(appended.length, 1);
    assert.ok(appended[0]!.includes(blk(2)) && appended[0]!.includes(blk(3)));
  });

  test('the parent is never put in the fields of the build: a parent that names a container that does not list the node still puts it there once', () => {
    write({ 'Apeiron/BlockNode.jsonld': [block(1), block(2, { parent: blk(1) }), block(3, { parent: blk(1) })] });
    const { engine, result } = load();
    assert.deepEqual(engine.items(TREE, blk(1), 'children'), [blk(2), blk(3)], 'in file order');
    assert.equal(result.warnings.length, 2);
  });

  test('a parent that names an id with no document leaves the node with no container, warns, and the id is returned among the dangling ones', () => {
    write({ 'Apeiron/BlockNode.jsonld': [block(1, { children: [blk(2)] }), block(2, { parent: blk(9) })] });
    const { engine, result } = load();
    assert.deepEqual(engine.values(TREE, blk(2), 'parent'), []);
    assert.deepEqual(engine.items(TREE, blk(1), 'children'), [], 'its entry in the container that did list it is dropped as well');
    assert.ok(result.dangling.includes(blk(9)));
    assert.ok(result.warnings.some((w) => w.includes(blk(2)) && w.includes(blk(9)) && /no container/.test(w)));
  });

  test('a parent that names a document that cannot hold a node leaves the node with no container', () => {
    write({ 'Apeiron/FolderNode.jsonld': [folder(1)], 'Apeiron/BlockNode.jsonld': [block(2, { parent: blk(3) }), block(3)] });
    const { engine, result } = load();
    assert.deepEqual(engine.items(TREE, blk(3), 'children'), [blk(2)], 'a block can hold a block');
    assert.deepEqual(result.warnings.length, 1);
    write({ 'Apeiron/FolderNode.jsonld': [folder(1)], 'Apeiron/BlockNode.jsonld': [block(2, { parent: fld(1) })] });
    const again = load();
    assert.deepEqual(again.engine.items(TREE, fld(1), 'children'), [blk(2)], 'and so can a folder');
  });

  test('a node listed by a container and with no parent stays in that container', () => {
    write({ 'Apeiron/BlockNode.jsonld': [block(1, { children: [blk(2)] }), block(2)] });
    const { engine, result } = load();
    assert.deepEqual(engine.items(TREE, blk(1), 'children'), [blk(2)]);
    assert.deepEqual(engine.values(TREE, blk(2), 'parent'), [blk(1)]);
    assert.deepEqual(result.warnings, []);
  });

  test('a node listed by two containers and with no parent stays in the first, in file order, and is dropped from the other with a warning', () => {
    write({ 'Apeiron/BlockNode.jsonld': [block(1, { children: [blk(3)] }), block(2, { children: [blk(3)] }), block(3)] });
    const { engine, result } = load();
    assert.deepEqual(engine.items(TREE, blk(1), 'children'), [blk(3)]);
    assert.deepEqual(engine.items(TREE, blk(2), 'children'), []);
    assert.ok(result.warnings.some((w) => w.includes(blk(3)) && w.includes(blk(1)) && w.includes(blk(2))));
  });

  test('works across graphs: the container is in one graph and the node in another', () => {
    write({ 'Apeiron/FolderNode.jsonld': [folder(1), folder(2, { children: [blk(3)] })], 'Apeiron/.state/BlockNode.jsonld': [block(3, { parent: fld(1) })] });
    const { engine, result } = load();
    assert.deepEqual(engine.items(TREE, fld(1), 'children'), [blk(3)]);
    assert.deepEqual(engine.items(TREE, fld(2), 'children'), []);
    assert.deepEqual(result.errors, []);
    assert.equal(result.warnings.length, 2);
  });

  test('an entry listed twice in one container is kept once, with a warning', () => {
    write({ 'Apeiron/BlockNode.jsonld': [block(1, { children: [blk(2), blk(2)] }), block(2, { parent: blk(1) })] });
    const { engine, result } = load();
    assert.deepEqual(engine.items(TREE, blk(1), 'children'), [blk(2)]);
    assert.equal(result.warnings.length, 1);
  });
});

describe('a file or a document the load cannot take', () => {
  test('an absent file is not an error', () => {
    write({ 'Apeiron/BlockNode.jsonld': [block(1)] });
    const { engine, result } = load();
    assert.deepEqual(result.errors, []);
    assert.deepEqual(engine.idsOfKind(THREADS, 'BlockNode'), [], 'a fresh checkout has no .state');
  });

  test('a file that is not JSON, and one that is not an array, stop the load and name the file', () => {
    writeTexts(scratch.root, { 'Apeiron/BlockNode.jsonld': '[{' });
    assert.throws(() => load(), (e: unknown) => e instanceof MirrorFileError && /BlockNode\.jsonld/.test(e.message) && /not JSON/.test(e.message));
    writeTexts(scratch.root, { 'Apeiron/BlockNode.jsonld': '{"a": 1}\n' });
    assert.throws(() => load(), (e: unknown) => e instanceof MirrorFileError && /not a JSON array/.test(e.message));
  });

  test('a document without an @id or an @type is reported and the others are built', () => {
    mkdirSync(join(scratch.root, 'Apeiron'), { recursive: true });
    writeFileSync(join(scratch.root, 'Apeiron/BlockNode.jsonld'), JSON.stringify([{ title: 'x' }, block(1), { '@id': blk(2) }, 7]));
    const { engine, result } = load();
    assert.equal(result.errors.length, 3);
    assert.deepEqual(engine.idsOfKind(TREE, 'BlockNode'), [blk(1)]);
  });

  test('what the engine refuses for a document is reported with its id, the class and the open point, and the load goes on', () => {
    write({ 'Apeiron/BlockNode.jsonld': [block(1, { predicate: 'x' }), block(2, { title: ['a', 'b'] }), block(3), { ...block(4), '@type': 'Nonesuch' }, block(5, { text: { nested: true } })] });
    const { engine, result } = load();
    const byId = Object.fromEntries(result.errors.map((e) => [e.subject, e]));
    assert.equal(byId[blk(1)]!.class, 'Undecided');
    assert.equal(byId[blk(1)]!.point, 'Enforcement');
    assert.equal(byId[blk(2)]!.class, 'Undecided', 'a doubled one field');
    assert.equal(byId[blk(4)]!.class, 'Refused', 'a kind that is not one');
    assert.equal(byId[blk(5)]!.class, 'Undecided', 'a value that is neither a literal nor an entry');
    assert.deepEqual(engine.idsOfKind(TREE, 'BlockNode'), [blk(3)]);
    assert.equal(result.documents, 1);
  });

  test('an embedded entry that is refused is reported with its id, and its owner stays built', () => {
    const bad = `${blk(1)}:links:Link:00T5MX0000300`;
    write({ 'Apeiron/BlockNode.jsonld': [block(1, { links: [{ '@id': bad, '@type': 'Link', target: blk(2), nonsense: true }] })] });
    const { engine, result } = load();
    assert.deepEqual(result.errors.map((e) => [e.subject, e.class, e.point]), [[bad, 'Undecided', 'Enforcement']]);
    assert.equal(engine.record(TREE, blk(1))!.id, blk(1));
    assert.ok(result.dangling.includes(bad), 'and the id the owner holds is returned as dangling');
  });

  test('problemOf reads an engine error by its class and point, and throws on any other', () => {
    assert.deepEqual(problemOf('X', new Undecided('Enforcement')), { subject: 'X', class: 'Undecided', point: 'Enforcement', message: 'undecided: Enforcement' });
    assert.deepEqual(problemOf('X', new Refused('no')), { subject: 'X', class: 'Refused', message: 'refused: no' });
    assert.throws(() => problemOf('X', new TypeError('bug')), TypeError);
    assert.throws(() => problemOf('X', 'a string'));
  });
});

describe('the start of the graphs', () => {
  test('the graph the engine starts with is kept when the mapping names it, and when it holds a record', () => {
    const named = newEngine();
    startGraphs(named, [DEFAULT_GRAPH, TREE]);
    assert.doesNotThrow(() => named.idsOfKind(DEFAULT_GRAPH, 'BlockNode'));
    assert.throws(() => named.createGraph(DEFAULT_GRAPH), Refused, 'it still exists');
    const used = newEngine();
    used.createNode(DEFAULT_GRAPH, blk(1), 'BlockNode');
    const warnings = startGraphs(used, [TREE]);
    assert.equal(warnings.length, 1);
    assert.deepEqual(used.idsOfKind(DEFAULT_GRAPH, 'BlockNode'), [blk(1)]);
  });
});

describe('the documents a load did not build, as the files hold them', () => {
  test('both documents that carry a repeated id, at the top or embedded, and no other document; the file named with its resolved path', () => {
    const link = (owner: string, n: number): Record<string, unknown> => ({ '@id': `${owner}:links:Link:${n}`, '@type': 'Link', target: blk(9) });
    write({
      'Apeiron/BlockNode.jsonld': [block(1, { title: 'first' }), block(2), block(1, { title: 'second' }), block(3, { links: [link(blk(3), 7)] }), block(4, { links: [link(blk(3), 7)] })],
      'Apeiron/.state/BlockNode.jsonld': [block(5)],
    });
    const { engine, result } = load();
    assert.deepEqual(result.rejected.map((r) => r.id).sort(), [blk(1), `${blk(3)}:links:Link:7`].sort(), 'the id of the block and the embedded id carried twice');
    assert.equal(engine.idsOfKind(TREE, 'BlockNode').length, 1, 'only block 2 was built');
    const skipped = skippedDocuments(scratch.root, MAPPING, result);
    assert.deepEqual(skipped.map((s) => s.file), [join(scratch.root, 'Apeiron/BlockNode.jsonld')], 'one file holds them; the file that holds none is not given');
    assert.deepEqual(skipped[0]!.documents.map((d) => (d as { '@id': string })['@id']), [blk(1), blk(1), blk(3), blk(4)], 'in file order, raw: the two blocks of the repeated id and the two that carry the embedded id');
    assert.equal((skipped[0]!.documents[0] as { title: string }).title, 'first');
    assert.equal((skipped[0]!.documents[1] as { title: string }).title, 'second');
  });

  test('a document the engine refused, and an entry that is no document when the error names the file', () => {
    const bogus = block(1, { notAField: 'x' });
    write({ 'Apeiron/BlockNode.jsonld': [bogus, block(2)] });
    const { result } = load();
    assert.deepEqual(result.errors.map((e) => e.subject), [blk(1)]);
    assert.deepEqual(skippedDocuments(scratch.root, MAPPING, result), [{ file: join(scratch.root, 'Apeiron/BlockNode.jsonld'), documents: [bogus] }]);
    writeTexts(scratch.root, { 'Apeiron/BlockNode.jsonld': documentsText([block(2), 'not a document', { title: 'no id' }]) });
    const { result: malformed } = load();
    assert.equal(malformed.errors.length, 2);
    const file = join(scratch.root, 'Apeiron/BlockNode.jsonld');
    assert.deepEqual(malformed.errors.map((e) => e.subject), [file, file]);
    assert.deepEqual(skippedDocuments(scratch.root, MAPPING, malformed), [{ file, documents: ['not a document', { title: 'no id' }] }]);
  });

  test('a load that skipped nothing gives nothing; asked for an id, the document is found in whichever file of the mapping holds it', () => {
    write({ 'Apeiron/BlockNode.jsonld': [block(1), block(2)] });
    const { result } = load();
    assert.deepEqual(skippedDocuments(scratch.root, MAPPING, result), []);
    assert.deepEqual(skippedDocuments(scratch.root, MAPPING, { rejected: [{ id: blk(1), files: [] }], errors: [] }), [{ file: join(scratch.root, 'Apeiron/BlockNode.jsonld'), documents: [block(1)] }], 'asked for an id, it finds the document in whichever file of the mapping holds it');
  });
});

describe('the same two reproductions on the reference copy (goes with it, Batch 12)', () => {
  const instanceFiles = { 'Apeiron/ArtifactNode.jsonld': '[]\n', 'Apeiron/FolderNode.jsonld': '[]\n', 'Apeiron/Profile.jsonld': '[]\n' };

  test('rehydrateStore merges the quads of a repeated @id and keeps both titles; the load keeps neither document', () => {
    write({ 'Apeiron/BlockNode.jsonld': [block(1, { title: 'first' }), block(1, { title: 'second' })] });
    writeTexts(scratch.root, instanceFiles);
    const reference = rehydrateStore(join(scratch.root, 'Apeiron'));
    assert.deepEqual(reference.duplicateIds, [blk(1)]);
    assert.deepEqual(objectsOf(reference.store, blk(1), 'title').map((o) => (o.kind === 'literal' ? o.value : '')).sort(), ['first', 'second'], 'the reference copy holds a node with two titles: the documents merged');
    freeWasm(reference.store);
    assert.deepEqual(load().engine.idsOfKind(TREE, 'BlockNode'), [], 'and the load holds no node');
  });

  test('rehydrateStore gives a node whose parent and container disagree two parents; the load gives it the one the parent names', () => {
    write({ 'Apeiron/BlockNode.jsonld': [block(1, { children: [blk(2)] }), block(2, { parent: blk(3) }), block(3)] });
    writeTexts(scratch.root, instanceFiles);
    const reference = rehydrateStore(join(scratch.root, 'Apeiron'));
    assert.equal(objectsOf(reference.store, blk(2), 'parent').length, 2, 'the reference copy writes the parent from the container and from the node\'s own pair');
    freeWasm(reference.store);
    assert.deepEqual(load().engine.values(TREE, blk(2), 'parent'), [blk(3)]);
  });
});
