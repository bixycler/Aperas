// Pairs and the forward side (planning/core.md, Batch 5 step 1): the values of a reference or embed field are the ids of
// nodes, held on the subject's record beside the literals. Hand-written cases; the random sequences against the oracle,
// with the reverse side, are in `relations.model.test.ts`. The engine and the oracle are given each case and must agree.
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, Refused, Undecided } from '@aperas/core/apeironNgn/engine';
import type { Engine } from '@aperas/core/apeironNgn/interface';
import type { SchemaSpec } from '@aperas/core/apeironNgn/schema';
import { Oracle, Refused as OracleRefused, Undecided as OracleUndecided } from '../support/oracle.ts';
import { TEST_SCHEMA } from '../support/engineSchema.ts';

const G = 'default';
let n = 0;
/** A valid id of a kind, a new one at each call. */
const mint = (kind: string): string => `${kind}:${(++n).toString().padStart(13, '0')}`;
/** The id of a node embedded by `owner` in `field`. */
const embedded = (owner: string, field: string, kind: string): string => `${owner}:${field}:${mint(kind)}`;

let e: Engine;
let o: Oracle;
const mk = (kind: string): string => { const id = mint(kind); e.createNode(G, id, kind); o.createNode(G, id, kind); return id; };
/** A write run on both implementations. */
const both = (run: (x: Engine) => void): void => { run(e); run(o); };

const undecided = (point: string) => (err: unknown): boolean => (err instanceof Undecided && err.point === point) || (err instanceof OracleUndecided && err.point === point);
const refused = (err: unknown): boolean => err instanceof Refused || err instanceof OracleRefused;
/** The same case thrown by both implementations, checked by the same predicate. */
const bothThrow = (run: (x: Engine) => void, check: (err: unknown) => boolean, why: string): void => {
  assert.throws(() => run(e), check, `engine: ${why}`);
  assert.throws(() => run(o), check, `oracle: ${why}`);
};
/** The two implementations answer a read the same way. */
const same = <T>(read: (x: Engine) => T, expected: T, why: string): void => {
  assert.deepEqual(read(e), expected, `engine: ${why}`);
  assert.deepEqual(read(o), expected, `oracle: ${why}`);
};

beforeEach(() => { e = createEngine(TEST_SCHEMA); o = new Oracle(e.schema); });

