// Reads and rules across graphs (planning/core.md, Batch 8 step 3; design/core.md, "Reads and rules across graphs"): for each read and rule
// that touches the bucket of an object, a case with a subject in each of two graphs, given to the engine and the oracle. The reads
// that give a node's relations are filtered to the graph they name (`subjectsOf`, `firstSubjectOf`, `countSubjectsOf`, the derived entry,
// the tree); the rules of the whole store read across graphs (a node has one container, containment has no cycle, the entries dropped with
// their target, the removal of a tombstone from the containers that hold it); a sweep marks and deletes inside the graph it names.
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, inspectEngine, Refused } from '@aperas/core/apeironNgn/engine';
import type { Engine } from '@aperas/core/apeironNgn/interface';
import { Oracle, Refused as OracleRefused } from '../support/oracle.ts';
import { TEST_SCHEMA } from '../support/engineSchema.ts';
import { checkTree } from '../support/engineTree.ts';

const A = 'a.example';
const B = 'b.example';
const AT = '2026-10-17T00:00:00Z';
let n = 0;
const mint = (kind: string): string => `${kind}:${(++n).toString().padStart(13, '0')}`;

let e: Engine;
let o: Oracle;
const mk = (kind: string, graph: string): string => { const id = mint(kind); e.createNode(graph, id, kind); o.createNode(graph, id, kind); return id; };
const both = (run: (x: Engine) => void): void => { run(e); run(o); };
const sorted = (xs: readonly string[]): string[] => [...xs].sort();
const refused = (err: unknown): boolean => err instanceof Refused || err instanceof OracleRefused;
const bothThrow = (run: (x: Engine) => void, why: string): void => {
  assert.throws(() => run(e), refused, `engine: ${why}`);
  assert.throws(() => run(o), refused, `oracle: ${why}`);
};
const same = <T>(read: (x: Engine) => T, expected: T, why: string): void => {
  assert.deepEqual(read(e), expected, `engine: ${why}`);
  assert.deepEqual(read(o), expected, `oracle: ${why}`);
};

beforeEach(() => { e = createEngine(TEST_SCHEMA); o = new Oracle(e.schema); both((x) => { x.createGraph(A); x.createGraph(B); }); });

