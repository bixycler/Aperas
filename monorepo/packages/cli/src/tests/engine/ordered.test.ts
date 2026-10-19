// Ordered fields (planning/core.md, Batch 6 step 1; design/core.md, "Ordered fields"): the forward side of an ordered field is the
// list of its host, and its order is the promise. `items` and `placeOf` read it, `insertItem`, `moveItem` and `removeItem` are one
// splice each, and the generic writes (`addPair`, `removePair`, `clearField`, `build`) do on it what the oracle does. Hand-written
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
const sorted = (xs: readonly string[]): string[] => [...xs].sort();
/** What a call gave: its class and open point if it threw, `ok` if not. The engine and the oracle must give the same. */
const outcome = (run: (x: Engine) => unknown): string => {
  try { run(e); } catch (err) {
    const a = err as Error & { point?: string };
    try { run(o); } catch (err2) {
      const b = err2 as Error & { point?: string };
      assert.equal(`${b.name}:${b.point ?? ''}`, `${a.name}:${a.point ?? ''}`, 'the oracle gave another error than the engine');
      return `${a.name}:${a.point ?? ''}`;
    }
    return assert.fail('the engine threw and the oracle did not');
  }
  try { run(o); } catch (err2) { return assert.fail(`the oracle threw ${(err2 as Error).name} and the engine did not`); }
  return 'ok';
};
const undecided = (point: string) => (err: unknown): boolean => (err instanceof Undecided && err.point === point) || (err instanceof OracleUndecided && err.point === point);
const refused = (err: unknown): boolean => err instanceof Refused || err instanceof OracleRefused;
const bothThrow = (run: (x: Engine) => void, check: (err: unknown) => boolean, why: string): void => {
  assert.throws(() => run(e), check, `engine: ${why}`);
  assert.throws(() => run(o), check, `oracle: ${why}`);
};
/** The list of a box and the reads that must agree with it: items, values, first and the place of each item. */
const checkList = (box: string, expected: readonly string[], why: string): void => {
  same((x) => x.items(G, box, 'items'), [...expected], `${why}: items`);
  same((x) => x.values(G, box, 'items'), [...expected], `${why}: values`);
  same((x) => x.first(G, box, 'items'), expected[0], `${why}: first`);
  expected.forEach((item, i) => same((x) => x.placeOf(G, box, 'items', item), i, `${why}: the place of item ${i}`));
};

beforeEach(() => { e = createEngine(TEST_SCHEMA); o = new Oracle(e.schema); });

describe('insertItem', () => {
  test('inserts at the head, in the middle, at the end and, with `at` omitted, at the end; the place of each item is its index after each', () => {
    const box = mk('Box'); const [a, b, c, d, f] = [mk('Leaf'), mk('Leaf'), mk('Stub'), mk('Leaf'), mk('Leaf')];
    both((x) => x.insertItem(G, box, 'items', a));
    checkList(box, [a], 'omitted, on an empty list');
    both((x) => x.insertItem(G, box, 'items', b, 0));
    checkList(box, [b, a], 'at the head');
    both((x) => x.insertItem(G, box, 'items', c, 1));
    checkList(box, [b, c, a], 'in the middle');
    both((x) => x.insertItem(G, box, 'items', d, 3));
    checkList(box, [b, c, a, d], 'at the end, given');
    both((x) => x.insertItem(G, box, 'items', f));
    checkList(box, [b, c, a, d, f], 'omitted again');
  });

  test('an item is in a list at most once: insertItem of it is Refused, addPair of it changes nothing', () => {
    const box = mk('Box'); const [a, b] = [mk('Leaf'), mk('Leaf')];
    both((x) => { x.insertItem(G, box, 'items', a); x.insertItem(G, box, 'items', b); });
    bothThrow((x) => x.insertItem(G, box, 'items', a), refused, 'a second time');
    bothThrow((x) => x.insertItem(G, box, 'items', a, 0), refused, 'at another place');
    both((x) => x.addPair(G, box, 'items', a));
    checkList(box, [a, b], 'addPair of an item already in the list');
  });

  test('the item need not have a record: it is listed, and created later', () => {
    const box = mk('Box'); const later = mint('Leaf');
    both((x) => x.insertItem(G, box, 'items', later));
    checkList(box, [later], 'listed with no record');
    same((x) => x.record(G, later), undefined, 'and has none');
    both((x) => x.createNode(G, later, 'Leaf'));
    checkList(box, [later], 'created');
    same((x) => x.record(G, later)!.id, later, 'now it has one');
  });

  test('a string that is no id is an item all the same: the value is any string', () => {
    const box = mk('Box');
    both((x) => x.insertItem(G, box, 'items', 'not an id'));
    checkList(box, ['not an id'], 'listed');
  });
});

