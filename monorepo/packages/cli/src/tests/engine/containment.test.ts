// Containment (planning/core.md, Batch 6 steps 3 and 4; design/core.md, "Containment", "Where a node's parent comes from",
// "Records follow containment"): containment is the ordered, partitioning field that `roles.containment` names (`items` in the
// test schema), and the parent of a node is a derived entry (`up`) read from the reverse side of that field; the engine keeps no
// pair for it. Hand-written cases, each given to the engine and the oracle, then the two reproductions of the issues that the
// old engine fails, then the tree the records are arranged in. The random sequences are in `containment.model.test.ts`.
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, inspectEngine, Refused, Undecided } from '@aperas/core/apeironNgn/engine';
import type { Engine } from '@aperas/core/apeironNgn/interface';
import { Oracle, Refused as OracleRefused, Undecided as OracleUndecided } from '../support/oracle.ts';
import { TEST_SCHEMA } from '../support/engineSchema.ts';
import { checkTree } from '../support/engineTree.ts';

const G = 'default';
let n = 0;
const mint = (kind: string): string => `${kind}:${(++n).toString().padStart(13, '0')}`;

let e: Engine;
let o: Oracle;
const mk = (kind: string): string => { const id = mint(kind); e.createNode(G, id, kind); o.createNode(G, id, kind); return id; };
const both = (run: (x: Engine) => void): void => { run(e); run(o); };
const same = <T>(read: (x: Engine) => T, expected: T, why: string): void => {
  assert.deepEqual(read(e), expected, `engine: ${why}`);
  assert.deepEqual(read(o), expected, `oracle: ${why}`);
};
const refused = (err: unknown): boolean => err instanceof Refused || err instanceof OracleRefused;
const undecided = (point: string) => (err: unknown): boolean => (err instanceof Undecided && err.point === point) || (err instanceof OracleUndecided && err.point === point);
const bothThrow = (run: (x: Engine) => void, check: (err: unknown) => boolean, why: string): void => {
  assert.throws(() => run(e), check, `engine: ${why}`);
  assert.throws(() => run(o), check, `oracle: ${why}`);
};
/** The container of a node, as the engine and the oracle read it. */
const parentIs = (id: string, expected: string | undefined, why: string): void => {
  same((x) => x.values(G, id, 'up'), expected === undefined ? [] : [expected], `${why}: values`);
  same((x) => x.first(G, id, 'up'), expected, `${why}: first`);
};

beforeEach(() => { e = createEngine(TEST_SCHEMA); o = new Oracle(e.schema); });

