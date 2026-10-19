// The model-based test of the tombstone and the sweep (planning/core.md, Batch 7 Done when and Layer 2): the engine and the oracle
// get the same seeded random sequence of operations over the test schema and what they answer is compared after every operation.
// The sequences hold the writes of the other batches (lists, references, embedded `Ref` nodes with their `to`, removal, build), the
// tombstone of a node and of a subtree (a live node, a tombstone, an embedded node, a kind with no marker, an id with no record), the
// sweep, a build of a tombstone with references, and the generic write of the marker (the engine and the oracle allow it), which
// together make tombstones that hold references again and islands of them.
//
// Checks independent of the oracle, on the engine alone, hold for what the operation just did:
//   - after a `tombstone` or a `tombstoneSubtree` that changed something, for each node it newly tombstoned: `record` shows its literal
//     fields and the marker only (so it holds no reference and no embed value), `up` is empty, no list holds it, none of the embedded
//     nodes it held has a record, its literal fields are what they were and its marker is `at`; for each field it lost, the reverse reads
//     of the values it held no longer include it; its incoming references are as they were (but for the pairs of the nodes tombstoned
//     with it); every node not tombstoned is unchanged but for the entries of the containers that listed a tombstoned node; a second
//     tombstone of the same node changes nothing; an operation that is refused changes nothing, a subtree that is refused included.
//   - after a `sweep`, computed from reads before it: the expected set is the tombstones that a mark by `values` from the live `Box`
//     records through `items`, `refs` and `to` does not reach, and the ids returned equal it sorted; each is gone from `record` and
//     `idsOfKind`; each marked tombstone still has its record; the entries of the swept in `pinned` are gone; the live nodes are
//     unchanged but for those entries.
//   - at every step: the reverse of `items`, `likes`, `mate`, `refs` and `to` equals a scan of the forward sides, and `checkTree` holds.
// "No live node refers to a tombstone's removed fields" (the plan's sentence) is held as the reverse reads and the lists above, right
// after the operation; a write after the tombstone gives the node references again, so it is not a standing property.
// A failing run names its seed and the operation, and the seed replays it.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '@aperas/core/apeironNgn/engine';
import type { BuildRecord, Engine, NodeRecord, Value } from '@aperas/core/apeironNgn/interface';
import { Oracle } from '../support/oracle.ts';
import { TEST_SCHEMA } from '../support/engineSchema.ts';
import { checkTree } from '../support/engineTree.ts';
import { rng } from '../support/prng.ts';

const G = 'default';
const SEEDS = Array.from({ length: 20 }, (_, i) => 721 + i);
const LENGTH = 250;
/** Every twelfth operation compares the whole state of both implementations; the others compare what the operation touched. */
const FULL_EVERY = 12;
const MARKER = 'retiredAt';
const KINDS = ['Box', 'Leaf', 'Stub', 'Loose', 'Ref'];

type Op =
  | { op: 'create'; id: string; kind: string }
  | { op: 'insert'; host: string; item: string; at?: number }
  | { op: 'removeItem'; host: string; item: string }
  | { op: 'pair'; how: 'add' | 'remove'; host: string; field: string; value: Value }
  | { op: 'clear'; host: string; field: string }
  | { op: 'makeRef'; owner: string; ref: string; to?: string } // a Ref made, held in `refs` and given its `to`
  | { op: 'setTo'; ref: string; to: string }
  | { op: 'dropRef'; owner: string; ref: string }
  | { op: 'tombstone' | 'subtree'; id: string; at: string }
  | { op: 'sweep' }
  | { op: 'removeNode'; id: string }
  | { op: 'build'; record: BuildRecord }
  | { op: 'marker'; how: 'add' | 'clear' | 'remove'; id: string; at: string }
  | { op: 'values' | 'first'; id: string; field: string }
  | { op: 'items'; id: string }
  | { op: 'subjectsOf' | 'countSubjectsOf'; field: string; id: string }
  | { op: 'idsOfKind'; kind: string }
  | { op: 'record'; id: string };

/** What an operation gave: a value, or the class and the open point of the error it threw. */
type Outcome = { value: unknown } | { error: string; point?: string };

