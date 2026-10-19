// The oracle checked by hand (planning/core.md, Batch 3 step 4): nothing else checks it, and every later batch tests
// the engine against it. A few hand-written cases for the meanings the design states in full: a pair and its
// reverse, an ordered splice with containment, a tombstone, embedded nodes, a value dropped with its target, several
// graphs and the build; and the meanings the design leaves open, which throw "undecided: <Open point>".
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '@aperas/core/apeironNgn/engine';
import { APERAS_SCHEMA } from '@aperas/core/shell/aperasSchema';
import { Oracle, NotBuilt, Refused, Undecided } from '../support/oracle.ts';
import { TEST_SCHEMA } from '../support/engineSchema.ts';

const G = 'default';
let o: Oracle;
const mk = (kind: string, n: string, graph = G): string => { const id = `${kind}:${n.toUpperCase().replace(/[ILOU]/g, (c) => ({ I: '1', L: '2', O: '3', U: '4' })[c]!).padStart(13, '0')}`; o.createNode(graph, id, kind); return id; };
const sorted = (xs: readonly unknown[]): unknown[] => [...xs].sort();
const undecided = (point: string) => (e: unknown): boolean => e instanceof Undecided && e.point === point && e.message === `undecided: ${point}`;

beforeEach(() => { o = new Oracle(createEngine(TEST_SCHEMA).schema); });

describe('the oracle: a pair and its reverse', () => {
  test('a pair is read forward and in reverse, and adding it again changes nothing', () => {
    const a = mk('Leaf', 'A'); const b = mk('Leaf', 'B'); const c = mk('Leaf', 'C');
    o.addPair(G, a, 'likes', b); o.addPair(G, a, 'likes', c); o.addPair(G, c, 'likes', b); o.addPair(G, a, 'likes', b);
    assert.deepEqual(sorted(o.values(G, a, 'likes')), [b, c]);
    assert.deepEqual(sorted(o.subjectsOf(G, 'likes', b)), [a, c]);
    assert.equal(o.countSubjectsOf(G, 'likes', b), 2);
    assert.ok([a, c].includes(o.firstSubjectOf(G, 'likes', b)!));
    assert.equal(o.countSubjectsOf(G, 'likes', a), 0);
    assert.equal(o.firstSubjectOf(G, 'likes', a), undefined);
  });

  test('a literal is a property, single-valued: the first or only value', () => {
    const a = mk('Leaf', 'A');
    o.addPair(G, a, 'label', 'one'); o.addPair(G, a, 'rank', 1); o.addPair(G, a, 'flag', false);
    assert.equal(o.first(G, a, 'label'), 'one');
    assert.equal(o.first(G, a, 'rank'), 1);
    assert.equal(o.first(G, a, 'flag'), false);
    assert.equal(o.first(G, a, 'note'), undefined);
    o.addPair(G, a, 'label', 'one'); // the same value: nothing changes
    o.clearField(G, a, 'label');
    o.addPair(G, a, 'label', 'two');
    assert.deepEqual(o.values(G, a, 'label'), ['two']);
  });

  test('removing a node removes its pairs and leaves the incoming reference, which is then dangling', () => {
    const a = mk('Leaf', 'A'); const b = mk('Leaf', 'B');
    o.addPair(G, a, 'mate', b); o.addPair(G, b, 'likes', a); o.addPair(G, b, 'label', 'b');
    o.removeNode(G, b);
    assert.deepEqual(o.values(G, b, 'likes'), []);
    assert.equal(o.record(G, b), undefined);
    assert.deepEqual(o.values(G, a, 'mate'), [b], 'other incoming references are not removed');
    assert.deepEqual(o.danglingRefs(G), [b]);
    assert.deepEqual(o.idsOfKind(G, 'Leaf'), [a]);
  });

  test('the ids of a kind come in the order of insertion, for that kind only', () => {
    const l2 = mk('Leaf', 'Z'); const s = mk('Stub', 'M'); const l1 = mk('Leaf', 'A');
    assert.deepEqual(o.idsOfKind(G, 'Leaf'), [l2, l1]);
    assert.deepEqual(o.idsOfKind(G, 'Stub'), [s]);
  });

  test('an id is unique across all graphs', () => {
    o.createGraph('other');
    mk('Leaf', 'A');
    assert.throws(() => o.createNode('other', 'Leaf:000000000000A', 'Leaf'), Refused);
    assert.throws(() => o.createNode(G, 'Leaf:000000000000B', 'Nowhere'), Refused);
  });
});