describe('the subjects of a reverse side are filtered to the graph the read names', () => {
  test('subjectsOf, firstSubjectOf and countSubjectsOf, for an object in one graph and a subject in each', () => {
    const t = mk('Leaf', A); const inA = mk('Leaf', A); const inB = mk('Leaf', B);
    both((x) => { x.addPair(A, inA, 'likes', t); x.addPair(B, inB, 'likes', t); });
    same((x) => sorted(x.subjectsOf(A, 'likes', t)), [inA], 'subjectsOf in A');
    same((x) => sorted(x.subjectsOf(B, 'likes', t)), [inB], 'subjectsOf in B');
    same((x) => x.firstSubjectOf(A, 'likes', t), inA, 'firstSubjectOf in A');
    same((x) => x.firstSubjectOf(B, 'likes', t), inB, 'firstSubjectOf in B');
    same((x) => x.countSubjectsOf(A, 'likes', t), 1, 'countSubjectsOf in A');
    same((x) => x.countSubjectsOf(B, 'likes', t), 1, 'countSubjectsOf in B');
    same((x) => x.subjectsOf('nowhere', 'likes', t), [], 'a graph that does not exist');
    same((x) => x.countSubjectsOf('default', 'likes', t), 0, 'a graph that holds no subject');
  });

  test('the same for an object with no record, and for an object that is a subject too', () => {
    const ghost = mint('Leaf'); const inA = mk('Leaf', A); const inB = mk('Leaf', B); const alsoB = mk('Leaf', B);
    both((x) => { x.addPair(A, inA, 'likes', ghost); x.addPair(B, inB, 'likes', ghost); x.addPair(B, alsoB, 'likes', ghost); });
    same((x) => sorted(x.subjectsOf(A, 'likes', ghost)), [inA], 'A');
    same((x) => sorted(x.subjectsOf(B, 'likes', ghost)), sorted([inB, alsoB]), 'B');
    same((x) => x.countSubjectsOf(A, 'likes', ghost), 1, 'count in A');
    same((x) => x.countSubjectsOf(B, 'likes', ghost), 2, 'count in B');
    const second = x2(); // an object in A, a subject only in B
    both((x) => x.addPair(B, inB, 'likes', second));
    same((x) => x.subjectsOf(A, 'likes', second), [], 'a subject of another graph only: nothing in the graph of the object');
    same((x) => x.firstSubjectOf(A, 'likes', second), undefined, 'and no first one');
    same((x) => x.subjectsOf(B, 'likes', second), [inB], 'in the graph of the subject');
  });
  function x2(): string { return mk('Leaf', A); }

  test('the same for a field with a reverse name, an embed field and a containment field', () => {
    const t = mk('Leaf', A); const mateA = mk('Leaf', A); const mateB = mk('Leaf', B);
    both((x) => { x.addPair(A, mateA, 'mate', t); x.addPair(B, mateB, 'mate', t); });
    same((x) => x.subjectsOf(A, 'mate', t), [mateA], 'mate in A');
    same((x) => x.subjectsOf(B, 'mate', t), [mateB], 'mate in B');
    const owner = mk('Leaf', A);
    const ref = `${owner}:refs:Ref:${mint('Ref').split(':')[1]}`;
    both((x) => { x.createNode(A, ref, 'Ref'); x.addPair(A, owner, 'refs', ref); });
    same((x) => x.subjectsOf(A, 'refs', ref), [owner], 'the owner of an embedded node, in its graph');
    same((x) => x.subjectsOf(B, 'refs', ref), [], 'and in another');
    const boxA = mk('Box', A); const boxB = mk('Box', B); const item = mk('Leaf', A);
    both((x) => x.insertItem(B, boxB, 'items', item));
    same((x) => x.subjectsOf(A, 'items', item), [], 'a container of another graph is no subject here');
    same((x) => x.subjectsOf(B, 'items', item), [boxB], 'it is a subject in its own graph');
    assert.ok(boxA);
  });

  test('the derived entry of a node is filtered to its graph, and so is the tree', () => {
    const boxB = mk('Box', B); const item = mk('Leaf', A);
    both((x) => x.insertItem(B, boxB, 'items', item));
    same((x) => x.values(A, item, 'up'), [], 'the container is in B: the node in A has no parent there');
    same((x) => x.first(A, item, 'up'), undefined, 'first');
    same((x) => x.record(A, item)!.fields, [], 'the record of the node shows no `up`');
    same((x) => x.values(B, item, 'up'), [], 'the node has no record in B');
    const own = mk('Leaf', B);
    both((x) => x.insertItem(B, boxB, 'items', own));
    same((x) => x.values(B, own, 'up'), [boxB], 'a node of the same graph has it');
    checkTree(e, [boxB, item, own], 'tree of A', A);
    checkTree(e, [boxB, item, own], 'tree of B', B);
    assert.deepEqual(inspectEngine(e).rootIds(A), [item], 'a node whose container is in another graph is a root of its own graph');
    assert.deepEqual(inspectEngine(e).rootIds(B), [boxB]);
    assert.equal(inspectEngine(e).treeParentOf(item), undefined);
    assert.equal(inspectEngine(e).treeParentOf(own), boxB);
  });
});

