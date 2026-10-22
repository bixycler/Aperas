// The model-based test of several graphs (planning/core.md, Batch 8 Done when and Layer 2): the engine and the oracle get the same seeded
// random sequence of operations over the test schema and what they answer is compared after every operation. The sequences hold the
// operations of the earlier models (lists, references, embedded `Ref` nodes with their `to`, removal, build, the tombstone of a node and of
// a subtree, the sweep), each issued in the graph of the node it names or, now and then, in another, over up to four graphs, with pairs
// across graphs (`mate`, `likes`, `pinned`, `items`, `refs`, `to`); and `createGraph` (a name that fails the grammar, a name taken, a name
// free) and `dropGraph` (a graph that is not there, a refused one, one that goes), a read of the graph of an id, and an embedded id
// offered to a list.
//
// Checks independent of the oracle, on the engine alone:
//   - an id is in one graph only, and `graphOf` names it;
//   - a refused operation of the graphs (`createGraph`, `dropGraph`, a sweep) changes nothing in any graph;
//   - after a drop that went through: the graph has no record of an id, `idsOfKind` is empty for every kind, and every other graph reads
//     as it did;
//   - after a sweep: it returns only tombstones of the graph it names, and the tombstones of the other graphs are still there;
//   - at every step: no bucket names a subject that has no record; in every graph the reverse of `items`, `likes`, `mate`, `refs`, `to`
//     and `pinned` equals a scan of the forward sides of the records of that graph; and `checkTree` holds for each graph.
// A failing run names its seed and the operation, and the seed replays it.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, inspectEngine } from '@aperas/core/apeironNgn/engine';
import type { BuildRecord, Engine, Value } from '@aperas/core/apeironNgn/interface';
import { Oracle } from '../support/oracle.ts';
import { noNode } from '../support/refusals.ts';
import { TEST_SCHEMA } from '../support/engineSchema.ts';
import { checkTree } from '../support/engineTree.ts';
import { rng } from '../support/prng.ts';

const SEEDS = Array.from({ length: 20 }, (_, i) => 821 + i);
const LENGTH = 250;
/** Every twelfth operation compares the whole state of both implementations; the others compare what the operation touched. */
const FULL_EVERY = 12;
const MARKER = 'retiredAt';
const KINDS = ['Box', 'Leaf', 'Stub', 'Loose', 'Ref'];
const FIELDS = ['items', 'likes', 'mate', 'refs', 'to', 'pinned'] as const;
/** The names that may be made: the graph at the start and three more. A name outside the pool is never made. */
const POOL = ['default', 'a.example', 'b-2', 'c.d.e'];
const BAD_NAMES = ['id', '', 'Bad', 'a..b', '-x', 'x-', 'a_b', 'a b', '.a', 'a.', 'a'.repeat(64)];

type Op =
  | { op: 'createGraph' | 'dropGraph'; name: string }
  | { op: 'create'; graph: string; id: string; kind: string }
  | { op: 'insert'; graph: string; host: string; item: string; at?: number }
  | { op: 'move'; graph: string; host: string; item: string; to: number }
  | { op: 'removeItem'; graph: string; host: string; item: string }
  | { op: 'pair'; how: 'add' | 'remove'; graph: string; host: string; field: string; value: Value }
  | { op: 'clear'; graph: string; host: string; field: string }
  | { op: 'makeRef'; graph: string; refGraph: string; owner: string; ref: string; to?: string }
  | { op: 'tombstone' | 'subtree'; graph: string; id: string; at: string }
  | { op: 'sweep'; graph: string }
  | { op: 'removeNode'; graph: string; id: string }
  | { op: 'build'; graph: string; record: BuildRecord }
  | { op: 'values' | 'first'; graph: string; id: string; field: string }
  | { op: 'items'; graph: string; id: string }
  | { op: 'subjects'; graph: string; field: string; id: string }
  | { op: 'idsOfKind'; graph: string; kind: string }
  | { op: 'record'; graph: string; id: string }
  | { op: 'graphOf'; id: string };