describe('moveItem', () => {
  test('moves forward, back and to its own place, as one splice', () => {
    const box = mk('Box'); const [a, b, c, d] = [mk('Leaf'), mk('Leaf'), mk('Leaf'), mk('Leaf')];
    both((x) => { for (const i of [a, b, c, d]) x.insertItem(G, box, 'items', i); });
    both((x) => x.moveItem(G, box, 'items', a, 2));
    checkList(box, [b, c, a, d], 'forward');
    both((x) => x.moveItem(G, box, 'items', d, 0));
    checkList(box, [d, b, c, a], 'back');
    both((x) => x.moveItem(G, box, 'items', c, 2));
    checkList(box, [d, b, c, a], 'to its own place');
    both((x) => x.moveItem(G, box, 'items', d, 3));
    checkList(box, [b, c, a, d], 'from the head to the end');
  });

  test('the item is in the list and `to` is an index the item can end at, else Refused, and nothing changes', () => {
    const box = mk('Box'); const [a, b, stray] = [mk('Leaf'), mk('Leaf'), mk('Leaf')];
    both((x) => { x.insertItem(G, box, 'items', a); x.insertItem(G, box, 'items', b); });
    bothThrow((x) => x.moveItem(G, box, 'items', stray, 0), refused, 'an item not in the list');
    for (const to of [-1, 2, 1.5, Number.NaN, Infinity]) bothThrow((x) => x.moveItem(G, box, 'items', a, to), refused, `to ${to}`);
    checkList(box, [a, b], 'nothing changed');
  });

  test('a move changes no bucket', () => {
    const box = mk('Box'); const [a, b, c] = [mk('Leaf'), mk('Leaf'), mk('Leaf')];
    both((x) => { for (const i of [a, b, c]) x.insertItem(G, box, 'items', i); });
    same((x) => [a, b, c].map((i) => x.subjectsOf(G, 'items', i)), [[box], [box], [box]], 'built');
    both((x) => x.moveItem(G, box, 'items', c, 0));
    same((x) => [a, b, c].map((i) => x.subjectsOf(G, 'items', i)), [[box], [box], [box]], 'unchanged by a move');
  });
});

describe('removeItem', () => {
  test('takes the item out and keeps the order of the others; the item is detached and its record stays', () => {
    const box = mk('Box'); const [a, b, c] = [mk('Leaf'), mk('Leaf'), mk('Leaf')];
    both((x) => { for (const i of [a, b, c]) x.insertItem(G, box, 'items', i); });
    both((x) => x.removeItem(G, box, 'items', b));
    checkList(box, [a, c], 'removed');
    same((x) => x.placeOf(G, box, 'items', b), undefined, 'it has no place');
    same((x) => x.record(G, b)!.id, b, 'its record is untouched');
    same((x) => x.subjectsOf(G, 'items', b), [], 'and nothing lists it');
    same((x) => x.idsOfKind(G, 'Leaf').sort(), sorted([a, b, c]), 'still in its collection');
  });

  test('an item not in the list is Refused, unlike removePair, which does nothing', () => {
    const box = mk('Box'); const [a, stray] = [mk('Leaf'), mk('Leaf')];
    both((x) => x.insertItem(G, box, 'items', a));
    bothThrow((x) => x.removeItem(G, box, 'items', stray), refused, 'removeItem');
    both((x) => x.removePair(G, box, 'items', stray));
    checkList(box, [a], 'removePair did nothing');
  });

  test('the last item out leaves an empty list with no entry in the record', () => {
    const box = mk('Box'); const a = mk('Leaf');
    both((x) => { x.insertItem(G, box, 'items', a); x.removeItem(G, box, 'items', a); });
    checkList(box, [], 'empty');
    same((x) => x.record(G, box)!.fields, [], 'a node with no value lists no entry');
  });
});

