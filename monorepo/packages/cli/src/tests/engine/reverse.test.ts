// The reverse side (planning/core.md, Batch 5 step 2): the reverse of a field is built on first use, from the
// forward sides, and from then on kept up by every write; a field not asked for is never touched. Hand-written
// cases; the random sequences, with the reverse asked before and after writes, are in `relations.model.test.ts`.
// What is built is read from the registry (`inspectEngine`) and not from the interface.
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, inspectEngine } from '@aperas/core/apeironNgn/engine';
import type { Engine } from '@aperas/core/apeironNgn/interface';
import { Oracle } from '../support/oracle.ts';
import { TEST_SCHEMA } from '../support/engineSchema.ts';

const G = 'default';
let n = 0;
const mint = (kind: string): string => `${kind}:${(++n).toString().padStart(13, '0')}`;
const embedded = (owner: string, field: string, kind: string): string => `${owner}:${field}:${mint(kind)}`;

let e: Engine;
let o: Oracle;
const mk = (kind: string): string => { const id = mint(kind); e.createNode(G, id, kind); o.createNode(G, id, kind); return id; };
const both = (run: (x: Engine) => void): void => { run(e); run(o); };
const built = (): string[] => inspectEngine(e).reversesBuilt();
const sorted = (xs: readonly string[]): string[] => [...xs].sort();
/** What both implementations say of the reverse of a field for an object, compared with what is expected. */
const reverse = (field: string, object: string, expected: readonly string[], why: string): void => {
  for (const [who, x] of [['engine', e], ['oracle', o]] as const) {
    assert.deepEqual(sorted(x.subjectsOf(G, field, object)), sorted(expected), `${who}: ${why}`);
    assert.equal(x.countSubjectsOf(G, field, object), expected.length, `${who}: the count, ${why}`);
    const first = x.firstSubjectOf(G, field, object);
    if (expected.length === 0) assert.equal(first, undefined, `${who}: first, ${why}`);
    else assert.ok(expected.includes(first!), `${who}: first, ${why}`);
  }
};

beforeEach(() => { e = createEngine(TEST_SCHEMA); o = new Oracle(e.schema); });

