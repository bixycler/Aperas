// The model-based test of containment (planning/core.md, Batch 6 Done when and Layer 2): the engine and the oracle get the same
// seeded random sequence of operations over the ordered, partitioning field `items` (every kind of splice, the generic writes,
// moves across containers, writes that must be refused, removals of hosts and of listed nodes, builds in a shuffled order) and what
// they answer is compared after every operation. A check independent of the oracle runs after every operation too: a node has a
// single container, there is no cycle, `up` is the host whose list holds the node, the place of each item is its index, the reverse
// of `items` is the hosts whose lists hold the node, and the tree of the records is what the lists say. A failing run names its
// seed and the operation, and the seed replays it.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '@aperas/core/apeironNgn/engine';
import type { BuildRecord, Engine, Value } from '@aperas/core/apeironNgn/interface';
import { Oracle } from '../support/oracle.ts';
import { noNode } from '../support/refusals.ts';
import { TEST_SCHEMA } from '../support/engineSchema.ts';
import { checkTree } from '../support/engineTree.ts';
import { rng } from '../support/prng.ts';

const G = 'default';
const SEEDS = Array.from({ length: 20 }, (_, i) => 701 + i);
const LENGTH = 250;
/** Every twelfth operation compares the whole state of both implementations; the others compare what the operation touched. */
const FULL_EVERY = 12;

type Op =
  | { op: 'createNode'; id: string; kind: string }
  | { op: 'insertItem'; host: string; item: Value; at?: number }
  | { op: 'moveItem'; host: string; item: string; to: number }
  | { op: 'removeItem'; host: string; item: string }
  | { op: 'addPair' | 'removePair'; host: string; item: string }
  | { op: 'clearField'; host: string }
  | { op: 'write'; host: string; items: string[] } // a clear, then an add of each
  | { op: 'xmove'; from: string; to: string; item: string; at?: number } // a removeItem, then an insertItem
  | { op: 'removeNode'; id: string }
  | { op: 'build'; record: BuildRecord }
  | { op: 'items' | 'values' | 'first' | 'upValues' | 'upFirst'; host: string }
  | { op: 'placeOf'; host: string; item: string }
  | { op: 'subjectsOf' | 'firstSubjectOf' | 'countSubjectsOf'; item: string }
  | { op: 'idsOfKind'; kind: string }
  | { op: 'record'; id: string }
  | { op: 'outside'; host: string; item: string; how: number };

/** What an operation gave: a value, or the class of the error it threw, and the rule that refused it when it is the existence of the subject. */
type Outcome = { value: unknown } | { error: string; rule?: string };

function run(x: Engine, o: Op): Outcome {
  try {
    switch (o.op) {
      case 'createNode': x.createNode(G, o.id, o.kind); return { value: undefined };
      case 'insertItem': x.insertItem(G, o.host, 'items', o.item as string, o.at); return { value: undefined };
      case 'moveItem': x.moveItem(G, o.host, 'items', o.item, o.to); return { value: undefined };
      case 'removeItem': x.removeItem(G, o.host, 'items', o.item); return { value: undefined };
      case 'addPair': x.addPair(G, o.host, 'items', o.item); return { value: undefined };
      case 'removePair': x.removePair(G, o.host, 'items', o.item); return { value: undefined };
      case 'clearField': x.clearField(G, o.host, 'items'); return { value: undefined };
      case 'write': x.clearField(G, o.host, 'items'); for (const i of o.items) x.addPair(G, o.host, 'items', i); return { value: undefined };
      case 'xmove': x.removeItem(G, o.from, 'items', o.item); x.insertItem(G, o.to, 'items', o.item, o.at); return { value: undefined };
      case 'removeNode': x.removeNode(G, o.id); return { value: undefined };
      case 'build': x.build(G, o.record); return { value: undefined };
      case 'items': return { value: x.items(G, o.host, 'items') };
      case 'values': return { value: x.values(G, o.host, 'items') };
      case 'first': return { value: x.first(G, o.host, 'items') };
      case 'upValues': return { value: x.values(G, o.host, 'up') };
      case 'upFirst': return { value: x.first(G, o.host, 'up') };
      case 'placeOf': return { value: x.placeOf(G, o.host, 'items', o.item) };
      case 'subjectsOf': return { value: x.subjectsOf(G, 'items', o.item).sort() };
      case 'firstSubjectOf': return { value: x.firstSubjectOf(G, 'items', o.item) };
      case 'countSubjectsOf': return { value: x.countSubjectsOf(G, 'items', o.item) };
      case 'idsOfKind': return { value: x.idsOfKind(G, o.kind).sort() };
      case 'record': return { value: x.record(G, o.id) };
      case 'outside': {
        // Outside the shape: a field the kind does not declare, a derived entry, an item that is no string, a field that is not ordered.
        if (o.how === 0) x.insertItem(G, o.host, 'nonsense', o.item);
        else if (o.how === 1) x.insertItem(G, o.host, 'up', o.item);
        else if (o.how === 2) x.insertItem(G, o.host, 'items', 7 as unknown as string);
        else if (o.how === 3) x.insertItem(G, o.host, 'pinned', o.item);
        else if (o.how === 4) x.moveItem(G, o.host, 'likes', o.item, 0);
        else x.addPair(G, o.host, 'items', false);
        return { value: undefined };
      }
    }
  } catch (e) {
    const err = e as Error;
    return { error: err.name, ...(noNode(err) ? { rule: 'no node' } : {}) };
  }
}

