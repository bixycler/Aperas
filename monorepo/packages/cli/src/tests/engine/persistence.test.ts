// The engine side of Persistence (planning/core.md, Batch 5; design/core.md, "Persistence"): the build is one operation,
// `build(graph, record)`, made of the create of Batch 4 and the pairs of step 1; the read-out is `record` and
// `idsOfKind`. A graph of references and embedded nodes built on one engine, read out, and built again on a second
// engine in a shuffled order (so that references point at nodes not built yet) gives equal records and equal reverse
// reads, whether the reverse of a field was asked before the second build or after. A build that fails leaves the engine
// as it was. A case of `build` among random operations is in `relations.model.test.ts`.
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, inspectEngine, Refused } from '@aperas/core/apeironNgn/engine';
import type { BuildRecord, Engine, Value } from '@aperas/core/apeironNgn/interface';
import { Oracle } from '../support/oracle.ts';
import { noNode, refusedInShape } from '../support/refusals.ts';
import { checkTree } from '../support/engineTree.ts';
import { TEST_SCHEMA } from '../support/engineSchema.ts';
import { rng } from '../support/prng.ts';

const G = 'default';
const SEEDS = Array.from({ length: 10 }, (_, i) => 501 + i);
const REVERSE_FIELDS = ['likes', 'mate', 'pinned', 'refs', 'to', 'attrs', 'items'];
const FLAKE = [...'0123456789ABCDEFGHJKMNPQRSTVWXYZ'];
let n = 0;
const mint = (kind: string): string => `${kind}:${(++n).toString().padStart(13, '0')}`;

/** A random graph of references and embedded nodes on an engine: gives the ids that may be named, whether or not they exist. */
function randomGraph(seed: number, x: Engine): string[] {
  const g = rng(seed);
  const flake = (): string => Array.from({ length: 13 }, () => g.pick(FLAKE)).join('');
  const tops = ['Leaf', 'Leaf', 'Leaf', 'Stub', 'Stub', 'Box', 'Box', 'Shelf', 'Node', 'Loose'].map((kind) => ({ id: `${kind}:${flake()}`, kind }));
  const all: string[] = tops.map((t) => t.id);
  const embeddedOf: { id: string; kind: string; owner: string; field: string }[] = [];
  for (const t of tops) {
    if (t.kind === 'Loose') continue;
    for (let i = 0; i < 2; i++) {
      const ref = `${t.id}:refs:Ref:${flake()}`;
      embeddedOf.push({ id: ref, kind: 'Ref', owner: t.id, field: 'refs' });
      for (let j = 0; j < 2; j++) embeddedOf.push({ id: `${ref}:attrs:Attr:${flake()}`, kind: 'Attr', owner: ref, field: 'attrs' });
    }
  }
  all.push(...embeddedOf.map((e) => e.id));
  const exists = new Set<string>();
  for (const t of [...tops, ...embeddedOf]) if (g.chance(0.85)) { x.createNode(G, t.id, t.kind); exists.add(t.id); }
  const any = (): string => g.pick(all);
  const declares = (id: string, field: string): boolean => x.schema.kinds.find((k) => k.name === id.split(':').slice(-2)[0])!.fields.some((f) => f.name === field && !f.derived);
  for (const id of exists) {
    for (const f of ['likes', 'pinned']) if (declares(id, f)) for (let i = g.int(4); i > 0; i--) x.addPair(G, id, f, any());
    for (const f of ['mate', 'to']) if (declares(id, f) && g.chance(0.7)) x.addPair(G, id, f, any());
    for (const f of ['refs', 'attrs']) if (declares(id, f)) for (const e of embeddedOf) if (e.owner === id && e.field === f && g.chance(0.7)) x.addPair(G, id, f, e.id);
    if (declares(id, 'label') && g.chance(0.5)) x.addPair(G, id, 'label', `L${g.int(9)}`);
    if (declares(id, 'rank') && g.chance(0.5)) x.addPair(G, id, 'rank', g.int(9));
    if (declares(id, 'k')) { x.addPair(G, id, 'k', 'key'); x.addPair(G, id, 'v', g.int(9)); }
    // A list of items, some of them nodes not built, in an order of its own: a second container and a cycle are left out.
    if (declares(id, 'items')) {
      for (let i = g.int(5); i > 0; i--) {
        try { x.insertItem(G, id, 'items', g.chance(0.7) ? g.pick(tops).id : any(), g.chance(0.3) ? 0 : undefined); } catch (err) { if (!(err instanceof Refused)) throw err; }
      }
    }
  }
  return all;
}

