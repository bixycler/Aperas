// The model-based test of the write layer and the reads of the handle (planning/core.md, Batch 11 steps 1 and 2, Done when and Layer 2): the real handle
// (`newDb`) and the oracle get the same seeded random sequence of writes, the real one through `db.write` (the shell's only way to write) and the oracle
// through the engine's own operations. The sequences hold the creation of every kind in the graph its rule gives (a bare node, then the writes of its
// keys, from a small pool of strings shared between the three maps so that duplicates are common), the embedded links of a node and their targets,
// pairs set, cleared and removed, items inserted, moved and taken out of the `children` lists (across graphs), a tombstone, the tombstone of a subtree,
// a removal and a sweep; a write the schema or the engine refuses is in them too (a second value of a one-valued field, a node that does not exist, an id
// taken, an item twice).
// After every operation:
//   - the engine and the oracle answer alike (taken, or refused with the same error and open point; the graph of a creation; the ids of a sweep);
//   - the three maps equal a linear scan of the oracle (a profile by handle, a view by name, a path with and without the graph and the kind, the
//     duplicates, the sizes), whether the write was taken or refused;
//   - the reads of the handle equal what the oracle gives: `allIdsOfKind` and `liveIdsOfKind` (by a scan of every graph), `nodeExists`, `graphOfId` and
//     `isThreadScoped` for every id of the universe, ghosts among them, and `backlinksOf` of a few ids for each reference field (all of them at the end).
// A failing run names its seed and the operation, and the seed replays it.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Id } from '@aperas/core/apeironNgn/interface';
import { allIdsOfKind, backlinksOf, graphOfId, isThreadScoped, liveIdsOfKind, newDb, nodeExists, type Db } from '@aperas/core/shell/db';
import { graphOfNewNode, type NewNode } from '@aperas/core/shell/graphOfPath';
import type { Duplicate } from '@aperas/core/shell/lookups';
import { Oracle } from '../support/oracle.ts';
import { rng } from '../support/prng.ts';
import { THREADS, TREE, VIEWS, idOf, newEngine } from '../support/mirrorFixture.ts';

const SEEDS = Array.from({ length: 20 }, (_, i) => 2001 + i);
const LENGTH = 200;
const MARKER = 'tombstonedAt';
const HANDLES = ['h0', 'h1', 'h2', 'shared'];
const NAMES = ['n0', 'n1', 'shared'];
const PATHS = ['p0', 'p1', 'p2', '.threads/t0', '.threads/t1', 'shared'];
const GRAPHS = [TREE, THREADS, VIEWS];
const PATH_KINDS = ['ArtifactNode', 'FolderNode'];
const KINDS = ['ArtifactNode', 'FolderNode', 'BlockNode', 'Profile', 'TreeView', 'Link', 'StringProp'];
const REFERENCE_FIELDS = ['children', 'target', 'links', 'profile', 'unfolds'];
const KEY_FIELD: Record<string, string> = { Profile: 'handle', TreeView: 'name', ArtifactNode: 'path', FolderNode: 'path' };
const POOL: Record<string, string[]> = { Profile: HANDLES, TreeView: NAMES, ArtifactNode: PATHS, FolderNode: PATHS };

type Op =
  | { op: 'create'; id: Id; node: NewNode }
  | { op: 'add'; graph: string; id: Id; field: string; value: string }
  | { op: 'clear'; graph: string; id: Id; field: string }
  | { op: 'removePair'; graph: string; id: Id; field: string; value: string }
  | { op: 'insert'; graph: string; host: Id; item: Id; at?: number }
  | { op: 'move'; graph: string; host: Id; item: Id; to: number }
  | { op: 'removeItem'; graph: string; host: Id; item: Id }
  | { op: 'tombstone' | 'subtree' | 'remove'; graph: string; id: Id }
  | { op: 'sweep'; graph: string };