describe('a pair of a reference field', () => {
  test('is added, read and added again, an inherited field included', () => {
    const a = mk('Leaf'); const b = mk('Leaf'); const s = mk('Stub');
    both((x) => { x.addPair(G, a, 'likes', b); x.addPair(G, a, 'likes', b); x.addPair(G, s, 'likes', a); });
    same((x) => x.values(G, a, 'likes'), [b], 'added twice is one pair');
    same((x) => x.first(G, a, 'likes'), b, 'first');
    same((x) => x.values(G, s, 'likes'), [a], 'a Stub inherits likes from Leaf');
    same((x) => x.first(G, b, 'likes'), undefined, 'a field with no value');
    same((x) => x.values(G, b, 'likes'), [], 'a field with no value');
  });

  test('a set takes several values, in the order of insertion for a reader that wants one', () => {
    const a = mk('Leaf'); const b = mk('Leaf'); const c = mk('Stub'); const d = mk('Box');
    both((x) => { x.addPair(G, a, 'likes', b); x.addPair(G, a, 'likes', c); x.addPair(G, a, 'likes', d); });
    same((x) => [...x.values(G, a, 'likes')].sort(), [b, c, d].sort(), 'three values');
    same((x) => x.first(G, a, 'likes'), b, 'first of a set');
  });

  test('values is a copy', () => {
    const a = mk('Leaf'); const b = mk('Leaf');
    e.addPair(G, a, 'likes', b);
    e.values(G, a, 'likes').push('x');
    assert.deepEqual(e.values(G, a, 'likes'), [b]);
  });

  test('an optional and a one field refuse a second, different value; a clear then an add replaces it', () => {
    const a = mk('Leaf'); const b = mk('Leaf'); const c = mk('Leaf');
    const ref = embedded(a, 'refs', 'Ref'); const t1 = mk('Leaf'); const t2 = mk('Leaf');
    both((x) => { x.addPair(G, a, 'mate', b); x.addPair(G, a, 'mate', b); });
    same((x) => x.values(G, a, 'mate'), [b], 'the same value again changes nothing');
    bothThrow((x) => x.addPair(G, a, 'mate', c), undecided('Enforcement'), 'a second value for an optional field');
    both((x) => { x.clearField(G, a, 'mate'); x.addPair(G, a, 'mate', c); });
    same((x) => x.values(G, a, 'mate'), [c], 'a write is a clear and then an add');
    both((x) => { x.createNode(G, ref, 'Ref'); x.addPair(G, ref, 'to', t1); });
    bothThrow((x) => x.addPair(G, ref, 'to', t2), undecided('Enforcement'), 'a second value for a one field');
    both((x) => x.clearField(G, ref, 'to'));
    same((x) => x.values(G, ref, 'to'), [], 'a one field may be left with no value');
  });

  test('a reference to a node that has no record, and one from a node to itself, are accepted', () => {
    const a = mk('Leaf');
    const gone = mint('Leaf');
    both((x) => { x.addPair(G, a, 'likes', gone); x.addPair(G, a, 'likes', a); x.addPair(G, a, 'mate', a); });
    same((x) => [...x.values(G, a, 'likes')].sort(), [a, gone].sort(), 'a missing target and the node itself');
    same((x) => x.values(G, a, 'mate'), [a], 'itself');
    same((x) => x.record(G, gone), undefined, 'the target has still no record');
  });

  test('a reference value is any string: no kind is checked for the target, and a string that is no id is taken', () => {
    const a = mk('Leaf');
    both((x) => { x.addPair(G, a, 'likes', mint('Loose')); x.addPair(G, a, 'likes', 'not an id'); });
    same((x) => x.values(G, a, 'likes').length, 2, 'two values');
  });

  test('a value that is not a string is Undecided of Enforcement', () => {
    const a = mk('Leaf');
    for (const bad of [4, true, {}, null]) {
      bothThrow((x) => x.addPair(G, a, 'likes', bad as unknown as string), undecided('Enforcement'), `${JSON.stringify(bad)} for a reference field`);
      bothThrow((x) => x.removePair(G, a, 'likes', bad as unknown as string), undecided('Enforcement'), `${JSON.stringify(bad)} removed`);
    }
    bothThrow((x) => x.addPair(G, a, 'refs', 4 as unknown as string), undecided('Enforcement'), 'a number for an embed field');
  });
});

describe('a pair of an embed field', () => {
  test('takes the id of a node the subject embeds in that field, whether or not the node exists yet', () => {
    const a = mk('Leaf');
    const r1 = embedded(a, 'refs', 'Ref'); const r2 = embedded(a, 'refs', 'Ref');
    both((x) => { x.addPair(G, a, 'refs', r1); x.createNode(G, r2, 'Ref'); x.addPair(G, a, 'refs', r2); });
    same((x) => [...x.values(G, a, 'refs')].sort(), [r1, r2].sort(), 'both are held');
    same((x) => x.record(G, r1), undefined, 'a node need not exist before it is named');
  });

  test('an id that is another owner\'s, another field\'s, or no embedded id at all is Refused', () => {
    const a = mk('Leaf'); const b = mk('Leaf'); const ref = embedded(a, 'refs', 'Ref');
    both((x) => x.createNode(G, ref, 'Ref'));
    const nested = embedded(ref, 'attrs', 'Attr');
    const cases: [string, string][] = [
      ['another owner', embedded(b, 'refs', 'Ref')],
      ['the owner itself', mint('Ref')],
      ['another field', embedded(a, 'attrs', 'Ref')],
      ['a string that is no id', 'refs'],
      ['a deeper node of the subject', nested],
      ['an id of the subject', a],
    ];
    for (const [why, value] of cases) bothThrow((x) => x.addPair(G, a, 'refs', value), refused, why);
    same((x) => x.values(G, a, 'refs'), [], 'nothing was added');
  });

  test('an embedded id of another kind than the field embeds is Undecided of Enforcement', () => {
    const a = mk('Leaf');
    bothThrow((x) => x.addPair(G, a, 'refs', embedded(a, 'refs', 'Attr')), undecided('Enforcement'), 'an Attr in refs, which embeds Ref');
    bothThrow((x) => x.addPair(G, a, 'refs', embedded(a, 'refs', 'Leaf')), undecided('Enforcement'), 'a Leaf in refs');
  });

  test('the embedded kind or one of its descendants is taken', () => {
    const spec: SchemaSpec = {
      kinds: [
        { name: 'Part', fields: [] },
        { name: 'SubPart', extends: 'Part', fields: [] },
        { name: 'SubSubPart', extends: 'SubPart', fields: [] },
        { name: 'Other', fields: [] },
        { name: 'Holder', fields: [{ name: 'parts', storage: 'embed', cardinality: 'set', embeds: 'Part' }] },
      ],
    };
    const x = createEngine(spec); const oracle = new Oracle(x.schema);
    const h = mint('Holder');
    x.createNode(G, h, 'Holder'); oracle.createNode(G, h, 'Holder');
    for (const kind of ['Part', 'SubPart', 'SubSubPart']) {
      const id = embedded(h, 'parts', kind);
      x.addPair(G, h, 'parts', id); oracle.addPair(G, h, 'parts', id);
      assert.ok(x.values(G, h, 'parts').includes(id), kind);
    }
    assert.throws(() => x.addPair(G, h, 'parts', embedded(h, 'parts', 'Other')), undecided('Enforcement'));
    assert.throws(() => oracle.addPair(G, h, 'parts', embedded(h, 'parts', 'Other')), undecided('Enforcement'));
    assert.equal(x.values(G, h, 'parts').length, 3);
  });

  test('a nested embedded id names its owner, which is itself embedded', () => {
    const a = mk('Leaf'); const ref = embedded(a, 'refs', 'Ref'); const attr = embedded(ref, 'attrs', 'Attr');
    both((x) => { x.createNode(G, ref, 'Ref'); x.addPair(G, a, 'refs', ref); x.createNode(G, attr, 'Attr'); x.addPair(G, ref, 'attrs', attr); });
    same((x) => x.values(G, ref, 'attrs'), [attr], 'the Attr is held by the Ref');
    bothThrow((x) => x.addPair(G, a, 'attrs', attr), undecided('Enforcement'), 'the Leaf declares no attrs');
  });
});

