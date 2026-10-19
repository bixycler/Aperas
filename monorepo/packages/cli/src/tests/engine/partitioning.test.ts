// Partitioning fields (planning/core.md, Batch 6 step 2; design/core.md, "Partitioning fields"): the mark is the schema's and
// nothing sets or clears it at run time; the engine refuses, in `addPair`, `insertItem` and `build`, a second value on the
// climbed side (an object has at most one subject in the field, as a node has at most one container) and a cycle. Hand-written
// cases, each given to the engine and the oracle; the random sequences are in `containment.model.test.ts`.
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, inspectEngine, Refused, Undecided } from '@aperas/core/apeironNgn/engine';
import type { Engine } from '@aperas/core/apeironNgn/interface';
import type { SchemaSpec } from '@aperas/core/apeironNgn/schema';
import { Oracle, Refused as OracleRefused, Undecided as OracleUndecided } from '../support/oracle.ts';
import { TEST_SCHEMA } from '../support/engineSchema.ts';

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
/** Everything a reader could tell of the engine over some ids: the records and the reverse of `items` for each. Asking builds the reverse, so read after the checks of what is built. */
const snapshot = (x: Engine, ids: readonly string[]): unknown => ({ records: ids.map((id) => x.record(G, id)), buckets: ids.map((id) => x.subjectsOf(G, 'items', id)) });

beforeEach(() => { e = createEngine(TEST_SCHEMA); o = new Oracle(e.schema); });

describe('a second container', () => {
  test('is refused by insertItem and by addPair, and nothing changes', () => {
    const b1 = mk('Box'); const b2 = mk('Box'); const a = mk('Leaf'); const c = mk('Leaf');
    both((x) => { x.insertItem(G, b1, 'items', a); x.insertItem(G, b2, 'items', c); });
    const before = snapshot(e, [b1, b2, a, c]);
    bothThrow((x) => x.insertItem(G, b2, 'items', a), refused, 'insertItem');
    bothThrow((x) => x.insertItem(G, b2, 'items', a, 0), refused, 'insertItem at a place');
    bothThrow((x) => x.addPair(G, b2, 'items', a), refused, 'addPair');
    assert.deepEqual(snapshot(e, [b1, b2, a, c]), before, 'the refused writes left the engine as it was');
    same((x) => [x.items(G, b1, 'items'), x.items(G, b2, 'items')], [[a], [c]], 'the lists');
    same((x) => x.subjectsOf(G, 'items', a), [b1], 'and the container of a');
  });

  test('is refused when the item\'s record is gone and its container still lists it, and when it never had a record', () => {
    const b1 = mk('Box'); const b2 = mk('Box'); const a = mk('Leaf'); const never = mint('Leaf');
    both((x) => { x.insertItem(G, b1, 'items', a); x.insertItem(G, b1, 'items', never); x.removeNode(G, a); });
    same((x) => x.items(G, b1, 'items'), [a, never], 'the entry of a node removed stays in its container');
    bothThrow((x) => x.insertItem(G, b2, 'items', a), refused, 'a removed item, still listed by b1');
    bothThrow((x) => x.insertItem(G, b2, 'items', never), refused, 'an item with no record, listed by b1');
    both((x) => x.createNode(G, a, 'Leaf'));
    bothThrow((x) => x.addPair(G, b2, 'items', a), refused, 'the same item created again is still b1\'s');
    same((x) => x.items(G, b2, 'items'), [], 'b2 holds nothing');
  });

  test('is free once the first container no longer lists the item: removed from the list, the list cleared, or the container removed', () => {
    const b1 = mk('Box'); const b2 = mk('Box'); const b3 = mk('Box'); const [a, c, d, f] = [mk('Leaf'), mk('Leaf'), mk('Leaf'), mk('Leaf')];
    both((x) => { x.insertItem(G, b1, 'items', a); x.insertItem(G, b1, 'items', c); x.insertItem(G, b3, 'items', d); x.insertItem(G, b3, 'items', f); });
    bothThrow((x) => x.insertItem(G, b2, 'items', a), refused, 'a is in b1');
    both((x) => x.removeItem(G, b1, 'items', a));
    both((x) => x.insertItem(G, b2, 'items', a));
    same((x) => [x.items(G, b1, 'items'), x.items(G, b2, 'items')], [[c], [a]], 'a moved by a removal then an insertion');
    both((x) => x.clearField(G, b1, 'items'));
    both((x) => x.addPair(G, b2, 'items', c));
    same((x) => x.items(G, b2, 'items'), [a, c], 'c is free after a clear');
    both((x) => x.removeNode(G, b3));
    both((x) => { x.insertItem(G, b2, 'items', d); x.addPair(G, b2, 'items', f); });
    same((x) => x.items(G, b2, 'items'), [a, c, d, f], 'the items of a removed container are free');
    both((x) => x.removePair(G, b2, 'items', a));
    both((x) => x.insertItem(G, b1, 'items', a));
    same((x) => x.subjectsOf(G, 'items', a), [b1], 'and removePair frees too');
  });

  test('is not reached by a move inside the list, nor by an item that is already in the list', () => {
    const b1 = mk('Box'); const [a, c] = [mk('Leaf'), mk('Leaf')];
    both((x) => { x.insertItem(G, b1, 'items', a); x.insertItem(G, b1, 'items', c); x.moveItem(G, b1, 'items', c, 0); x.addPair(G, b1, 'items', a); });
    same((x) => x.items(G, b1, 'items'), [c, a], 'moved and added again');
  });
});

