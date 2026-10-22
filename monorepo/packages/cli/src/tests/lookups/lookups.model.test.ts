// The model-based test of the maps of a literal value (planning/core.md, Batch 10 Done when and Layer 2): the engine and the oracle get the same
// seeded random sequence of writes over the Aperas schema and the three graphs of the shell, and after every operation the three maps equal a
// linear scan of the oracle: a profile by handle, a view by name, an artifact or a folder by stored path (with and without the graph and the kind
// as filters), the keys with more than one live holder, and the size of each map. The scan is written here, apart from the maps: every record of
// the four kinds in the graphs, read from the oracle, a tombstoned one dropped, the first holder by code point.
//
// The sequences hold: the build of a node (with a key from a small pool of strings, shared between the three maps, so that duplicates are common;
// now and then a tombstoned node), a bare `createNode` followed by writes of a key, a second value for a one-valued field (the engine does not
// take it), a clear and the removal of a pair, a tombstone, the tombstone of a subtree (over `children` of folders and artifacts, in either graph),
// a removal, a sweep, the drop and the making of a graph, and now and then a reload: a dump of the engine, a load into a new engine and new maps,
// whose maps equal the scan too, and now and then a few writes made without telling the maps and a `rebuild` of the same maps after them. After a
// write the engine took, the maps are told by the function of that write; a write it did not take is not told. A failing run names its seed and the operation, and the seed replays it.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Engine, Id } from '@aperas/core/apeironNgn/interface';
import { MIRROR_GRAPHS } from '@aperas/core/graphConfig';
import { createLookups, type Duplicate, type Lookups } from '@aperas/core/shell/lookups';
import { dumpMirror } from '@aperas/core/shell/mirrorDump';
import { loadMirror } from '@aperas/core/shell/mirrorLoad';
import { createMirrorGraphs } from '@aperas/core/shell/mirrorFiles';
import { Oracle } from '../support/oracle.ts';
import { noNode } from '../support/refusals.ts';
import { rng } from '../support/prng.ts';
import { THREADS, TREE, VIEWS, idOf, newEngine, scratchRoot, testMapping } from '../support/mirrorFixture.ts';

const SEEDS = Array.from({ length: 20 }, (_, i) => 1001 + i);
const LENGTH = 200;
/** How often (one in) a reload is made. */
const RELOAD_EVERY = 60;
/** Every this many operations, the next few are made without telling the maps, and a rebuild follows. */
const SILENT_EVERY = 45;
const SILENT_LENGTH = 4;
const MARKER = 'tombstonedAt';
const HANDLES = ['h0', 'h1', 'h2', 'shared'];
const NAMES = ['n0', 'n1', 'shared'];
const PATHS = ['p0', 'p1', 'p2', 'p3', 'shared'];
const GRAPHS = [TREE, THREADS, VIEWS];
const PATH_KINDS = ['ArtifactNode', 'FolderNode'];
const KEY_FIELD: Record<string, string> = { Profile: 'handle', TreeView: 'name', ArtifactNode: 'path', FolderNode: 'path' };
const POOL: Record<string, string[]> = { Profile: HANDLES, TreeView: NAMES, ArtifactNode: PATHS, FolderNode: PATHS };
const HOME: Record<string, string> = { Profile: TREE, TreeView: VIEWS };

type Op =
  | { op: 'build'; graph: string; id: Id; kind: string; fields: Record<string, string> }
  | { op: 'create'; graph: string; id: Id; kind: string }
  | { op: 'add'; graph: string; id: Id; field: string; value: string }
  | { op: 'clear'; graph: string; id: Id; field: string }
  | { op: 'removePair'; graph: string; id: Id; field: string; value: string }
  | { op: 'contain'; graph: string; host: Id; item: Id }
  | { op: 'tombstone' | 'subtree'; graph: string; id: Id }
  | { op: 'remove'; graph: string; id: Id }
  | { op: 'sweep'; graph: string }
  | { op: 'createGraph' | 'dropGraph'; graph: string }
  | { op: 'reload' };

type Outcome = { ok: true; value?: unknown } | { ok: false; error: string; rule?: string };

