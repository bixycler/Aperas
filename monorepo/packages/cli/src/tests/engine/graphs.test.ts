// Several graphs (planning/core.md, Batch 8 steps 1, 2 and 4; design/core.md, "Graphs in memory", "Dropping a graph"): the creation of a
// graph under the grammar of a graph's name, a node that lives in one graph, the drop of a graph and its refusal when a pair from
// another graph points in, and `graphOf`. Hand-written cases, each given to the engine and the oracle. The reads and rules across
// graphs are in `graphReads.test.ts`, the random sequences in `graphs.model.test.ts`.
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, inspectEngine, Refused } from '@aperas/core/apeironNgn/engine';
import { isGraphName } from '@aperas/core/apeironNgn/graphName';
import type { Engine } from '@aperas/core/apeironNgn/interface';
import { Oracle, Refused as OracleRefused, oracleIsGraphName } from '../support/oracle.ts';
import { TEST_SCHEMA } from '../support/engineSchema.ts';
import { checkTree } from '../support/engineTree.ts';

const G = 'default';
let n = 0;
const mint = (kind: string): string => `${kind}:${(++n).toString().padStart(13, '0')}`;

let e: Engine;
let o: Oracle;
const mk = (kind: string, graph = G): string => { const id = mint(kind); e.createNode(graph, id, kind); o.createNode(graph, id, kind); return id; };
const both = (run: (x: Engine) => void): void => { run(e); run(o); };
const sorted = (xs: readonly string[]): string[] => [...xs].sort();
const refused = (err: unknown): boolean => err instanceof Refused || err instanceof OracleRefused;
const bothThrow = (run: (x: Engine) => void, why: string): void => {
  assert.throws(() => run(e), refused, `engine: ${why}`);
  assert.throws(() => run(o), refused, `oracle: ${why}`);
};
/** What a reader can see of an engine in some graphs: the record of each id and the ids of each kind. */
const snapshot = (x: Engine, graphs: readonly string[], ids: readonly string[]) => graphs.map((g) => ({
  records: ids.map((id) => x.record(g, id)),
  kinds: x.schema.kinds.map((k) => sorted(x.idsOfKind(g, k.name))),
  subjects: ids.flatMap((id) => ['likes', 'mate', 'items', 'refs'].map((f) => sorted(x.subjectsOf(g, f, id)))),
}));

beforeEach(() => { e = createEngine(TEST_SCHEMA); o = new Oracle(e.schema); });

const LABEL63 = 'a'.repeat(63);
/** [the name, whether it is one, what the row shows] */
const NAMES: [string, boolean, string][] = [
  ['default', true, 'the graph that exists at the start'],
  ['tree', true, 'the name the shell warns of is not the engine\'s concern'],
  ['threads.tree', true, 'two labels'],
  ['my.graph.myhost', true, 'three labels'],
  ['a', true, 'a label of one character'],
  ['9', true, 'a label that is a digit'],
  ['1.2.3', true, 'labels that start with a digit'],
  ['a-b', true, 'a hyphen inside a label'],
  ['a--b', true, 'two hyphens inside a label'],
  ['xn--x9-0ma', true, 'a punycode label'],
  ['id.example', true, 'a name that has `id` as a label is not `id`'],
  ['idx', true, 'a name that starts with `id`'],
  [LABEL63, true, 'a label of 63 characters'],
  [Array.from({ length: 4 }, () => 'a'.repeat(62)).join('.') + '.a', true, 'a name of 253 characters'],
  ['id', false, 'the reserved authority'],
  ['', false, 'the empty string'],
  ['Default', false, 'an uppercase letter'],
  ['a.B', false, 'an uppercase letter in a later label'],
  ['.a', false, 'a leading dot'],
  ['a.', false, 'a trailing dot'],
  ['a..b', false, 'an empty label'],
  ['.', false, 'only a dot'],
  ['-a', false, 'a hyphen at the start of the name'],
  ['a-', false, 'a hyphen at the end of the name'],
  ['a.-b', false, 'a hyphen at the start of a label'],
  ['a-.b', false, 'a hyphen at the end of a label'],
  ['a_b', false, 'an underscore'],
  ['a b', false, 'a space'],
  [' a', false, 'a leading space'],
  ['a\n', false, 'a trailing newline'],
  ['a/b', false, 'a slash'],
  ['a:b', false, 'a colon'],
  ['a@b', false, 'an at sign'],
  ['é', false, 'a letter outside a to z'],
  ['а', false, 'a Cyrillic letter that looks like a'],
  [LABEL63 + 'a', false, 'a label of 64 characters'],
  [Array.from({ length: 4 }, () => 'a'.repeat(62)).join('.') + '.aa', false, 'a name of 254 characters'],
];