function run(x: Engine, o: Op): Outcome {
  try {
    switch (o.op) {
      case 'create': x.createNode(G, o.id, o.kind); return { value: undefined };
      case 'insert': x.insertItem(G, o.host, 'items', o.item, o.at); return { value: undefined };
      case 'removeItem': x.removeItem(G, o.host, 'items', o.item); return { value: undefined };
      case 'pair': (o.how === 'add' ? x.addPair : x.removePair).call(x, G, o.host, o.field, o.value); return { value: undefined };
      case 'clear': x.clearField(G, o.host, o.field); return { value: undefined };
      case 'makeRef': x.createNode(G, o.ref, 'Ref'); x.addPair(G, o.owner, 'refs', o.ref); if (o.to !== undefined) x.addPair(G, o.ref, 'to', o.to); return { value: undefined };
      case 'setTo': x.addPair(G, o.ref, 'to', o.to); return { value: undefined };
      case 'dropRef': x.removePair(G, o.owner, 'refs', o.ref); return { value: undefined };
      case 'tombstone': x.tombstone(G, o.id, o.at); return { value: undefined };
      case 'subtree': x.tombstoneSubtree(G, o.id, o.at); return { value: undefined };
      case 'sweep': return { value: x.sweep(G) };
      case 'removeNode': x.removeNode(G, o.id); return { value: undefined };
      case 'build': x.build(G, o.record); return { value: undefined };
      case 'marker':
        if (o.how === 'add') x.addPair(G, o.id, MARKER, o.at);
        else if (o.how === 'clear') x.clearField(G, o.id, MARKER);
        else x.removePair(G, o.id, MARKER, o.at);
        return { value: undefined };
      case 'values': return { value: [...x.values(G, o.id, o.field)].sort() };
      case 'first': return { value: x.first(G, o.id, o.field) };
      case 'items': return { value: x.items(G, o.id, 'items') };
      case 'subjectsOf': return { value: x.subjectsOf(G, o.field, o.id).sort() };
      case 'countSubjectsOf': return { value: x.countSubjectsOf(G, o.field, o.id) };
      case 'idsOfKind': return { value: x.idsOfKind(G, o.kind).sort() };
      case 'record': return { value: x.record(G, o.id) };
    }
  } catch (e) {
    const err = e as Error & { point?: string };
    return { error: err.name, ...(err.point !== undefined ? { point: err.point } : {}) };
  }
}

function same(a: unknown, b: unknown, message: () => string): void {
  if (JSON.stringify(a) !== JSON.stringify(b)) assert.deepEqual(a, b, message());
}

const FLAKE = [...'0123456789ABCDEFGHJKMNPQRSTVWXYZ'];
const kindOf = (id: string): string => id.split(':').slice(-2)[0]!;
const ownerOf = (id: string): string | undefined => { const p = id.split(':'); return p.length > 2 ? p.slice(0, -3).join(':') : undefined; };

interface Plan { readonly all: readonly string[]; readonly refs: readonly string[]; readonly ops: readonly Op[] }