describe('the parent of a node', () => {
  test('is read from the container that lists it: after an insertion, a move, a clear and a removePair', () => {
    const b1 = mk('Box'); const b2 = mk('Box'); const [a, c, d] = [mk('Leaf'), mk('Stub'), mk('Leaf')];
    parentIs(a, undefined, 'a node nobody lists');
    both((x) => { x.insertItem(G, b1, 'items', a); x.insertItem(G, b1, 'items', c); x.insertItem(G, b1, 'items', d); });
    for (const id of [a, c, d]) parentIs(id, b1, 'listed by b1');
    both((x) => { x.removeItem(G, b1, 'items', a); x.insertItem(G, b2, 'items', a); });
    parentIs(a, b2, 'moved: a removal, then an insertion');
    both((x) => x.removePair(G, b1, 'items', c));
    parentIs(c, undefined, 'removePair');
    both((x) => x.clearField(G, b1, 'items'));
    parentIs(d, undefined, 'a clear');
    both((x) => x.addPair(G, b2, 'items', d));
    parentIs(d, b2, 'addPair');
    both((x) => x.moveItem(G, b2, 'items', d, 0));
    parentIs(d, b2, 'a move inside the list');
  });

  test('a box is a node too: it has a container, and its own list', () => {
    const outer = mk('Box'); const inner = mk('Box'); const shelf = mk('Shelf');
    both((x) => { x.insertItem(G, outer, 'items', inner); x.insertItem(G, outer, 'items', shelf); });
    parentIs(inner, outer, 'a box in a box');
    parentIs(shelf, outer, 'a shelf in a box');
    parentIs(outer, undefined, 'the outer');
  });

  test('is empty for an absent subject and for a kind that does not declare it', () => {
    const loose = mk('Loose'); const ghost = mint('Leaf'); const leaf = mk('Leaf');
    same((x) => [x.values(G, ghost, 'up'), x.first(G, ghost, 'up')], [[], undefined], 'a node with no record');
    same((x) => [x.values(G, loose, 'up'), x.first(G, loose, 'up')], [[], undefined], 'Loose declares no up');
    same((x) => [x.values('elsewhere', leaf, 'up'), x.first('elsewhere', leaf, 'up')], [[], undefined], 'another graph');
  });

  test('holds no pair: addPair, removePair and clearField of it are Undecided of Enforcement', () => {
    const box = mk('Box'); const leaf = mk('Leaf');
    bothThrow((x) => x.addPair(G, leaf, 'up', box), undecided('Enforcement'), 'addPair');
    bothThrow((x) => x.removePair(G, leaf, 'up', box), undecided('Enforcement'), 'removePair');
    bothThrow((x) => x.clearField(G, leaf, 'up'), undecided('Enforcement'), 'clearField');
    bothThrow((x) => x.insertItem(G, leaf, 'up', box), undecided('Enforcement'), 'insertItem');
  });

  test('the reverse reads of the containment field give the container, and of the derived name give nothing', () => {
    const box = mk('Box'); const a = mk('Leaf'); const free = mk('Leaf');
    both((x) => x.insertItem(G, box, 'items', a));
    same((x) => [x.subjectsOf(G, 'items', a), x.firstSubjectOf(G, 'items', a), x.countSubjectsOf(G, 'items', a)], [[box], box, 1], 'the container');
    same((x) => [x.subjectsOf(G, 'items', free), x.firstSubjectOf(G, 'items', free), x.countSubjectsOf(G, 'items', free)], [[], undefined, 0], 'a node with no container');
    same((x) => [x.subjectsOf(G, 'up', a), x.firstSubjectOf(G, 'up', a), x.countSubjectsOf(G, 'up', a)], [[], undefined, 0], 'the derived name has no reverse side of its own');
  });

  test('is read without building the reverse of the containment field while no pair of it can exist', () => {
    const leaf = mk('Leaf');
    parentIs(leaf, undefined, 'no write yet');
    assert.equal(e.record(G, leaf)!.fields.length, 0);
    assert.deepEqual(inspectEngine(e).reversesBuilt(), [], 'reading the parent builds nothing before the first write');
    both((x) => x.insertItem(G, mk('Box'), 'items', leaf));
    assert.deepEqual(inspectEngine(e).reversesBuilt(), ['items']);
  });
});

describe('the record of a node', () => {
  test('lists the derived entry at its place with its container as value, and an ordered field in order', () => {
    const box = mk('Box'); const leaf = mk('Leaf'); const stub = mk('Stub');
    both((x) => { x.addPair(G, leaf, 'rank', 3); x.addPair(G, leaf, 'note', 'n'); x.addPair(G, leaf, 'label', 'L'); x.insertItem(G, box, 'items', leaf); x.insertItem(G, box, 'items', stub, 0); });
    same((x) => x.record(G, leaf)!.fields, [{ name: 'label', values: ['L'] }, { name: 'note', values: ['n'] }, { name: 'up', values: [box] }, { name: 'rank', values: [3] }], 'a Leaf: up after note and before rank');
    same((x) => x.record(G, box)!.fields, [{ name: 'items', values: [stub, leaf] }], 'a Box lists its items in order');
    same((x) => x.record(G, stub)!.fields, [{ name: 'up', values: [box] }], 'a Stub with nothing else');
    both((x) => x.moveItem(G, box, 'items', leaf, 0));
    same((x) => x.record(G, box)!.fields, [{ name: 'items', values: [leaf, stub] }], 'in the order of the move');
  });

  test('a Shelf lists up at the place its own order gives', () => {
    const box = mk('Box'); const shelf = mk('Shelf');
    both((x) => { x.addPair(G, shelf, 'label', 'S'); x.addPair(G, shelf, 'slot', 'one'); x.addPair(G, shelf, 'note', 'n'); x.insertItem(G, box, 'items', shelf); });
    same((x) => x.record(G, shelf)!.fields.map((f) => f.name), ['note', 'slot', 'up', 'label'], 'the order the kind declares');
  });

  test('a supplied derived entry in a build is an assertion and never a pair, even when a container lists the node', () => {
    const box = mk('Box'); const other = mk('Box'); const leaf = mint('Leaf');
    both((x) => x.insertItem(G, box, 'items', leaf));
    both((x) => x.build(G, { id: leaf, kind: 'Leaf', fields: { up: other, note: 'n' } }));
    parentIs(leaf, box, 'the container that lists it, not the assertion');
    same((x) => x.record(G, leaf)!.fields, [{ name: 'note', values: ['n'] }, { name: 'up', values: [box] }], 'read out from the reverse side');
    same((x) => x.items(G, other, 'items'), [], 'and the other box holds nothing');
  });
});

