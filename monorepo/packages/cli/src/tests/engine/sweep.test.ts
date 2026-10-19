// The sweep (planning/core.md, Batch 7 step 3; design/core.md, "The sweep"): `sweep(graph)` deletes outright every tombstone that
// the mark from the live nodes of the root kinds, through the followed fields, does not reach, and gives the ids it removed,
// sorted by code point. Hand-written cases, each given to the engine and the oracle. The random sequences are in
// `tombstone.model.test.ts`.
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, inspectEngine, Refused, Undecided } from '@aperas/core/apeironNgn/engine';
import type { Engine } from '@aperas/core/apeironNgn/interface';
import type { SchemaSpec } from '@aperas/core/apeironNgn/schema';
import { APERAS_SCHEMA } from '@aperas/core/shell/aperasSchema';
import { Oracle, Refused as OracleRefused, Undecided as OracleUndecided } from '../support/oracle.ts';
import { TEST_SCHEMA } from '../support/engineSchema.ts';
import { checkTree } from '../support/engineTree.ts';

const G = 'default';
const AT = '2026-10-16T00:00:00Z';
let n = 0;
const mint = (kind: string): string => `${kind}:${(++n).toString().padStart(13, '0')}`;
const embedded = (owner: string, field: string, kind: string): string => `${owner}:${field}:${mint(kind)}`;

let e: Engine;
let o: Oracle;
const mk = (kind: string): string => { const id = mint(kind); e.createNode(G, id, kind); o.createNode(G, id, kind); return id; };
/** A tombstone: a node made and tombstoned. */
const dead = (kind: string): string => { const id = mk(kind); both((s) => s.tombstone(G, id, AT)); return id; };
/** An embedded node made and held by its owner. */
const own = (owner: string, field: string, kind: string): string => { const id = embedded(owner, field, kind); e.createNode(G, id, kind); o.createNode(G, id, kind); e.addPair(G, owner, field, id); o.addPair(G, owner, field, id); return id; };
/** A `Ref` of `owner` that names `to`. */
const refTo = (owner: string, to: string): string => { const r = own(owner, 'refs', 'Ref'); both((s) => s.addPair(G, r, 'to', to)); return r; };
const both = (run: (x: Engine) => void): void => { run(e); run(o); };
const sorted = (xs: readonly string[]): string[] => [...xs].sort();
const same = <T>(read: (x: Engine) => T, expected: T, why: string): void => {
  assert.deepEqual(read(e), expected, `engine: ${why}`);
  assert.deepEqual(read(o), expected, `oracle: ${why}`);
};
const sameSet = (read: (x: Engine) => readonly (string | number | boolean)[], expected: string[], why: string): void => same((x) => sorted(read(x) as string[]), sorted(expected), why);
const undecided = (point: string) => (err: unknown): boolean => (err instanceof Undecided && err.point === point) || (err instanceof OracleUndecided && err.point === point);
const bothThrow = (run: (x: Engine) => void, check: (err: unknown) => boolean, why: string): void => {
  assert.throws(() => run(e), check, `engine: ${why}`);
  assert.throws(() => run(o), check, `oracle: ${why}`);
};
/** Both sweep the default graph and give the same ids, sorted. */
const sweep = (): string[] => {
  const got = e.sweep(G);
  assert.deepEqual(o.sweep(G), got, 'the oracle gave other ids');
  return got;
};
const exists = (id: string): [boolean, boolean] => [e.record(G, id) !== undefined, o.record(G, id) !== undefined];
const snapshot = (x: Engine, ids: readonly string[]) => ({ records: ids.map((id) => x.record(G, id)), kinds: x.schema.kinds.map((k) => sorted(x.idsOfKind(G, k.name))) });

beforeEach(() => { e = createEngine(TEST_SCHEMA); o = new Oracle(e.schema); });