describe('removePair', () => {
  test('removes a value, leaves the others and the order of the rest, and does nothing for a pair that is not there', () => {
    const a = mk('Leaf'); const b = mk('Leaf'); const c = mk('Leaf'); const d = mk('Leaf');
    both((x) => { x.addPair(G, a, 'likes', b); x.addPair(G, a, 'likes', c); x.addPair(G, a, 'likes', d); x.removePair(G, a, 'likes', c); });
    same((x) => x.values(G, a, 'likes'), [b, d], 'c is gone');
    both((x) => { x.removePair(G, a, 'likes', c); x.removePair(G, a, 'likes', mint('Leaf')); });
    same((x) => x.values(G, a, 'likes'), [b, d], 'a pair that is not there changes nothing');
    both((x) => { x.removePair(G, a, 'likes', b); x.removePair(G, a, 'likes', d); });
    same((x) => x.values(G, a, 'likes'), [], 'a field left with no value');
    same((x) => x.record(G, a)!.fields, [], 'and no entry in the record');
  });

  test('takes a literal value as well', () => {
    const a = mk('Leaf'); const bag = mk('Leaf');
    both((x) => { x.addPair(G, a, 'rank', 3); x.addPair(G, bag, 'label', 'x'); x.removePair(G, a, 'rank', 3); x.removePair(G, bag, 'label', 'y'); });
    same((x) => x.values(G, a, 'rank'), [], 'removed');
    same((x) => x.values(G, bag, 'label'), ['x'], 'another value stays');
  });

  test('a pair of an embed field is removed without the check of the embedded id', () => {
    const a = mk('Leaf');
    both((x) => x.removePair(G, a, 'refs', 'no id at all'));
    same((x) => x.values(G, a, 'refs'), [], 'nothing there, nothing removed');
  });

  test('the Existence and Enforcement cases are Undecided of the right point, for each write', () => {
    const a = mk('Leaf'); const gone = mint('Leaf');
    for (const [name, run] of [
      ['addPair', (x: Engine) => x.addPair(G, gone, 'likes', a)],
      ['removePair', (x: Engine) => x.removePair(G, gone, 'likes', a)],
      ['clearField', (x: Engine) => x.clearField(G, gone, 'likes')],
    ] as const) bothThrow(run, undecided('Existence'), `${name} of a subject with no record`);
    for (const [name, run] of [
      ['addPair of an undeclared field', (x: Engine) => x.addPair(G, a, 'nonsense', a)],
      ['removePair of an undeclared field', (x: Engine) => x.removePair(G, a, 'nonsense', a)],
      ['clearField of an undeclared field', (x: Engine) => x.clearField(G, a, 'nonsense')],
      ['addPair of a derived entry', (x: Engine) => x.addPair(G, a, 'up', a)],
      ['removePair of a derived entry', (x: Engine) => x.removePair(G, a, 'up', a)],
      ['clearField of a derived entry', (x: Engine) => x.clearField(G, a, 'up')],
      ['addPair of a field of another kind', (x: Engine) => x.addPair(G, a, 'pinned', a)],
      ['removePair of a field of another kind', (x: Engine) => x.removePair(G, a, 'pinned', a)],
    ] as const) bothThrow(run, undecided('Enforcement'), name);
  });
});