/** What an operation gave: a value, or the class of the error it threw, and the rule that refused it when it is the existence of the subject. */
type Outcome = { value: unknown } | { error: string; rule?: string };

function run(x: Engine, o: Op): Outcome {
  try {
    switch (o.op) {
      case 'createGraph': x.createGraph(o.name); return { value: undefined };
      case 'dropGraph': x.dropGraph(o.name); return { value: undefined };
      case 'create': x.createNode(o.graph, o.id, o.kind); return { value: undefined };
      case 'insert': x.insertItem(o.graph, o.host, 'items', o.item, o.at); return { value: undefined };
      case 'move': x.moveItem(o.graph, o.host, 'items', o.item, o.to); return { value: undefined };
      case 'removeItem': x.removeItem(o.graph, o.host, 'items', o.item); return { value: undefined };
      case 'pair': (o.how === 'add' ? x.addPair : x.removePair).call(x, o.graph, o.host, o.field, o.value); return { value: undefined };
      case 'clear': x.clearField(o.graph, o.host, o.field); return { value: undefined };
      case 'makeRef': x.createNode(o.refGraph, o.ref, 'Ref'); x.addPair(o.graph, o.owner, 'refs', o.ref); if (o.to !== undefined) x.addPair(o.refGraph, o.ref, 'to', o.to); return { value: undefined };
      case 'tombstone': x.tombstone(o.graph, o.id, o.at); return { value: undefined };
      case 'subtree': x.tombstoneSubtree(o.graph, o.id, o.at); return { value: undefined };
      case 'sweep': return { value: x.sweep(o.graph) };
      case 'removeNode': x.removeNode(o.graph, o.id); return { value: undefined };
      case 'build': x.build(o.graph, o.record); return { value: undefined };
      case 'values': return { value: [...x.values(o.graph, o.id, o.field)].sort() };
      case 'first': return { value: x.first(o.graph, o.id, o.field) };
      case 'items': return { value: x.items(o.graph, o.id, 'items') };
      case 'subjects': { // the order is promised to no reader: the first one is checked to be one of the subjects
        const all = x.subjectsOf(o.graph, o.field, o.id);
        const first = x.firstSubjectOf(o.graph, o.field, o.id);
        return { value: { subjects: [...all].sort(), count: x.countSubjectsOf(o.graph, o.field, o.id), first: first === undefined ? null : all.includes(first) } };
      }
      case 'idsOfKind': return { value: x.idsOfKind(o.graph, o.kind).sort() };
      case 'record': return { value: x.record(o.graph, o.id) };
      case 'graphOf': return { value: x.graphOf(o.id) };
    }
  } catch (e) {
    const err = e as Error;
    return { error: err.name, ...(noNode(err) ? { rule: 'no node' } : {}) };
  }
}

const FLAKE = [...'0123456789ABCDEFGHJKMNPQRSTVWXYZ'];
const kindOf = (id: string): string => id.split(':').slice(-2)[0]!;
const ownerOf = (id: string): string | undefined => { const p = id.split(':'); return p.length > 2 ? p.slice(0, -3).join(':') : undefined; };

interface Plan { readonly all: readonly string[]; readonly refs: readonly string[]; readonly ops: readonly Op[] }