describe('sweep', () => {
  test('a tombstone that nothing reaches is swept and returned; a live node is never swept', () => {
    const box = mk('Box'); const live = mk('Leaf'); const gone = dead('Leaf');
    both((s) => s.insertItem(G, box, 'items', live));
    assert.deepEqual(sweep(), [gone]);
    same((s) => [s.record(G, gone), s.idsOfKind(G, 'Leaf')], [undefined, [live]], 'gone from record and from its collection');
    assert.deepEqual(exists(live), [true, true]);
  });

  test('a tombstone that a live root reaches through a followed field survives: items, and refs to a Ref whose to names it', () => {
    const box = mk('Box'); const viaItems = dead('Leaf'); const viaRef = dead('Stub'); const unreached = dead('Leaf');
    both((s) => s.insertItem(G, box, 'items', viaItems));
    refTo(box, viaRef);
    assert.deepEqual(sweep(), [unreached]);
    assert.deepEqual([exists(viaItems), exists(viaRef)], [[true, true], [true, true]]);
  });

  test('one reached only through a field that is not followed (likes, mate) is swept, and the reference stays naming no record', () => {
    const box = mk('Box'); const watcher = mk('Leaf'); const a = dead('Leaf'); const b = dead('Leaf');
    both((s) => { s.insertItem(G, box, 'items', watcher); s.addPair(G, watcher, 'likes', a); s.addPair(G, watcher, 'mate', b); });
    sameSet((s) => s.subjectsOf(G, 'likes', a), [watcher], 'built');
    sameSet((s) => s.subjectsOf(G, 'mate', b), [watcher], 'built too');
    assert.deepEqual(sweep(), sorted([a, b]));
    sameSet((s) => s.values(G, watcher, 'likes'), [a], 'the likes stays');
    sameSet((s) => s.values(G, watcher, 'mate'), [b], 'and the mate');
    sameSet((s) => s.subjectsOf(G, 'likes', a), [watcher], 'with its bucket');
    assert.deepEqual(sorted(inspectEngine(e).waitingIds()), sorted([a, b]), 'which waits in the waiting map, read as no existence');
    bothThrow((s) => s.exists(G, a), undecided('Existence'), 'exists stays undecided');
  });

  test('the mark goes through a tombstone: a chain from a live root to a tombstone to a tombstone keeps both', () => {
    const box = mk('Box'); const t1 = dead('Leaf'); const t2 = dead('Leaf'); const t3 = dead('Leaf');
    both((s) => s.insertItem(G, box, 'items', t1));
    refTo(t1, t2); refTo(t2, t3);
    assert.deepEqual(sweep(), []);
    assert.deepEqual([t1, t2, t3].map(exists), [[true, true], [true, true], [true, true]]);
    both((s) => s.removeItem(G, box, 'items', t1));
    assert.deepEqual(sweep(), sorted([t1, t2, t3]), 'cut at the root, the whole chain goes');
  });

  test('an island of two and an island of three (a cycle a count of references would keep) are swept', () => {
    const box = mk('Box'); const live = mk('Leaf');
    both((s) => s.insertItem(G, box, 'items', live));
    const a = dead('Leaf'); const b = dead('Leaf'); const c = dead('Leaf'); const d = dead('Leaf'); const f = dead('Leaf');
    refTo(a, b); refTo(b, a);
    refTo(c, d); refTo(d, f); refTo(f, c);
    assert.deepEqual(sweep(), sorted([a, b, c, d, f]));
    same((s) => [a, b, c, d, f].map((id) => s.record(G, id)), [undefined, undefined, undefined, undefined, undefined], 'all gone');
    same((s) => s.idsOfKind(G, 'Ref'), [], 'with their embedded nodes');
  });

  test('a tombstone built with references (the marker among its fields) is swept with its pairs and its embedded nodes', () => {
    const t = mint('Leaf'); const y = mk('Leaf'); const r1 = embedded(t, 'refs', 'Ref');
    both((s) => {
      s.build(G, { id: r1, kind: 'Ref', fields: { to: y } });
      s.build(G, { id: t, kind: 'Leaf', fields: { label: 't', retiredAt: AT, likes: y, refs: r1 } });
    });
    sameSet((s) => s.subjectsOf(G, 'likes', y), [t], 'built: it holds a reference');
    assert.deepEqual(sweep(), [t]);
    same((s) => [s.record(G, t), s.record(G, r1)], [undefined, undefined], 'both gone');
    sameSet((s) => s.subjectsOf(G, 'likes', y), [], 'its pair is out of the reverse');
    sameSet((s) => s.subjectsOf(G, 'to', y), [], 'and its embedded node\'s');
  });

  test('a tombstone referenced only by a live node of no root kind, in no followed field, is swept', () => {
    const lone = mk('Leaf'); const t = dead('Leaf');
    refTo(lone, t);
    assert.deepEqual(sweep(), [t]);
    assert.deepEqual(exists(lone), [true, true]);
  });

  test('the ids come back sorted and a second sweep gives none', () => {
    const ids = Array.from({ length: 8 }, () => dead('Leaf')).reverse();
    const first = sweep();
    assert.deepEqual(first, sorted(ids));
    assert.deepEqual(sweep(), []);
  });

  test('the live records are unchanged but for the entries dropped with their target; a swept tombstone is gone from every read; its bucket waits', () => {
    const box = mk('Box'); const live = mk('Leaf'); const watcher = mk('Leaf'); const t = dead('Leaf'); const keep = dead('Leaf');
    both((s) => { s.insertItem(G, box, 'items', live); s.insertItem(G, box, 'items', keep); s.insertItem(G, box, 'items', watcher); s.addPair(G, box, 'pinned', t); s.addPair(G, box, 'pinned', keep); s.addPair(G, watcher, 'likes', t); s.addPair(G, live, 'label', 'l'); });
    const before = [e, o].map((s) => snapshot(s, [box, live, watcher, keep]));
    assert.deepEqual(sweep(), [t]);
    const after = [e, o].map((s) => snapshot(s, [box, live, watcher, keep]));
    // The box lost one entry of pinned: nothing else differs.
    for (const k of [0, 1]) {
      assert.deepEqual(after[k]!.records.slice(1), before[k]!.records.slice(1), 'the other live records are the same');
      assert.deepEqual(after[k]!.records[0]!.fields.map((f) => f.name), before[k]!.records[0]!.fields.map((f) => f.name));
    }
    sameSet((s) => s.values(G, box, 'pinned'), [keep], 'the entry that named the swept is dropped, the other stays');
    sameSet((s) => s.subjectsOf(G, 'pinned', t), [], 'the reverse of pinned');
    same((s) => [s.record(G, t), s.idsOfKind(G, 'Leaf').includes(t)], [undefined, false], 'record and collection');
    sameSet((s) => s.subjectsOf(G, 'likes', t), [watcher], 'the bucket of the pair that names it');
    assert.deepEqual(inspectEngine(e).waitingIds(), [t], 'is in the waiting map');
    assert.deepEqual(after[0], after[1], 'and the oracle agrees');
    bothThrow((s) => s.size(G), undecided('Existence'), 'size stays undecided');
    checkTree(e, [box, live, watcher, keep, t], 'after');
  });

  test('a swept tombstone created again starts with the incoming references that are still there', () => {
    const watcher = mk('Leaf'); const t = dead('Leaf');
    both((s) => s.addPair(G, watcher, 'likes', t));
    assert.deepEqual(sweep(), [t]);
    both((s) => s.createNode(G, t, 'Leaf'));
    sameSet((s) => s.subjectsOf(G, 'likes', t), [watcher], 'the reference is still there');
    assert.deepEqual(inspectEngine(e).waitingIds(), [], 'the bucket moved onto the new record');
    same((s) => s.first(G, t, 'retiredAt'), undefined, 'and the new node is live');
  });

  test('a sweep with nothing to do changes nothing, builds no reverse, and the sweep of a tombstone that embeds builds the removal\'s', () => {
    const box = mk('Box'); const live = mk('Leaf');
    both((s) => s.insertItem(G, box, 'items', live));
    const before = snapshot(e, [box, live]);
    assert.deepEqual(sweep(), []);
    assert.deepEqual(snapshot(e, [box, live]), before);
    assert.deepEqual(inspectEngine(e).reversesBuilt(), ['items'], 'only what the writes built');
    dead('Leaf');
    assert.deepEqual(sweep().length, 1);
    assert.deepEqual(inspectEngine(e).reversesBuilt(), ['items', 'pinned'], 'the first removal builds the field dropped with its target');
  });

  test('the three refusals, in their order: the graph, the sweep role, the tombstone role', () => {
    const noSweep: SchemaSpec = { kinds: TEST_SCHEMA.kinds, roles: { tombstone: 'retiredAt', containment: 'items' } };
    const neither: SchemaSpec = { kinds: TEST_SCHEMA.kinds };
    const noMarker: SchemaSpec = { kinds: TEST_SCHEMA.kinds, roles: { containment: 'items', sweep: { roots: ['Box'], follow: ['items'] } } };
    const message = (re: RegExp) => (err: unknown): boolean => (err instanceof Refused || err instanceof OracleRefused) && re.test(err.message);
    for (const [spec, graph, re] of [[neither, 'elsewhere', /no graph/], [neither, G, /no sweep/], [noSweep, G, /no sweep/], [noMarker, G, /no tombstone marker/], [noMarker, 'elsewhere', /no graph/]] as const) {
      const x = createEngine(spec); const y = new Oracle(x.schema);
      assert.throws(() => x.sweep(graph), message(re), `engine: ${re}`);
      assert.throws(() => y.sweep(graph), message(re), `oracle: ${re}`);
    }
    bothThrow((s) => s.sweep('elsewhere'), message(/no graph/), 'an unknown graph');
  });

  test('an inline schema with a root kind that has a descendant kind: the descendants are roots too', () => {
    const spec: SchemaSpec = {
      kinds: [
        { name: 'Base', fields: [{ name: 'gone', storage: 'literal', cardinality: 'optional' }, { name: 'kids', storage: 'reference', cardinality: 'set' }] },
        { name: 'Sub', extends: 'Base', fields: [] },
        { name: 'SubSub', extends: 'Sub', fields: [] },
        { name: 'Outside', fields: [{ name: 'gone', storage: 'literal', cardinality: 'optional' }, { name: 'kids', storage: 'reference', cardinality: 'set' }] },
      ],
      roles: { tombstone: 'gone', sweep: { roots: ['Sub'], follow: ['kids'] } },
    };
    const x = createEngine(spec); const y = new Oracle(x.schema);
    const [sub, subsub, base, outside, a, b, c, d] = ['Sub', 'SubSub', 'Base', 'Outside', 'Base', 'Base', 'Base', 'Base'].map(mint);
    for (const s of [x, y]) {
      for (const [id, kind] of [[sub, 'Sub'], [subsub, 'SubSub'], [base, 'Base'], [outside, 'Outside'], [a, 'Base'], [b, 'Base'], [c, 'Base'], [d, 'Base']] as const) s.createNode(G, id!, kind);
      s.addPair(G, sub!, 'kids', a!); s.addPair(G, subsub!, 'kids', b!); s.addPair(G, base!, 'kids', c!); s.addPair(G, outside!, 'kids', d!);
      for (const id of [a, b, c, d]) s.addPair(G, id!, 'gone', 'T');
    }
    assert.deepEqual(x.sweep(G), sorted([c!, d!]), 'a Sub and a SubSub are roots; a Base above the root kind and an Outside are not');
    assert.deepEqual(y.sweep(G), sorted([c!, d!]));
  });

  test('with the Aperas schema: an artifact, its folder and blocks; a Link whose target is a tombstoned block keeps it, one not linked is swept', () => {
    const a = createEngine(APERAS_SCHEMA); const b = new Oracle(a.schema);
    const dir = mint('FolderNode'); const art = mint('ArtifactNode'); const live = mint('BlockNode'); const kept = mint('BlockNode'); const lost = mint('BlockNode'); const lostKid = mint('BlockNode'); const tombArt = mint('ArtifactNode');
    const link = embedded(live, 'links', 'Link'); const prop = embedded(lost, 'props', 'StringProp');
    for (const s of [a, b]) {
      for (const [id, kind] of [[dir, 'FolderNode'], [art, 'ArtifactNode'], [live, 'BlockNode'], [kept, 'BlockNode'], [lost, 'BlockNode'], [lostKid, 'BlockNode'], [tombArt, 'ArtifactNode'], [link, 'Link'], [prop, 'StringProp']] as const) s.createNode(G, id, kind);
      s.addPair(G, dir, 'children', art); s.addPair(G, art, 'children', live); s.addPair(G, live, 'links', link); s.addPair(G, link, 'target', kept);
      s.addPair(G, lost, 'props', prop); s.addPair(G, lost, 'children', lostKid);
      s.tombstone(G, kept, AT); s.tombstone(G, lost, AT); s.tombstone(G, tombArt, AT);
    }
    // `lost` has been tombstoned, so its children and props went; the kid stays live and detached.
    const swept = [a.sweep(G), b.sweep(G)];
    assert.deepEqual(swept[0], sorted([lost, tombArt]));
    assert.deepEqual(swept[1], swept[0]);
    for (const s of [a, b]) {
      assert.deepEqual([dir, art, live, kept, link, lostKid].map((id) => s.record(G, id) !== undefined), [true, true, true, true, true, true], 'the live nodes, the linked tombstone and the detached kid stay');
      assert.deepEqual([lost, tombArt].map((id) => s.record(G, id)), [undefined, undefined]);
    }
  });

  test('a chain of 5,000 containers is marked with no stack overflow, and a tombstone at its end survives; another is swept', () => {
    const x = createEngine(TEST_SCHEMA);
    const ids = Array.from({ length: 5000 }, () => mint('Box'));
    for (const id of ids) x.createNode(G, id, 'Box');
    for (let i = ids.length - 2; i >= 0; i--) x.insertItem(G, ids[i]!, 'items', ids[i + 1]!);
    const end = ids[ids.length - 1]!;
    const kept = mint('Leaf'); const lost = mint('Leaf');
    for (const id of [kept, lost]) { x.createNode(G, id, 'Leaf'); x.tombstone(G, id, AT); }
    const r = embedded(end, 'refs', 'Ref'); x.createNode(G, r, 'Ref'); x.addPair(G, end, 'refs', r); x.addPair(G, r, 'to', kept);
    assert.deepEqual(x.sweep(G), [lost]);
    assert.ok(x.record(G, kept) !== undefined, 'the tombstone at the end of the chain is reached');
    assert.equal(x.idsOfKind(G, 'Box').length, 5000, 'and no box is touched');
  });
});