describe('the oracle: an ordered field and containment', () => {
  test('a splice inserts, moves and removes, and the place of an item is its index', () => {
    const box = mk('Box', 'B'); const x = mk('Leaf', 'X'); const y = mk('Leaf', 'Y'); const z = mk('Leaf', 'Z'); const w = mk('Leaf', 'W');
    o.insertItem(G, box, 'items', x); o.insertItem(G, box, 'items', y); o.insertItem(G, box, 'items', z, 0); o.insertItem(G, box, 'items', w, 1);
    assert.deepEqual(o.items(G, box, 'items'), [z, w, x, y]);
    assert.deepEqual(o.values(G, box, 'items'), [z, w, x, y], 'the values of an ordered field come in order');
    assert.equal(o.first(G, box, 'items'), z);
    assert.equal(o.placeOf(G, box, 'items', x), 2);
    o.moveItem(G, box, 'items', z, 3);
    assert.deepEqual(o.items(G, box, 'items'), [w, x, y, z]);
    o.moveItem(G, box, 'items', y, 0);
    assert.deepEqual(o.items(G, box, 'items'), [y, w, x, z]);
    o.removeItem(G, box, 'items', w);
    assert.deepEqual(o.items(G, box, 'items'), [y, x, z]);
    assert.equal(o.placeOf(G, box, 'items', w), undefined);
    assert.deepEqual(o.idsOfKind(G, 'Leaf').includes(w), true, 'taking an item out detaches it and does not delete it');
    assert.throws(() => o.insertItem(G, box, 'items', x), Refused, 'an item appears at most once');
    assert.throws(() => o.insertItem(G, box, 'items', w, 4), Refused);
    assert.throws(() => o.moveItem(G, box, 'items', w, 0), Refused);
    assert.throws(() => o.removeItem(G, box, 'items', w), Refused);
  });

  test('a splice in a list that holds other lists in the array keeps each list apart', () => {
    const b1 = mk('Box', '1'); const b2 = mk('Box', '2'); const x = mk('Leaf', 'X'); const y = mk('Leaf', 'Y'); const z = mk('Leaf', 'Z'); const w = mk('Leaf', 'W');
    o.insertItem(G, b1, 'items', x); o.insertItem(G, b2, 'items', y); o.insertItem(G, b1, 'items', z); o.insertItem(G, b2, 'items', w, 0);
    assert.deepEqual(o.items(G, b1, 'items'), [x, z]);
    assert.deepEqual(o.items(G, b2, 'items'), [w, y]);
  });

  test('the parent is read from the reverse of the containment field, as a derived entry', () => {
    const box = mk('Box', 'B'); const x = mk('Leaf', 'X');
    o.insertItem(G, box, 'items', x);
    assert.deepEqual(o.values(G, x, 'up'), [box]);
    assert.equal(o.first(G, x, 'up'), box);
    o.removeItem(G, box, 'items', x);
    assert.deepEqual(o.values(G, x, 'up'), []);
  });

  test('a node is in at most one container, and containment has no cycle', () => {
    const b1 = mk('Box', '1'); const b2 = mk('Box', '2'); const x = mk('Leaf', 'X');
    o.insertItem(G, b1, 'items', x);
    assert.throws(() => o.insertItem(G, b2, 'items', x), Refused, 'while the node is still in another list');
    assert.throws(() => o.addPair(G, b2, 'items', x), Refused);
    o.removeItem(G, b1, 'items', x);
    o.insertItem(G, b2, 'items', x); // moved to another container: a removal and an insertion
    assert.deepEqual(o.items(G, b2, 'items'), [x]);
    o.insertItem(G, b1, 'items', b2);
    assert.throws(() => o.insertItem(G, b2, 'items', b1), Refused, 'a cycle');
    assert.throws(() => o.insertItem(G, b1, 'items', b1), Refused, 'a node under itself');
    assert.deepEqual(o.items(G, b2, 'items'), [x]);
  });

  test('an add on an ordered field appends', () => {
    const box = mk('Box', 'B'); const x = mk('Leaf', 'X'); const y = mk('Leaf', 'Y');
    o.addPair(G, box, 'items', x); o.addPair(G, box, 'items', y); o.addPair(G, box, 'items', x);
    assert.deepEqual(o.items(G, box, 'items'), [x, y]);
  });

  test('items and places are asked of an ordered field only', () => {
    const a = mk('Leaf', 'A');
    assert.throws(() => o.items(G, a, 'likes'), Refused);
  });
});