type Outcome = { ok: true; value?: unknown } | { ok: false; error: string; point?: string };

const failed = (e: unknown): Outcome => {
  const err = e as Error & { point?: string };
  return { ok: false, error: err.name, ...(err.point !== undefined ? { point: err.point } : {}) };
};

/** One write on the handle, through its write layer. */
function applyReal(db: Db, o: Op): Outcome {
  try {
    switch (o.op) {
      case 'create': return { ok: true, value: db.write.createNode(o.id, o.node) };
      case 'add': db.write.addPair(o.graph, o.id, o.field, o.value); break;
      case 'clear': db.write.clearField(o.graph, o.id, o.field); break;
      case 'removePair': db.write.removePair(o.graph, o.id, o.field, o.value); break;
      case 'insert': db.write.insertItem(o.graph, o.host, 'children', o.item, o.at); break;
      case 'move': db.write.moveItem(o.graph, o.host, 'children', o.item, o.to); break;
      case 'removeItem': db.write.removeItem(o.graph, o.host, 'children', o.item); break;
      case 'tombstone': db.write.tombstone(o.graph, o.id, 'T'); break;
      case 'subtree': db.write.tombstoneSubtree(o.graph, o.id, 'T'); break;
      case 'remove': db.write.removeNode(o.graph, o.id); break;
      case 'sweep': return { ok: true, value: db.write.sweep(o.graph) };
    }
    return { ok: true };
  } catch (e) {
    return failed(e);
  }
}