describe('a cycle', () => {
  test('of one: a box is not in its own list', () => {
    const b = mk('Box');
    bothThrow((x) => x.insertItem(G, b, 'items', b), refused, 'insertItem');
    bothThrow((x) => x.addPair(G, b, 'items', b), refused, 'addPair');
    same((x) => x.items(G, b, 'items'), [], 'nothing was listed');
  });

  test('of two, of three, and of a long chain: a box into its own descendant', () => {
    const [a, b, c, d] = [mk('Box'), mk('Box'), mk('Box'), mk('Box')];
    both((x) => { x.insertItem(G, a, 'items', b); });
    bothThrow((x) => x.insertItem(G, b, 'items', a), refused, 'a in b in a');
    both((x) => { x.insertItem(G, b, 'items', c); });
    bothThrow((x) => x.insertItem(G, c, 'items', a), refused, 'a in c in b in a');
    bothThrow((x) => x.addPair(G, c, 'items', b), refused, 'b in c in b');
    both((x) => { x.insertItem(G, c, 'items', d); });
    bothThrow((x) => x.insertItem(G, d, 'items', a), refused, 'a chain of four');
    bothThrow((x) => x.insertItem(G, d, 'items', b), refused, 'b is above d');
    same((x) => [a, b, c, d].map((id) => x.items(G, id, 'items')), [[b], [c], [d], []], 'the lists are as they were');
    both((x) => x.removeItem(G, b, 'items', c));
    both((x) => x.insertItem(G, c, 'items', a));
    same((x) => x.items(G, c, 'items'), [d, a], 'the cycle was cut and the move that closed it is now allowed');
  });

  test('through a node whose container waits: a build sees the waiting bucket of the host', () => {
    // `inner` lists `outer`, which is not built yet. Building `outer` with `inner` in its items would close a cycle.
    const inner = mk('Box'); const outer = mint('Box'); const leaf = mint('Leaf');
    both((x) => x.insertItem(G, inner, 'items', outer));
    const before = snapshot(e, [inner, outer, leaf]);
    bothThrow((x) => x.build(G, { id: outer, kind: 'Box', fields: { items: [leaf, inner] } }), refused, 'inner is under outer');
    assert.deepEqual(snapshot(e, [inner, outer, leaf]), before, 'a build that fails changes nothing');
    same((x) => x.record(G, outer), undefined, 'outer was not built');
    both((x) => x.build(G, { id: outer, kind: 'Box', fields: { items: [leaf] } }));
    same((x) => x.subjectsOf(G, 'items', outer), [inner], 'built without it');
  });

  test('a second container is refused by a build, and so is the host itself in its own list', () => {
    const b1 = mk('Box'); const a = mk('Leaf'); const b2 = mint('Box'); const stub = mk('Stub');
    both((x) => x.insertItem(G, b1, 'items', a));
    bothThrow((x) => x.build(G, { id: b2, kind: 'Box', fields: { items: [stub, a] } }), refused, 'a is in b1');
    bothThrow((x) => x.build(G, { id: b2, kind: 'Box', fields: { items: [b2] } }), refused, 'itself');
    same((x) => x.record(G, b2), undefined, 'nothing was built');
    same((x) => x.subjectsOf(G, 'items', a), [b1], 'and a is still b1\'s');
  });
});