describe('the rules of the whole store read across graphs', () => {
  test('a node has one container, whichever graph the second is in', () => {
    const boxA = mk('Box', A); const boxB = mk('Box', B); const item = mk('Leaf', A);
    both((x) => x.insertItem(A, boxA, 'items', item));
    bothThrow((x) => x.insertItem(B, boxB, 'items', item), 'a second container in another graph');
    assert.deepEqual(e.items(B, boxB, 'items'), []);
    both((x) => x.removeItem(A, boxA, 'items', item));
    both((x) => x.insertItem(B, boxB, 'items', item)); // free again
    bothThrow((x) => x.insertItem(A, boxA, 'items', item), 'and the other way');
  });

  test('containment has no cycle through two graphs', () => {
    const boxA = mk('Box', A); const boxB = mk('Box', B); const boxC = mk('Box', A);
    both((x) => { x.insertItem(A, boxA, 'items', boxB); x.insertItem(B, boxB, 'items', boxC); });
    bothThrow((x) => x.insertItem(A, boxC, 'items', boxA), 'a cycle of three containers in two graphs');
    bothThrow((x) => x.insertItem(B, boxB, 'items', boxA), 'a cycle of two');
  });

  test('a removed node leaves the fields dropped with their target in every graph', () => {
    const target = mk('Leaf', A); const pinA = mk('Box', A); const pinB = mk('Box', B); const keep = mk('Leaf', A);
    both((x) => { x.addPair(A, pinA, 'pinned', target); x.addPair(B, pinB, 'pinned', target); x.addPair(B, pinB, 'pinned', keep); });
    both((x) => x.removeNode(A, target));
    same((x) => x.values(A, pinA, 'pinned'), [], 'the pin in the graph of the node');
    same((x) => x.values(B, pinB, 'pinned'), [keep], 'the pin in the other graph, and only that one');
  });

  test('a tombstone leaves the containers that hold it, in every graph', () => {
    const item = mk('Leaf', A); const boxB = mk('Box', B); const sibling = mk('Leaf', B);
    both((x) => { x.insertItem(B, boxB, 'items', item); x.insertItem(B, boxB, 'items', sibling); });
    both((x) => x.tombstone(A, item, AT));
    same((x) => x.items(B, boxB, 'items'), [sibling], 'the list of the container in the other graph');
    checkTree(e, [boxB, item, sibling], 'tree of B', B);
  });

  test('a subtree is the nodes of its own graph that the lists name', () => {
    const top = mk('Box', A); const inA = mk('Leaf', A); const inB = mk('Leaf', B);
    both((x) => { x.insertItem(A, top, 'items', inA); x.insertItem(A, top, 'items', inB); });
    both((x) => x.tombstoneSubtree(A, top, AT));
    same((x) => x.values(A, top, 'retiredAt'), [AT], 'the top');
    same((x) => x.values(A, inA, 'retiredAt'), [AT], 'the member in the graph');
    same((x) => x.values(B, inB, 'retiredAt'), [], 'a node of another graph that the list names is not a member');
  });
});

describe('a sweep deals inside the graph it names', () => {
  test('a live node of another graph does not keep a tombstone alive, and a reference across graphs may dangle', () => {
    const live = mk('Box', B); const tomb = mk('Leaf', A);
    both((x) => { x.insertItem(B, live, 'items', tomb); x.tombstone(A, tomb, AT); });
    both((x) => x.addPair(B, live, 'pinned', tomb));
    same((x) => x.sweep(A), [tomb], 'swept in its own graph');
    same((x) => x.record(A, tomb), undefined, 'gone');
    same((x) => x.values(B, live, 'pinned'), [], 'the entry in a field dropped with its target goes in the other graph');
    same((x) => x.values(B, live, 'items'), [], 'and so does the list entry, which the tombstone had already taken out');
  });

  test('a sweep of one graph deletes no tombstone of another, and the mark follows the fields inside its graph only', () => {
    const tombA = mk('Leaf', A); const tombB = mk('Leaf', B); const boxA = mk('Box', A); const boxB = mk('Box', B);
    both((x) => { x.tombstone(A, tombA, AT); x.tombstone(B, tombB, AT); });
    same((x) => x.sweep(A), [tombA], 'A');
    same((x) => x.record(B, tombB)?.id, tombB, 'the tombstone of B is still there');
    both((x) => x.insertItem(A, boxA, 'items', tombB)); // a live container of A names the tombstone of B
    same((x) => x.sweep(A), [], 'nothing else in A');
    same((x) => x.sweep(B), [tombB], 'the tombstone of B is deleted, though a live node of A names it');
    same((x) => x.record(B, boxB)?.id, boxB, 'the live nodes stay');
  });

  test('a tombstone that a live node of its own graph reaches is kept, and one that only a tombstone reaches goes', () => {
    const live = mk('Box', A); const kept = mk('Leaf', A); const island = mk('Leaf', A); const other = mk('Box', B);
    both((x) => { x.tombstone(A, kept, AT); x.tombstone(A, island, AT); x.addPair(B, other, 'pinned', island); });
    both((x) => x.insertItem(A, live, 'items', kept)); // a plain write gives a tombstone a container again
    same((x) => x.sweep(A), [island], 'island');
    same((x) => x.record(A, kept)?.id, kept, 'the one that the mark reaches stays');
  });

  test('a sweep of a graph that does not exist is refused', () => {
    bothThrow((x) => x.sweep('nowhere'), 'sweep');
  });
});