describe('the oracle: tombstones', () => {
  test('a tombstone keeps its literals, loses its references and its place in its container', () => {
    const box = mk('Box', 'B'); const x = mk('Leaf', 'X'); const y = mk('Leaf', 'Y');
    o.insertItem(G, box, 'items', x); o.insertItem(G, box, 'items', y);
    o.addPair(G, x, 'label', 'x'); o.addPair(G, x, 'note', 'n'); o.addPair(G, x, 'rank', 3); o.addPair(G, x, 'likes', y); o.addPair(G, x, 'mate', y);
    const ref = 'Leaf:000000000000X:refs:Ref:00000000000R1';
    o.createNode(G, ref, 'Ref'); o.addPair(G, x, 'refs', ref); o.addPair(G, ref, 'to', y);
    o.tombstone(G, x, '2026-10-16T00:00:00Z');
    assert.deepEqual(o.items(G, box, 'items'), [y], 'a container lists live nodes only');
    assert.deepEqual(o.values(G, x, 'up'), []);
    assert.deepEqual(o.values(G, x, 'likes'), []);
    assert.deepEqual(o.values(G, x, 'mate'), []);
    assert.deepEqual(o.values(G, x, 'refs'), []);
    assert.equal(o.record(G, ref), undefined, 'the embedded node goes with it');
    assert.deepEqual(o.record(G, x)!.fields, [{ name: 'label', values: ['x'] }, { name: 'retiredAt', values: ['2026-10-16T00:00:00Z'] }, { name: 'note', values: ['n'] }, { name: 'rank', values: [3] }]);
    o.tombstone(G, x, 'later');
    assert.equal(o.first(G, x, 'retiredAt'), '2026-10-16T00:00:00Z', 'the first timestamp stays');
  });

  test('a tombstone catches incoming references: they stay', () => {
    const x = mk('Leaf', 'X'); const y = mk('Leaf', 'Y');
    o.addPair(G, y, 'mate', x);
    o.tombstone(G, x, 't');
    assert.deepEqual(o.values(G, y, 'mate'), [x]);
    assert.deepEqual(o.danglingRefs(G), []);
  });

  test('a subtree over containment is tombstoned', () => {
    const top = mk('Box', 'T'); const mid = mk('Box', 'M'); const leaf = mk('Leaf', 'L'); const other = mk('Leaf', 'O');
    o.insertItem(G, top, 'items', mid); o.insertItem(G, mid, 'items', leaf); o.insertItem(G, top, 'items', other);
    o.tombstoneSubtree(G, mid, 'T1');
    assert.equal(o.first(G, mid, 'retiredAt'), 'T1');
    assert.equal(o.first(G, leaf, 'retiredAt'), 'T1');
    assert.equal(o.first(G, other, 'retiredAt'), undefined);
    assert.equal(o.first(G, top, 'retiredAt'), undefined);
    assert.deepEqual(o.items(G, top, 'items'), [other]);
    assert.deepEqual(o.items(G, mid, 'items'), []);
  });
});

describe('the oracle: tombstones of a subtree', () => {
  test('a member whose kind holds no marker refuses the whole, with nothing changed', () => {
    const top = mk('Box', 'T'); const early = mk('Leaf', 'E'); const loose = mk('Loose', 'L'); const late = mk('Leaf', 'Z');
    o.insertItem(G, top, 'items', early); o.insertItem(G, top, 'items', loose); o.insertItem(G, top, 'items', late);
    const before = [top, early, loose, late].map((id) => o.record(G, id));
    assert.throws(() => o.tombstoneSubtree(G, top, 'T1'), Refused);
    assert.deepEqual([top, early, loose, late].map((id) => o.record(G, id)), before, 'the member before the Loose is not tombstoned either');
  });

  test('an entry naming no record is skipped, and a member that is a tombstone keeps its stamp', () => {
    const top = mk('Box', 'T'); const dead = mk('Leaf', 'D'); const live = mk('Leaf', 'V');
    o.insertItem(G, top, 'items', 'Leaf:0000000000GST'); o.insertItem(G, top, 'items', dead); o.insertItem(G, top, 'items', live);
    o.tombstone(G, dead, 'early');
    o.tombstoneSubtree(G, top, 'late');
    assert.deepEqual([top, dead, live].map((id) => o.first(G, id, 'retiredAt')), ['late', 'early', 'late']);
  });

  test('the role comes first, then the record', () => {
    const noRole = new Oracle(createEngine({ kinds: TEST_SCHEMA.kinds }).schema);
    assert.throws(() => noRole.tombstoneSubtree(G, 'Box:0000000000GST', 't'), Refused);
    assert.throws(() => o.tombstoneSubtree(G, 'Box:0000000000GST', 't'), undecided('Existence'));
  });
});