function generate(seed: number): Plan {
  const g = rng(seed);
  const flake = (): string => Array.from({ length: 13 }, () => g.pick(FLAKE)).join('');
  const boxes = Array.from({ length: 6 }, () => `Box:${flake()}`);
  const leaves = [...Array.from({ length: 7 }, () => `Leaf:${flake()}`), ...Array.from({ length: 3 }, () => `Stub:${flake()}`)];
  const looses = Array.from({ length: 3 }, () => `Loose:${flake()}`);
  const ghosts = Array.from({ length: 3 }, () => `Leaf:${flake()}`); // ids that never get a record
  const nodes = [...boxes, ...leaves, ...looses, ...ghosts];
  const creatable = [...boxes, ...leaves, ...looses];
  const refs: string[] = [];

  const probe = new Oracle(createEngine(TEST_SCHEMA).schema);
  const ops: Op[] = [];
  const record = (o: Op): void => { ops.push(o); run(probe, o); };
  const exists = (id: string): boolean => probe.record(G, id) !== undefined;
  const dead = (id: string): boolean => exists(id) && probe.first(G, id, MARKER) !== undefined;
  const live = (ids: readonly string[]): string[] => ids.filter((id) => exists(id) && !dead(id));
  const tombs = (): string[] => nodes.filter(dead);
  const listOf = (box: string): string[] => (kindOf(box) === 'Box' && exists(box) ? probe.items(G, box, 'items') : []);
  const holders = (): string[] => [...boxes, ...leaves].filter(exists); // the nodes that hold `refs`
  const anyBox = (): string => g.pick(g.chance(0.9) && boxes.some(exists) ? boxes.filter(exists) : boxes);
  const anyNode = (): string => g.pick(nodes);
  const target = (): string => g.pick(g.chance(0.5) && tombs().length > 0 ? tombs() : nodes); // tombstones are what the references point at
  const stamp = (): string => `T${ops.length}`;

  while (ops.length < LENGTH) {
    const t = g.int(100);
    if (t < 16) { // a creation, a few with a kind that is not the id's
      const id = g.pick(creatable);
      record({ op: 'create', id, kind: g.int(100) < 92 ? kindOf(id) : g.pick(['Box', 'Leaf', 'Loose', 'Ref']) });
    } else if (t < 25) {
      const host = anyBox();
      record({ op: 'insert', host, item: g.chance(0.45) && live([...boxes, ...leaves]).length > 0 ? g.pick(live([...boxes, ...leaves])) : g.chance(0.85) ? target() : g.pick(nodes), at: g.chance(0.7) ? undefined : g.int(listOf(host).length + 1) });
    } else if (t < 28) {
      const host = anyBox(); const list = listOf(host);
      record({ op: 'removeItem', host, item: g.chance(0.8) && list.length > 0 ? g.pick(list) : anyNode() });
    } else if (t < 37) {
      const field = g.pick(['likes', 'mate', 'pinned', 'likes']);
      const host = field === 'pinned' ? anyBox() : g.pick(g.chance(0.8) ? leaves : nodes);
      record({ op: 'pair', how: g.chance(0.82) ? 'add' : 'remove', host, field, value: target() });
    } else if (t < 38) {
      record({ op: 'clear', host: g.pick(nodes), field: g.pick(['likes', 'mate', 'pinned', 'items', 'refs']) });
    } else if (t < 43) { // a Ref made and held, with its `to`
      const owner = g.chance(0.9) && holders().length > 0 ? g.pick(holders()) : g.pick([...boxes, ...leaves, ...looses, ...ghosts]);
      const ref = `${owner}:refs:Ref:${flake()}`;
      refs.push(ref);
      record({ op: 'makeRef', owner, ref, ...(g.chance(0.9) ? { to: target() } : {}) });
    } else if (t < 45) {
      if (refs.length === 0) continue;
      const ref = g.pick(refs);
      if (g.chance(0.5)) record({ op: 'setTo', ref, to: target() });
      else record({ op: 'dropRef', owner: ownerOf(ref)!, ref });
    } else if (t < 53) { // a tombstone: a live node, a tombstone, an embedded node, a kind with no marker, an id with no record
      const roll = g.int(100);
      const id = roll < 70 && live([...boxes, ...leaves]).length > 0 ? g.pick(live(g.chance(0.7) ? leaves : [...boxes, ...leaves]).length > 0 ? live(g.chance(0.7) ? leaves : [...boxes, ...leaves]) : live([...boxes, ...leaves]))
        : roll < 80 && tombs().length > 0 ? g.pick(tombs())
        : roll < 88 && refs.length > 0 ? g.pick(refs)
        : roll < 94 ? g.pick(looses) : g.pick(ghosts);
      record({ op: 'tombstone', id, at: stamp() });
    } else if (t < 58) { // a subtree: a container, a leaf, a container with a kind with no marker in its list
      const roll = g.int(100);
      const withContainer = live(boxes).filter((b) => listOf(b).length > 0);
      const withLoose = withContainer.filter((b) => listOf(b).some((i) => kindOf(i) === 'Loose'));
      const id = roll < 55 && withContainer.length > 0 ? g.pick(withContainer)
        : roll < 70 && withLoose.length > 0 ? g.pick(withLoose)
        : roll < 85 && live(leaves).length > 0 ? g.pick(live(leaves))
        : roll < 95 ? anyBox() : g.pick(ghosts);
      record({ op: 'subtree', id, at: stamp() });
    } else if (t < 63) {
      record({ op: 'sweep' });
    } else if (t < 66) {
      record({ op: 'removeNode', id: g.chance(0.85) ? g.pick(nodes) : g.pick(refs.length > 0 ? refs : nodes) });
    } else if (t < 72) { // a build of an absent node, a tombstone with references more often than not
      const absent = creatable.filter((id) => !exists(id));
      const id = absent.length > 0 && g.chance(0.9) ? g.pick(absent) : g.pick(creatable);
      const fields: Record<string, Value | readonly Value[]> = {};
      if (kindOf(id) !== 'Loose') {
        if (g.chance(0.65)) fields[MARKER] = stamp();
        if (g.chance(0.6)) fields.likes = Array.from({ length: 1 + g.int(2) }, target);
        if (kindOf(id) === 'Box' && g.chance(0.5)) fields.items = Array.from({ length: 1 + g.int(3) }, target);
        if (g.chance(0.4)) fields.label = 'b';
        if (g.chance(0.3)) { const ref = `${id}:refs:Ref:${flake()}`; refs.push(ref); fields.refs = ref; }
        if (g.chance(0.04)) fields.items = [7 as unknown as string];
      } else fields.name = 'l';
      record({ op: 'build', record: { id, kind: kindOf(id), fields } });
      const ref = fields.refs;
      if (typeof ref === 'string' && g.chance(0.85)) record({ op: 'build', record: { id: ref, kind: 'Ref', fields: { to: target() } } });
    } else if (t < 77) { // the generic write of the marker
      const how = g.pick(['add', 'add', 'clear', 'remove'] as const);
      const id = how === 'add' ? g.pick(live([...boxes, ...leaves]).length > 0 && g.chance(0.8) ? live([...boxes, ...leaves]) : nodes) : g.pick(tombs().length > 0 && g.chance(0.8) ? tombs() : nodes);
      record({ op: 'marker', how, id, at: how === 'remove' && exists(id) ? String(probe.first(G, id, MARKER) ?? 'x') : stamp() });
    } else { // reads
      const r = g.int(8);
      const id = g.pick(g.chance(0.85) ? [...boxes, ...leaves] : [...nodes, ...refs]);
      if (r === 0) record({ op: g.pick(['values', 'first'] as const), id, field: g.pick(['likes', 'mate', 'items', 'refs', 'up', MARKER, 'label', 'pinned']) });
      else if (r === 1) record({ op: 'items', id: anyBox() });
      else if (r < 5) record({ op: g.pick(['subjectsOf', 'countSubjectsOf'] as const), field: g.pick(['likes', 'mate', 'items', 'refs', 'to', 'pinned']), id: g.chance(0.9) ? g.pick(nodes) : g.pick(refs.length > 0 ? refs : nodes) });
      else if (r === 5) record({ op: 'idsOfKind', kind: g.pick(KINDS) });
      else record({ op: 'record', id });
    }
  }
  return { all: nodes, refs, ops };
}