function generate(seed: number): Plan {
  const g = rng(seed);
  const flake = (): string => Array.from({ length: 13 }, () => g.pick(FLAKE)).join('');
  const boxes = Array.from({ length: 6 }, () => `Box:${flake()}`);
  const leaves = [...Array.from({ length: 7 }, () => `Leaf:${flake()}`), ...Array.from({ length: 2 }, () => `Stub:${flake()}`)];
  const looses = Array.from({ length: 2 }, () => `Loose:${flake()}`);
  const ghosts = Array.from({ length: 3 }, () => `Leaf:${flake()}`); // ids that never get a record
  const nodes = [...boxes, ...leaves, ...looses, ...ghosts];
  const creatable = [...boxes, ...leaves, ...looses];
  const refs: string[] = [];
  const home = new Map(nodes.map((id) => [id, g.pick(POOL)]));

  const probe = new Oracle(createEngine(TEST_SCHEMA).schema);
  const ops: Op[] = [];
  const made = new Set<string>(['default']); // the graphs that exist, as the probe says
  const record = (o: Op): void => {
    ops.push(o);
    const r = run(probe, o);
    if (!('error' in r)) { if (o.op === 'createGraph') made.add(o.name); else if (o.op === 'dropGraph') made.delete(o.name); }
  };
  const graphOf = (id: string): string | undefined => probe.graphOf(id);
  const exists = (id: string): boolean => graphOf(id) !== undefined;
  const dead = (id: string): boolean => exists(id) && probe.first(graphOf(id)!, id, MARKER) !== undefined;
  const live = (ids: readonly string[]): string[] => ids.filter((id) => exists(id) && !dead(id));
  const tombs = (): string[] => nodes.filter(dead);
  /** The graph an operation on a node names: the graph that holds it, or one of the pool when none does or, rarely, by mistake. */
  const where = (id: string): string => (graphOf(id) !== undefined && g.chance(0.94) ? graphOf(id)! : g.pick(g.chance(0.7) && made.size > 0 ? [...made] : POOL));
  const listOf = (box: string): string[] => (kindOf(box) === 'Box' && exists(box) ? probe.items(graphOf(box)!, box, 'items') : []);
  const holders = (): string[] => [...boxes, ...leaves].filter(exists);
  const anyBox = (): string => g.pick(g.chance(0.9) && boxes.some(exists) ? boxes.filter(exists) : boxes);
  const anyNode = (): string => g.pick(nodes);
  const target = (): string => g.pick(g.chance(0.5) && tombs().length > 0 ? tombs() : nodes);
  const stamp = (): string => `T${ops.length}`;
  const embeddedId = (): string => `${g.pick([...boxes, ...leaves])}:refs:Ref:${flake()}`;

  for (const name of POOL.slice(1, 3)) record({ op: 'createGraph', name }); // two more graphs to start with, the rest as the sequence goes
  while (ops.length < LENGTH) {
    const t = g.int(100);
    if (t < 3) {
      record({ op: 'createGraph', name: g.chance(0.25) ? g.pick(BAD_NAMES) : g.pick(POOL) });
    } else if (t < 5) {
      record({ op: 'dropGraph', name: g.chance(0.85) ? g.pick(g.chance(0.8) ? [...made] : POOL) : g.pick([...BAD_NAMES, 'nowhere']) });
    } else if (t < 22) {
      const id = g.pick(creatable);
      record({ op: 'create', graph: g.chance(0.8) ? home.get(id)! : g.pick(POOL), id, kind: g.int(100) < 94 ? kindOf(id) : g.pick(['Box', 'Leaf', 'Loose', 'Ref']) });
    } else if (t < 31) {
      const host = anyBox();
      const item = g.chance(0.05) ? embeddedId() : g.chance(0.5) && live([...boxes, ...leaves]).length > 0 ? g.pick(live([...boxes, ...leaves])) : g.chance(0.85) ? target() : g.pick(nodes);
      record({ op: 'insert', graph: where(host), host, item, at: g.chance(0.7) ? undefined : g.int(listOf(host).length + 1) });
    } else if (t < 33) {
      const host = anyBox(); const list = listOf(host);
      record({ op: 'move', graph: where(host), host, item: g.chance(0.85) && list.length > 0 ? g.pick(list) : g.chance(0.5) ? embeddedId() : anyNode(), to: g.int(list.length + 1) });
    } else if (t < 36) {
      const host = anyBox(); const list = listOf(host);
      record({ op: 'removeItem', graph: where(host), host, item: g.chance(0.8) && list.length > 0 ? g.pick(list) : anyNode() });
    } else if (t < 48) {
      const field = g.pick(['likes', 'mate', 'pinned', 'likes', 'items']);
      const host = field === 'pinned' || field === 'items' ? anyBox() : g.pick(g.chance(0.8) ? leaves : nodes);
      record({ op: 'pair', how: g.chance(0.85) ? 'add' : 'remove', graph: where(host), host, field, value: field === 'items' && g.chance(0.05) ? embeddedId() : target() });
    } else if (t < 49) {
      const host = g.pick(nodes);
      record({ op: 'clear', graph: where(host), host, field: g.pick(['likes', 'mate', 'pinned', 'items', 'refs']) });
    } else if (t < 54) {
      const owner = g.chance(0.9) && holders().length > 0 ? g.pick(holders()) : g.pick([...boxes, ...leaves, ...looses, ...ghosts]);
      const ref = `${owner}:refs:Ref:${flake()}`;
      refs.push(ref);
      record({ op: 'makeRef', graph: where(owner), refGraph: g.chance(0.85) ? where(owner) : g.pick(POOL), owner, ref, ...(g.chance(0.9) ? { to: target() } : {}) });
    } else if (t < 62) {
      const id = g.chance(0.75) && live([...boxes, ...leaves]).length > 0 ? g.pick(live([...boxes, ...leaves])) : g.chance(0.5) && tombs().length > 0 ? g.pick(tombs()) : g.pick(g.chance(0.5) && refs.length > 0 ? refs : [...looses, ...ghosts]);
      record({ op: g.chance(0.7) ? 'tombstone' : 'subtree', graph: where(id), id, at: stamp() });
    } else if (t < 68) {
      record({ op: 'sweep', graph: g.pick(g.chance(0.85) ? [...made] : POOL) });
    } else if (t < 71) {
      const id = g.chance(0.85) ? g.pick(nodes) : g.pick(refs.length > 0 ? refs : nodes);
      record({ op: 'removeNode', graph: where(id), id });
    } else if (t < 78) {
      const absent = creatable.filter((id) => !exists(id));
      const id = absent.length > 0 && g.chance(0.9) ? g.pick(absent) : g.pick(creatable);
      const fields: Record<string, Value | readonly Value[]> = {};
      if (kindOf(id) !== 'Loose') {
        if (g.chance(0.4)) fields[MARKER] = stamp();
        if (g.chance(0.6)) fields.likes = Array.from({ length: 1 + g.int(2) }, target);
        if (kindOf(id) === 'Box' && g.chance(0.5)) fields.items = Array.from({ length: 1 + g.int(3) }, () => (g.chance(0.06) ? embeddedId() : target()));
        if (g.chance(0.4)) fields.label = 'b';
      } else fields.name = 'l';
      record({ op: 'build', graph: g.chance(0.85) ? home.get(id)! : g.pick(POOL), record: { id, kind: kindOf(id), fields } });
    } else { // reads
      const r = g.int(8);
      const id = g.pick(g.chance(0.85) ? [...boxes, ...leaves] : [...nodes, ...refs]);
      const graph = g.chance(0.7) ? where(id) : g.pick(POOL);
      if (r === 0) record({ op: g.pick(['values', 'first'] as const), graph, id, field: g.pick(['likes', 'mate', 'items', 'refs', 'up', MARKER, 'label', 'pinned']) });
      else if (r === 1) record({ op: 'items', graph, id: anyBox() });
      else if (r < 5) record({ op: 'subjects', graph, field: g.pick(['likes', 'mate', 'items', 'refs', 'to', 'pinned']), id: g.chance(0.9) ? g.pick(nodes) : g.pick(refs.length > 0 ? refs : nodes) });
      else if (r === 5) record({ op: 'idsOfKind', graph, kind: g.pick(KINDS) });
      else if (r === 6) record({ op: 'record', graph, id });
      else record({ op: 'graphOf', id: g.pick(g.chance(0.9) ? nodes : refs.length > 0 ? refs : nodes) });
    }
  }
  return { all: nodes, refs, ops };
}