describe('the generic writes on an ordered field', () => {
  test('addPair appends', () => {
    const box = mk('Box'); const [a, b, c] = [mk('Leaf'), mk('Leaf'), mk('Leaf')];
    both((x) => { x.addPair(G, box, 'items', b); x.addPair(G, box, 'items', a); x.addPair(G, box, 'items', c); });
    checkList(box, [b, a, c], 'in the order of the writes');
  });

  test('removePair keeps the order of the others and frees the item; it does nothing for an item that is not there', () => {
    const box = mk('Box'); const [a, b, c] = [mk('Leaf'), mk('Leaf'), mk('Leaf')];
    both((x) => { for (const i of [a, b, c]) x.insertItem(G, box, 'items', i); });
    both((x) => x.removePair(G, box, 'items', a));
    checkList(box, [b, c], 'removed from the head');
    both((x) => x.removePair(G, box, 'items', a));
    checkList(box, [b, c], 'again: nothing changes');
    both((x) => x.insertItem(G, box, 'items', a, 1));
    checkList(box, [b, a, c], 'the freed item is inserted again');
  });

  test('clearField empties the list and takes the host out of the bucket of each item', () => {
    const box = mk('Box'); const [a, b] = [mk('Leaf'), mk('Leaf')];
    both((x) => { x.insertItem(G, box, 'items', a); x.insertItem(G, box, 'items', b); });
    same((x) => [x.subjectsOf(G, 'items', a), x.subjectsOf(G, 'items', b)], [[box], [box]], 'built');
    both((x) => x.clearField(G, box, 'items'));
    checkList(box, [], 'empty');
    same((x) => [x.subjectsOf(G, 'items', a), x.subjectsOf(G, 'items', b)], [[], []], 'out of both buckets');
    same((x) => x.idsOfKind(G, 'Leaf').sort(), sorted([a, b]), 'the records stay');
  });

  test('a write of the field is a clear then an add of each value: the array a caller gives is the order', () => {
    const box = mk('Box'); const [a, b, c] = [mk('Leaf'), mk('Leaf'), mk('Leaf')];
    both((x) => { x.insertItem(G, box, 'items', a); x.insertItem(G, box, 'items', b); });
    both((x) => { x.clearField(G, box, 'items'); for (const v of [c, b, a]) x.addPair(G, box, 'items', v); });
    checkList(box, [c, b, a], 'the new order');
    same((x) => x.record(G, box)!.fields, [{ name: 'items', values: [c, b, a] }], 'and the read-out lists it in order');
  });

  test('a splice inside a list changes no bucket: the buckets are equal before and after an insertion at the head, a move and a removal of other items', () => {
    const box = mk('Box'); const [a, b, c, d] = [mk('Leaf'), mk('Leaf'), mk('Leaf'), mk('Leaf')];
    both((x) => { x.insertItem(G, box, 'items', a); x.insertItem(G, box, 'items', b); x.insertItem(G, box, 'items', c); });
    const buckets = (x: Engine): string[][] => [a, b, c].map((i) => x.subjectsOf(G, 'items', i));
    const before = buckets(e);
    both((x) => x.insertItem(G, box, 'items', d, 0));
    assert.deepEqual(buckets(e), before, 'an insertion at the head');
    both((x) => x.moveItem(G, box, 'items', d, 3));
    assert.deepEqual(buckets(e), before, 'a move');
    both((x) => x.removeItem(G, box, 'items', d));
    assert.deepEqual(buckets(e), before, 'a removal of another item');
    assert.deepEqual(buckets(o), before);
  });
});