describe('the oracle: the sweep', () => {
  const dead = (kind: string, n: string): string => { const id = mk(kind, n); o.tombstone(G, id, 'T0'); return id; };
  /** A `Ref` owned by `owner` in `refs`, naming `to`. */
  const refTo = (owner: string, n: string, to: string): string => { const r = `${owner}:refs:Ref:${n.padStart(13, '0')}`; o.createNode(G, r, 'Ref'); o.addPair(G, owner, 'refs', r); o.addPair(G, r, 'to', to); return r; };

  test('a tombstone that nothing reaches is swept and returned, and a reached one is kept', () => {
    const box = mk('Box', 'B'); const kept = dead('Leaf', 'K'); const gone = dead('Leaf', 'G'); const viaRef = dead('Stub', 'S');
    o.insertItem(G, box, 'items', kept); refTo(box, '1', viaRef);
    assert.deepEqual(o.sweep(G), [gone]);
    assert.deepEqual([kept, gone, viaRef].map((id) => o.record(G, id) !== undefined), [true, false, true]);
    assert.deepEqual(o.sweep(G), [], 'a second sweep finds nothing');
  });

  test('a field that is not followed does not reach: a likes and a mate', () => {
    const box = mk('Box', 'B'); const a = dead('Leaf', 'A'); const b = dead('Leaf', 'C'); const watcher = mk('Leaf', 'W');
    o.insertItem(G, box, 'items', watcher); o.addPair(G, watcher, 'likes', a); o.addPair(G, watcher, 'mate', b);
    assert.deepEqual(o.sweep(G), [a, b]);
    assert.deepEqual(o.values(G, watcher, 'likes'), [a], 'the reference stays, naming no record');
  });

  test('the mark goes through a tombstone: a chain keeps both, and an island of two or of three is swept', () => {
    const box = mk('Box', 'B'); const t1 = dead('Leaf', 'T1'); const t2 = dead('Leaf', 'T2');
    o.insertItem(G, box, 'items', t1); refTo(t1, '1', t2);
    const i1 = dead('Leaf', 'I1'); const i2 = dead('Leaf', 'I2'); const j1 = dead('Leaf', 'J1'); const j2 = dead('Leaf', 'J2'); const j3 = dead('Leaf', 'J3');
    refTo(i1, '1', i2); refTo(i2, '1', i1); refTo(j1, '1', j2); refTo(j2, '1', j3); refTo(j3, '1', j1);
    assert.deepEqual(o.sweep(G), [i1, i2, j1, j2, j3].sort());
    assert.ok(o.record(G, t1) && o.record(G, t2), 'the chain is kept');
  });

  test('a tombstone referenced only by a live node that is no root and in no followed field is swept', () => {
    const lone = mk('Leaf', 'L'); const t = dead('Leaf', 'T');
    refTo(lone, '1', t);
    assert.deepEqual(o.sweep(G), [t]);
  });

  test('a swept tombstone takes its pairs, its embedded nodes and the entries that name it in a field dropped with its target', () => {
    const box = mk('Box', 'B'); const t = dead('Leaf', 'T'); const other = mk('Leaf', 'O');
    o.addPair(G, box, 'pinned', t); o.addPair(G, box, 'pinned', other); o.addPair(G, t, 'likes', other);
    const r = refTo(t, '1', other);
    assert.deepEqual(o.sweep(G), [t]);
    assert.deepEqual(o.values(G, box, 'pinned'), [other]);
    assert.deepEqual([o.record(G, r), o.subjectsOf(G, 'likes', other), o.subjectsOf(G, 'to', other)], [undefined, [], []]);
  });

  test('the roots include the kinds below a root kind', () => {
    const spec = {
      kinds: [
        { name: 'Base', fields: [{ name: 'gone', storage: 'literal', cardinality: 'optional' }, { name: 'kids', storage: 'reference', cardinality: 'set' }] },
        { name: 'Sub', extends: 'Base', fields: [] },
        { name: 'Other', extends: 'Base', fields: [] },
      ],
      roles: { tombstone: 'gone', sweep: { roots: ['Base'], follow: ['kids'] } },
    } as const;
    const x = new Oracle(createEngine(spec).schema);
    const [sub, other, a, b] = ['Sub:00000000000A1', 'Other:00000000000B1', 'Other:00000000000C1', 'Other:00000000000D1'];
    for (const [id, kind] of [[sub, 'Sub'], [other, 'Other'], [a, 'Other'], [b, 'Other']] as const) x.createNode(G, id, kind);
    x.tombstone(G, a, 'T'); x.tombstone(G, b, 'T');
    x.addPair(G, sub, 'kids', a);
    assert.deepEqual(x.sweep(G), [b], 'a live Sub reaches a, and the live Other is a root too');
  });

  test('the refusals, in their order: the graph, the sweep, the marker', () => {
    const none = new Oracle(createEngine({ kinds: TEST_SCHEMA.kinds }).schema);
    assert.throws(() => none.sweep('elsewhere'), /no graph/);
    assert.throws(() => none.sweep(G), /no sweep/);
    const noMarker = new Oracle(createEngine({ kinds: TEST_SCHEMA.kinds, roles: { sweep: { roots: ['Box'], follow: ['items'] } } }).schema);
    assert.throws(() => noMarker.sweep(G), /no tombstone marker/);
    assert.throws(() => o.sweep('elsewhere'), Refused);
  });

  test('the ids come back sorted by code point', () => {
    const ids = ['Z', 'A', 'M', 'B'].map((n) => dead('Leaf', n));
    assert.deepEqual(o.sweep(G), [...ids].sort());
  });
});