/** The ids an operation names, which the comparison after it reads in full. */
function touched(o: Op): string[] {
  switch (o.op) {
    case 'create': case 'removeNode': case 'record': case 'tombstone': case 'subtree': case 'items': case 'values': case 'first': case 'graphOf': return [o.id];
    case 'subjects': return [o.id];
    case 'insert': case 'removeItem': case 'move': return [o.host, o.item];
    case 'pair': return [o.host, ...(typeof o.value === 'string' ? [o.value] : [])];
    case 'clear': return [o.host];
    case 'makeRef': return [o.owner, o.ref, ...(o.to !== undefined ? [o.to] : [])];
    case 'build': return [o.record.id, ...Object.values(o.record.fields).flat().filter((v): v is string => typeof v === 'string')];
    case 'sweep': case 'idsOfKind': case 'createGraph': case 'dropGraph': return [];
  }
}

/** What the engine alone shows of the universe in every graph of the pool at a moment. */
interface Snap { readonly json: string; readonly records: ReadonlyMap<string, unknown> }
function snap(x: Engine, universe: readonly string[]): Snap {
  const records = new Map<string, unknown>();
  const parts: unknown[] = [];
  for (const graph of POOL) {
    for (const id of universe) {
      const rec = x.record(graph, id);
      records.set(`${graph}|${id}`, rec);
      parts.push([graph, id, rec, FIELDS.map((f) => [...x.subjectsOf(graph, f, id)].sort())]);
    }
    parts.push(KINDS.map((k) => [...x.idsOfKind(graph, k)].sort()));
  }
  parts.push(universe.map((id) => x.graphOf(id)));
  return { json: JSON.stringify(parts), records };
}