/** The ids an operation names, which the comparison after it reads in full. */
function touched(o: Op): string[] {
  switch (o.op) {
    case 'create': case 'removeNode': case 'record': case 'tombstone': case 'subtree': case 'items': case 'marker': return [o.id];
    case 'insert': case 'removeItem': return [o.host, o.item];
    case 'pair': return [o.host, ...(typeof o.value === 'string' ? [o.value] : [])];
    case 'clear': return [o.host];
    case 'makeRef': return [o.owner, o.ref, ...(o.to !== undefined ? [o.to] : [])];
    case 'setTo': return [o.ref, o.to, ownerOf(o.ref)!];
    case 'dropRef': return [o.owner, o.ref];
    case 'build': return [o.record.id, ...Object.values(o.record.fields).flat().filter((v): v is string => typeof v === 'string')];
    case 'values': case 'first': return [o.id];
    case 'subjectsOf': case 'countSubjectsOf': return [o.id];
    case 'sweep': case 'idsOfKind': return [];
  }
}

const fieldOf = (rec: NodeRecord | undefined, name: string): Value[] => [...(rec?.fields.find((f) => f.name === name)?.values ?? [])];
const FORWARD = ['items', 'likes', 'mate', 'refs', 'to', 'pinned'] as const;
const isLiteralField = (x: Engine, kind: string, name: string): boolean => x.schema.kinds.find((k) => k.name === kind)!.fields.find((f) => f.name === name)!.storage === 'literal';