describe('the oracle: embedded nodes and values dropped with their target', () => {
  test('an embedded node is removed with its owner, recursively, and by assigning its field', () => {
    const x = mk('Leaf', 'X');
    const r1 = 'Leaf:000000000000X:refs:Ref:00000000000R1'; const a1 = 'Leaf:000000000000X:refs:Ref:00000000000R1:attrs:Attr:00000000000A1'; const r2 = 'Leaf:000000000000X:refs:Ref:00000000000R2';
    for (const [id, kind] of [[r1, 'Ref'], [a1, 'Attr'], [r2, 'Ref']] as const) o.createNode(G, id, kind);
    o.addPair(G, x, 'refs', r1); o.addPair(G, x, 'refs', r2); o.addPair(G, r1, 'attrs', a1); o.addPair(G, a1, 'k', 'position'); o.addPair(G, a1, 'v', '3');
    o.clearField(G, x, 'refs');
    assert.deepEqual([r1, a1, r2].map((id) => o.record(G, id)), [undefined, undefined, undefined]);
    const y = mk('Leaf', 'Y'); const r3 = 'Leaf:000000000000Y:refs:Ref:00000000000R3'; o.createNode(G, r3, 'Ref'); o.addPair(G, y, 'refs', r3);
    o.removeNode(G, y);
    assert.equal(o.record(G, r3), undefined);
  });

  test('a node removed is dropped from a field dropped with its target, and from no other', () => {
    const box = mk('Box', 'B'); const x = mk('Leaf', 'X'); const y = mk('Leaf', 'Y');
    o.addPair(G, box, 'pinned', x); o.addPair(G, box, 'pinned', y); o.insertItem(G, box, 'items', x);
    o.removeNode(G, x);
    assert.deepEqual(o.values(G, box, 'pinned'), [y]);
    assert.deepEqual(o.items(G, box, 'items'), [x], 'a container still names a node removed: the sweeps of the service');
    assert.deepEqual(o.danglingRefs(G), [x]);
  });
});