describe('a node taken out of its container', () => {
  test('is detached and not deleted: its record stays in the master map and in the collection of its kind, and it can go elsewhere', () => {
    const b1 = mk('Box'); const b2 = mk('Box'); const a = mk('Leaf');
    both((x) => { x.insertItem(G, b1, 'items', a); x.removeItem(G, b1, 'items', a); });
    parentIs(a, undefined, 'detached');
    same((x) => x.idsOfKind(G, 'Leaf'), [a], 'still in its collection');
    same((x) => x.record(G, a)!.id, a, 'and the master map');
    both((x) => x.insertItem(G, b2, 'items', a));
    parentIs(a, b2, 'inserted elsewhere');
  });

  test('moving to another container is a removal then an insertion, and the insertion is refused while the node is in the first list', () => {
    const b1 = mk('Box'); const b2 = mk('Box'); const a = mk('Leaf');
    both((x) => x.insertItem(G, b1, 'items', a));
    bothThrow((x) => x.insertItem(G, b2, 'items', a), refused, 'no cross-container move');
    bothThrow((x) => x.moveItem(G, b2, 'items', a, 0), refused, 'moveItem is inside one list');
    parentIs(a, b1, 'still in the first');
  });

  test('a container removed takes its list with it: the former children keep their records and are detached', () => {
    const box = mk('Box'); const [a, c] = [mk('Leaf'), mk('Stub')];
    both((x) => { x.insertItem(G, box, 'items', a); x.insertItem(G, box, 'items', c); });
    both((x) => x.removeNode(G, box));
    for (const id of [a, c]) parentIs(id, undefined, 'a former child');
    same((x) => [x.record(G, a)!.id, x.record(G, c)!.id], [a, c], 'the records stay');
    same((x) => x.record(G, box), undefined, 'and the container is gone');
    same((x) => x.subjectsOf(G, 'items', a), [], 'the box is out of the bucket');
  });
});