function same(a: unknown, b: unknown, message: () => string): void {
  if (JSON.stringify(a) !== JSON.stringify(b)) assert.deepEqual(a, b, message());
}

const FLAKE = [...'0123456789ABCDEFGHJKMNPQRSTVWXYZ'];
const kindOf = (id: string): string => id.split(':').slice(-2)[0]!;

interface Plan { readonly all: readonly string[]; readonly ops: readonly Op[] }

function generate(seed: number): Plan {
  const g = rng(seed);
  const flake = (): string => Array.from({ length: 13 }, () => g.pick(FLAKE)).join('');
  const boxes = Array.from({ length: 6 }, () => `Box:${flake()}`);
  const leaves = [...Array.from({ length: 7 }, () => `Leaf:${flake()}`), ...Array.from({ length: 3 }, () => `Stub:${flake()}`)];
  const ghosts = Array.from({ length: 3 }, () => `Leaf:${flake()}`); // ids that never get a record
  const all = [...boxes, ...leaves, ...ghosts];
  const creatable = [...boxes, ...leaves];

  const closed = createEngine(TEST_SCHEMA).schema;
  const probe = new Oracle(closed);
  const ops: Op[] = [];
  const record = (o: Op): void => { ops.push(o); run(probe, o); };
  const exists = (id: string): boolean => probe.record(G, id) !== undefined;
  const liveBoxes = (): string[] => boxes.filter(exists);
  const listOf = (box: string): string[] => (kindOf(box) === 'Box' && exists(box) ? probe.items(G, box, 'items') : []);
  const containerOf = (id: string): string | undefined => (exists(id) ? probe.first(G, id, 'up') as string | undefined : undefined);
  const listed = (): string[] => liveBoxes().flatMap(listOf);
  const free = (): string[] => all.filter((id) => !listed().includes(id));
  const anyBox = (): string => g.pick(g.chance(0.9) && liveBoxes().length > 0 ? liveBoxes() : boxes);
  const itemFor = (): string => g.pick(g.chance(0.6) && free().length > 0 ? free() : all);
  const descendants = (box: string): string[] => listOf(box).flatMap((i) => [i, ...descendants(i)]);
  const place = (len: number, valid: number): number | undefined => {
    const roll = g.int(10);
    if (roll < 3) return undefined;
    if (roll < valid) return g.int(len + 1);
    return g.pick([-1, len + 1, len + 2, 0.5, Number.NaN]);
  };
  const target = (len: number): number => (g.chance(0.8) ? g.int(Math.max(len, 1)) : g.pick([-1, len, len + 1, 1.5]));

  while (ops.length < LENGTH) {
    const t = g.int(100);
    if (t < 14) { // a creation, a few with a kind that is not the id's
      const id = g.pick(creatable);
      const roll = g.int(100);
      record({ op: 'createNode', id, kind: roll < 92 ? kindOf(id) : g.pick(['Box', 'Leaf', 'Stub', 'Ref']) });
    } else if (t < 30) {
      const host = anyBox();
      record({ op: 'insertItem', host, item: itemFor(), at: place(listOf(host).length, 8) });
    } else if (t < 38) {
      const host = anyBox(); const list = listOf(host);
      record({ op: 'moveItem', host, item: g.chance(0.85) && list.length > 0 ? g.pick(list) : g.pick(all), to: target(list.length) });
    } else if (t < 46) {
      const host = anyBox(); const list = listOf(host);
      record({ op: 'removeItem', host, item: g.chance(0.8) && list.length > 0 ? g.pick(list) : g.pick(all) });
    } else if (t < 50) {
      record({ op: 'addPair', host: anyBox(), item: itemFor() });
    } else if (t < 53) {
      const host = anyBox(); const list = listOf(host);
      record({ op: 'removePair', host, item: g.chance(0.75) && list.length > 0 ? g.pick(list) : g.pick(all) });
    } else if (t < 55) {
      record({ op: 'clearField', host: anyBox() });
    } else if (t < 58) {
      record({ op: 'write', host: anyBox(), items: Array.from({ length: g.int(4) }, itemFor) });
    } else if (t < 64) { // a move across containers: out of the one, into the other
      const withContainer = listed();
      if (withContainer.length === 0) continue;
      const item = g.pick(withContainer);
      const from = containerOf(item) ?? anyBox(); const to = anyBox();
      record({ op: 'xmove', from, to, item, at: place(listOf(to).length, 8) });
    } else if (t < 68) { // a direct insertion into a second container: refused while the first still lists it
      const withContainer = listed();
      if (withContainer.length === 0) continue;
      const item = g.pick(withContainer);
      const other = g.pick(boxes.filter((b) => b !== containerOf(item)));
      record({ op: 'insertItem', host: other, item });
    } else if (t < 72) { // a cycle: a box into one of its own descendants, or into itself
      const withDescendant = liveBoxes().filter((b) => descendants(b).some((d) => boxes.includes(d) && exists(d)));
      if (withDescendant.length === 0 || g.chance(0.15)) { const b = anyBox(); record({ op: g.pick(['insertItem', 'addPair'] as const), host: b, item: b } as Op); continue; }
      const top = g.pick(withDescendant);
      const below = g.pick(descendants(top).filter((d) => boxes.includes(d) && exists(d)));
      record(g.chance(0.5) ? { op: 'insertItem', host: below, item: top } : { op: 'addPair', host: below, item: top });
    } else if (t < 78) {
      const roll = g.int(10);
      const pool = roll < 3 ? liveBoxes() : roll < 8 ? listed() : all;
      record({ op: 'removeNode', id: pool.length > 0 ? g.pick(pool) : g.pick(all) });
    } else if (t < 83) { // a build of an absent host with its items in a random order, among them nodes that nest or close a cycle
      const absent = creatable.filter((id) => !exists(id));
      const id = absent.length > 0 && g.chance(0.9) ? g.pick(absent) : g.pick(creatable);
      const fields: Record<string, Value | readonly Value[]> = {};
      if (kindOf(id) === 'Box') fields.items = g.shuffle(all.filter(() => g.chance(0.25))).slice(0, 5).concat(g.chance(0.15) ? [id] : []);
      if (g.chance(0.3)) fields.note = 'n';
      if (kindOf(id) !== 'Box' && g.chance(0.2)) fields.up = g.pick(boxes); // a derived entry the shell supplies: an assertion, never a pair
      if (g.chance(0.05)) fields.items = [g.pick(all), 7 as unknown as string];
      record({ op: 'build', record: { id, kind: kindOf(id), fields } });
    } else if (t < 85) {
      record({ op: 'outside', host: g.pick(g.chance(0.5) ? boxes : leaves), item: g.pick(all), how: g.int(6) });
    } else { // reads
      const r = g.int(10);
      const host = g.chance(0.9) ? anyBox() : g.pick(all);
      if (r === 0) record({ op: g.pick(['items', 'values', 'first'] as const), host });
      else if (r === 1 || r === 9) record({ op: g.pick(['upValues', 'upFirst'] as const), host: g.chance(0.6) && listed().length > 0 ? g.pick(listed()) : g.pick(g.chance(0.9) ? [...leaves, ...boxes] : all) });
      else if (r === 2) record({ op: 'placeOf', host, item: g.chance(0.8) && listOf(host).length > 0 ? g.pick(listOf(host)) : g.pick(all) });
      else if (r < 5) record({ op: g.pick(['subjectsOf', 'firstSubjectOf', 'countSubjectsOf'] as const), item: g.pick(g.chance(0.7) && listed().length > 0 ? listed() : all) });
      else if (r === 5) record({ op: 'idsOfKind', kind: g.pick(['Box', 'Leaf', 'Stub']) });
      else record({ op: 'record', id: g.pick(g.chance(0.9) ? creatable : all) });
    }
  }
  return { all, ops };
}