describe('the engine against the oracle: several graphs', () => {
  for (const seed of SEEDS) {
    test(`seed ${seed}: ${LENGTH} operations, compared after every one`, () => {
      const { all, refs, ops } = generate(seed);
      const engine = createEngine(TEST_SCHEMA);
      const oracle = new Oracle(engine.schema);
      const universe = [...all, ...refs, 'zzz', ''];
      let errors = 0;

      const sameState = (id: string, at: string): void => {
        for (const graph of POOL) {
          for (const op of [{ op: 'record', graph, id }, { op: 'values', graph, id, field: 'up' }, { op: 'items', graph, id }, ...FIELDS.map((field) => ({ op: 'subjects', graph, field, id })), { op: 'values', graph, id, field: 'refs' }] as Op[]) {
            assert.deepEqual(run(engine, op), run(oracle, op), `${at}: ${op.op} of ${id} in ${graph}`);
          }
        }
        assert.deepEqual(run(engine, { op: 'graphOf', id }), run(oracle, { op: 'graphOf', id }), `${at}: graphOf ${id}`);
      };

      ops.forEach((op, i) => {
        const at = `seed ${seed}, operation ${i}: ${JSON.stringify(op)}`;
        const guarded = op.op === 'createGraph' || op.op === 'dropGraph' || op.op === 'sweep';
        const before = guarded ? snap(engine, universe) : undefined;
        const tombstonesBefore = op.op === 'sweep' ? universe.filter((id) => engine.graphOf(id) !== undefined && engine.values(engine.graphOf(id)!, id, MARKER).length > 0) : [];
        const holder = op.op === 'sweep' ? new Map(tombstonesBefore.map((id) => [id, engine.graphOf(id)!])) : undefined;
        const a = run(engine, op);
        const b = run(oracle, op);
        assert.deepEqual(a, b, at);
        if ('error' in a) errors++;

        if (before !== undefined && 'error' in a) assert.equal(snap(engine, universe).json, before.json, `${at}: a refused operation changed the engine`);
        if (before !== undefined && op.op === 'dropGraph' && !('error' in a)) {
          const after = snap(engine, universe);
          for (const id of universe) {
            assert.equal(engine.record(op.name, id), undefined, `${at}: ${id} still has a record in the dropped graph`);
            assert.notEqual(engine.graphOf(id), op.name, `${at}: graphOf ${id} names the dropped graph`);
          }
          for (const k of KINDS) assert.deepEqual(engine.idsOfKind(op.name, k), [], `${at}: the dropped graph still holds ${k}`);
          for (const graph of POOL) {
            if (graph === op.name) continue;
            for (const id of universe) assert.deepEqual(after.records.get(`${graph}|${id}`), before.records.get(`${graph}|${id}`), `${at}: ${id} changed in ${graph}`);
          }
        }
        if (holder !== undefined && op.op === 'sweep' && !('error' in a)) {
          for (const id of (a as { value: string[] }).value) assert.equal(holder.get(id), op.graph, `${at}: ${id} swept by a graph that does not hold it`);
          for (const [id, graph] of holder) if (graph !== op.graph) assert.equal(engine.graphOf(id), graph, `${at}: the tombstone ${id} of ${graph} went with a sweep of ${op.graph}`);
        }

        const full = i % FULL_EVERY === 0 || i === ops.length - 1;
        for (const id of full ? universe : touched(op)) sameState(id, at);
        if (full) for (const graph of POOL) for (const k of KINDS) assert.deepEqual(run(engine, { op: 'idsOfKind', graph, kind: k }), run(oracle, { op: 'idsOfKind', graph, kind: k }), `${at}: the ids of ${k} in ${graph}`);

        // At every step: an id is in one graph, no bucket names a subject with no record, the reverse equals a scan in each graph, and each tree holds.
        const homes = new Map<string, string>();
        for (const id of universe) {
          const holding = POOL.filter((graph) => engine.record(graph, id) !== undefined);
          assert.ok(holding.length <= 1, `${at}: ${id} has a record in ${holding.join(' and ')}`);
          assert.equal(engine.graphOf(id), holding[0], `${at}: graphOf ${id}`);
          if (holding[0] !== undefined) homes.set(id, holding[0]);
        }
        for (const subject of inspectEngine(engine).bucketedSubjects()) assert.ok(homes.has(subject), `${at}: a bucket names ${subject}, which has no record`);
        for (const graph of POOL) {
          const here = universe.filter((id) => homes.get(id) === graph);
          // Existence is a record in that graph: exists and size read the records, the oracle's too, whatever the pairs name.
          assert.equal(engine.size(graph), here.length, `${at}: size of ${graph}`);
          assert.equal(oracle.size(graph), here.length, `${at}: the oracle's size of ${graph}`);
          for (const id of universe) assert.deepEqual([engine.exists(graph, id), oracle.exists(graph, id)], [homes.get(id) === graph, homes.get(id) === graph], `${at}: exists ${id} in ${graph}`);
          for (const f of FIELDS) {
            const scan = new Map<string, string[]>();
            for (const host of here) for (const v of engine.values(graph, host, f) as string[]) scan.set(v, [...(scan.get(v) ?? []), host]);
            for (const id of universe) {
              assert.deepEqual(engine.subjectsOf(graph, f, id).sort(), (scan.get(id) ?? []).sort(), `${at}: the reverse of ${f} for ${id} in ${graph}`);
              assert.equal(engine.countSubjectsOf(graph, f, id), (scan.get(id) ?? []).length, `${at}: the count of ${f} for ${id} in ${graph}`);
            }
          }
          checkTree(engine, universe, `${at} (tree of ${graph})`, graph);
        }
      });
      assert.ok(errors < ops.length, 'a sequence that only fails shows nothing');
    });
  }

  test('the sequences reach what they are for', () => {
    const seen = {
      graphsMade: 0, namesRefused: 0, graphsTaken: 0, drops: 0, dropsRefusedByPair: 0, dropsNoGraph: 0, dropsWithNodes: 0,
      crossPairs: 0, crossContainer: 0, readsSplit: 0, sweepsSome: 0, sweepsOfOther: 0, embeddedRefused: 0, graphOfSome: 0, graphOfNone: 0, rebuilt: 0,
      errors: new Set<string>(),
    };
    for (const seed of SEEDS) {
      const { all, refs, ops } = generate(seed);
      const universe = [...all, ...refs];
      const engine = createEngine(TEST_SCHEMA);
      const dropped = new Set<string>();
      for (const op of ops) {
        const nodesBefore = op.op === 'dropGraph' ? universe.filter((id) => engine.record(op.name, id) !== undefined).length : 0;
        const r = run(engine, op);
        if ('error' in r) {
          seen.errors.add(`${r.error}:${r.rule ?? ''}`);
          if (op.op === 'createGraph') { if (POOL.includes(op.name)) seen.graphsTaken++; else seen.namesRefused++; }
          else if (op.op === 'dropGraph') { if (POOL.includes(op.name) && universe.some((id) => engine.graphOf(id) !== undefined)) seen.dropsRefusedByPair++; else seen.dropsNoGraph++; }
          else if ((op.op === 'insert' || op.op === 'move') && ownerOf(op.item) !== undefined && r.error === 'Refused') seen.embeddedRefused++;
          continue;
        }
        if (op.op === 'createGraph') { seen.graphsMade++; if (dropped.has(op.name)) seen.rebuilt++; }
        else if (op.op === 'dropGraph') { seen.drops++; dropped.add(op.name); if (nodesBefore > 0) seen.dropsWithNodes++; }
        else if (op.op === 'pair' && op.how === 'add' && typeof op.value === 'string' && engine.graphOf(op.value) !== undefined && engine.graphOf(op.value) !== op.graph) seen.crossPairs++;
        else if (op.op === 'insert' && engine.graphOf(op.item) !== undefined && engine.graphOf(op.item) !== op.graph) seen.crossContainer++;
        else if (op.op === 'subjects') { if (POOL.some((graph) => graph !== op.graph && engine.subjectsOf(graph, op.field, op.id).length > 0)) seen.readsSplit++; }
        else if (op.op === 'sweep' && (r as { value: string[] }).value.length > 0) { seen.sweepsSome++; if (POOL.filter((graph) => graph !== op.graph).some((graph) => universe.some((id) => engine.record(graph, id) !== undefined))) seen.sweepsOfOther++; }
        else if (op.op === 'graphOf') { if ((r as { value: unknown }).value === undefined) seen.graphOfNone++; else seen.graphOfSome++; }
      }
    }
    assert.ok(seen.graphsMade > 40, `graphs made: ${seen.graphsMade}`);
    assert.ok(seen.namesRefused > 10, `names refused: ${seen.namesRefused}`);
    assert.ok(seen.graphsTaken > 10, `graphs made twice: ${seen.graphsTaken}`);
    assert.ok(seen.drops > 20, `graphs dropped: ${seen.drops}`);
    assert.ok(seen.dropsWithNodes > 20, `graphs dropped with nodes in them: ${seen.dropsWithNodes}`);
    assert.ok(seen.dropsRefusedByPair > 10, `drops refused: ${seen.dropsRefusedByPair}`);
    assert.ok(seen.dropsNoGraph > 6, `drops of a graph that is not there: ${seen.dropsNoGraph}`);
    assert.ok(seen.rebuilt > 10, `graphs made again after a drop: ${seen.rebuilt}`);
    assert.ok(seen.crossPairs > 40, `references across graphs: ${seen.crossPairs}`);
    assert.ok(seen.crossContainer > 30, `containers listing a node of another graph: ${seen.crossContainer}`);
    assert.ok(seen.readsSplit > 6, `reverse reads of an object with subjects in another graph: ${seen.readsSplit}`);
    assert.ok(seen.sweepsSome > 50, `sweeps that removed something: ${seen.sweepsSome}`);
    assert.ok(seen.sweepsOfOther > 40, `sweeps that removed something while another graph held nodes: ${seen.sweepsOfOther}`);
    assert.ok(seen.embeddedRefused > 15, `embedded ids refused in the containment field: ${seen.embeddedRefused}`);
    assert.ok(seen.graphOfSome > 20 && seen.graphOfNone > 5, `graphOf: ${seen.graphOfSome} answered, ${seen.graphOfNone} not`);
    for (const e of ['Refused:', 'Refused:no node']) assert.ok(seen.errors.has(e), `${e} was never thrown (${[...seen.errors].join(', ')})`);
  });
});