describe('the name of a graph', () => {
  for (const [name, valid, why] of NAMES) {
    test(`${JSON.stringify(name.length > 40 ? name.slice(0, 12) + '...(' + name.length + ')' : name)}: ${valid ? 'a name' : 'refused'} (${why})`, () => {
      assert.equal(isGraphName(name), valid, 'the engine\'s grammar');
      assert.equal(oracleIsGraphName(name), valid, 'the oracle\'s grammar, written apart');
      if (name === G) return; // exists already
      if (valid) {
        both((x) => x.createGraph(name));
        const id = mk('Leaf', name);
        assert.deepEqual(e.idsOfKind(name, 'Leaf'), [id]);
        assert.deepEqual(o.idsOfKind(name, 'Leaf'), [id]);
      } else {
        bothThrow((x) => x.createGraph(name), 'createGraph');
        bothThrow((x) => x.createNode(name, mint('Leaf'), 'Leaf'), 'a node in a graph that was not made');
      }
    });
  }

  test('a value that is no string is not a name', () => {
    for (const v of [undefined, null, 7, {}, ['a']]) assert.equal(isGraphName(v), false);
  });
});

describe('createGraph', () => {
  test('refuses a graph that exists, the one at the start included, and changes nothing', () => {
    both((x) => x.createGraph('threads'));
    const a = mk('Leaf'); const b = mk('Leaf', 'threads');
    const before = [snapshot(e, [G, 'threads'], [a, b]), snapshot(o, [G, 'threads'], [a, b])];
    bothThrow((x) => x.createGraph('threads'), 'a second creation');
    bothThrow((x) => x.createGraph(G), 'the graph at the start');
    assert.deepEqual([snapshot(e, [G, 'threads'], [a, b]), snapshot(o, [G, 'threads'], [a, b])], before);
  });

  test('a new graph has no record, no kind, no root and no read', () => {
    both((x) => x.createGraph('a.b'));
    for (const k of e.schema.kinds) assert.deepEqual(e.idsOfKind('a.b', k.name), [], k.name);
    assert.deepEqual(inspectEngine(e).rootIds('a.b'), []);
    assert.deepEqual(e.subjectsOf('a.b', 'likes', 'Leaf:0000000000001'), []);
    assert.equal(e.countSubjectsOf('a.b', 'likes', 'Leaf:0000000000001'), 0);
    assert.equal(e.firstSubjectOf('a.b', 'likes', 'Leaf:0000000000001'), undefined);
  });

  test('a node is created in the graph it names, and is found in that graph only', () => {
    both((x) => x.createGraph('threads'));
    const a = mk('Leaf'); const b = mk('Leaf', 'threads');
    for (const x of [e, o]) {
      assert.deepEqual(x.idsOfKind(G, 'Leaf'), [a]);
      assert.deepEqual(x.idsOfKind('threads', 'Leaf'), [b]);
      assert.equal(x.record(G, b), undefined);
      assert.equal(x.record('threads', a), undefined);
      assert.deepEqual(x.record('threads', b), { id: b, kind: 'Leaf', fields: [] });
    }
    assert.deepEqual(inspectEngine(e).rootIds(G), [a]);
    assert.deepEqual(inspectEngine(e).rootIds('threads'), [b]);
  });

  test('an id is unique across all graphs', () => {
    both((x) => x.createGraph('other'));
    const a = mk('Leaf');
    bothThrow((x) => x.createNode('other', a, 'Leaf'), 'the same id in another graph');
    bothThrow((x) => x.createNode(G, a, 'Leaf'), 'the same id in the same graph');
    assert.deepEqual(e.idsOfKind('other', 'Leaf'), []);
  });

  test('a node in a graph that does not exist is refused', () => {
    bothThrow((x) => x.createNode('nowhere', mint('Leaf'), 'Leaf'), 'createNode');
    bothThrow((x) => x.build('nowhere', { id: mint('Leaf'), kind: 'Leaf', fields: {} }), 'build');
  });

  test('every graph keeps its own tree of records', () => {
    both((x) => x.createGraph('threads'));
    const box = mk('Box'); const inside = mk('Leaf'); const apart = mk('Leaf', 'threads');
    both((x) => x.insertItem(G, box, 'items', inside));
    checkTree(e, [box, inside, apart], 'default graph');
    checkTree(e, [box, inside, apart], 'threads graph', 'threads');
    assert.deepEqual(inspectEngine(e).rootIds(G), [box]);
    assert.deepEqual(inspectEngine(e).rootIds('threads'), [apart]);
  });
});