/** One write on a store, the outcome of it, and nothing else. */
function apply(x: Engine, o: Op): Outcome {
  try {
    switch (o.op) {
      case 'build': x.build(o.graph, { id: o.id, kind: o.kind, fields: o.fields }); break;
      case 'create': x.createNode(o.graph, o.id, o.kind); break;
      case 'add': x.addPair(o.graph, o.id, o.field, o.value); break;
      case 'clear': x.clearField(o.graph, o.id, o.field); break;
      case 'removePair': x.removePair(o.graph, o.id, o.field, o.value); break;
      case 'contain': x.insertItem(o.graph, o.host, 'children', o.item); break;
      case 'tombstone': x.tombstone(o.graph, o.id, 'T'); break;
      case 'subtree': x.tombstoneSubtree(o.graph, o.id, 'T'); break;
      case 'remove': x.removeNode(o.graph, o.id); break;
      case 'sweep': return { ok: true, value: x.sweep(o.graph) };
      case 'createGraph': x.createGraph(o.graph); break;
      case 'dropGraph': x.dropGraph(o.graph); break;
      case 'reload': break;
    }
    return { ok: true };
  } catch (e) {
    const err = e as Error;
    return { ok: false, error: err.name, ...(noNode(err) ? { rule: 'no node' } : {}) };
  }
}

/** Tells the maps of a write the engine took. */
/** The ids of the subtree of `id` over `children` in the graph, the node first; read before the write, which takes each member out of the lists that held it. */
function subtreeMembers(x: Engine, graph: string, id: Id): Id[] {
  const members: Id[] = [];
  const seen = new Set<Id>([id]);
  for (const stack = [id]; stack.length > 0; ) {
    const next = stack.pop()!;
    members.push(next);
    if (x.graphOf(next) !== graph) continue;
    for (const child of x.items(graph, next, 'children')) if (!seen.has(child) && x.graphOf(child) === graph) { seen.add(child); stack.push(child); }
  }
  return members;
}

function tell(maps: Lookups, o: Op, outcome: Outcome, members: readonly Id[]): void {
  switch (o.op) {
    case 'build': maps.built(o.graph, o.id); break;
    case 'add': case 'clear': case 'removePair': maps.fieldWritten(o.graph, o.id, o.field); break;
    case 'tombstone': maps.tombstoned(o.graph, o.id); break;
    case 'subtree': for (const member of members) maps.tombstoned(o.graph, member); break;
    case 'remove': maps.removed(o.graph, o.id); break;
    case 'sweep': maps.swept(o.graph, (outcome as { value: Id[] }).value); break;
    case 'dropGraph': maps.graphDropped(o.graph); break;
    default: break; // `create` and `contain` change no key, `createGraph` holds no node, `reload` is not a write
  }
}

/** What a linear scan of a store gives: for each of the three maps, the live holders of each key, by code point, with the graph and kind of each. */
interface Held { readonly id: Id; readonly graph: string; readonly kind: string }
interface Scan { readonly handle: Map<string, Held[]>; readonly name: Map<string, Held[]>; readonly path: Map<string, Held[]> }

function scan(x: Engine): Scan {
  const out: Scan = { handle: new Map(), name: new Map(), path: new Map() };
  const put = (m: Map<string, Held[]>, key: string, h: Held): void => { m.set(key, [...(m.get(key) ?? []), h].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))); };
  for (const graph of GRAPHS) {
    for (const kind of ['Profile', 'TreeView', ...PATH_KINDS]) {
      for (const id of x.idsOfKind(graph, kind)) {
        const record = x.record(graph, id);
        if (record === undefined || record.fields.some((f) => f.name === MARKER && f.values.length > 0)) continue;
        const key = record.fields.find((f) => f.name === KEY_FIELD[kind])?.values[0];
        if (typeof key !== 'string') continue;
        put(kind === 'Profile' ? out.handle : kind === 'TreeView' ? out.name : out.path, key, { id, graph, kind });
      }
    }
  }
  return out;
}

const dupsOf = (s: Scan): Duplicate[] => (['handle', 'name', 'path'] as const).flatMap((map) => [...s[map].entries()].filter(([, h]) => h.length > 1).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, h]) => ({ map, key, ids: h.map((x) => x.id) })));
const count = (m: Map<string, Held[]>): number => [...m.values()].reduce((n, h) => n + h.length, 0);

/** Fails when the maps differ from the scan. */
function agree(maps: Lookups, s: Scan, where: string): void {
  for (const key of [...HANDLES, ...NAMES, ...PATHS, 'absent', '']) {
    assert.equal(maps.profileByHandle(key), s.handle.get(key)?.[0]?.id, `${where}: profile ${JSON.stringify(key)}`);
    assert.equal(maps.viewByName(key), s.name.get(key)?.[0]?.id, `${where}: view ${JSON.stringify(key)}`);
    const held = s.path.get(key) ?? [];
    assert.equal(maps.liveAtPath(key), held[0]?.id, `${where}: path ${JSON.stringify(key)}`);
    for (const graph of GRAPHS) {
      assert.equal(maps.liveAtPath(key, { graph }), held.find((h) => h.graph === graph)?.id, `${where}: path ${JSON.stringify(key)} in ${graph}`);
      for (const kind of PATH_KINDS) assert.equal(maps.liveAtPath(key, { graph, kind }), held.find((h) => h.graph === graph && h.kind === kind)?.id, `${where}: path ${JSON.stringify(key)} in ${graph} of ${kind}`);
    }
    for (const kind of PATH_KINDS) assert.equal(maps.liveAtPath(key, { kind }), held.find((h) => h.kind === kind)?.id, `${where}: path ${JSON.stringify(key)} of ${kind}`);
  }
  assert.deepEqual(maps.duplicates(), dupsOf(s), `${where}: duplicates`);
  assert.deepEqual(maps.size(), { profiles: count(s.handle), views: count(s.name), paths: count(s.path) }, `${where}: size`);
}