/** The ids an operation names, which the comparison after it reads in full. */
function touched(o: Op): string[] {
  switch (o.op) {
    case 'createNode': case 'removeNode': case 'record': return [o.op === 'record' ? o.id : o.id];
    case 'insertItem': return [o.host, ...(typeof o.item === 'string' ? [o.item] : [])];
    case 'moveItem': case 'removeItem': case 'addPair': case 'removePair': case 'placeOf': case 'outside': return [o.host, o.item];
    case 'clearField': case 'items': case 'values': case 'first': case 'upValues': case 'upFirst': return [o.host];
    case 'write': return [o.host, ...o.items];
    case 'xmove': return [o.from, o.to, o.item];
    case 'build': return [o.record.id, ...Object.values(o.record.fields).flat().filter((v): v is string => typeof v === 'string')];
    case 'subjectsOf': case 'firstSubjectOf': case 'countSubjectsOf': return [o.item];
    case 'idsOfKind': return [];
  }
}

describe('the engine against the oracle: containment', () => {
  for (const seed of SEEDS) {
    test(`seed ${seed}: ${LENGTH} operations, compared after every one`, () => {
      const { all, ops } = generate(seed);
      const engine = createEngine(TEST_SCHEMA);
      const oracle = new Oracle(engine.schema);
      const universe = [...all, 'zzz', ''];
      let errors = 0;

      const sameState = (id: string, at: string): void => {
        for (const op of [{ op: 'record', id }, { op: 'upValues', host: id }, { op: 'items', host: id }, { op: 'subjectsOf', item: id }] as Op[]) {
          same(run(engine, op), run(oracle, op), () => `${at}: ${op.op} of ${id}`);
        }
      };

      ops.forEach((op, i) => {
        const at = `seed ${seed}, operation ${i}: ${JSON.stringify(op)}`;
        const a = run(engine, op);
        const b = run(oracle, op);
        assert.deepEqual(a, b, at);
        if ('error' in a) errors++;

        const full = i % FULL_EVERY === 0 || i === ops.length - 1;
        for (const id of full ? universe : touched(op)) sameState(id, at);
        if (full) for (const k of ['Box', 'Leaf', 'Stub']) same(run(engine, { op: 'idsOfKind', kind: k }), run(oracle, { op: 'idsOfKind', kind: k }), () => `${at}: the ids of ${k}`);

        // The checks independent of the oracle, on the engine alone.
        const present = all.filter((id) => engine.record(G, id) !== undefined);
        const hosts = present.filter((id) => kindOf(id) === 'Box');
        const holders = new Map<string, string[]>();
        for (const h of hosts) {
          const list = engine.items(G, h, 'items');
          assert.deepEqual(engine.values(G, h, 'items'), list, `${at}: items and values of ${h}`);
          assert.equal(engine.first(G, h, 'items'), list[0], `${at}: first of ${h}`);
          assert.equal(new Set(list).size, list.length, `${at}: an item twice in the list of ${h}`);
          list.forEach((item, k) => {
            assert.equal(engine.placeOf(G, h, 'items', item), k, `${at}: the place of ${item} in ${h}`);
            holders.set(item, [...(holders.get(item) ?? []), h]);
          });
        }
        for (const [item, by] of holders) assert.equal(by.length, 1, `${at}: ${item} is in the lists of ${by.join(', ')}: a single container for each node`);
        for (const id of universe) {
          const by = holders.get(id) ?? [];
          if (present.includes(id) && kindOf(id) !== 'Loose') assert.deepEqual(engine.values(G, id, 'up'), by, `${at}: up of ${id} is the host whose list holds it`);
          assert.deepEqual(engine.subjectsOf(G, 'items', id).sort(), [...by].sort(), `${at}: the reverse of items for ${id}`);
          assert.equal(engine.countSubjectsOf(G, 'items', id), by.length, `${at}: the count for ${id}`);
          assert.equal(engine.firstSubjectOf(G, 'items', id), by[0], `${at}: the first subject for ${id}`);
        }
        for (const id of present) { // no cycle: climbing by `up` ends within as many steps as there are nodes
          let steps = 0;
          for (let up = engine.first(G, id, 'up'); up !== undefined; up = engine.first(G, up as string, 'up')) assert.ok(++steps <= present.length, `${at}: ${id} is on a cycle`);
        }
        checkTree(engine, all, at);
      });
      assert.ok(errors < ops.length, 'a sequence that only fails shows nothing');
    });
  }

  test('the sequences reach what they are for', () => {
    const seen = { created: 0, inserted: 0, moved: 0, removedItems: 0, hostsRemoved: 0, listedRemoved: 0, builtWithItems: 0, refusedSecond: 0, errors: new Set<string>(), nonEmptyUp: 0, deepest: 0 };
    for (const seed of SEEDS) {
      const { all, ops } = generate(seed);
      const engine = createEngine(TEST_SCHEMA);
      for (const op of ops) {
        const before = op.op === 'removeNode' ? all.filter((id) => engine.record(G, id) !== undefined).length : 0;
        const wasListed = op.op === 'removeNode' ? engine.subjectsOf(G, 'items', op.id).length > 0 : false;
        const wasHost = op.op === 'removeNode' && kindOf(op.id) === 'Box' && engine.record(G, op.id) !== undefined;
        const r = run(engine, op);
        if ('error' in r) { seen.errors.add(`${r.error}:${r.rule ?? ''}`); if (op.op === 'insertItem' && r.error === 'Refused') seen.refusedSecond++; continue; }
        if (op.op === 'createNode') seen.created++;
        else if (op.op === 'insertItem' || op.op === 'addPair') seen.inserted++;
        else if (op.op === 'moveItem') seen.moved++;
        else if (op.op === 'removeItem' || op.op === 'removePair') seen.removedItems++;
        else if (op.op === 'build' && 'items' in op.record.fields) seen.builtWithItems++;
        else if (op.op === 'removeNode' && before > all.filter((id) => engine.record(G, id) !== undefined).length) { if (wasHost) seen.hostsRemoved++; if (wasListed) seen.listedRemoved++; }
        if ((op.op === 'upValues' && (r.value as string[]).length > 0) || (op.op === 'upFirst' && r.value !== undefined) || (op.op === 'record' && (r.value as { fields: { name: string }[] } | undefined)?.fields.some((f) => f.name === 'up'))) seen.nonEmptyUp++;
        for (const id of all) { let d = 0; for (let up = engine.first(G, id, 'up'); up !== undefined && d < all.length; up = engine.first(G, up as string, 'up')) d++; seen.deepest = Math.max(seen.deepest, d); }
      }
    }
    assert.ok(seen.created > 150, `creations: ${seen.created}`);
    assert.ok(seen.inserted > 100, `insertions that held: ${seen.inserted}`);
    assert.ok(seen.moved > 20, `moves inside a list: ${seen.moved}`);
    assert.ok(seen.removedItems > 20, `items taken out: ${seen.removedItems}`);
    assert.ok(seen.hostsRemoved > 5, `containers removed: ${seen.hostsRemoved}`);
    assert.ok(seen.listedRemoved > 5, `listed nodes removed: ${seen.listedRemoved}`);
    assert.ok(seen.builtWithItems > 10, `builds with items: ${seen.builtWithItems}`);
    assert.ok(seen.refusedSecond > 30, `insertions refused: ${seen.refusedSecond}`);
    assert.ok(seen.nonEmptyUp > 20, `reads of a parent that found one: ${seen.nonEmptyUp}`);
    assert.ok(seen.deepest >= 3, `a tree at least three deep: ${seen.deepest}`);
    for (const e of ['Refused:', 'Refused:no node']) assert.ok(seen.errors.has(e), `${e} was never thrown (${[...seen.errors].join(', ')})`);
  });
});