/** The same write on the oracle, which has no maps and no write layer. */
function applyOracle(x: Oracle, o: Op): Outcome {
  try {
    switch (o.op) {
      case 'create': { const graph = graphOfNewNode(x, o.node); x.createNode(graph, o.id, o.node.kind); return { ok: true, value: graph }; }
      case 'add': x.addPair(o.graph, o.id, o.field, o.value); break;
      case 'clear': x.clearField(o.graph, o.id, o.field); break;
      case 'removePair': x.removePair(o.graph, o.id, o.field, o.value); break;
      case 'insert': x.insertItem(o.graph, o.host, 'children', o.item, o.at); break;
      case 'move': x.moveItem(o.graph, o.host, 'children', o.item, o.to); break;
      case 'removeItem': x.removeItem(o.graph, o.host, 'children', o.item); break;
      case 'tombstone': x.tombstone(o.graph, o.id, 'T'); break;
      case 'subtree': x.tombstoneSubtree(o.graph, o.id, 'T'); break;
      case 'remove': x.removeNode(o.graph, o.id); break;
      case 'sweep': return { ok: true, value: x.sweep(o.graph) };
    }
    return { ok: true };
  } catch (e) {
    return failed(e);
  }
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** What a linear scan of the oracle gives for each map: the live holders of each key, by id, with the graph and kind of each. */
interface Held { readonly id: Id; readonly graph: string; readonly kind: string }
interface Scan { readonly handle: Map<string, Held[]>; readonly name: Map<string, Held[]>; readonly path: Map<string, Held[]> }

function scan(x: Oracle): Scan {
  const out: Scan = { handle: new Map(), name: new Map(), path: new Map() };
  const put = (m: Map<string, Held[]>, key: string, h: Held): void => { m.set(key, [...(m.get(key) ?? []), h].sort((a, b) => byId(a.id, b.id))); };
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

const dupsOf = (s: Scan): Duplicate[] => (['handle', 'name', 'path'] as const).flatMap((map) => [...s[map].entries()].filter(([, h]) => h.length > 1).sort(([a], [b]) => byId(a, b)).map(([key, h]) => ({ map, key, ids: h.map((x) => x.id) })));
const count = (m: Map<string, Held[]>): number => [...m.values()].reduce((n, h) => n + h.length, 0);

/** Fails when the maps differ from the scan. */
function agreeMaps(db: Db, s: Scan, where: string): void {
  const maps = db.maps;
  for (const key of [...HANDLES, ...NAMES, ...PATHS, 'absent']) {
    assert.equal(maps.profileByHandle(key), s.handle.get(key)?.[0]?.id, `${where}: profile ${JSON.stringify(key)}`);
    assert.equal(maps.viewByName(key), s.name.get(key)?.[0]?.id, `${where}: view ${JSON.stringify(key)}`);
    const held = s.path.get(key) ?? [];
    assert.equal(maps.liveAtPath(key), held[0]?.id, `${where}: path ${JSON.stringify(key)}`);
    for (const graph of GRAPHS) {
      assert.equal(maps.liveAtPath(key, { graph }), held.find((h) => h.graph === graph)?.id, `${where}: path ${JSON.stringify(key)} in ${graph}`);
      for (const kind of PATH_KINDS) assert.equal(maps.liveAtPath(key, { graph, kind }), held.find((h) => h.graph === graph && h.kind === kind)?.id, `${where}: path ${JSON.stringify(key)} in ${graph} of ${kind}`);
    }
  }
  assert.deepEqual(maps.duplicates(), dupsOf(s), `${where}: duplicates`);
  assert.deepEqual(maps.size(), { profiles: count(s.handle), views: count(s.name), paths: count(s.path) }, `${where}: size`);
}

const tombstoned = (x: Oracle, graph: string, id: Id): boolean => x.first(graph, id, MARKER) !== undefined;

/** Fails when a listing or a per-node read of the handle differs from what the oracle gives. */
function agreeReads(db: Db, x: Oracle, universe: readonly Id[], backlinkOf: readonly Id[], where: string): void {
  for (const kind of KINDS) {
    const all = GRAPHS.flatMap((g) => x.idsOfKind(g, kind)).sort(byId);
    assert.deepEqual(allIdsOfKind(db, kind), all, `${where}: allIdsOfKind ${kind}`);
    const live = GRAPHS.flatMap((g) => x.idsOfKind(g, kind).filter((id) => !tombstoned(x, g, id))).sort(byId);
    assert.deepEqual(liveIdsOfKind(db, kind), live, `${where}: liveIdsOfKind ${kind}`);
  }
  for (const id of universe) {
    const graph = x.graphOf(id);
    assert.equal(graphOfId(db, id), graph, `${where}: graphOfId ${id}`);
    assert.equal(nodeExists(db, id), graph !== undefined, `${where}: nodeExists ${id}`);
    assert.equal(isThreadScoped(db, id), graph === THREADS, `${where}: isThreadScoped ${id}`);
  }
  for (const id of backlinkOf) {
    for (const field of REFERENCE_FIELDS) {
      const expected = GRAPHS.flatMap((g) => x.subjectsOf(g, field, id)).sort(byId);
      assert.deepEqual(backlinksOf(db, id, field), expected, `${where}: backlinksOf ${id} by ${field}`);
    }
  }
}

function plan(seed: number) {
  const g = rng(seed);
  const ids: Record<string, Id[]> = {};
  let serial = 0;
  for (const [kind, n] of [['Profile', 6], ['TreeView', 6], ['ArtifactNode', 10], ['FolderNode', 8], ['BlockNode', 8]] as const) ids[kind] = Array.from({ length: n }, () => idOf(kind, ++serial));
  const links: Id[] = [];
  const all = Object.values(ids).flat();
  const containers = [...ids.ArtifactNode!, ...ids.FolderNode!, ...ids.BlockNode!];
  const kindOf = (id: Id): string => id.split(':').slice(-2)[0]!;
  const queue: Op[] = [];
  /** The universe of the reads: every id a sequence can name, links included. */
  const universe = (): Id[] => [...all, ...links];
  const graphFor = (id: Id, probe: Oracle): string => {
    const at = probe.graphOf(id);
    if (at !== undefined && g.chance(0.95)) return at;
    return g.pick(kindOf(id) === 'Profile' ? [TREE] : kindOf(id) === 'TreeView' ? [VIEWS] : [TREE, THREADS]);
  };
  const keyOf = (kind: string): string => g.pick(POOL[kind]!);
  const next = (probe: Oracle): Op => {
    const queued = queue.shift();
    if (queued !== undefined) return queued;
    const exist = (xs: readonly Id[]): Id[] => xs.filter((x) => probe.graphOf(x) !== undefined);
    const absent = (xs: readonly Id[]): Id[] => xs.filter((x) => probe.graphOf(x) === undefined);
    /** A node that is there, most of the time, when the operation is on one. */
    const there = (xs: readonly Id[] = all): Id => g.pick(g.chance(0.9) && exist(xs).length > 0 ? exist(xs) : xs);
    const t = g.int(100);
    if (t < 26) {
      // A bare node, then (most of the time) the writes of its keys, which are separate operations.
      const kind = g.pick(['Profile', 'TreeView', 'ArtifactNode', 'ArtifactNode', 'FolderNode', 'FolderNode'] as const);
      const id = g.pick(g.chance(0.9) && absent(ids[kind]!).length > 0 ? absent(ids[kind]!) : ids[kind]!);
      const node: NewNode = PATH_KINDS.includes(kind) ? { kind, path: keyOf(kind) } : { kind };
      if (g.chance(0.85)) {
        const graph = (): string => graphFor(id, probe);
        queue.push({ op: 'add', graph: graph(), id, field: KEY_FIELD[kind]!, value: keyOf(kind) });
        if (PATH_KINDS.includes(kind)) queue.push({ op: 'add', graph: graph(), id, field: 'title', value: 't' });
      }
      return { op: 'create', id, node };
    }
    if (t < 33) {
      const id = g.pick(g.chance(0.9) && absent(ids.BlockNode!).length > 0 ? absent(ids.BlockNode!) : ids.BlockNode!);
      return { op: 'create', id, node: { kind: 'BlockNode', under: there(containers) } };
    }
    if (t < 41) {
      const owner = there([...all, ...ids.Profile!]);
      const link = `${owner}:links:Link:${idOf('Link', ++serial).split(':')[1]}`;
      links.push(link);
      const graph = probe.graphOf(owner) ?? TREE;
      if (g.chance(0.85)) queue.push({ op: 'add', graph, id: owner, field: 'links', value: link });
      if (g.chance(0.85)) queue.push({ op: 'add', graph, id: link, field: 'target', value: there() });
      return { op: 'create', id: link, node: { kind: 'Link', under: owner } };
    }
    const id = there();
    const kind = kindOf(id);
    if (t < 50 && KEY_FIELD[kind] !== undefined) {
      // A second value for a one-valued field is not taken (`Undecided` on Enforcement): most writes go to a field that is empty.
      const at = probe.graphOf(id);
      if (at !== undefined && probe.first(at, id, KEY_FIELD[kind]!) !== undefined && g.chance(0.85)) return { op: 'clear', graph: at, id, field: KEY_FIELD[kind]! };
      return { op: 'add', graph: graphFor(id, probe), id, field: KEY_FIELD[kind]!, value: keyOf(kind) };
    }
    if (t < 56) return { op: 'clear', graph: graphFor(id, probe), id, field: g.pick([...Object.values(KEY_FIELD), 'title', 'text', 'links']) };
    if (t < 60) { const at = probe.graphOf(id); const v = at !== undefined && KEY_FIELD[kind] !== undefined ? probe.first(at, id, KEY_FIELD[kind]!) : undefined; return { op: 'removePair', graph: graphFor(id, probe), id, field: KEY_FIELD[kind] ?? 'path', value: typeof v === 'string' && g.chance(0.8) ? v : keyOf(kind in POOL ? kind : 'ArtifactNode') }; }
    if (t < 63 && links.length > 0) { const link = g.pick(links); const owner = link.split(':').slice(0, 2).join(':'); return { op: 'removePair', graph: graphFor(owner, probe), id: owner, field: 'links', value: link }; }
    if (t < 77) { const host = there(containers); return { op: 'insert', graph: graphFor(host, probe), host, item: there(containers), ...(g.chance(0.3) ? { at: 0 } : {}) }; }
    if (t < 79) { const host = there(containers); const at = probe.graphOf(host); const items = at === undefined ? [] : probe.values(at, host, 'children') as Id[]; return { op: 'move', graph: graphFor(host, probe), host, item: items.length > 0 ? g.pick(items) : there(containers), to: g.int(Math.max(items.length, 1)) }; }
    if (t < 81) { const host = there(containers); const at = probe.graphOf(host); const items = at === undefined ? [] : probe.values(at, host, 'children') as Id[]; return { op: 'removeItem', graph: graphFor(host, probe), host, item: items.length > 0 ? g.pick(items) : there(containers) }; }
    if (t < 87) { const live = exist(all).filter((x) => probe.first(probe.graphOf(x)!, x, MARKER) === undefined); const tid = g.chance(0.85) && live.length > 0 ? g.pick(live) : id; return { op: 'tombstone', graph: graphFor(tid, probe), id: tid }; }
    if (t < 94) { const host = there(containers); return { op: 'subtree', graph: graphFor(host, probe), id: host }; }
    if (t < 97) return { op: 'remove', graph: graphFor(id, probe), id };
    return { op: 'sweep', graph: g.pick(GRAPHS) };
  };
  return { next, universe, ghosts: [idOf('BlockNode', 900), idOf('ArtifactNode', 901)] };
}

describe('the write layer and the reads of the handle against the oracle (20 seeds)', () => {
  for (const seed of SEEDS) {
    test(`seed ${seed}`, () => {
      const db = newDb();
      const oracle = new Oracle(newEngine().schema);
      for (const graph of GRAPHS) oracle.createGraph(graph);
      oracle.dropGraph('default');
      const { next, universe, ghosts } = plan(seed);
      const pick = rng(seed + 7000);
      const seen = { accepted: 0, refused: 0, duplicates: 0, tombstones: 0, swept: 0, threads: 0, links: 0 };
      for (let i = 0; i < LENGTH; i++) {
        const o = next(oracle);
        const where = `seed ${seed}, operation ${i} ${JSON.stringify(o)}`;
        const a = applyReal(db, o);
        const b = applyOracle(oracle, o);
        assert.deepEqual(a, b, `${where}: the handle and the oracle answer alike`);
        if (a.ok) {
          seen.accepted += 1;
          if (o.op === 'tombstone' || o.op === 'subtree') seen.tombstones += 1;
          if (o.op === 'sweep') seen.swept += (a.value as Id[]).length;
          if (o.op === 'create' && a.value === THREADS) seen.threads += 1;
          if (o.op === 'create' && o.node.kind === 'Link') seen.links += 1;
        } else seen.refused += 1;
        const s = scan(oracle);
        agreeMaps(db, s, where);
        const ids = [...universe(), ...ghosts];
        agreeReads(db, oracle, ids, Array.from({ length: 5 }, () => pick.pick(ids)), where);
        if (dupsOf(s).length > 0) seen.duplicates += 1;
      }
      const ids = [...universe(), ...ghosts];
      agreeReads(db, oracle, ids, ids, `seed ${seed}, at the end`);
      const note = JSON.stringify(seen);
      assert.ok(seen.accepted > LENGTH / 2, `the sequence takes most of its writes (${note})`);
      assert.ok(seen.refused > 0, `and meets refusals (${note})`);
      assert.ok(seen.duplicates > 0, `and holds duplicates (${note})`);
      assert.ok(seen.threads > 0 && seen.links > 0 && seen.tombstones > 0, `and creates in the threads graph, makes links and tombstones (${note})`);
    });
  }
});