describe('dropGraph', () => {
  test('refuses a graph that does not exist, and the name of one that fails the grammar', () => {
    bothThrow((x) => x.dropGraph('nowhere'), 'a graph that was never made');
    bothThrow((x) => x.dropGraph('Not A Name'), 'a name that fails the grammar');
    both((x) => { x.createGraph('threads'); x.dropGraph('threads'); });
    bothThrow((x) => x.dropGraph('threads'), 'a graph that was dropped');
  });

  test('drops a graph with its records, its kinds and its roots, and its ids are free again', () => {
    both((x) => x.createGraph('threads'));
    const a = mk('Leaf'); const b = mk('Box', 'threads'); const c = mk('Leaf', 'threads');
    both((x) => x.insertItem('threads', b, 'items', c));
    both((x) => x.dropGraph('threads'));
    for (const x of [e, o]) {
      assert.equal(x.record('threads', b), undefined);
      assert.equal(x.record('threads', c), undefined);
      assert.deepEqual(x.idsOfKind('threads', 'Box'), []);
      assert.deepEqual(x.idsOfKind(G, 'Leaf'), [a]);
    }
    assert.deepEqual(inspectEngine(e).rootIds('threads'), []);
    assert.equal(inspectEngine(e).treeParentOf(c), undefined);
    bothThrow((x) => x.createNode('threads', b, 'Box'), 'a node in a graph that was dropped');
    both((x) => x.createGraph('threads'));
    both((x) => x.createNode('threads', b, 'Box')); // the id is free
    assert.deepEqual(e.idsOfKind('threads', 'Box'), [b]);
    assert.deepEqual(e.values('threads', b, 'items'), []);
  });

  test('the graph at the start is a graph as any other: it can be dropped', () => {
    both((x) => x.createGraph('threads'));
    const a = mk('Leaf');
    both((x) => x.dropGraph(G));
    for (const x of [e, o]) {
      assert.equal(x.record(G, a), undefined);
      assert.deepEqual(x.idsOfKind(G, 'Leaf'), []);
    }
    both((x) => x.createGraph(G));
    both((x) => x.createNode(G, a, 'Leaf'));
  });

  test('refuses while a pair from another graph points in, names nothing in either, and changes nothing', () => {
    both((x) => x.createGraph('threads'));
    const a = mk('Leaf'); const b = mk('Leaf', 'threads'); const c = mk('Leaf', 'threads');
    both((x) => x.addPair(G, a, 'likes', b));
    both((x) => x.addPair('threads', b, 'likes', c));
    const ids = [a, b, c];
    const before = [snapshot(e, [G, 'threads'], ids), snapshot(o, [G, 'threads'], ids)];
    bothThrow((x) => x.dropGraph('threads'), 'a reference from default into threads');
    assert.deepEqual([snapshot(e, [G, 'threads'], ids), snapshot(o, [G, 'threads'], ids)], before, 'a refused drop changes nothing in any graph');
    assert.deepEqual(inspectEngine(e).bucketedSubjects().sort(), [a, b].sort(), 'the buckets are as they were');
    both((x) => x.removePair(G, a, 'likes', b));
    both((x) => x.dropGraph('threads'));
  });

  test('refuses for a reference, a container and an embedded node alike, and not for a literal', () => {
    both((x) => x.createGraph('threads'));
    const box = mk('Box'); const inside = mk('Leaf', 'threads'); const leaf = mk('Leaf'); const apart = mk('Leaf', 'threads');
    both((x) => x.insertItem(G, box, 'items', inside)); // the container is in default, the item in threads
    bothThrow((x) => x.dropGraph('threads'), 'a container in another graph');
    both((x) => x.removeItem(G, box, 'items', inside));
    const ref = `${leaf}:refs:Ref:${mint('Ref').split(':')[1]}`;
    both((x) => x.createNode('threads', ref, 'Ref')); // an embedded node made in another graph than its owner
    both((x) => x.addPair(G, leaf, 'refs', ref));
    bothThrow((x) => x.dropGraph('threads'), 'an embed field of a node in another graph');
    both((x) => x.removePair(G, leaf, 'refs', ref));
    both((x) => x.addPair(G, leaf, 'label', apart)); // a literal that has the text of an id is no pair into the graph
    both((x) => x.dropGraph('threads'));
    assert.deepEqual(e.values(G, leaf, 'label'), [apart]);
  });

  test('takes the pairs that leave the graph out of the reverse of the graphs that remain', () => {
    both((x) => x.createGraph('threads'));
    const a = mk('Leaf'); const b = mk('Leaf', 'threads');
    const ghost = mint('Leaf'); // no record in any graph
    both((x) => x.addPair('threads', b, 'likes', a));
    both((x) => x.addPair('threads', b, 'likes', ghost));
    both((x) => x.addPair('threads', b, 'mate', a));
    for (const x of [e, o]) assert.deepEqual(x.subjectsOf('threads', 'likes', a), [b]); // the reverse is built
    assert.ok(inspectEngine(e).reversesBuilt().includes('likes'));
    both((x) => x.dropGraph('threads'));
    for (const x of [e, o]) {
      for (const f of ['likes', 'mate']) for (const v of [a, ghost]) {
        for (const g of [G, 'threads']) assert.deepEqual(x.subjectsOf(g, f, v), [], `${f} ${v} ${g}`);
        assert.equal(x.countSubjectsOf(G, f, v), 0);
      }
    }
    assert.deepEqual(inspectEngine(e).bucketedSubjects(), [], 'no bucket names a subject of the dropped graph');
    assert.deepEqual(inspectEngine(e).waitingIds(), [], 'no waiting entry is left for the id nobody holds');
  });

  test('leaves no bucket and no waiting entry that names a subject of the graph, for the ids that were never defined', () => {
    both((x) => x.createGraph('threads'));
    const keep = mk('Leaf');
    const ghost = mint('Leaf');
    both((x) => x.addPair('threads', mk('Leaf', 'threads'), 'likes', ghost));
    both((x) => x.addPair(G, keep, 'likes', ghost));
    e.subjectsOf(G, 'likes', ghost); // builds the reverse of `likes`
    assert.equal(inspectEngine(e).bucketedSubjects().length, 2, 'a subject in each graph is in the bucket of the id nobody defined');
    both((x) => x.dropGraph('threads'));
    assert.deepEqual(inspectEngine(e).bucketedSubjects(), [keep]);
    assert.deepEqual(inspectEngine(e).waitingIds(), [ghost]);
    assert.deepEqual(e.subjectsOf(G, 'likes', ghost), [keep]);
  });

  test('a graph that remains reads what it did before, and a node made later takes the buckets that waited for its id', () => {
    both((x) => x.createGraph('threads'));
    const a = mk('Leaf'); const b = mk('Leaf');
    both((x) => x.addPair(G, a, 'mate', b));
    const dropped = mk('Leaf', 'threads');
    both((x) => x.dropGraph('threads'));
    for (const x of [e, o]) assert.deepEqual(x.subjectsOf(G, 'mate', b), [a]);
    both((x) => x.createGraph('threads'));
    both((x) => x.createNode('threads', dropped, 'Leaf'));
    assert.deepEqual(e.record('threads', dropped), { id: dropped, kind: 'Leaf', fields: [] });
  });
});