describe('a reverse built on first use', () => {
  test('nothing is built until it is asked, and a write builds none', () => {
    const a = mk('Leaf'); const b = mk('Leaf');
    both((x) => { x.addPair(G, a, 'likes', b); x.addPair(G, a, 'mate', b); x.removePair(G, a, 'likes', b); x.clearField(G, a, 'mate'); });
    assert.deepEqual(built(), []);
  });

  test('asked before any write, it is empty and then kept up through the writes', () => {
    const a = mk('Leaf'); const b = mk('Leaf'); const c = mk('Stub');
    reverse('likes', b, [], 'asked before any write');
    assert.deepEqual(built(), ['likes']);
    both((x) => { x.addPair(G, a, 'likes', b); x.addPair(G, c, 'likes', b); });
    reverse('likes', b, [a, c], 'two subjects');
    both((x) => x.removePair(G, a, 'likes', b));
    reverse('likes', b, [c], 'one removed');
    both((x) => x.clearField(G, c, 'likes'));
    reverse('likes', b, [], 'cleared');
  });

  test('asked after writes, it is built from them', () => {
    const a = mk('Leaf'); const b = mk('Leaf'); const c = mk('Stub'); const d = mk('Leaf');
    both((x) => { x.addPair(G, a, 'likes', b); x.addPair(G, a, 'likes', d); x.addPair(G, c, 'likes', b); x.addPair(G, c, 'likes', c); });
    assert.deepEqual(built(), []);
    reverse('likes', b, [a, c], 'built from the forward sides');
    reverse('likes', d, [a], 'another object');
    reverse('likes', c, [c], 'a reference from a node to itself');
    reverse('likes', a, [], 'an object nothing points at');
    both((x) => x.addPair(G, d, 'likes', a));
    reverse('likes', a, [d], 'a write after the build');
  });

  test('asked of two fields, one is built and the other is not, though both are written', () => {
    const a = mk('Leaf'); const b = mk('Leaf');
    both((x) => { x.addPair(G, a, 'likes', b); x.addPair(G, a, 'mate', b); });
    reverse('mate', b, [a], 'the reverse of mate');
    assert.deepEqual(built(), ['mate']);
    both((x) => { x.clearField(G, a, 'mate'); x.addPair(G, a, 'likes', a); });
    assert.deepEqual(built(), ['mate'], 'writes of likes do not build it');
    reverse('likes', a, [a], 'now likes');
    assert.deepEqual(built(), ['mate', 'likes']);
    reverse('mate', b, [], 'mate was kept up');
  });

  test('the reverse is by the name of the field, over every kind that declares it', () => {
    const leaf = mk('Leaf'); const box = mk('Box'); const shelf = mk('Shelf'); const stub = mk('Stub'); const target = mk('Leaf');
    both((x) => { x.addPair(G, leaf, 'mate', target); x.addPair(G, stub, 'mate', target); x.addPair(G, box, 'pinned', target); x.addPair(G, shelf, 'kept', target); });
    reverse('mate', target, [leaf, stub], 'Leaf and its descendant Stub');
    reverse('pinned', target, [box], 'a field of Box only');
    reverse('kept', target, [shelf], 'a field of Shelf only');
    const refs = [leaf, box, shelf, stub].map((owner) => embedded(owner, 'refs', 'Ref'));
    both((x) => [leaf, box, shelf, stub].forEach((owner, i) => x.addPair(G, owner, 'refs', refs[i]!)));
    reverse('refs', refs[2]!, [shelf], 'refs is declared by Entity, so by Leaf, Box, Shelf and Stub');
  });

  test('a bucket emptied and refilled', () => {
    const a = mk('Leaf'); const b = mk('Leaf');
    reverse('likes', b, [], 'built empty');
    both((x) => x.addPair(G, a, 'likes', b));
    reverse('likes', b, [a], 'filled');
    both((x) => x.removePair(G, a, 'likes', b));
    reverse('likes', b, [], 'emptied');
    both((x) => x.addPair(G, a, 'likes', b));
    reverse('likes', b, [a], 'refilled');
  });

  test('a pair removed by removePair and by clearField leaves the bucket right', () => {
    const a = mk('Leaf'); const c = mk('Leaf'); const b = mk('Leaf'); const d = mk('Leaf');
    both((x) => { x.addPair(G, a, 'likes', b); x.addPair(G, a, 'likes', d); x.addPair(G, c, 'likes', b); });
    reverse('likes', b, [a, c], 'built');
    both((x) => x.removePair(G, a, 'likes', b));
    reverse('likes', b, [c], 'by removePair');
    reverse('likes', d, [a], 'the other value of a stays');
    both((x) => x.clearField(G, a, 'likes'));
    reverse('likes', d, [], 'by clearField');
    reverse('likes', b, [c], 'the other subject stays');
    both((x) => x.removePair(G, c, 'likes', mint('Leaf')));
    reverse('likes', b, [c], 'a pair that is not there changes nothing');
  });

  test('a pair added twice is one subject, and a pair added then removed leaves no trace', () => {
    const a = mk('Leaf'); const b = mk('Leaf');
    reverse('likes', b, [], 'built');
    both((x) => { x.addPair(G, a, 'likes', b); x.addPair(G, a, 'likes', b); });
    reverse('likes', b, [a], 'twice');
    both((x) => x.removePair(G, a, 'likes', b));
    reverse('likes', b, [], 'once removed');
  });

  test('the count is the size of the bucket, however many subjects', () => {
    const target = mk('Leaf');
    const subjects = Array.from({ length: 3000 }, () => { const id = mint('Leaf'); e.createNode(G, id, 'Leaf'); e.addPair(G, id, 'likes', target); return id; });
    assert.equal(e.countSubjectsOf(G, 'likes', target), 3000, 'built from the forward sides');
    for (const s of subjects.slice(0, 1000)) e.removePair(G, s, 'likes', target);
    assert.equal(e.countSubjectsOf(G, 'likes', target), 2000);
    assert.equal(e.subjectsOf(G, 'likes', target).length, 2000);
    assert.ok(subjects.slice(1000).includes(e.firstSubjectOf(G, 'likes', target)!));
    for (const s of subjects.slice(1000)) e.clearField(G, s, 'likes');
    assert.equal(e.countSubjectsOf(G, 'likes', target), 0);
  });

  test('subjectsOf is a copy', () => {
    const a = mk('Leaf'); const b = mk('Leaf');
    e.addPair(G, a, 'likes', b);
    e.subjectsOf(G, 'likes', b).push('x');
    assert.deepEqual(e.subjectsOf(G, 'likes', b), [a]);
  });
});