describe('clearField', () => {
  test('on a reference field removes each value', () => {
    const a = mk('Leaf'); const b = mk('Leaf'); const c = mk('Leaf');
    both((x) => { x.addPair(G, a, 'likes', b); x.addPair(G, a, 'likes', c); x.clearField(G, a, 'likes'); x.clearField(G, a, 'likes'); });
    same((x) => x.values(G, a, 'likes'), [], 'cleared, and a second clear changes nothing');
    both((x) => x.addPair(G, a, 'likes', b));
    same((x) => x.values(G, a, 'likes'), [b], 'a clear then an add');
  });

  test('on a field that holds nothing does nothing, and leaves the other fields alone', () => {
    const a = mk('Leaf'); const b = mk('Leaf');
    both((x) => { x.addPair(G, a, 'label', 'L'); x.addPair(G, a, 'mate', b); x.clearField(G, a, 'likes'); });
    same((x) => x.record(G, a)!.fields.map((f) => f.name), ['label', 'mate'], 'the other fields stay');
  });
});

describe('the read-out of the pairs', () => {
  test('record lists the reference and embed fields that hold a value, in the schema\'s order, the values being ids', () => {
    const a = mk('Leaf'); const b = mk('Leaf'); const ref = embedded(a, 'refs', 'Ref');
    both((x) => { x.addPair(G, a, 'mate', b); x.addPair(G, a, 'label', 'L'); x.addPair(G, a, 'refs', ref); x.addPair(G, a, 'likes', b); x.addPair(G, a, 'note', 'n'); });
    const names = (x: Engine): string[] => x.record(G, a)!.fields.map((f) => f.name);
    assert.deepEqual(names(e), ['label', 'refs', 'note', 'likes', 'mate'], 'Entity, Node, then Leaf: the order of Leaf\'s fields');
    assert.deepEqual(names(o), names(e));
    assert.deepEqual(e.record(G, a)!.fields.find((f) => f.name === 'refs')!.values, [ref]);
    assert.deepEqual(e.record(G, a), o.record(G, a));
  });

  test('a read of an absent subject or of a field the kind does not declare is empty', () => {
    const a = mk('Loose');
    same((x) => x.values(G, mint('Leaf'), 'likes'), [], 'an absent subject');
    same((x) => x.first(G, mint('Leaf'), 'likes'), undefined, 'an absent subject, first');
    same((x) => x.values(G, a, 'likes'), [], 'a field Loose does not declare');
    same((x) => x.first(G, a, 'likes'), undefined, 'first of it');
  });
});

describe('an ordered field and a derived entry', () => {
  test('the pairs of an ordered field are in `ordered.test.ts`; a derived entry holds no pair and is read from the reverse side', () => {
    const box = mk('Box'); const leaf = mk('Leaf');
    assert.doesNotThrow(() => e.addPair(G, box, 'items', leaf));
    assert.deepEqual(e.values(G, box, 'items'), [leaf]);
    assert.deepEqual(e.values(G, leaf, 'up'), [box], 'the container of a node');
    assert.throws(() => e.addPair(G, leaf, 'up', box), undecided('Enforcement'), 'a derived entry holds no pair');
    assert.throws(() => e.removePair(G, leaf, 'up', box), undecided('Enforcement'));
    assert.throws(() => e.clearField(G, leaf, 'up'), undecided('Enforcement'));
    assert.doesNotThrow(() => e.addPair(G, box, 'pinned', leaf));
  });
});