describe('the oracle: removePair', () => {
  test('removes one pair of a set and its reverse, leaves the others, and a pair that is not there changes nothing', () => {
    const a = mk('Leaf', 'A'); const b = mk('Leaf', 'B'); const c = mk('Leaf', 'C');
    o.addPair(G, a, 'likes', b); o.addPair(G, a, 'likes', c); o.addPair(G, c, 'likes', b);
    o.removePair(G, a, 'likes', b);
    assert.deepEqual(o.values(G, a, 'likes'), [c]);
    assert.deepEqual(o.subjectsOf(G, 'likes', b), [c]);
    o.removePair(G, a, 'likes', b); // gone already
    o.removePair(G, b, 'likes', a); // never there
    assert.deepEqual(o.values(G, a, 'likes'), [c]);
    assert.ok(o.record(G, b) !== undefined, 'the node the pair pointed to stays');
  });

  test('removes a literal value, and a value that is not the one held changes nothing', () => {
    const a = mk('Leaf', 'A');
    o.addPair(G, a, 'label', 'one');
    o.removePair(G, a, 'label', 'two');
    assert.deepEqual(o.values(G, a, 'label'), ['one']);
    o.removePair(G, a, 'label', 'one');
    assert.deepEqual(o.values(G, a, 'label'), []);
    o.addPair(G, a, 'label', 'two'); // a single-valued field takes a new value once the old one is removed
    assert.deepEqual(o.values(G, a, 'label'), ['two']);
  });

  test('on an embed field the embedded node goes with the pair, recursively, and the sibling stays', () => {
    const x = mk('Leaf', 'X');
    const r1 = 'Leaf:000000000000X:refs:Ref:00000000000R1'; const a1 = 'Leaf:000000000000X:refs:Ref:00000000000R1:attrs:Attr:00000000000A1'; const r2 = 'Leaf:000000000000X:refs:Ref:00000000000R2';
    for (const [id, kind] of [[r1, 'Ref'], [a1, 'Attr'], [r2, 'Ref']] as const) o.createNode(G, id, kind);
    o.addPair(G, x, 'refs', r1); o.addPair(G, x, 'refs', r2); o.addPair(G, r1, 'attrs', a1); o.addPair(G, a1, 'k', 'position'); o.addPair(G, r1, 'to', x);
    o.removePair(G, x, 'refs', r1);
    assert.deepEqual([r1, a1].map((id) => o.record(G, id)), [undefined, undefined]);
    assert.deepEqual(o.values(G, x, 'refs'), [r2]);
    assert.deepEqual(o.subjectsOf(G, 'to', x), [], 'the pairs of the embedded nodes go');
    assert.deepEqual(o.danglingRefs(G), []);
    assert.deepEqual(o.record(G, r2)!.fields, []);
  });

  test('a write of an embed field is removePair for the dropped values and addPair for the new, so a kept node keeps its id', () => {
    const x = mk('Leaf', 'X'); const y = mk('Leaf', 'Y');
    const r1 = 'Leaf:000000000000X:refs:Ref:00000000000R1'; const r2 = 'Leaf:000000000000X:refs:Ref:00000000000R2'; const r3 = 'Leaf:000000000000X:refs:Ref:00000000000R3';
    for (const id of [r1, r2, r3]) o.createNode(G, id, 'Ref');
    o.addPair(G, x, 'refs', r1); o.addPair(G, x, 'refs', r2); o.addPair(G, r1, 'to', y); o.addPair(G, r2, 'to', y);
    // the new value is r1 and r3: r2 is dropped, r1 is kept untouched, r3 is added
    o.removePair(G, x, 'refs', r2); o.addPair(G, x, 'refs', r3);
    assert.deepEqual(sorted(o.values(G, x, 'refs')), [r1, r3]);
    assert.deepEqual(o.values(G, r1, 'to'), [y], 'the kept node still holds its pair');
    assert.equal(o.record(G, r2), undefined);
    assert.ok(o.record(G, r3) !== undefined);
  });

  test('on an ordered field the other items keep their order, the item stays a node and loses its parent', () => {
    const box = mk('Box', 'B'); const x = mk('Leaf', 'X'); const y = mk('Leaf', 'Y'); const z = mk('Leaf', 'Z');
    o.insertItem(G, box, 'items', x); o.insertItem(G, box, 'items', y); o.insertItem(G, box, 'items', z);
    o.removePair(G, box, 'items', y);
    assert.deepEqual(o.items(G, box, 'items'), [x, z]);
    assert.equal(o.placeOf(G, box, 'items', z), 1);
    assert.deepEqual(o.values(G, y, 'up'), []);
    assert.ok(o.record(G, y) !== undefined);
    o.removePair(G, box, 'items', y); // not there
    assert.deepEqual(o.items(G, box, 'items'), [x, z]);
    o.insertItem(G, box, 'items', y, 0); // free to go in again
    assert.deepEqual(o.items(G, box, 'items'), [y, x, z]);
  });

  test('a node removed from a field dropped with its target by removePair is no more in it, and the open points still throw', () => {
    const box = mk('Box', 'B'); const x = mk('Leaf', 'X');
    o.addPair(G, box, 'pinned', x);
    o.removePair(G, box, 'pinned', x);
    assert.deepEqual(o.values(G, box, 'pinned'), []);
    assert.throws(() => o.removePair(G, 'Box:000000M1SS1NG', 'pinned', x), undecided('Existence'));
    assert.throws(() => o.removePair(G, box, 'madeUp', 'x'), undecided('Enforcement'));
    assert.throws(() => o.removePair(G, x, 'up', box), undecided('Enforcement'), 'a derived entry is no pair');
    assert.throws(() => o.removePair(G, box, 'pinned', 5), undecided('Enforcement'), 'a reference that is not an id');
  });
});