describe('the reverse of an embed field', () => {
  test('the object is the embedded node, the subject its owner; the reference inside it has a reverse of its own', () => {
    const a = mk('Leaf'); const t = mk('Leaf'); const ref = embedded(a, 'refs', 'Ref');
    both((x) => { x.createNode(G, ref, 'Ref'); x.addPair(G, a, 'refs', ref); x.addPair(G, ref, 'to', t); });
    reverse('refs', ref, [a], 'the owner of an embedded node');
    reverse('to', t, [ref], 'the Link-shaped node that points at t');
    both((x) => x.removePair(G, ref, 'to', t));
    reverse('to', t, [], 'removed');
  });
});

describe('a reverse side with no record for its object', () => {
  test('the bucket of a node that has no record is held until the node is created, then moves onto its record', () => {
    const a = mk('Leaf'); const c = mk('Leaf'); const later = mint('Leaf');
    both((x) => { x.addPair(G, a, 'likes', later); x.addPair(G, c, 'likes', later); });
    assert.deepEqual(inspectEngine(e).waitingIds(), [], 'a field not built holds nothing in the waiting map');
    reverse('likes', later, [a, c], 'built, for a node with no record');
    assert.deepEqual(inspectEngine(e).waitingIds(), [later]);
    both((x) => x.removePair(G, a, 'likes', later));
    reverse('likes', later, [c], 'kept up');
    both((x) => x.createNode(G, later, 'Leaf'));
    assert.deepEqual(inspectEngine(e).waitingIds(), [], 'the bucket moved onto the record');
    reverse('likes', later, [c], 'the same after the node is created');
  });

  test('a write to a node with no record, after the build, goes to the waiting map and a waiting entry that empties is dropped', () => {
    const a = mk('Leaf'); const later = mint('Leaf');
    reverse('likes', later, [], 'built');
    both((x) => x.addPair(G, a, 'likes', later));
    assert.deepEqual(inspectEngine(e).waitingIds(), [later]);
    both((x) => x.removePair(G, a, 'likes', later));
    assert.deepEqual(inspectEngine(e).waitingIds(), []);
    reverse('likes', later, [], 'empty');
  });
});

describe('a field with no reverse side, and one that is not built', () => {
  test('a literal or an unknown field gives an empty list, undefined and 0, and builds nothing', () => {
    const a = mk('Leaf');
    for (const field of ['label', 'rank', 'nonsense', 'matedBy']) reverse(field, a, [], field);
    assert.deepEqual(built(), []);
    assert.deepEqual(e.subjectsOf('elsewhere', 'likes', a), [], 'a graph that is not there');
  });

  test('a derived entry has no reverse side of its own: an empty list, undefined and 0, and nothing built', () => {
    const a = mk('Leaf');
    reverse('up', a, [], 'a derived entry');
    assert.deepEqual(built(), []);
  });

  test('an ordered field has a reverse, built on first use like the others', () => {
    const box = mk('Box'); const leaf = mk('Leaf');
    both((x) => x.addPair(G, box, 'items', leaf));
    reverse('items', leaf, [box], 'built by the ask');
    assert.deepEqual(built(), ['items']);
  });
});
