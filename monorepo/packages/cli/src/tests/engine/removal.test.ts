// Removal (planning/core.md, Batch 5 steps 3 and 4): `removeNode`, and `removePair` and `clearField` on an embed field.
// A node's own pairs go with it, as `removePair` removes them (so a built reverse loses the entries), its embedded nodes go
// in turn, and it is dropped from every field dropped with its target; the pairs that name it stay. Hand-written cases,
// each given to the engine and the oracle; the random sequences are in `relations.model.test.ts`.
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, inspectEngine, Refused } from '@aperas/core/apeironNgn/engine';
import type { Engine } from '@aperas/core/apeironNgn/interface';
import type { SchemaSpec } from '@aperas/core/apeironNgn/schema';
import { Oracle, Refused as OracleRefused } from '../support/oracle.ts';
import { TEST_SCHEMA } from '../support/engineSchema.ts';

const G = 'default';
let n = 0;
const mint = (kind: string): string => `${kind}:${(++n).toString().padStart(13, '0')}`;
const embedded = (owner: string, field: string, kind: string): string => `${owner}:${field}:${mint(kind)}`;

let e: Engine;
let o: Oracle;
const mk = (kind: string): string => { const id = mint(kind); e.createNode(G, id, kind); o.createNode(G, id, kind); return id; };
/** An embedded node made and held by its owner. */
const own = (owner: string, field: string, kind: string): string => { const id = embedded(owner, field, kind); e.createNode(G, id, kind); o.createNode(G, id, kind); e.addPair(G, owner, field, id); o.addPair(G, owner, field, id); return id; };
const both = (run: (x: Engine) => void): void => { run(e); run(o); };
const sorted = (xs: readonly string[]): string[] => [...xs].sort();
const same = <T>(read: (x: Engine) => T, expected: T, why: string): void => {
  assert.deepEqual(read(e), expected, `engine: ${why}`);
  assert.deepEqual(read(o), expected, `oracle: ${why}`);
};
const sameSet = (read: (x: Engine) => readonly (string | number | boolean)[], expected: string[], why: string): void => same((x) => sorted(read(x) as string[]), sorted(expected), why);
const built = (): string[] => inspectEngine(e).reversesBuilt();

beforeEach(() => { e = createEngine(TEST_SCHEMA); o = new Oracle(e.schema); });