describe('the oracle: persistence', () => {
  test('a build accepts a reference to a node not built yet, and the record reads out in the schema order with parent at its place', () => {
    o.build(G, { id: 'Box:000000000000B', kind: 'Box', fields: { label: 'b', items: ['Leaf:000000000000X', 'Leaf:000000000000Y'] } });
    assert.deepEqual(o.danglingRefs(G), ['Leaf:000000000000X', 'Leaf:000000000000Y']);
    o.build(G, { id: 'Leaf:000000000000X', kind: 'Leaf', fields: { rank: 2, label: 'x', up: 'Box:000000000000B', note: 'n', mate: 'Leaf:000000000000Y' } });
    o.build(G, { id: 'Leaf:000000000000Y', kind: 'Leaf', fields: { label: 'y', likes: ['Leaf:000000000000X'] } });
    assert.deepEqual(o.danglingRefs(G), []);
    assert.deepEqual(o.record(G, 'Leaf:000000000000X'), { id: 'Leaf:000000000000X', kind: 'Leaf', fields: [{ name: 'label', values: ['x'] }, { name: 'note', values: ['n'] }, { name: 'up', values: ['Box:000000000000B'] }, { name: 'rank', values: [2] }, { name: 'mate', values: ['Leaf:000000000000Y'] }] });
    assert.deepEqual(o.items(G, 'Box:000000000000B', 'items'), ['Leaf:000000000000X', 'Leaf:000000000000Y']);
    assert.deepEqual(o.idsOfKind(G, 'Leaf'), ['Leaf:000000000000X', 'Leaf:000000000000Y']);
  });

  test('a parent that a build supplies is an assertion and never a pair', () => {
    o.build(G, { id: 'Leaf:000000000000X', kind: 'Leaf', fields: { label: 'x', up: 'Box:000000N0WHERE' } });
    assert.deepEqual(o.values(G, 'Leaf:000000000000X', 'up'), []);
    assert.deepEqual(o.danglingRefs(G), []);
  });

  test('a build that fails leaves the store as it was', () => {
    assert.throws(() => o.build(G, { id: 'Leaf:000000000000X', kind: 'Leaf', fields: { label: 'x', nonsense: 1 } }), (e: unknown) => e instanceof Undecided);
    assert.equal(o.idsOfKind(G, 'Leaf').length, 0);
  });
});

describe('the oracle: several graphs', () => {
  test('a node lives in one graph, and the ids of a kind are asked of a graph', () => {
    o.createGraph('threads');
    const a = mk('Leaf', 'A'); const b = mk('Leaf', 'B', 'threads');
    assert.deepEqual(o.idsOfKind(G, 'Leaf'), [a]);
    assert.deepEqual(o.idsOfKind('threads', 'Leaf'), [b]);
    assert.throws(() => o.createGraph('threads'), Refused);
    assert.throws(() => o.createNode('nowhere', 'Leaf:000000000000C', 'Leaf'), Refused);
  });

  test('a graph is dropped only if no pair from the remaining graphs points into it', () => {
    o.createGraph('threads');
    const a = mk('Leaf', 'A'); const b = mk('Leaf', 'B', 'threads');
    o.addPair(G, a, 'mate', b);
    assert.throws(() => o.dropGraph('threads'), Refused);
    assert.deepEqual(o.idsOfKind('threads', 'Leaf'), [b], 'a refused drop leaves every graph as it was');
    o.clearField(G, a, 'mate');
    o.addPair('threads', b, 'mate', a);
    o.dropGraph('threads'); // pairs that go out of a dropped graph go with it
    assert.deepEqual(o.idsOfKind('threads', 'Leaf'), []);
    assert.deepEqual(o.subjectsOf(G, 'mate', a), []);
    assert.throws(() => o.dropGraph('threads'), Refused);
  });
});