describe('the checks and the order of the errors', () => {
  test('a host with no record is Undecided of Existence, for each operation', () => {
    const ghost = mint('Box'); const a = mk('Leaf');
    const ops: [string, (x: Engine) => unknown][] = [
      ['insertItem', (x) => x.insertItem(G, ghost, 'items', a)],
      ['moveItem', (x) => x.moveItem(G, ghost, 'items', a, 0)],
      ['removeItem', (x) => x.removeItem(G, ghost, 'items', a)],
      ['items', (x) => x.items(G, ghost, 'items')],
      ['placeOf', (x) => x.placeOf(G, ghost, 'items', a)],
      ['addPair', (x) => x.addPair(G, ghost, 'items', a)],
      ['removePair', (x) => x.removePair(G, ghost, 'items', a)],
      ['clearField', (x) => x.clearField(G, ghost, 'items')],
    ];
    for (const [name, run] of ops) bothThrow(run as (x: Engine) => void, undecided('Existence'), name);
    same((x) => x.values(G, ghost, 'items'), [], 'values of an absent subject is still empty');
    same((x) => x.first(G, ghost, 'items'), undefined, 'and first');
  });

  test('an unordered field is Refused by items, placeOf and the three splices', () => {
    const leaf = mk('Leaf'); const box = mk('Box'); const a = mk('Leaf');
    for (const [host, field] of [[leaf, 'likes'], [box, 'pinned']] as const) {
      bothThrow((x) => x.items(G, host, field), refused, `items of ${field}`);
      bothThrow((x) => x.placeOf(G, host, field, a), refused, `placeOf of ${field}`);
      bothThrow((x) => x.insertItem(G, host, field, a), refused, `insertItem of ${field}`);
      bothThrow((x) => x.moveItem(G, host, field, a, 0), refused, `moveItem of ${field}`);
      bothThrow((x) => x.removeItem(G, host, field, a), refused, `removeItem of ${field}`);
    }
  });

  test('a literal field that is not ordered, a derived entry and an undeclared field are refused by the shape, not by the order', () => {
    const leaf = mk('Leaf'); const a = mk('Leaf');
    for (const field of ['label', 'up', 'nonsense']) {
      const expected = field === 'label' ? refused : undecided('Enforcement');
      bothThrow((x) => x.items(G, leaf, field), expected, `items of ${field}`);
      bothThrow((x) => x.insertItem(G, leaf, field, a), expected, `insertItem of ${field}`);
      bothThrow((x) => x.moveItem(G, leaf, field, a, 0), expected, `moveItem of ${field}`);
      bothThrow((x) => x.removeItem(G, leaf, field, a), expected, `removeItem of ${field}`);
    }
  });

  test('an item that is not a string is Undecided of Enforcement, after the field is known to be ordered', () => {
    const box = mk('Box'); const leaf = mk('Leaf');
    bothThrow((x) => x.insertItem(G, box, 'items', 4 as unknown as string), undecided('Enforcement'), 'a number');
    bothThrow((x) => x.addPair(G, box, 'items', true), undecided('Enforcement'), 'addPair of a boolean');
    bothThrow((x) => x.insertItem(G, leaf, 'likes', 4 as unknown as string), refused, 'an unordered field is Refused before the item is looked at');
    checkList(box, [], 'nothing was written');
  });

  test('a place that is not an index from 0 to the length is Refused, and the item and the order are looked at first', () => {
    const box = mk('Box'); const [a, b] = [mk('Leaf'), mk('Leaf')];
    both((x) => x.insertItem(G, box, 'items', a));
    for (const at of [-1, 2, 0.5, Number.NaN, Infinity, '0' as unknown as number]) bothThrow((x) => x.insertItem(G, box, 'items', b, at), refused, `at ${String(at)}`);
    both((x) => x.insertItem(G, box, 'items', b, 1));
    checkList(box, [a, b], 'the place equal to the length is the end');
    // two checks apply: the item is not a string and the place is out of range; the item is looked at first.
    assert.equal(outcome((x) => x.insertItem(G, box, 'items', 7 as unknown as string, 99)), 'Undecided:Enforcement');
    // two checks apply: the item is already in the list and the place is out of range; both are Refused.
    assert.equal(outcome((x) => x.insertItem(G, box, 'items', a, 99)), 'Refused:');
    // two checks apply: the host has no record and the field is unordered; Existence is first.
    assert.equal(outcome((x) => x.insertItem(G, mint('Leaf'), 'likes', a)), 'Undecided:Existence');
  });
});