describe('removeNode', () => {
  test('a node removed is dropped from the field dropped with its target, and the other values of it stay (the dangling-unfolds case)', () => {
    const box = mk('Box'); const x = mk('Leaf'); const y = mk('Leaf'); const z = mk('Leaf');
    both((s) => { s.addPair(G, box, 'pinned', x); s.addPair(G, box, 'pinned', y); s.addPair(G, z, 'likes', x); s.addPair(G, z, 'mate', x); });
    both((s) => s.removeNode(G, x));
    sameSet((s) => s.values(G, box, 'pinned'), [y], 'x is gone from pinned and y is not');
    sameSet((s) => s.values(G, z, 'likes'), [x], 'a pair that is not dropped with its target stays');
    sameSet((s) => s.values(G, z, 'mate'), [x], 'another stays');
    same((s) => s.record(G, x), undefined, 'the record is gone');
    sameSet((s) => s.idsOfKind(G, 'Leaf'), [y, z], 'and the collection of its kind');
  });

  test('the reverse of the field dropped with its target, read by object, equals a scan of every container', () => {
    const boxes = [mk('Box'), mk('Box'), mk('Box')]; const targets = [mk('Leaf'), mk('Stub'), mk('Leaf'), mk('Leaf')];
    boxes.forEach((b, i) => targets.forEach((t, j) => { if ((i + j) % 2 === 0) both((s) => s.addPair(G, b, 'pinned', t)); }));
    both((s) => { s.removeNode(G, targets[0]!); s.removeNode(G, targets[3]!); });
    for (const t of targets) {
      const scan = boxes.filter((b) => e.values(G, b, 'pinned').includes(t));
      assert.deepEqual(sorted(e.subjectsOf(G, 'pinned', t)), sorted(scan), `the reverse of pinned for ${t}`);
      sameSet((s) => s.subjectsOf(G, 'pinned', t), scan, `the same on the oracle for ${t}`);
    }
    sameSet((s) => s.subjectsOf(G, 'pinned', targets[0]!), [], 'nothing pins a removed node');
  });

  test('the first removal builds the reverse of the field dropped with its target; a later one finds it built', () => {
    const box = mk('Box'); const x = mk('Leaf'); const y = mk('Leaf');
    both((s) => { s.addPair(G, box, 'pinned', x); s.addPair(G, box, 'pinned', y); });
    assert.deepEqual(built(), [], 'nothing built by the writes');
    both((s) => s.removeNode(G, x));
    assert.deepEqual(built(), ['pinned'], 'the removal built it');
    sameSet((s) => s.values(G, box, 'pinned'), [y], 'dropped');
    both((s) => s.removeNode(G, y));
    assert.deepEqual(built(), ['pinned']);
    sameSet((s) => s.values(G, box, 'pinned'), [], 'dropped when the reverse was built');
    sameSet((s) => s.subjectsOf(G, 'pinned', x), [], 'the bucket is empty');
  });

  test('each pair the node holds goes from a built reverse, and the pairs naming it stay with their bucket in the waiting map', () => {
    const a = mk('Leaf'); const b = mk('Leaf'); const c = mk('Leaf');
    both((s) => { s.addPair(G, a, 'likes', b); s.addPair(G, a, 'likes', c); s.addPair(G, c, 'likes', a); s.addPair(G, b, 'mate', a); });
    sameSet((s) => s.subjectsOf(G, 'likes', b), [a], 'built');
    sameSet((s) => s.subjectsOf(G, 'likes', a), [c], 'built');
    sameSet((s) => s.subjectsOf(G, 'mate', a), [b], 'built');
    both((s) => s.removeNode(G, a));
    sameSet((s) => s.subjectsOf(G, 'likes', b), [], 'the pairs a held as subject are gone from the reverse');
    sameSet((s) => s.subjectsOf(G, 'likes', c), [], 'the pairs a held as subject are gone from the reverse');
    sameSet((s) => s.subjectsOf(G, 'likes', a), [c], 'the pair naming a stays, with its bucket');
    sameSet((s) => s.subjectsOf(G, 'mate', a), [b], 'and the other');
    sameSet((s) => s.values(G, c, 'likes'), [a], 'the forward side of the one that named it');
    assert.deepEqual(inspectEngine(e).waitingIds(), [a], 'the bucket waits for a node with no record');
  });

  test('a node removed and created again starts with the incoming references that are still there', () => {
    const a = mk('Leaf'); const b = mk('Leaf');
    both((s) => { s.addPair(G, b, 'likes', a); s.addPair(G, a, 'label', 'before'); s.addPair(G, a, 'likes', b); });
    sameSet((s) => s.subjectsOf(G, 'likes', a), [b], 'built');
    both((s) => s.removeNode(G, a));
    both((s) => s.createNode(G, a, 'Leaf'));
    sameSet((s) => s.subjectsOf(G, 'likes', a), [b], 'the reference is still there');
    same((s) => s.record(G, a)!.fields, [], 'and nothing else: the literals and the pairs it held went');
    sameSet((s) => s.subjectsOf(G, 'likes', b), [], 'its old pair is not in the reverse');
    assert.deepEqual(inspectEngine(e).waitingIds(), [], 'the bucket moved onto the new record');
  });

  test('a self reference goes with the node', () => {
    const a = mk('Leaf'); const box = mk('Box');
    both((s) => { s.addPair(G, a, 'likes', a); s.addPair(G, a, 'mate', a); s.addPair(G, box, 'pinned', box); });
    sameSet((s) => s.subjectsOf(G, 'likes', a), [a], 'built');
    both((s) => { s.removeNode(G, a); s.removeNode(G, box); });
    sameSet((s) => s.subjectsOf(G, 'likes', a), [], 'the self reference is gone');
    sameSet((s) => s.subjectsOf(G, 'pinned', box), [], 'a self pin is gone');
    assert.deepEqual(inspectEngine(e).waitingIds(), [], 'and no bucket waits');
  });

  test('a node with no record: the removal changes nothing, as the removal of a pair that is not there', () => {
    const watcher = mk('Leaf');
    both((s) => s.removeNode(G, mint('Leaf'))); // an id nobody created
    const a = mk('Leaf');
    both((s) => { s.addPair(G, watcher, 'likes', a); s.removeNode(G, a); });
    sameSet((s) => s.subjectsOf(G, 'likes', a), [watcher], 'the bucket waits');
    both((s) => s.removeNode(G, a)); // a node removed twice
    sameSet((s) => s.subjectsOf(G, 'likes', a), [watcher], 'and the second removal moves nothing');
    same((s) => [s.size(G), s.values(G, watcher, 'likes')], [1, [a]], 'the pair that names it stays');
    assert.deepEqual(inspectEngine(e).waitingIds(), [a]);
  });

  test('literals go with the record, and nothing else changes', () => {
    const a = mk('Leaf'); const b = mk('Leaf');
    both((s) => { s.addPair(G, a, 'label', 'x'); s.addPair(G, b, 'label', 'y'); s.addPair(G, b, 'rank', 3); });
    both((s) => s.removeNode(G, a));
    same((s) => s.values(G, a, 'label'), [], 'gone');
    same((s) => s.record(G, b)!.fields.map((f) => [f.name, f.values]), [['label', ['y']], ['rank', [3]]], 'the other node is as it was');
  });

  test('a node removed is dropped from a field dropped with its target that is ordered, and the others keep their order', () => {
    const spec: SchemaSpec = {
      kinds: [
        { name: 'Thing', fields: [{ name: 'name', storage: 'literal', cardinality: 'optional' }, { name: 'friends', storage: 'reference', cardinality: 'set' }] },
        { name: 'Shelf', fields: [{ name: 'slots', storage: 'reference', cardinality: 'ordered' }] },
      ],
      roles: { dropWithTarget: ['slots'] },
    };
    const x = createEngine(spec); const y = new Oracle(x.schema);
    const shelf = mint('Shelf'); const [a, b, c, d] = [mint('Thing'), mint('Thing'), mint('Thing'), mint('Thing')];
    for (const s of [x, y]) {
      s.createNode(G, shelf, 'Shelf');
      for (const t of [a, b, c, d]) { s.createNode(G, t, 'Thing'); s.addPair(G, shelf, 'slots', t); }
      s.addPair(G, a, 'friends', b);
      s.removeNode(G, b);
    }
    for (const s of [x, y]) assert.deepEqual(s.values(G, shelf, 'slots'), [a, c, d], 'b is out and the others keep their order');
    assert.deepEqual(inspectEngine(x).reversesBuilt(), ['slots'], 'the removal built the reverse of the field');
    for (const s of [x, y]) assert.deepEqual(s.subjectsOf(G, 'slots', b), [], 'and nothing slots a removed node');
  });
});