/** The engine's mirror dumped, loaded into a new engine, and the maps of that one rebuilt. */
function reloaded(x: Engine): { engine: Engine; maps: Lookups } {
  const { root, cleanup } = scratchRoot();
  try {
    const mapping = testMapping();
    dumpMirror(x, root, mapping);
    const engine = newEngine();
    const result = loadMirror(engine, root, mapping);
    assert.deepEqual({ errors: result.errors, rejected: result.rejected }, { errors: [], rejected: [] }, 'the dump loads');
    const maps = createLookups(engine, MIRROR_GRAPHS);
    maps.rebuild();
    return { engine, maps };
  } finally {
    cleanup();
  }
}

function plan(seed: number): { next: (made: ReadonlySet<string>, probe: Oracle) => Op } {
  const g = rng(seed);
  const ids: Record<string, Id[]> = {};
  const home = new Map<Id, string>();
  let serial = 0;
  for (const [kind, n] of [['Profile', 8], ['TreeView', 8], ['ArtifactNode', 12], ['FolderNode', 8]] as const) {
    ids[kind] = Array.from({ length: n }, () => idOf(kind, ++serial));
    for (const id of ids[kind]!) home.set(id, HOME[kind] ?? (g.chance(0.3) ? THREADS : TREE));
  }
  const all = Object.values(ids).flat();
  const containers = [...ids.ArtifactNode!, ...ids.FolderNode!];
  const kindOf = (id: Id): string => id.split(':')[0]!;
  /** The graphs a kind has a file in: a node of a kind in another is not written by a dump. */
  const graphsOf = (kind: string): string[] => (kind === 'Profile' ? [TREE] : kind === 'TreeView' ? [VIEWS] : [TREE, THREADS]);
  const where = (id: Id, probe: Oracle): string => {
    const at = probe.graphOf(id);
    return at !== undefined && g.chance(0.95) ? at : g.chance(0.9) ? home.get(id)! : g.pick(graphsOf(kindOf(id)));
  };
  const keyOf = (kind: string): string => g.pick(POOL[kind]!);
  const fieldsFor = (id: Id): Record<string, string> => {
    const kind = kindOf(id);
    const f: Record<string, string> = {};
    if (kind === 'Profile') { f.handle = keyOf(kind); if (g.chance(0.5)) f.name = g.pick([...NAMES, 'Will']); }
    else if (kind === 'TreeView') { f.profile = g.pick(ids.Profile!); f.name = keyOf(kind); }
    else { f.title = 't'; f.path = keyOf(kind); }
    if (kind !== 'Profile' && kind !== 'TreeView' && g.chance(0.12)) f[MARKER] = 'T';
    return f;
  };
  return {
    next(made, probe) {
      const missing = GRAPHS.filter((n) => !made.has(n));
      if (missing.length > 0 && g.chance(0.4)) return { op: 'createGraph', graph: g.pick(missing) };
      const t = g.int(100);
      const exist = (xs: readonly Id[]): Id[] => xs.filter((x) => probe.graphOf(x) !== undefined);
      const absent = (xs: readonly Id[]): Id[] => xs.filter((x) => probe.graphOf(x) === undefined);
      /** A node that is there, most of the time, when the operation is on one. */
      const there = (xs: readonly Id[] = all): Id => g.pick(g.chance(0.9) && exist(xs).length > 0 ? exist(xs) : xs);
      const id = t < 36 ? g.pick(g.chance(0.9) && absent(all).length > 0 ? absent(all) : all) : there();
      const kind = kindOf(id);
      if (t < 30) return { op: 'build', graph: where(id, probe), id, kind, fields: fieldsFor(id) };
      if (t < 36) return { op: 'create', graph: where(id, probe), id, kind };
      if (t < 48) {
        // A second value for a one-valued field is not taken (`Refused`): most writes go to a field that is empty.
        const at = probe.graphOf(id);
        const field = g.chance(0.85) ? KEY_FIELD[kind]! : g.pick(['title', 'name', 'handle', 'path']);
        if (at !== undefined && probe.first(at, id, field) !== undefined && g.chance(0.85)) return { op: 'clear', graph: at, id, field };
        return { op: 'add', graph: where(id, probe), id, field, value: g.chance(0.9) ? keyOf(kind) : 'x' };
      }
      if (t < 56) return { op: 'clear', graph: where(id, probe), id, field: g.chance(0.85) ? KEY_FIELD[kind]! : g.pick(['title', 'text']) };
      if (t < 60) { const at = probe.graphOf(id); const v = at !== undefined ? probe.first(at, id, KEY_FIELD[kind]!) : undefined; return { op: 'removePair', graph: where(id, probe), id, field: KEY_FIELD[kind]!, value: typeof v === 'string' && g.chance(0.8) ? v : keyOf(kind) }; }
      if (t < 70) { const host0 = there(containers); return { op: 'contain', graph: where(host0, probe), host: host0, item: there(containers) }; }
      if (t < 78) { const live = exist(all).filter((x) => probe.first(probe.graphOf(x)!, x, MARKER) === undefined); const tid = g.chance(0.85) && live.length > 0 ? g.pick(live) : id; return { op: 'tombstone', graph: where(tid, probe), id: tid }; }
      if (t < 84) { const host = there(containers); return { op: 'subtree', graph: where(host, probe), id: host }; }
      if (t < 90) return { op: 'remove', graph: where(id, probe), id };
      if (t < 93) return { op: 'sweep', graph: g.pick(GRAPHS) };
      if (t < 95) return { op: 'createGraph', graph: g.pick(GRAPHS) };
      if (t < 97) return { op: 'dropGraph', graph: g.pick(GRAPHS) };
      return { op: 'create', graph: where(id, probe), id, kind };
    },
  };
}