describe('graphOf', () => {
  test('answers the graph whose record has the id, and nothing for an id no graph holds', () => {
    both((x) => x.createGraph('threads'));
    const a = mk('Leaf'); const b = mk('Leaf', 'threads'); const owner = mk('Leaf', 'threads');
    const ref = `${owner}:refs:Ref:${mint('Ref').split(':')[1]}`;
    both((x) => x.createNode('threads', ref, 'Ref'));
    for (const x of [e, o]) {
      assert.equal(x.graphOf(a), G);
      assert.equal(x.graphOf(b), 'threads');
      assert.equal(x.graphOf(ref), 'threads');
      assert.equal(x.graphOf(mint('Leaf')), undefined);
      assert.equal(x.graphOf(''), undefined);
      assert.equal(x.graphOf('not an id'), undefined);
    }
  });

  test('follows the record: a node removed, a graph dropped', () => {
    both((x) => x.createGraph('threads'));
    const a = mk('Leaf'); const b = mk('Leaf', 'threads');
    both((x) => x.removeNode('threads', b));
    for (const x of [e, o]) assert.equal(x.graphOf(b), undefined);
    const c = mk('Leaf', 'threads');
    both((x) => x.dropGraph('threads'));
    for (const x of [e, o]) { assert.equal(x.graphOf(c), undefined); assert.equal(x.graphOf(a), G); }
  });
});