/** What the engine alone shows of the universe at a moment. */
interface Snap {
  readonly rec: ReadonlyMap<string, NodeRecord | undefined>;
  readonly incoming: ReadonlyMap<string, string[]>; // `field|id` -> subjects
  readonly kinds: string;
}
function snap(x: Engine, universe: readonly string[]): Snap {
  const rec = new Map<string, NodeRecord | undefined>();
  const incoming = new Map<string, string[]>();
  for (const id of universe) {
    rec.set(id, x.record(G, id));
    for (const f of FORWARD) incoming.set(`${f}|${id}`, x.subjectsOf(G, f, id).sort());
  }
  return { rec, incoming, kinds: JSON.stringify(KINDS.map((k) => x.idsOfKind(G, k).sort())) };
}
const asJson = (s: Snap): string => JSON.stringify([[...s.rec], [...s.incoming], s.kinds]);

/** The checks of a tombstone or a subtree that went through. */
function checkTombstoned(x: Engine, before: Snap, after: Snap, universe: readonly string[], at: string, where: string): void {
  const isTomb = (r: NodeRecord | undefined): boolean => fieldOf(r, MARKER).length > 0;
  const newly = new Set(universe.filter((id) => before.rec.get(id) !== undefined && !isTomb(before.rec.get(id)) && after.rec.get(id) !== undefined && isTomb(after.rec.get(id))));
  const gone = new Set(universe.filter((id) => before.rec.get(id) !== undefined && after.rec.get(id) === undefined));
  const list = [...newly].sort();
  for (const id of universe) assert.ok(!(before.rec.get(id) === undefined && after.rec.get(id) !== undefined), `${where}: ${id} was made by a tombstone`);

  for (const id of list) {
    const was = before.rec.get(id)!; const now = after.rec.get(id)!;
    assert.deepEqual(fieldOf(now, MARKER), [at], `${where}: the marker of ${id}`);
    for (const f of now.fields) assert.ok(isLiteralField(x, now.kind, f.name) || false, `${where}: ${id} still shows ${f.name}, which is no literal`);
    assert.deepEqual(x.values(G, id, 'up'), [], `${where}: up of ${id}`);
    for (const f of was.fields) {
      if (!isLiteralField(x, was.kind, f.name)) continue;
      if (f.name !== MARKER) assert.deepEqual(fieldOf(now, f.name), f.values, `${where}: the literal ${f.name} of ${id}`);
    }
    for (const host of universe) {
      const r = after.rec.get(host);
      if (r !== undefined && kindOf(host) === 'Box') assert.ok(!x.items(G, host, 'items').includes(id), `${where}: ${host} still lists ${id}`);
    }
    for (const f of ['items', 'likes', 'mate', 'refs', 'pinned'] as const) {
      for (const v of fieldOf(was, f) as string[]) {
        assert.ok(!(after.incoming.get(`${f}|${v}`) ?? x.subjectsOf(G, f, v)).includes(id), `${where}: the reverse of ${f} for ${v} still holds ${id}`);
      }
    }
    for (const ref of fieldOf(was, 'refs') as string[]) {
      assert.equal(after.rec.get(ref), undefined, `${where}: the embedded ${ref} of ${id} has a record`);
      for (const v of fieldOf(before.rec.get(ref), 'to') as string[]) assert.ok(!x.subjectsOf(G, 'to', v).includes(ref), `${where}: the reverse of to for ${v} holds ${ref}`);
    }
  }

  for (const id of gone) { // a record that went is an embedded node of a node newly tombstoned, or of one that went with it
    const owner = ownerOf(id);
    assert.ok(owner !== undefined && (newly.has(owner) || gone.has(owner)), `${where}: ${id} went and is not embedded by a tombstoned node`);
  }

  for (const id of universe) { // the incoming references are as they were, but for the pairs of the nodes tombstoned with it
    for (const f of ['likes', 'mate', 'pinned', 'to'] as const) {
      const expected = (before.incoming.get(`${f}|${id}`) ?? []).filter((s) => after.rec.get(s) !== undefined && !newly.has(s));
      assert.deepEqual(after.incoming.get(`${f}|${id}`), expected, `${where}: the incoming ${f} of ${id}`);
    }
  }

  for (const id of universe) { // every other node is unchanged but for the entries of the containers that listed a tombstoned node
    const was = before.rec.get(id); const now = after.rec.get(id);
    if (was === undefined || newly.has(id) || gone.has(id)) continue;
    const expected: NodeRecord['fields'] = was.fields.flatMap((f) => {
      const values: readonly Value[] = f.name === 'items' ? (f.values as string[]).filter((v) => !newly.has(v)) : f.name === 'up' ? (f.values as string[]).filter((v) => !newly.has(v)) : f.values;
      return values.length === 0 ? [] : [{ name: f.name, values }];
    });
    assert.deepEqual(now, { id, kind: was.kind, fields: expected }, `${where}: ${id} changed`);
  }
}