describe('the maps against a linear scan of the oracle (20 seeds)', () => {
  for (const seed of SEEDS) {
    test(`seed ${seed}`, () => {
      const engine = newEngine();
      createMirrorGraphs(engine);
      const oracle = new Oracle(newEngine().schema);
      for (const graph of GRAPHS) oracle.createGraph(graph);
      oracle.dropGraph('default');
      const maps = createLookups(engine, MIRROR_GRAPHS);
      maps.rebuild();
      const made = new Set<string>(GRAPHS);
      const { next } = plan(seed);
      const seen = { accepted: 0, refused: 0, duplicates: 0 };
      /** Writes still to be made without telling the maps, before a rebuild brings them back (the load's use of `rebuild` on maps that hold something). */
      let silent = 0;
      for (let i = 0; i < LENGTH; i++) {
        if (i % SILENT_EVERY === SILENT_EVERY - 1) silent = SILENT_LENGTH;
        const o = i > 0 && i % RELOAD_EVERY === 0 && GRAPHS.every((n) => made.has(n)) ? ({ op: 'reload' } as Op) : next(made, oracle);
        const where = `seed ${seed}, operation ${i} ${JSON.stringify(o)}`;
        if (o.op === 'reload') {
          const again = reloaded(engine);
          agree(again.maps, scan(oracle), `${where}: the reloaded maps`);
          continue;
        }
        const members = o.op === 'subtree' && engine.graphOf(o.id) === o.graph ? subtreeMembers(engine, o.graph, o.id) : [];
        const a = apply(engine, o);
        const b = apply(oracle, o);
        assert.deepEqual(a.ok ? { ok: true, ...(o.op === 'sweep' ? { value: a.value } : {}) } : a, b.ok ? { ok: true, ...(o.op === 'sweep' ? { value: b.value } : {}) } : b, `${where}: the engine and the oracle answer alike`);
        if (a.ok) {
          seen.accepted += 1;
          if (o.op === 'createGraph') made.add(o.graph);
          if (o.op === 'dropGraph') made.delete(o.graph);
          if (silent === 0) tell(maps, o, a, members);
        } else seen.refused += 1;
        if (silent > 0) {
          silent -= 1;
          if (silent > 0) continue;
          maps.rebuild(); // the maps held a state the engine had left: the rebuild forgets it
        }
        const s = scan(oracle);
        agree(maps, s, where);
        if (dupsOf(s).length > 0) seen.duplicates += 1;
      }
      assert.ok(seen.accepted > LENGTH / 2, `the sequence takes most of its writes (${JSON.stringify(seen)})`);
      assert.ok(seen.duplicates > 0, `and holds duplicates (${JSON.stringify(seen)})`);
      assert.ok(seen.refused > 0, `and meets refusals (${JSON.stringify(seen)})`);
    });
  }
});