/** The read-out of an engine: the record of every id of every kind, sorted by id. */
function readOut(x: Engine): { id: string; kind: string; fields: { name: string; values: Value[] }[] }[] {
  const out = x.schema.kinds.flatMap((k) => x.idsOfKind(G, k.name)).sort().map((id) => {
    const r = x.record(G, id)!;
    return { id: r.id, kind: r.kind, fields: r.fields.map((f) => ({ name: f.name, values: [...f.values].sort() })) };
  });
  return out;
}

/** The tree the records are arranged in, as `inspectEngine` shows it: for each id its place and the records beneath it, and the roots. */
function treeOf(x: Engine, ids: readonly string[]): unknown {
  const tree = inspectEngine(x);
  return { places: ids.map((id) => [id, tree.treeParentOf(id), tree.nestedIds(id).sort()]), roots: tree.rootIds(G).sort() };
}

/** The reverse reads of an engine, for every field and every id that may be named. */
function reverses(x: Engine, ids: readonly string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const f of REVERSE_FIELDS) for (const v of ids) out[`${f} ${v}`] = x.subjectsOf(G, f, v).sort();
  return out;
}

/** What the build reads: the record as a build record, a single value written as one now and then. */
const asBuild = (r: { id: string; kind: string; fields: { name: string; values: Value[] }[] }, pick: (xs: readonly boolean[]) => boolean): BuildRecord => ({
  id: r.id,
  kind: r.kind,
  fields: Object.fromEntries(r.fields.map((f) => [f.name, f.values.length === 1 && pick([true, false]) ? f.values[0]! : f.values])),
});

describe('the build and the read-out round-trip', () => {
  for (const seed of SEEDS) {
    for (const asked of ['before', 'after'] as const) {
      test(`seed ${seed}: built in a shuffled order, the reverse asked ${asked} the build`, () => {
        const first = createEngine(TEST_SCHEMA);
        const all = randomGraph(seed, first);
        const records = readOut(first);
        assert.ok(records.length > 8, 'a graph with something in it');
        assert.ok(records.some((r) => r.fields.some((f) => f.name === 'likes')), 'with references');
        assert.ok(records.some((r) => r.kind === 'Ref' && r.fields.some((f) => f.name === 'to')), 'and an embedded node that points');

        const g = rng(seed + 1000);
        const second = createEngine(TEST_SCHEMA);
        if (asked === 'before') for (const f of REVERSE_FIELDS) second.countSubjectsOf(G, f, all[0]!);
        let dangling = 0;
        const built = new Set<string>();
        for (const r of g.shuffle(records)) {
          second.build(G, asBuild(r, () => g.chance(0.5)));
          built.add(r.id);
          for (const f of r.fields) if (f.name !== 'label' && f.name !== 'rank' && f.name !== 'k' && f.name !== 'v') for (const v of f.values) if (!built.has(v as string)) dangling++;
        }
        assert.ok(dangling > 0, 'some build named a node not built yet');

        assert.deepEqual(readOut(second), records, 'equal records');
        assert.deepEqual(treeOf(second, all), treeOf(first, all), 'equal trees');
        checkTree(first, all, 'the first engine'); checkTree(second, all, 'the second engine');
        for (const k of first.schema.kinds) assert.deepEqual(second.idsOfKind(G, k.name).sort(), first.idsOfKind(G, k.name).sort(), `the ids of ${k.name}`);
        const universe = [...all, 'zzz'];
        assert.deepEqual(reverses(second, universe), reverses(first, universe), 'equal reverse reads');
        if (asked === 'after') assert.deepEqual(inspectEngine(second).reversesBuilt().sort(), [...REVERSE_FIELDS].sort(), 'built by the reads that came after');
        // the read-out of the second is the same again, once more
        assert.deepEqual(readOut(second), records);
      });
    }
  }
});