/** The tombstones that a mark from the live Box records, through `items`, `refs` and `to`, does not reach; and the ones it does. */
function expectedSweep(x: Engine, universe: readonly string[]): { swept: string[]; marked: Set<string> } {
  const isTomb = (id: string): boolean => x.values(G, id, MARKER).length > 0;
  const present = universe.filter((id) => x.record(G, id) !== undefined);
  const marked = new Set<string>();
  const work: string[] = [];
  for (const id of present) if (kindOf(id) === 'Box' && !isTomb(id)) { marked.add(id); work.push(id); }
  while (work.length > 0) {
    const id = work.pop()!;
    for (const f of ['items', 'refs', 'to']) for (const v of x.values(G, id, f) as string[]) if (x.record(G, v) !== undefined && !marked.has(v)) { marked.add(v); work.push(v); }
  }
  return { swept: present.filter((id) => isTomb(id) && !marked.has(id)).sort(), marked };
}

describe('the engine against the oracle: the tombstone and the sweep', () => {
  for (const seed of SEEDS) {
    test(`seed ${seed}: ${LENGTH} operations, compared after every one`, () => {
      const { all, refs, ops } = generate(seed);
      const engine = createEngine(TEST_SCHEMA);
      const oracle = new Oracle(engine.schema);
      const universe = [...all, ...refs, 'zzz', ''];
      const present = (): string[] => universe.filter((id) => engine.record(G, id) !== undefined);
      let errors = 0;

      const sameState = (id: string, at: string): void => {
        for (const op of [{ op: 'record', id }, { op: 'values', id, field: 'up' }, { op: 'items', id }, ...['items', 'likes', 'mate', 'refs', 'to', 'pinned'].map((field) => ({ op: 'subjectsOf', field, id })), { op: 'values', id, field: 'refs' }] as Op[]) {
          same(run(engine, op), run(oracle, op), () => `${at}: ${op.op} of ${id}`);
        }
      };

      ops.forEach((op, i) => {
        const at = `seed ${seed}, operation ${i}: ${JSON.stringify(op)}`;
        const stamped = op.op === 'tombstone' || op.op === 'subtree';
        const before = stamped || op.op === 'sweep' ? snap(engine, universe) : undefined;
        const swept = op.op === 'sweep' ? expectedSweep(engine, universe) : undefined;
        const a = run(engine, op);
        const b = run(oracle, op);
        assert.deepEqual(a, b, at);
        if ('error' in a) errors++;

        if (before !== undefined && 'error' in a) assert.equal(asJson(snap(engine, universe)), asJson(before), `${at}: a refused operation changed the engine`);
        if (before !== undefined && stamped && !('error' in a)) {
          const after = snap(engine, universe);
          checkTombstoned(engine, before, after, universe, (op as { at: string }).at, at);
          // A second tombstone of the same node changes nothing.
          const again = run(engine, { ...(op as Extract<Op, { op: 'tombstone' | 'subtree' }>), at: 'again' });
          const againOracle = run(oracle, { ...(op as Extract<Op, { op: 'tombstone' | 'subtree' }>), at: 'again' });
          assert.deepEqual(again, againOracle, `${at}: the second tombstone`);
          assert.equal(asJson(snap(engine, universe)), asJson(after), `${at}: a second tombstone changed something`);
        }
        if (before !== undefined && swept !== undefined && !('error' in a)) {
          const after = snap(engine, universe);
          assert.deepEqual((a as { value: string[] }).value, swept.swept, `${at}: the ids returned are the tombstones the mark does not reach, sorted`);
          for (const id of swept.swept) {
            assert.equal(after.rec.get(id), undefined, `${at}: ${id} swept and still has a record`);
            for (const k of KINDS) assert.ok(!engine.idsOfKind(G, k).includes(id), `${at}: ${id} swept and still in its collection`);
            for (const host of present()) if (kindOf(host) === 'Box') assert.ok(!engine.values(G, host, 'pinned').includes(id), `${at}: ${host} still pins the swept ${id}`);
          }
          for (const id of universe) {
            const was = before.rec.get(id);
            if (was !== undefined && fieldOf(was, MARKER).length > 0 && swept.marked.has(id)) assert.ok(after.rec.get(id) !== undefined, `${at}: the marked tombstone ${id} was swept`);
            if (was === undefined || swept.swept.includes(id) || ownerOf(id) !== undefined && swept.swept.includes(ownerOf(id)!)) continue;
            // The former children of a swept tombstone that was written a list lose their `up`.
            const expected: NodeRecord['fields'] = was.fields.flatMap((f) => { const values: readonly Value[] = f.name === 'pinned' || f.name === 'up' ? (f.values as string[]).filter((v) => !swept.swept.includes(v)) : f.values; return values.length === 0 ? [] : [{ name: f.name, values }]; });
            if (!after.rec.get(id) && ownerOf(id) !== undefined) continue; // an embedded node of a swept tombstone
            assert.deepEqual(after.rec.get(id), { id, kind: was.kind, fields: expected }, `${at}: ${id} changed by the sweep`);
          }
          assert.deepEqual(run(engine, { op: 'sweep' }), { value: [] }, `${at}: a second sweep`);
          run(oracle, { op: 'sweep' });
        }

        const full = i % FULL_EVERY === 0 || i === ops.length - 1;
        for (const id of full ? universe : touched(op)) sameState(id, at);
        if (full) for (const k of KINDS) same(run(engine, { op: 'idsOfKind', kind: k }), run(oracle, { op: 'idsOfKind', kind: k }), () => `${at}: the ids of ${k}`);

        // At every step: the reverse of the fields equals a scan of the forward sides, and the tree holds.
        const here = present();
        for (const f of ['items', 'likes', 'mate', 'refs', 'to'] as const) {
          const scan = new Map<string, string[]>();
          for (const host of here) for (const v of engine.values(G, host, f) as string[]) scan.set(v, [...(scan.get(v) ?? []), host]);
          for (const id of universe) {
            assert.deepEqual(engine.subjectsOf(G, f, id).sort(), (scan.get(id) ?? []).sort(), `${at}: the reverse of ${f} for ${id}`);
            assert.equal(engine.countSubjectsOf(G, f, id), (scan.get(id) ?? []).length, `${at}: the count of ${f} for ${id}`);
          }
        }
        checkTree(engine, universe, at);
      });
      assert.ok(errors < ops.length, 'a sequence that only fails shows nothing');
    });
  }

  test('the sequences reach what they are for', () => {
    const seen = { tombstoned: 0, subtrees: 0, severalMembers: 0, subtreeRefused: 0, stampKept: 0, builtTombstones: 0, markerAdded: 0, revived: 0, sweeps: 0, sweptSome: 0, sweptWithRefs: 0, markedTombstones: 0, islands: 0, errors: new Set<string>() };
    for (const seed of SEEDS) {
      const { all, refs, ops } = generate(seed);
      const universe = [...all, ...refs];
      const engine = createEngine(TEST_SCHEMA);
      for (const op of ops) {
        const before = snap(engine, universe);
        const sw = op.op === 'sweep' ? expectedSweep(engine, universe) : undefined;
        const r = run(engine, op);
        if ('error' in r) {
          seen.errors.add(`${r.error}:${r.point ?? ''}`);
          if (op.op === 'subtree' && r.error === 'Refused') seen.subtreeRefused++;
          continue;
        }
        const after = snap(engine, universe);
        const newly = universe.filter((id) => before.rec.get(id) !== undefined && fieldOf(before.rec.get(id), MARKER).length === 0 && fieldOf(after.rec.get(id), MARKER).length > 0);
        if (op.op === 'tombstone') { seen.tombstoned += newly.length; if (newly.length === 0 && before.rec.get(op.id) !== undefined && fieldOf(before.rec.get(op.id), MARKER).length > 0) seen.stampKept++; }
        else if (op.op === 'subtree') { seen.subtrees++; seen.tombstoned += newly.length; if (newly.length > 1) seen.severalMembers++; }
        else if (op.op === 'build' && MARKER in op.record.fields && Object.keys(op.record.fields).some((f) => ['likes', 'items', 'refs'].includes(f))) seen.builtTombstones++;
        else if (op.op === 'marker' && op.how === 'add' && newly.length > 0) seen.markerAdded++;
        else if (op.op === 'marker' && op.how === 'clear' && universe.some((id) => fieldOf(before.rec.get(id), MARKER).length > 0 && fieldOf(after.rec.get(id), MARKER).length === 0)) seen.revived++;
        else if (sw !== undefined) {
          seen.sweeps++;
          const ids = (r as { value: string[] }).value;
          if (ids.length > 0) seen.sweptSome++;
          if (ids.some((id) => ['likes', 'refs', 'items'].some((f) => fieldOf(before.rec.get(id), f).length > 0))) seen.sweptWithRefs++;
          seen.markedTombstones += [...sw.marked].filter((id) => fieldOf(before.rec.get(id), MARKER).length > 0).length;
          // An island: a swept tombstone that another swept tombstone's embedded Ref named.
          if (ids.some((id) => (before.incoming.get(`to|${id}`) ?? []).some((s) => ids.includes(ownerOf(s) ?? '')))) seen.islands++;
        }
      }
    }
    assert.ok(seen.tombstoned > 100, `nodes newly tombstoned: ${seen.tombstoned}`);
    assert.ok(seen.subtrees > 50, `subtrees that went through: ${seen.subtrees}`);
    assert.ok(seen.severalMembers > 8, `subtrees of several members: ${seen.severalMembers}`);
    assert.ok(seen.subtreeRefused > 4, `subtrees refused: ${seen.subtreeRefused}`);
    assert.ok(seen.stampKept > 20, `tombstones of a tombstone: ${seen.stampKept}`);
    assert.ok(seen.builtTombstones > 30, `builds of a tombstone with references: ${seen.builtTombstones}`);
    assert.ok(seen.markerAdded > 30, `generic writes of the marker that made a tombstone: ${seen.markerAdded}`);
    assert.ok(seen.revived > 10, `generic clears of the marker: ${seen.revived}`);
    assert.ok(seen.sweptSome > 80, `sweeps that removed something: ${seen.sweptSome}`);
    assert.ok(seen.sweptWithRefs > 40, `sweeps that removed a tombstone holding references: ${seen.sweptWithRefs}`);
    assert.ok(seen.markedTombstones > 50, `tombstones a sweep kept because the mark reached them: ${seen.markedTombstones}`);
    assert.ok(seen.islands > 10, `sweeps that removed an island of tombstones: ${seen.islands}`);
    for (const e of ['Refused:', 'Undecided:Enforcement', 'Undecided:Existence']) assert.ok(seen.errors.has(e), `${e} was never thrown (${[...seen.errors].join(', ')})`);
  });
});