describe('an ordered field that is not partitioning', () => {
  const spec: SchemaSpec = {
    kinds: [
      { name: 'Thing', fields: [{ name: 'name', storage: 'literal', cardinality: 'optional' }] },
      { name: 'Shelf', fields: [{ name: 'slots', storage: 'reference', cardinality: 'ordered', reverse: 'shelvedOn' }] },
    ],
  };

  test('one item sits in the lists of two hosts, and the reverse reads both', () => {
    const x = createEngine(spec); const y = new Oracle(x.schema);
    const s1 = mint('Shelf'); const s2 = mint('Shelf'); const t = mint('Thing'); const u = mint('Thing');
    for (const s of [x, y]) {
      for (const [id, kind] of [[s1, 'Shelf'], [s2, 'Shelf'], [t, 'Thing'], [u, 'Thing']] as const) s.createNode(G, id, kind);
      s.insertItem(G, s1, 'slots', t); s.insertItem(G, s1, 'slots', u); s.insertItem(G, s2, 'slots', u, 0); s.insertItem(G, s2, 'slots', t);
    }
    for (const s of [x, y]) {
      assert.deepEqual(s.items(G, s1, 'slots'), [t, u]);
      assert.deepEqual(s.items(G, s2, 'slots'), [u, t]);
      assert.deepEqual(sorted(s.subjectsOf(G, 'slots', t)), sorted([s1, s2]), 'both hosts list t');
      assert.deepEqual(s.placeOf(G, s2, 'slots', t), 1);
    }
    for (const s of [x, y]) s.removeItem(G, s1, 'slots', t);
    for (const s of [x, y]) assert.deepEqual(s.subjectsOf(G, 'slots', t), [s2], 'one left');
    for (const s of [x, y]) s.removeNode(G, s2);
    for (const s of [x, y]) assert.deepEqual(s.subjectsOf(G, 'slots', t), [], 'a host removed takes its list with it');
    assert.deepEqual(inspectEngine(x).waitingIds(), [], 'and no bucket waits');
  });

  test('a host with thousands of items is removed with its list in one pass, the host leaving the bucket of each item', () => {
    const x = createEngine(spec);
    const shelf = mint('Shelf'); const things = Array.from({ length: 100000 }, () => mint('Thing'));
    x.build(G, { id: shelf, kind: 'Shelf', fields: { slots: things } });
    assert.equal(x.countSubjectsOf(G, 'slots', things[99999]!), 1, 'the reverse is built and the host is in the bucket of the last item');
    const started = performance.now();
    x.removeNode(G, shelf);
    const took = performance.now() - started;
    assert.equal(x.countSubjectsOf(G, 'slots', things[0]!) + x.countSubjectsOf(G, 'slots', things[99999]!), 0, 'the host left every bucket');
    assert.equal(x.record(G, shelf), undefined);
    assert.ok(took < 1000, `the removal took ${took.toFixed(0)} ms, where a splice from the head for each of 100000 items takes seconds`);
  });
});