describe('a node removed while a container lists it', () => {
  test('leaves its entry in the list, with its place; no read counts the entry as existence', () => {
    const box = mk('Box'); const [a, b, c] = [mk('Leaf'), mk('Leaf'), mk('Leaf')];
    both((x) => { for (const i of [a, b, c]) x.insertItem(G, box, 'items', i); x.removeNode(G, b); });
    same((x) => x.items(G, box, 'items'), [a, b, c], 'the entry stays');
    same((x) => x.placeOf(G, box, 'items', c), 2, 'and keeps its place');
    same((x) => x.record(G, b), undefined, 'no record');
    same((x) => x.idsOfKind(G, 'Leaf'), [a, c], 'not in the collection');
    parentIs(b, undefined, 'an absent node has no parent');
    same((x) => x.subjectsOf(G, 'items', b), [box], 'but the bucket of its id is the container');
    assert.deepEqual(inspectEngine(e).waitingIds(), [b], 'which waits in the waiting map');
    bothThrow((x) => x.exists(G, b), undecided('Existence'), 'exists is still an open point');
    bothThrow((x) => x.size(G), undecided('Existence'), 'and size');
  });

  test('is created again under the id: it reads its old container as its parent', () => {
    const box = mk('Box'); const a = mk('Leaf');
    both((x) => { x.insertItem(G, box, 'items', a); x.removeNode(G, a); x.createNode(G, a, 'Leaf'); });
    parentIs(a, box, 'the old container');
    same((x) => x.record(G, a)!.fields, [{ name: 'up', values: [box] }], 'and the record says so');
    assert.deepEqual(inspectEngine(e).waitingIds(), [], 'the bucket moved onto the new record');
  });

  test('a node listed by a container before it exists: its parent is the container once it is created', () => {
    const box = mk('Box'); const later = mint('Leaf');
    both((x) => x.insertItem(G, box, 'items', later));
    parentIs(later, undefined, 'no record yet');
    both((x) => x.createNode(G, later, 'Leaf'));
    parentIs(later, box, 'created');
    same((x) => x.idsOfKind(G, 'Leaf'), [later], 'in its collection');
  });

  test('removed twice is Undecided of Existence the second time and changes nothing', () => {
    const box = mk('Box'); const a = mk('Leaf');
    both((x) => { x.insertItem(G, box, 'items', a); x.removeNode(G, a); });
    bothThrow((x) => x.removeNode(G, a), undecided('Existence'), 'the second removal');
    same((x) => x.items(G, box, 'items'), [a], 'the entry is as it was');
  });
});

describe('the two issues of the old engine', () => {
  // issues/core.md, "Sibling indexes are not kept dense: a move to another parent leaves a gap in the old parent and the next
  // append there can repeat an index". The old engine, run from the working checkout, ends with two children of P at index 2.
  test('sibling indexes: a child moved to another container leaves the old list dense, and the next append there takes the next place', () => {
    const p = mk('Box'); const q = mk('Box'); const [a, b, c, d] = [mk('Leaf'), mk('Leaf'), mk('Leaf'), mk('Leaf')];
    both((x) => { for (const i of [a, b, c]) x.insertItem(G, p, 'items', i); });
    both((x) => { x.removeItem(G, p, 'items', b); x.insertItem(G, q, 'items', b); });
    both((x) => x.insertItem(G, p, 'items', d));
    same((x) => x.items(G, p, 'items'), [a, c, d], 'the list of P');
    same((x) => [a, c, d].map((i) => x.placeOf(G, p, 'items', i)), [0, 1, 2], 'with the places 0, 1, 2 and no repeat');
    same((x) => x.items(G, q, 'items'), [b], 'the list of Q');
    same((x) => x.placeOf(G, q, 'items', b), 0, 'with B at its head');
  });

  // issues/core.md, "A child can end with two `parent` pairs: writing `children` detaches only the children the container already
  // has". The old engine, run from the working checkout, ends with the child under container1 and container2.
  test('two parent pairs: a child written into a second container is refused, and has one container; after a removal and an insertion it has the other', () => {
    const c1 = mk('Box'); const c2 = mk('Box'); const child = mk('Leaf');
    both((x) => x.insertItem(G, c1, 'items', child));
    bothThrow((x) => x.insertItem(G, c2, 'items', child), refused, 'insertItem into the second');
    bothThrow((x) => { x.clearField(G, c2, 'items'); x.addPair(G, c2, 'items', child); }, refused, 'the generic write: a clear then an add of the child');
    same((x) => x.subjectsOf(G, 'items', child), [c1], 'one container');
    parentIs(child, c1, 'its parent');
    both((x) => { x.removeItem(G, c1, 'items', child); x.insertItem(G, c2, 'items', child); });
    same((x) => x.subjectsOf(G, 'items', child), [c2], 'the other, and only it');
    parentIs(child, c2, 'its parent now');
    same((x) => x.items(G, c1, 'items'), [], 'the first holds nothing');
  });
});