describe('the oracle: what the design leaves open', () => {
  test('existence: the read, the size, and a write to a subject that has no node', () => {
    const a = mk('Leaf', 'A');
    assert.throws(() => o.exists(G, a), undecided('Existence'));
    assert.throws(() => o.size(G), undecided('Existence'));
    assert.throws(() => o.addPair(G, 'Leaf:000000M1SS1NG', 'label', 'x'), undecided('Existence'));
    assert.throws(() => o.removeNode(G, 'Leaf:000000M1SS1NG'), undecided('Existence'));
    assert.throws(() => o.tombstone(G, 'Leaf:000000M1SS1NG', 't'), undecided('Existence'));
    assert.throws(() => o.insertItem(G, 'Box:000000M1SS1NG', 'items', a), undecided('Existence'));
  });

  test('enforcement: a write outside the shape of the schema', () => {
    const a = mk('Leaf', 'A'); const b = mk('Leaf', 'B');
    assert.throws(() => o.addPair(G, a, 'madeUp', 'x'), undecided('Enforcement'), 'a field the kind does not declare');
    assert.throws(() => o.addPair(G, a, 'name', 'x'), undecided('Enforcement'), 'a field of another kind');
    assert.throws(() => o.addPair(G, a, 'up', 'Box:000000000000X'), undecided('Enforcement'), 'a derived entry is no pair');
    assert.throws(() => o.addPair(G, a, 'likes', 5), undecided('Enforcement'), 'a reference that is not an id');
    o.addPair(G, a, 'label', 'one');
    assert.throws(() => o.addPair(G, a, 'label', 'two'), undecided('Enforcement'), 'a second value of a single-valued field');
    assert.throws(() => o.clearField(G, a, 'madeUp'), undecided('Enforcement'));
    assert.deepEqual(o.values(G, b, 'madeUp'), [], 'a read of a field the kind does not declare is empty');
  });

  test('the ports are Batch 14', () => {
    assert.throws(() => o.portTree(G, { field: 'likes', value: 'Leaf:000000000000A' }), NotBuilt);
    assert.throws(() => o.setPortCap(G, 'likes', 1, 'items'), NotBuilt);
    assert.throws(() => o.capturePortView(G, { field: 'likes', value: 'Leaf:000000000000A' }), NotBuilt);
    assert.throws(() => o.readThroughView('v', { field: 'likes', value: 'Leaf:000000000000A' }), NotBuilt);
    assert.throws(() => o.removePortView('v'), NotBuilt);
  });
});

describe('the oracle with the Aperas schema', () => {
  test('is constructed with the same schema as the engine and keeps a document tree', () => {
    const engine = createEngine(APERAS_SCHEMA);
    const a = new Oracle(engine.schema);
    a.createNode(G, 'ArtifactNode:000000000000A', 'ArtifactNode'); a.createNode(G, 'BlockNode:000000000000B', 'BlockNode');
    a.addPair(G, 'ArtifactNode:000000000000A', 'children', 'BlockNode:000000000000B');
    assert.deepEqual(a.values(G, 'BlockNode:000000000000B', 'parent'), ['ArtifactNode:000000000000A']);
    a.addPair(G, 'ArtifactNode:000000000000A', 'title', 'doc'); a.addPair(G, 'BlockNode:000000000000B', 'type', 'paragraph');
    a.tombstone(G, 'BlockNode:000000000000B', 'T');
    assert.deepEqual(a.record(G, 'BlockNode:000000000000B')!.fields, [{ name: 'tombstonedAt', values: ['T'] }, { name: 'type', values: ['paragraph'] }]);
    assert.deepEqual(a.items(G, 'ArtifactNode:000000000000A', 'children'), []);
  });

  test('sweeps the tombstones that no artifact or folder reaches through children, links and the target of a link', () => {
    const a = new Oracle(createEngine(APERAS_SCHEMA).schema);
    const art = 'ArtifactNode:000000000000A'; const dir = 'FolderNode:000000000000F'; const live = 'BlockNode:000000000000B'; const kept = 'BlockNode:000000000000K'; const lost = 'BlockNode:000000000000M'; const kid = 'BlockNode:000000000000C';
    const link = `${live}:links:Link:0000000000QK1`; const stale = `${lost}:links:Link:0000000000QK2`;
    for (const [id, kind] of [[art, 'ArtifactNode'], [dir, 'FolderNode'], [live, 'BlockNode'], [kept, 'BlockNode'], [lost, 'BlockNode'], [kid, 'BlockNode'], [link, 'Link']] as const) a.createNode(G, id, kind);
    a.addPair(G, dir, 'children', art); a.addPair(G, art, 'children', live); a.addPair(G, live, 'links', link); a.addPair(G, link, 'target', kept);
    a.tombstone(G, kept, 'T'); a.tombstone(G, lost, 'T');
    a.createNode(G, stale, 'Link'); a.addPair(G, lost, 'links', stale); a.addPair(G, stale, 'target', kid); a.tombstone(G, kid, 'T');
    assert.deepEqual(a.sweep(G), [kid, lost].sort(), 'the unreached tombstones, and the one only a swept tombstone linked to');
    assert.deepEqual([kept, live, art, dir, link].map((id) => a.record(G, id) !== undefined), [true, true, true, true, true]);
    assert.equal(a.record(G, stale), undefined, 'the Link of a swept tombstone goes with it');
  });
});