describe('the rule is the field\'s and not containment\'s', () => {
  const spec: SchemaSpec = {
    kinds: [
      {
        name: 'Person',
        fields: [
          { name: 'name', storage: 'literal', cardinality: 'optional' },
          { name: 'reports', storage: 'reference', cardinality: 'set', partitioning: true },
          { name: 'sponsor', storage: 'reference', cardinality: 'optional', partitioning: true },
        ],
      },
    ],
  };
  let x: Engine; let y: Oracle;
  const mkp = (): string => { const id = mint('Person'); x.createNode(G, id, 'Person'); y.createNode(G, id, 'Person'); return id; };
  const bothP = (run: (s: Engine) => void): void => { run(x); run(y); };
  const throwsP = (run: (s: Engine) => void, check: (err: unknown) => boolean, why: string): void => {
    assert.throws(() => run(x), check, `engine: ${why}`);
    assert.throws(() => run(y), check, `oracle: ${why}`);
  };
  beforeEach(() => { x = createEngine(spec); y = new Oracle(x.schema); });

  test('a set that is partitioning gives each object one subject, and no cycle', () => {
    const [a, b, c] = [mkp(), mkp(), mkp()];
    bothP((s) => { s.addPair(G, a, 'reports', b); s.addPair(G, a, 'reports', c); });
    throwsP((s) => s.addPair(G, c, 'reports', b), refused, 'a second subject for b');
    throwsP((s) => s.addPair(G, b, 'reports', a), refused, 'a cycle of two');
    throwsP((s) => s.addPair(G, a, 'reports', a), refused, 'itself');
    throwsP((s) => s.addPair(G, b, 'reports', c), refused, 'c is already a\'s');
    for (const s of [x, y]) assert.deepEqual([a, b, c].map((id) => s.values(G, id, 'reports')), [[b, c], [], []], 'and nothing changed');
  });

  test('an optional field that is partitioning: the cardinality is looked at first, then the rule', () => {
    const [a, b, c] = [mkp(), mkp(), mkp()];
    bothP((s) => s.addPair(G, a, 'sponsor', c));
    throwsP((s) => s.addPair(G, b, 'sponsor', c), refused, 'c already has a subject sponsoring it: the climbed side is the reverse');
    throwsP((s) => s.addPair(G, a, 'sponsor', b), undecided('Enforcement'), 'a second value for an optional field is Enforcement\'s, before the rule');
    bothP((s) => s.addPair(G, b, 'sponsor', a));
    throwsP((s) => s.addPair(G, c, 'sponsor', b), refused, 'a cycle of three, b sponsoring a sponsoring c');
  });

  test('the reverse of a partitioning field that is not ordered is built at the first write, like any other', () => {
    const [a, b] = [mkp(), mkp()];
    assert.deepEqual(inspectEngine(x).reversesBuilt(), []);
    throwsP((s) => s.addPair(G, a, 'reports', a), refused, 'a refused first write');
    assert.deepEqual(inspectEngine(x).reversesBuilt(), [], 'builds nothing');
    bothP((s) => s.addPair(G, a, 'reports', b));
    assert.deepEqual(inspectEngine(x).reversesBuilt(), ['reports'], 'the first write built it');
  });
});

describe('the reverse of a partitioning field is built at the first write or the first ask', () => {
  test('not before, not by a refused write, and at the first write of the field', () => {
    const b1 = mk('Box'); const b2 = mk('Box'); const a = mk('Leaf');
    assert.deepEqual(inspectEngine(e).reversesBuilt(), [], 'created nodes build nothing');
    bothThrow((x) => x.insertItem(G, b1, 'items', b1), refused, 'a refused first write');
    bothThrow((x) => x.insertItem(G, b1, 'items', a, 3), refused, 'another');
    assert.deepEqual(inspectEngine(e).reversesBuilt(), [], 'builds nothing');
    both((x) => x.insertItem(G, b1, 'items', a));
    assert.deepEqual(inspectEngine(e).reversesBuilt(), ['items'], 'the first write built it');
    bothThrow((x) => x.insertItem(G, b2, 'items', a), refused, 'and the rule reads it');
  });

  test('the first ask builds it too', () => {
    const b1 = mk('Box'); const a = mk('Leaf');
    assert.deepEqual(e.subjectsOf(G, 'items', a), []);
    assert.deepEqual(inspectEngine(e).reversesBuilt(), ['items'], 'the ask built it');
    both((x) => x.insertItem(G, b1, 'items', a));
    same((x) => x.subjectsOf(G, 'items', a), [b1], 'and the write kept it up');
  });

  test('a build writes the field, so the build builds it', () => {
    const a = mint('Leaf'); const b = mint('Box');
    assert.deepEqual(inspectEngine(e).reversesBuilt(), []);
    both((x) => x.build(G, { id: b, kind: 'Box', fields: { items: [a] } }));
    assert.deepEqual(inspectEngine(e).reversesBuilt(), ['items']);
    same((x) => x.subjectsOf(G, 'items', a), [b], 'the item is in the bucket, with no record of its own');
  });
});

describe('the mark', () => {
  test('is set by the schema at construction, and nothing sets or clears it at run time', () => {
    const items = e.schema.kinds.find((k) => k.name === 'Box')!.fields.find((f) => f.name === 'items')!;
    assert.equal(items.partitioning, true);
    assert.equal(e.schema.kinds.find((k) => k.name === 'Box')!.fields.find((f) => f.name === 'pinned')!.partitioning, false);
    assert.ok(Object.isFrozen(e.schema) && Object.isFrozen(e.schema.kinds) && Object.isFrozen(items), 'the schema is frozen down to the field');
    assert.throws(() => { (items as { partitioning: boolean }).partitioning = false; }, TypeError, 'and a write to the mark throws');
    const offered = Object.keys(e).filter((k) => /partition|mark/i.test(k));
    assert.deepEqual(offered, [], 'the interface offers no operation for it');
    assert.equal(createEngine(TEST_SCHEMA).schema.kinds.find((k) => k.name === 'Box')!.fields.find((f) => f.name === 'items')!.partitioning, true, 'another engine, the same mark');
  });
});