describe('the records follow containment', () => {
  const made: string[] = [];
  const mkt = (kind: string): string => { const id = mk(kind); made.push(id); return id; };
  /** An embedded node made and held by its owner. */
  const own = (owner: string, field: string, kind: string): string => {
    const id = `${owner}:${field}:${mint(kind)}`;
    both((x) => { x.createNode(G, id, kind); x.addPair(G, owner, field, id); });
    made.push(id);
    return id;
  };
  const check = (why: string): void => checkTree(e, made, why);
  const tree = (): ReturnType<typeof inspectEngine> => inspectEngine(e);
  beforeEach(() => { made.length = 0; });

  test('a record with no container is a root, and a record in a list is beneath the record of its host', () => {
    const box = mkt('Box'); const [a, c] = [mkt('Leaf'), mkt('Stub')];
    check('created');
    assert.deepEqual(tree().rootIds(G), [box, a, c], 'every record is a root');
    both((x) => { x.insertItem(G, box, 'items', a); x.insertItem(G, box, 'items', c); });
    check('inserted');
    assert.deepEqual(tree().rootIds(G), [box]);
    assert.deepEqual(tree().nestedIds(box).sort(), [a, c].sort());
    assert.equal(tree().treeParentOf(a), box);
  });

  test('is kept by a move to another container (a removal then an insertion), a clear, a removePair and a removeItem; a move inside a list changes nothing', () => {
    const b1 = mkt('Box'); const b2 = mkt('Box'); const [a, c, d] = [mkt('Leaf'), mkt('Leaf'), mkt('Leaf')];
    both((x) => { x.insertItem(G, b1, 'items', a); x.insertItem(G, b1, 'items', c); x.insertItem(G, b1, 'items', d); });
    check('three in b1');
    const before = [tree().rootIds(G), tree().nestedIds(b1)];
    both((x) => x.moveItem(G, b1, 'items', d, 0));
    assert.deepEqual([tree().rootIds(G), tree().nestedIds(b1)], before, 'a move inside the list');
    check('after the move inside');
    both((x) => { x.removeItem(G, b1, 'items', a); x.insertItem(G, b2, 'items', a); });
    check('a moved to b2');
    both((x) => x.removePair(G, b1, 'items', c));
    check('removePair');
    both((x) => x.clearField(G, b1, 'items'));
    check('a clear');
    assert.deepEqual(tree().nestedIds(b1), []);
    both((x) => x.addPair(G, b2, 'items', c));
    check('addPair');
  });

  test('a container removed makes its children roots; a listed node removed leaves its container\'s tree while the entry stays; created again, it nests', () => {
    const box = mkt('Box'); const inner = mkt('Box'); const [a, c] = [mkt('Leaf'), mkt('Leaf')];
    both((x) => { x.insertItem(G, box, 'items', inner); x.insertItem(G, box, 'items', c); x.insertItem(G, inner, 'items', a); });
    check('a tree of three levels');
    both((x) => x.removeNode(G, c));
    made.splice(made.indexOf(c), 1);
    check('a listed node removed');
    assert.deepEqual(tree().nestedIds(box), [inner]);
    both((x) => x.createNode(G, c, 'Leaf'));
    made.push(c);
    check('created again under its old container');
    assert.equal(tree().treeParentOf(c), box);
    both((x) => x.removeNode(G, inner));
    made.splice(made.indexOf(inner), 1);
    check('a container removed');
    assert.equal(tree().treeParentOf(a), undefined, 'its child is a root');
    assert.deepEqual(tree().nestedIds(box), [c]);
  });

  test('a node listed by a container before it exists nests under the container when it is created, and when it is built', () => {
    const box = mkt('Box'); const later = mint('Leaf'); const builtLater = mint('Leaf'); const containerLater = mint('Box'); const child = mkt('Leaf');
    both((x) => { x.insertItem(G, box, 'items', later); x.insertItem(G, box, 'items', builtLater); });
    check('two entries with no record');
    both((x) => x.createNode(G, later, 'Leaf')); made.push(later);
    both((x) => x.build(G, { id: builtLater, kind: 'Leaf', fields: { note: 'n' } })); made.push(builtLater);
    check('created and built');
    assert.deepEqual(tree().nestedIds(box).sort(), [later, builtLater].sort());
    both((x) => x.build(G, { id: containerLater, kind: 'Box', fields: { items: [child] } })); made.push(containerLater);
    check('a container built after its item, and an item before its container');
    assert.equal(tree().treeParentOf(child), containerLater);
  });

  test('a refused write and a failed build leave the tree as it was', () => {
    const b1 = mkt('Box'); const b2 = mkt('Box'); const a = mkt('Leaf'); const later = mint('Box');
    both((x) => { x.insertItem(G, b1, 'items', a); x.insertItem(G, b1, 'items', b2); });
    const before = [tree().rootIds(G), tree().nestedIds(b1)];
    bothThrow((x) => x.insertItem(G, b2, 'items', a), refused, 'a second container');
    bothThrow((x) => x.insertItem(G, b2, 'items', b1), refused, 'a cycle');
    bothThrow((x) => x.build(G, { id: later, kind: 'Box', fields: { items: [a] } }), refused, 'a build');
    assert.deepEqual([tree().rootIds(G), tree().nestedIds(b1)], before);
    check('after the refusals');
  });

  test('an embedded node is beneath the node that embeds it, whichever of the two is created first, and goes with its pair', () => {
    const leaf = mkt('Leaf'); const target = mkt('Leaf');
    const r1 = own(leaf, 'refs', 'Ref'); const r2 = own(leaf, 'refs', 'Ref'); const at1 = own(r1, 'attrs', 'Attr');
    both((x) => x.addPair(G, r1, 'to', target));
    check('embedded nodes');
    assert.deepEqual(tree().nestedIds(leaf).sort(), [r1, r2].sort());
    assert.deepEqual(tree().nestedIds(r1), [at1], 'an embedded node embeds in turn');
    assert.deepEqual(tree().rootIds(G), [leaf, target]);
    both((x) => x.removePair(G, leaf, 'refs', r1));
    for (const gone of [r1, at1]) made.splice(made.indexOf(gone), 1);
    check('an embedded node removed with its pair takes the node it embedded');
    const owner = mkt('Leaf');
    const earlyRef = `${owner}:refs:Ref:${'0'.repeat(12)}5`;
    both((x) => x.createNode(G, earlyRef, 'Ref')); made.push(earlyRef);
    check('an embedded node created before its owner holds it is a root');
    both((x) => x.addPair(G, owner, 'refs', earlyRef));
    check('and nests once held');
    assert.equal(tree().treeParentOf(earlyRef), owner);
    const lateOwner = `Leaf:${'0'.repeat(12)}9`;
    const lateRef = `${lateOwner}:refs:Ref:${'0'.repeat(12)}6`;
    both((x) => x.build(G, { id: lateOwner, kind: 'Leaf', fields: { refs: lateRef } })); made.push(lateOwner);
    both((x) => x.build(G, { id: lateRef, kind: 'Ref', fields: {} })); made.push(lateRef);
    check('an embedded node built after its owner nests at its build');
    assert.equal(tree().treeParentOf(lateRef), lateOwner);
    both((x) => x.clearField(G, owner, 'refs'));
    made.splice(made.indexOf(earlyRef), 1);
    check('a clear of the embed field');
  });

  test('a node that is embedded is not listed by a container: the list refuses it, and the node stays beneath its owner', () => {
    const leaf = mkt('Leaf'); const box = mkt('Box');
    const ref = own(leaf, 'refs', 'Ref');
    both((x) => assert.throws(() => x.insertItem(G, box, 'items', ref), refused));
    both((x) => assert.throws(() => x.addPair(G, box, 'items', ref), refused));
    check('listed and embedded');
    assert.equal(tree().treeParentOf(ref), leaf);
    assert.deepEqual(tree().nestedIds(box), []);
    assert.deepEqual(e.items(G, box, 'items'), [], 'the list took nothing');
  });

  test('is shown by no operation of the interface: the reads of it are `inspectEngine`\'s, for the tests', () => {
    assert.ok(!Object.keys(e).some((k) => /^(treeParentOf|nestedIds|rootIds)$/.test(k)), 'no operation of the interface shows the arrangement');
  });
});