describe('the graphs of the round-trip', () => {
  test('hold lists of items, nodes with a container and a tree more than one level deep', () => {
    let lists = 0; let contained = 0; let nested = 0;
    for (const seed of SEEDS) {
      const x = createEngine(TEST_SCHEMA);
      const all = randomGraph(seed, x);
      const records = readOut(x);
      lists += records.filter((r) => r.fields.some((f) => f.name === 'items' && f.values.length > 0)).length;
      contained += records.filter((r) => r.fields.some((f) => f.name === 'up')).length;
      nested += all.filter((id) => inspectEngine(x).treeParentOf(id) !== undefined && inspectEngine(x).treeParentOf(inspectEngine(x).treeParentOf(id)!) !== undefined).length;
    }
    assert.ok(lists >= 10, `lists: ${lists}`);
    assert.ok(contained >= 10, `nodes with a container: ${contained}`);
    assert.ok(nested >= 3, `nodes two levels down: ${nested}`);
  });
});

describe('a build', () => {
  let e: Engine;
  let o: Oracle;
  beforeEach(() => { e = createEngine(TEST_SCHEMA); o = new Oracle(e.schema); });
  const both = (run: (x: Engine) => void): void => { run(e); run(o); };
  const same = <T>(read: (x: Engine) => T, expected: T, why: string): void => {
    assert.deepEqual(read(e), expected, `engine: ${why}`);
    assert.deepEqual(read(o), expected, `oracle: ${why}`);
  };

  /** Everything an engine holds that a reader or a later write could tell: records, collections, reverses, what is built, what waits. */
  const snapshot = (x: Engine, ids: readonly string[]): unknown => ({
    records: readOut(x),
    reverses: reverses(x, ids),
    built: x === e ? inspectEngine(e).reversesBuilt() : [],
    waiting: x === e ? inspectEngine(e).waitingIds() : [],
    tree: x === e ? treeOf(e, ids) : [],
  });

  test('creates the node, sets its fields, and accepts a reference to a node not built yet; the bucket waits and moves when that node is built', () => {
    const a = mint('Leaf'); const b = mint('Leaf');
    reverses(e, [a, b]); // asked before: the registry has built every reverse
    both((x) => x.build(G, { id: a, kind: 'Leaf', fields: { label: 'A', likes: [b], mate: b } }));
    same((x) => x.record(G, b), undefined, 'b is not built');
    same((x) => x.subjectsOf(G, 'likes', b), [a], 'but a is in the reverse for b');
    assert.deepEqual(inspectEngine(e).waitingIds(), [b]);
    both((x) => x.build(G, { id: b, kind: 'Leaf', fields: {} }));
    assert.deepEqual(inspectEngine(e).waitingIds(), []);
    same((x) => x.subjectsOf(G, 'mate', b), [a], 'the same for mate, once b is built');
    same((x) => x.record(G, a)!.fields.map((f) => f.name), ['label', 'likes', 'mate'], 'read out in the schema\'s order');
  });

  test('takes a single value or an array, a repeated value once, and no field at all', () => {
    const a = mint('Leaf'); const b = mint('Leaf'); const c = mint('Leaf'); const empty = mint('Leaf'); const d = mint('Stub');
    both((x) => {
      x.build(G, { id: a, kind: 'Leaf', fields: { likes: b } });
      x.build(G, { id: c, kind: 'Leaf', fields: { likes: [b, b, a] } });
      x.build(G, { id: empty, kind: 'Leaf', fields: { likes: [] } });
      x.build(G, { id: d, kind: 'Stub', fields: {} });
    });
    same((x) => x.values(G, a, 'likes'), [b], 'a single value');
    same((x) => [...x.values(G, c, 'likes')].sort(), [a, b].sort(), 'an array with a repeat');
    same((x) => x.record(G, empty)!.fields, [], 'an empty array holds nothing');
    same((x) => x.record(G, d)!.fields, [], 'no field');
  });

  test('a derived entry the shell supplies is an assertion and never a pair', () => {
    const box = mint('Box');
    both((x) => x.build(G, { id: box, kind: 'Box', fields: { up: 'Box:0000000000001', pinned: [] } }));
    same((x) => x.record(G, box)!.fields, [], 'nothing was stored for up');
  });

  test('an embedded node is built with its owner\'s pair in either order', () => {
    const a = mint('Leaf'); const r = `${a}:refs:Ref:${'0'.repeat(12)}7`; const t = mint('Leaf');
    both((x) => { x.build(G, { id: r, kind: 'Ref', fields: { to: t } }); x.build(G, { id: a, kind: 'Leaf', fields: { refs: r } }); });
    same((x) => x.values(G, a, 'refs'), [r], 'held');
    same((x) => x.subjectsOf(G, 'to', t), [r], 'and the link-shaped node points');
    same((x) => x.subjectsOf(G, 'refs', r), [a], 'the owner is its subject');
  });

  test('the errors are the oracle\'s, in the same order: the create first, then each field in the order given', () => {
    const a = mint('Leaf'); const taken = mint('Leaf'); const stranger = `${mint('Leaf')}:refs:Ref:${'0'.repeat(12)}8`;
    both((x) => x.createNode(G, taken, 'Leaf'));
    const cases: [string, BuildRecord, (err: unknown) => boolean][] = [
      ['a taken id', { id: taken, kind: 'Leaf', fields: { likes: 'x' } }, refusedInShape],
      ['a bad id', { id: 'Leaf:1', kind: 'Leaf', fields: {} }, refusedInShape],
      ['a kind that is not the id\'s', { id: a, kind: 'Box', fields: {} }, refusedInShape],
      ['a field the kind does not declare', { id: a, kind: 'Leaf', fields: { likes: 'x', nonsense: 'y' } }, refusedInShape],
      ['a field the kind does not declare, with no value', { id: a, kind: 'Leaf', fields: { likes: 'x', nonsense: [] } }, refusedInShape],
      ['a second value for an optional field', { id: a, kind: 'Leaf', fields: { likes: 'x', mate: ['p', 'q'] } }, refusedInShape],
      ['a value of the wrong sort in a later field', { id: a, kind: 'Leaf', fields: { likes: 'x', mate: 'p', rank: {} as unknown as Value } }, refusedInShape],
      ['a number for a reference field', { id: a, kind: 'Leaf', fields: { likes: 4 as unknown as Value } }, refusedInShape],
      ['an embedded id of another owner', { id: a, kind: 'Leaf', fields: { label: 'L', refs: stranger } }, refusedInShape],
    ];
    for (const [why, record, check] of cases) {
      assert.throws(() => e.build(G, record), check, `engine: ${why}`);
      assert.throws(() => o.build(G, record), check, `oracle: ${why}`);
    }
    same((x) => x.record(G, a), undefined, 'none of them left a node');
  });

  test('an ordered field is built in the order of its array, and a value repeated is kept once at its first place', () => {
    const box = mint('Box'); const [a, b, c] = [mint('Leaf'), mint('Leaf'), mint('Stub')];
    const record: BuildRecord = { id: box, kind: 'Box', fields: { pinned: a, items: [c, a, c, b, a] } };
    both((x) => x.build(G, record));
    same((x) => x.values(G, box, 'items'), [c, a, b], 'the first place of each');
    same((x) => x.record(G, box)!.fields, [{ name: 'items', values: [c, a, b] }, { name: 'pinned', values: [a] }], 'and in the read-out, in the order of the schema');
  });

  for (const asked of ['unbuilt', 'built'] as const) {
    test(`a build that fails halfway leaves the engine as it was, with the reverses ${asked}`, () => {
      const ids = [mint('Leaf'), mint('Leaf'), mint('Box'), mint('Stub'), mint('Box')];
      const [a, b, box, stub, box2] = ids as [string, string, string, string, string]; // box2 is listed by box and not built
      const r = `${a}:refs:Ref:${'0'.repeat(12)}9`;
      for (const x of [e, o]) {
        x.createNode(G, a, 'Leaf'); x.createNode(G, b, 'Leaf'); x.createNode(G, box, 'Box'); x.createNode(G, r, 'Ref');
        x.addPair(G, a, 'likes', b); x.addPair(G, box, 'pinned', a); x.addPair(G, a, 'refs', r); x.addPair(G, r, 'to', b);
        x.insertItem(G, box, 'items', b); x.insertItem(G, box, 'items', box2);
      }
      const universe = [...ids, r, 'zzz'];
      if (asked === 'built') reverses(e, universe);
      const before = snapshot(e, universe);
      const failing: [string, BuildRecord][] = [
        ['a second value for a one field', { id: `Ref:${'0'.repeat(12)}A`, kind: 'Ref', fields: { to: [a, b] } }],
        ['a value of the wrong sort in a later field', { id: stub, kind: 'Stub', fields: { likes: [a, b], mate: a, rank: {} as unknown as Value } }],
        ['a taken id', { id: a, kind: 'Leaf', fields: { likes: [b] } }],
        ['a second value for an optional field after good fields', { id: stub, kind: 'Stub', fields: { likes: [a, b, box], mate: [a, b] } }],
        ['a field the kind does not declare, last', { id: stub, kind: 'Stub', fields: { likes: [a], mate: b, pinned: [a] } }],
        ['an embedded value of another owner', { id: stub, kind: 'Stub', fields: { likes: a, refs: [`${b}:refs:Ref:${'0'.repeat(12)}B`] } }],
        ['a second container', { id: box2, kind: 'Box', fields: { pinned: a, items: [stub, b] } }],
        ['a cycle through the waiting bucket of the host', { id: box2, kind: 'Box', fields: { items: [a, box] } }],
        ['the host in its own list', { id: box2, kind: 'Box', fields: { items: [a, box2] } }],
        ['an item of the wrong sort in a later field', { id: box2, kind: 'Box', fields: { items: [a, stub], note: {} as unknown as Value } }],
        ['a taken id with a list', { id: box, kind: 'Box', fields: { items: [stub] } }],
      ];
      for (const [why, record] of failing) {
        assert.throws(() => e.build(G, record), Error, `engine: ${why}`);
        assert.throws(() => o.build(G, record), Error, `oracle: ${why}`);
        let errorOfEngine: unknown; let errorOfOracle: unknown;
        try { e.build(G, record); } catch (err) { errorOfEngine = err; }
        try { o.build(G, record); } catch (err) { errorOfOracle = err; }
        assert.equal((errorOfEngine as Error).name, (errorOfOracle as Error).name, `${why}: the same class of error`);
        assert.equal(noNode(errorOfEngine), noNode(errorOfOracle), `${why}: the same rule`);
        assert.deepEqual(snapshot(e, universe), before, `engine: ${why}: the engine is as it was`);
        assert.deepEqual(readOut(o), readOut(e), `${why}: the oracle too`);
      }
    });
  }
});