describe('embedded nodes', () => {
  test('an embedded node removed with its pair takes its own embedded nodes and its pairs with it, and its sibling stays (the oracle\'s case)', () => {
    const x = mk('Leaf'); const t = mk('Leaf');
    const r1 = own(x, 'refs', 'Ref'); const r2 = own(x, 'refs', 'Ref'); const a1 = own(r1, 'attrs', 'Attr');
    both((s) => { s.addPair(G, a1, 'k', 'position'); s.addPair(G, r1, 'to', t); s.addPair(G, r2, 'to', t); });
    sameSet((s) => s.subjectsOf(G, 'to', t), [r1, r2], 'built');
    sameSet((s) => s.subjectsOf(G, 'refs', r1), [x], 'built');
    both((s) => s.removePair(G, x, 'refs', r1));
    same((s) => [r1, a1].map((id) => s.record(G, id)), [undefined, undefined], 'the node and the node it embedded are gone');
    sameSet((s) => s.values(G, x, 'refs'), [r2], 'the sibling is held');
    sameSet((s) => s.subjectsOf(G, 'to', t), [r2], 'the pairs of the removed nodes are gone from the reverse');
    sameSet((s) => s.subjectsOf(G, 'refs', r1), [], 'the pair is gone from the reverse of refs');
    same((s) => s.record(G, r2)!.fields.map((f) => [f.name, f.values]), [['to', [t]]], 'the sibling\'s record is unchanged');
    same((s) => s.idsOfKind(G, 'Attr'), [], 'the nested node is not in its collection');
  });

  test('a write that keeps some nodes is removePair then addPair: the kept node keeps its id and its pairs', () => {
    const x = mk('Leaf'); const y = mk('Leaf');
    const r1 = own(x, 'refs', 'Ref'); const r2 = own(x, 'refs', 'Ref'); const r3 = embedded(x, 'refs', 'Ref');
    both((s) => { s.addPair(G, r1, 'to', y); s.addPair(G, r2, 'to', y); });
    // the new value is r1 and r3: r2 is dropped, r1 is kept untouched, r3 is added
    both((s) => { s.removePair(G, x, 'refs', r2); s.createNode(G, r3, 'Ref'); s.addPair(G, x, 'refs', r3); });
    sameSet((s) => s.values(G, x, 'refs'), [r1, r3], 'held');
    sameSet((s) => s.values(G, r1, 'to'), [y], 'the kept node still holds its pair');
    same((s) => s.record(G, r2), undefined, 'the dropped node is gone');
    sameSet((s) => s.subjectsOf(G, 'to', y), [r1], 'and its pair with it');
  });

  test('a removal of two levels takes the node, the node it embeds and the one below', () => {
    const spec: SchemaSpec = {
      kinds: [
        { name: 'Top', fields: [{ name: 'mids', storage: 'embed', cardinality: 'set', embeds: 'Mid' }] },
        { name: 'Mid', fields: [{ name: 'lows', storage: 'embed', cardinality: 'set', embeds: 'Low' }] },
        { name: 'Low', fields: [{ name: 'tag', storage: 'literal', cardinality: 'optional' }, { name: 'sees', storage: 'reference', cardinality: 'set' }] },
      ],
    };
    const x = createEngine(spec); const oracle = new Oracle(x.schema);
    const top = mint('Top');
    const mid = embedded(top, 'mids', 'Mid'); const low = embedded(mid, 'lows', 'Low'); const other = embedded(top, 'mids', 'Mid');
    for (const s of [x, oracle]) {
      s.createNode(G, top, 'Top'); s.createNode(G, mid, 'Mid'); s.createNode(G, low, 'Low'); s.createNode(G, other, 'Mid');
      s.addPair(G, top, 'mids', mid); s.addPair(G, top, 'mids', other); s.addPair(G, mid, 'lows', low); s.addPair(G, low, 'tag', 't'); s.addPair(G, low, 'sees', top);
    }
    assert.deepEqual(x.subjectsOf(G, 'sees', top), [low], 'built');
    for (const s of [x, oracle]) s.removePair(G, top, 'mids', mid);
    for (const s of [x, oracle]) {
      assert.deepEqual([mid, low].map((id) => s.record(G, id)), [undefined, undefined]);
      assert.deepEqual(s.values(G, top, 'mids'), [other]);
    }
    assert.deepEqual(x.subjectsOf(G, 'sees', top), [], 'the reverse lost the pair of the node two levels down');
    for (const s of [x, oracle]) s.removeNode(G, top);
    for (const s of [x, oracle]) assert.deepEqual([top, other].map((id) => s.record(G, id)), [undefined, undefined]);
  });

  test('a removePair of an embedded value that has no record removes the pair only', () => {
    const x = mk('Leaf');
    const r1 = embedded(x, 'refs', 'Ref'); const r2 = own(x, 'refs', 'Ref');
    both((s) => s.addPair(G, x, 'refs', r1));
    sameSet((s) => s.values(G, x, 'refs'), [r1, r2], 'a named node need not exist');
    both((s) => s.removePair(G, x, 'refs', r1));
    sameSet((s) => s.values(G, x, 'refs'), [r2], 'removed');
    same((s) => s.record(G, r2) !== undefined, true, 'the node that exists stays');
  });

  test('clearField of an embed field removes the pairs and the nodes with them', () => {
    const x = mk('Leaf'); const t = mk('Leaf');
    const r1 = own(x, 'refs', 'Ref'); const r2 = own(x, 'refs', 'Ref'); const a1 = own(r1, 'attrs', 'Attr');
    both((s) => { s.addPair(G, r1, 'to', t); s.addPair(G, r2, 'to', t); });
    sameSet((s) => s.subjectsOf(G, 'to', t), [r1, r2], 'built');
    both((s) => s.clearField(G, x, 'refs'));
    same((s) => [r1, r2, a1].map((id) => s.record(G, id)), [undefined, undefined, undefined], 'all gone');
    sameSet((s) => s.subjectsOf(G, 'to', t), [], 'and out of the reverse');
    sameSet((s) => s.values(G, x, 'refs'), [], 'the field is empty');
  });

  test('removing the owner takes the embedded nodes, and a reference that names an embedded node stays dangling', () => {
    const x = mk('Leaf'); const watcher = mk('Leaf');
    const r1 = own(x, 'refs', 'Ref');
    both((s) => s.addPair(G, watcher, 'likes', r1));
    sameSet((s) => s.subjectsOf(G, 'likes', r1), [watcher], 'built');
    both((s) => s.removeNode(G, x));
    same((s) => s.record(G, r1), undefined, 'the embedded node went with its owner');
    sameSet((s) => s.values(G, watcher, 'likes'), [r1], 'the reference to it stays');
    sameSet((s) => s.subjectsOf(G, 'likes', r1), [watcher], 'with its bucket');
  });

  test('removeNode of an embedded node keeps the behaviour of the oracle: the owner\'s pair naming it stays', () => {
    const x = mk('Leaf'); const t = mk('Leaf');
    const r1 = own(x, 'refs', 'Ref'); const a1 = own(r1, 'attrs', 'Attr');
    both((s) => s.addPair(G, r1, 'to', t));
    sameSet((s) => s.subjectsOf(G, 'to', t), [r1], 'built');
    both((s) => s.removeNode(G, r1));
    same((s) => [r1, a1].map((id) => s.record(G, id)), [undefined, undefined], 'the node and what it embedded are gone');
    sameSet((s) => s.values(G, x, 'refs'), [r1], 'the owner\'s pair stays, dangling: the shell removes through the owner');
    sameSet((s) => s.subjectsOf(G, 'to', t), [], 'its pairs are gone from the reverse');
    sameSet((s) => s.subjectsOf(G, 'refs', r1), [x], 'the owner\'s bucket for it waits');
  });

  test('the Existence, Enforcement and grammar checks of an embedded value are those of pairs.test.ts, and a Refused one changes nothing', () => {
    const x = mk('Leaf'); const y = mk('Leaf');
    const stranger = embedded(y, 'refs', 'Ref');
    assert.throws(() => e.addPair(G, x, 'refs', stranger), (err: unknown) => err instanceof Refused);
    assert.throws(() => o.addPair(G, x, 'refs', stranger), (err: unknown) => err instanceof OracleRefused);
    same((s) => s.values(G, x, 'refs'), [], 'nothing was added');
  });
});
