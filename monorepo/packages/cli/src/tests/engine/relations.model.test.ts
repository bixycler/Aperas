// The model-based test of the relations (planning/core.md, Batch 5 Done when and Layer 2): the engine and the oracle
// get the same seeded random sequence of operations over the reference fields `likes`, `mate` and `pinned`, the embed
// fields `refs` and `attrs`, and the reference `to` inside an embedded node, and what they answer is compared after
// every operation. Two disciplines make "asked after writes and asked before" real: each seed draws, for each field,
// the operation at which its reverse is first asked (some at the start, some late, some never), and a field's reverse
// is read only from that point on, so that the engine builds it then and not at once; and a check independent of the
// oracle runs after every operation on the fields already asked: for every subject S, field F and object V, S is in
// the reverse of F for V exactly when V is in the values of F for S, and the count is the number of subjects.
// The writes stay inside the shape of the schema, apart from a few table cases outside it. A failing run names its
// seed and the operation, and the seed replays it.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, inspectEngine } from '@aperas/core/apeironNgn/engine';
import { ownerOfId } from '@aperas/core/apeironNgn/ids';
import type { BuildRecord, Engine, Value } from '@aperas/core/apeironNgn/interface';
import { Oracle, oracleOwnerOfId } from '../support/oracle.ts';
import { TEST_SCHEMA } from '../support/engineSchema.ts';
import { rng } from '../support/prng.ts';

const G = 'default';
const SEEDS = Array.from({ length: 20 }, (_, i) => 301 + i);
const LENGTH = 200;
/** Every tenth operation compares the whole state of both implementations; the others compare what the operation touched. */
const FULL_EVERY = 12;

/** The fields under test: those with a reverse side the engine builds. */
const FIELDS = ['likes', 'mate', 'pinned', 'refs', 'to', 'attrs'] as const;
type Field = (typeof FIELDS)[number];

type Op =
  | { op: 'createNode'; id: string; kind: string }
  | { op: 'addPair' | 'removePair'; subject: string; field: string; value: Value }
  | { op: 'clearField'; subject: string; field: string }
  | { op: 'write'; subject: string; field: string; values: Value[] } // a clear, then an add of each
  | { op: 'keepWrite'; subject: string; field: string; values: Value[] } // a removePair of each dropped value, then an addPair of each
  | { op: 'removeNode'; id: string }
  | { op: 'build'; record: BuildRecord }
  | { op: 'values' | 'first'; subject: string; field: string }
  | { op: 'subjectsOf' | 'firstSubjectOf' | 'countSubjectsOf'; field: string; value: string }
  | { op: 'idsOfKind'; kind: string }
  | { op: 'record'; subject: string };

/** What an operation gave: a value, or the class and the open point of the error it threw. */
type Outcome = { value: unknown } | { error: string; point?: string };

const canon = (v: unknown): string => JSON.stringify([typeof v, v]);
const sortedValues = (vs: readonly Value[]): string[] => vs.map(canon).sort();

function run(x: Engine, o: Op): Outcome {
  try {
    switch (o.op) {
      case 'createNode': x.createNode(G, o.id, o.kind); return { value: undefined };
      case 'addPair': x.addPair(G, o.subject, o.field, o.value); return { value: undefined };
      case 'removePair': x.removePair(G, o.subject, o.field, o.value); return { value: undefined };
      case 'clearField': x.clearField(G, o.subject, o.field); return { value: undefined };
      case 'write': x.clearField(G, o.subject, o.field); for (const v of o.values) x.addPair(G, o.subject, o.field, v); return { value: undefined };
      case 'keepWrite': {
        for (const v of x.values(G, o.subject, o.field)) if (!o.values.includes(v)) x.removePair(G, o.subject, o.field, v);
        for (const v of o.values) x.addPair(G, o.subject, o.field, v);
        return { value: undefined };
      }
      case 'removeNode': x.removeNode(G, o.id); return { value: undefined };
      case 'build': x.build(G, o.record); return { value: undefined };
      case 'values': return { value: sortedValues(x.values(G, o.subject, o.field)) };
      case 'first': { const v = x.first(G, o.subject, o.field); return { value: v === undefined ? undefined : canon(v) }; }
      case 'subjectsOf': return { value: x.subjectsOf(G, o.field, o.value).sort() };
      case 'firstSubjectOf': { const v = x.firstSubjectOf(G, o.field, o.value); return { value: v === undefined ? undefined : 'some' }; }
      case 'countSubjectsOf': return { value: x.countSubjectsOf(G, o.field, o.value) };
      case 'idsOfKind': return { value: x.idsOfKind(G, o.kind).sort() };
      case 'record': {
        const r = x.record(G, o.subject);
        return { value: r === undefined ? undefined : { id: r.id, kind: r.kind, fields: r.fields.map((f) => ({ name: f.name, values: sortedValues(f.values) })) } };
      }
    }
  } catch (e) {
    const err = e as Error & { point?: string };
    return { error: err.name, ...(err.point !== undefined ? { point: err.point } : {}) };
  }
}

/** `assert.deepEqual` for the hot loops: a cheap comparison first, the assertion (and its message) only when they differ. */
function same(a: unknown, b: unknown, message: () => string): void {
  if (JSON.stringify(a) !== JSON.stringify(b)) assert.deepEqual(a, b, message());
}

const FLAKE = [...'0123456789ABCDEFGHJKMNPQRSTVWXYZ'];
const kindOf = (id: string): string => id.split(':').slice(-2)[0]!;

interface Plan {
  readonly all: readonly string[];
  readonly ops: readonly Op[];
  /** For each field, the operation at which its reverse is first asked (`Infinity` for never). */
  readonly askAt: Readonly<Record<Field, number>>;
}

function generate(seed: number): Plan {
  const g = rng(seed);
  const closed = createEngine(TEST_SCHEMA).schema;
  const declares = (kind: string, field: string): boolean => closed.kinds.find((k) => k.name === kind)?.fields.some((f) => f.name === field && !f.derived) === true;
  const flake = (): string => Array.from({ length: 13 }, () => g.pick(FLAKE)).join('');

  // The pool of ids: top-level nodes, the Refs two of each could embed, the Attrs two of each Ref could embed.
  const tops = ['Leaf', 'Leaf', 'Leaf', 'Leaf', 'Stub', 'Stub', 'Box', 'Box', 'Box', 'Shelf', 'Node', 'Loose'].map((kind) => `${kind}:${flake()}`);
  const refsOf = new Map<string, string[]>();
  const attrsOf = new Map<string, string[]>();
  for (const t of tops) if (declares(kindOf(t), 'refs')) refsOf.set(t, [`${t}:refs:Ref:${flake()}`, `${t}:refs:Ref:${flake()}`]);
  for (const rs of refsOf.values()) for (const r of rs) attrsOf.set(r, [`${r}:attrs:Attr:${flake()}`, `${r}:attrs:Attr:${flake()}`]);
  const refIds = [...refsOf.values()].flat();
  const attrIds = [...attrsOf.values()].flat();
  const all = [...tops, ...refIds, ...attrIds];
  const withField = (field: string): string[] => all.filter((id) => declares(kindOf(id), field));

  const askAt = Object.fromEntries(FIELDS.map((f) => {
    const roll = g.int(10);
    return [f, roll < 3 ? 0 : roll < 7 ? 10 + g.int(LENGTH - 10) : Infinity];
  })) as Record<Field, number>;

  const ops: Op[] = [];
  const probe = new Oracle(closed);
  const record = (o: Op): void => { ops.push(o); run(probe, o); };
  const exists = (id: string): boolean => probe.record(G, id) !== undefined;
  const anyId = (): string => (g.chance(0.04) ? g.pick(['zzz', 'not an id', '']) : g.pick(all));
  const asked = new Set<Field>();

  /** One write of a field of a subject, inside the shape. */
  const writeOf = (field: Field, subject: string): Op => {
    const held = probe.values(G, subject, field) as string[];
    if (field === 'refs' || field === 'attrs') {
      const own = field === 'refs' ? refsOf.get(subject)! : attrsOf.get(subject)!;
      const values = own.filter(() => g.chance(0.5));
      return g.chance(0.5) ? { op: 'keepWrite', subject, field, values } : { op: 'addPair', subject, field, value: g.pick(own) };
    }
    const single = field === 'mate' || field === 'to';
    if (g.chance(0.4)) return { op: 'write', subject, field, values: Array.from({ length: single ? 1 : 1 + g.int(3) }, anyId) };
    if (single && held.length > 0) return { op: 'addPair', subject, field, value: held[0]! }; // the value it holds: nothing changes
    return { op: 'addPair', subject, field, value: anyId() };
  };

  /** A `build` of an absent node, with a few bad ones. */
  const buildOf = (id: string): Op => {
    const kind = kindOf(id);
    const fields: Record<string, Value | readonly Value[]> = {};
    const some = (xs: readonly string[], max: number): string[] => xs.filter(() => g.chance(0.4)).slice(0, max);
    const shape = (xs: string[]): Value | readonly Value[] => (xs.length === 1 && g.chance(0.5) ? xs[0]! : xs);
    if (declares(kind, 'likes')) fields.likes = shape(Array.from({ length: g.int(3) }, anyId));
    if (declares(kind, 'mate') && g.chance(0.6)) fields.mate = g.chance(0.1) ? [anyId(), anyId()] : anyId();
    if (declares(kind, 'pinned')) fields.pinned = shape(Array.from({ length: g.int(3) }, anyId));
    if (declares(kind, 'refs')) fields.refs = shape(some(refsOf.get(id)!, 2));
    if (declares(kind, 'to') && g.chance(0.8)) fields.to = g.chance(0.1) ? [anyId(), anyId()] : anyId();
    if (declares(kind, 'attrs')) fields.attrs = shape(some(attrsOf.get(id)!, 2));
    if (declares(kind, 'label') && g.chance(0.3)) fields.label = 'L';
    if (declares(kind, 'k')) { fields.k = 'key'; fields.v = g.int(5); }
    if (declares(kind, 'up') && g.chance(0.2)) fields.up = anyId(); // a derived entry the shell supplies: an assertion, never a pair
    const roll = g.int(100);
    if (roll < 3) fields.nonsense = 'x';
    else if (roll < 6 && declares(kind, 'refs')) fields.refs = [`${id}:refs:Attr:${flake()}`];
    else if (roll < 9 && declares(kind, 'refs')) fields.refs = [`${g.pick(tops)}:refs:Ref:${flake()}`];
    return { op: 'build', record: { id, kind, fields } };
  };

  while (ops.length < LENGTH) {
    const due = FIELDS.find((f) => askAt[f] <= ops.length && !asked.has(f));
    if (due !== undefined) { asked.add(due); record({ op: 'subjectsOf', field: due, value: g.pick(all) }); continue; }
    const t = g.int(100);
    if (t < 20) { // a creation, a few of them with an id that is no id or a kind that is not the id's
      const id = g.pick(all);
      const roll = g.int(100);
      record(roll < 90 ? { op: 'createNode', id, kind: kindOf(id) } : roll < 95 ? { op: 'createNode', id, kind: g.pick(['Leaf', 'Box', 'Ref']) } : { op: 'createNode', id: id.slice(0, -1), kind: kindOf(id) });
    } else if (t < 28) {
      const absent = all.filter((id) => !exists(id));
      record(buildOf(absent.length > 0 && g.chance(0.9) ? g.pick(absent) : g.pick(all)));
    } else if (t < 50) {
      const field = g.pick(FIELDS);
      const subjects = withField(field);
      record(writeOf(field, g.pick(subjects)));
    } else if (t < 60) {
      const field = g.pick(FIELDS);
      const subject = g.pick(withField(field));
      const held = probe.values(G, subject, field);
      record({ op: 'removePair', subject, field, value: held.length > 0 && g.chance(0.75) ? g.pick(held) : anyId() });
    } else if (t < 64) {
      const field = g.pick(FIELDS);
      record({ op: 'clearField', subject: g.pick(withField(field)), field });
    } else if (t < 72) {
      record({ op: 'removeNode', id: g.chance(0.7) ? g.pick(all.filter(exists).concat(all.slice(0, 1))) : g.pick(all) });
    } else if (t < 80) {
      const field = g.pick(FIELDS);
      record({ op: g.pick(['values', 'first'] as const), subject: g.pick(g.chance(0.9) ? withField(field) : all), field });
    } else if (t < 90) {
      const open = FIELDS.filter((f) => asked.has(f));
      if (open.length === 0) continue;
      const field = g.pick(open);
      // An object that something points at, when there is one: most reads of an empty bucket show little.
      let value = anyId();
      for (let tries = 0; tries < 6 && g.chance(0.8); tries++) {
        const held = probe.values(G, g.pick(withField(field)), field);
        if (held.length > 0) { value = g.pick(held) as string; break; }
      }
      record({ op: g.pick(['subjectsOf', 'firstSubjectOf', 'countSubjectsOf'] as const), field, value });
    } else if (t < 93) {
      record({ op: 'idsOfKind', kind: g.pick(['Leaf', 'Box', 'Ref', 'Attr', 'Stub']) });
    } else if (t < 97) {
      record({ op: 'record', subject: g.pick(all) });
    } else { // outside the shape: both implementations meet it with the same error
      const subject = g.pick(withField('likes'));
      const outside = g.int(6);
      if (outside === 0) record({ op: 'addPair', subject, field: 'nonsense', value: anyId() });
      else if (outside === 1) record({ op: 'removePair', subject, field: 'nonsense', value: anyId() });
      else if (outside === 2) record({ op: 'addPair', subject, field: 'likes', value: 4 as unknown as Value });
      else if (outside === 3) record({ op: 'removePair', subject, field: 'likes', value: true });
      else if (outside === 4) { record({ op: 'write', subject, field: 'mate', values: [g.pick(all)] }); record({ op: 'addPair', subject, field: 'mate', value: g.pick(all) }); }
      else record({ op: 'addPair', subject: g.pick(withField('refs')), field: 'refs', value: `${g.pick(tops)}:refs:Ref:${flake()}` }); // another owner's
    }
  }
  return { all, ops, askAt };
}

/** The ids an operation names, which the comparison after it reads in full. */
function touched(o: Op): string[] {
  switch (o.op) {
    case 'createNode': case 'removeNode': return [o.id];
    case 'addPair': case 'removePair': return [o.subject, ...(typeof o.value === 'string' ? [o.value] : [])];
    case 'write': case 'keepWrite': return [o.subject, ...o.values.filter((v): v is string => typeof v === 'string')];
    case 'clearField': case 'values': case 'first': case 'record': return [o.subject];
    case 'build': return [o.record.id, ...Object.values(o.record.fields).flat().filter((v): v is string => typeof v === 'string')];
    case 'subjectsOf': case 'firstSubjectOf': case 'countSubjectsOf': return [o.value];
    case 'idsOfKind': return [];
  }
}

describe('the engine against the oracle: the relations and their reverse side', () => {
  for (const seed of SEEDS) {
    test(`seed ${seed}: ${LENGTH} operations, compared after every one`, () => {
      const { all, ops, askAt } = generate(seed);
      const engine = createEngine(TEST_SCHEMA);
      const oracle = new Oracle(engine.schema);
      const kinds = engine.schema.kinds.map((k) => k.name);
      const asked = new Set<Field>();
      const universe = [...all, 'zzz', 'not an id', ''];
      let errors = 0;

      const sameRecord = (id: string, at: string): void => same(run(engine, { op: 'record', subject: id }), run(oracle, { op: 'record', subject: id }), () => `${at}: the record of ${id}`);
      const sameReverse = (field: Field, id: string, at: string): void => {
        for (const op of ['subjectsOf', 'countSubjectsOf', 'firstSubjectOf'] as const) same(run(engine, { op, field, value: id }), run(oracle, { op, field, value: id }), () => `${at}: ${op} ${field} of ${id}`);
      };
      const declaring = Object.fromEntries(FIELDS.map((f) => [f, all.filter((id) => engine.schema.kinds.find((k) => k.name === kindOf(id))!.fields.some((d) => d.name === f && !d.derived))])) as Record<Field, string[]>;

      ops.forEach((op, i) => {
        const at = `seed ${seed}, operation ${i}: ${JSON.stringify(op)}`;
        const a = run(engine, op);
        const b = run(oracle, op);
        assert.deepEqual(a, b, at);
        if ('error' in a) errors++;
        if ((op.op === 'subjectsOf' || op.op === 'firstSubjectOf' || op.op === 'countSubjectsOf') && !('error' in a)) asked.add(op.field as Field);

        // The reverse is built when it is first asked and not before; a removal builds the field dropped with its target.
        const builtNow = new Set(inspectEngine(engine).reversesBuilt());
        for (const f of builtNow) assert.ok(asked.has(f as Field) || f === 'pinned', `${at}: ${f} was built before it was asked`);
        for (const f of asked) assert.ok(builtNow.has(f), `${at}: ${f} was asked and is not built`);
        for (const f of FIELDS) if (i < askAt[f] && f !== 'pinned') assert.ok(!asked.has(f), `${at}: ${f} was asked before its draw`);

        // What the operation touched, and the whole state every FULL_EVERY operations, against the oracle.
        const ids = i % FULL_EVERY === 0 || i === ops.length - 1 ? all : touched(op);
        for (const id of ids) {
          sameRecord(id, at);
          for (const f of asked) sameReverse(f, id, at);
        }
        if (i % FULL_EVERY === 0 || i === ops.length - 1) for (const k of kinds) same(run(engine, { op: 'idsOfKind', kind: k }), run(oracle, { op: 'idsOfKind', kind: k }), () => `${at}: the ids of ${k}`);

        // The reverse is the inverse of the forward side, checked on the engine alone.
        for (const f of asked) {
          const expected = new Map<string, Set<string>>();
          let pairs = 0;
          for (const s of declaring[f]) for (const v of engine.values(G, s, f)) { pairs++; (expected.get(v as string) ?? expected.set(v as string, new Set()).get(v as string)!).add(s); }
          let counted = 0;
          for (const v of universe) {
            const want = expected.get(v) ?? new Set<string>();
            const got = engine.subjectsOf(G, f, v);
            if (got.length !== want.size || !got.every((s) => want.has(s))) assert.deepEqual([...got].sort(), [...want].sort(), `${at}: the reverse of ${f} for ${v} is the inverse of the forward side`);
            if (engine.countSubjectsOf(G, f, v) !== want.size) assert.equal(engine.countSubjectsOf(G, f, v), want.size, `${at}: the count of ${f} for ${v}`);
            const first = engine.firstSubjectOf(G, f, v);
            if (want.size === 0 ? first !== undefined : !want.has(first!)) assert.fail(`${at}: first of ${f} for ${v} is ${first}`);
            counted += got.length;
          }
          assert.equal(counted, pairs, `${at}: every pair of ${f} is in the reverse of its object`);
        }

        // Backlinks: the links that point at X, each with the owner read from its id, are what a scan of the forward side gives.
        if (asked.has('to')) {
          for (const x of universe) {
            const scanned = new Set<string>();
            for (const owner of declaring.refs) for (const link of engine.values(G, owner, 'refs')) if (engine.values(G, link as string, 'to').includes(x)) scanned.add(JSON.stringify([link, owner]));
            const held = (link: string): boolean => declaring.refs.some((owner) => engine.values(G, owner, 'refs').includes(link));
            const read = new Set(engine.subjectsOf(G, 'to', x).filter(held).map((link) => JSON.stringify([link, ownerOfId(link)])));
            assert.deepEqual([...read].sort(), [...scanned].sort(), `${at}: the backlinks of ${x} with the owner read from the id`);
            for (const link of engine.subjectsOf(G, 'to', x)) assert.equal(ownerOfId(link), oracleOwnerOfId(link), `${at}: the owner of ${link} is read one way by both`);
          }
        }
      });
      assert.ok(errors < ops.length, 'a sequence that only fails shows nothing');
    });
  }

  test('the sequences reach what they are for', () => {
    const seen = { created: 0, built: 0, removed: 0, cascades: 0, reverseNonEmpty: 0, errors: new Set<string>(), earliest: new Set<string>(), never: new Set<string>(), late: new Set<string>() };
    for (const seed of SEEDS) {
      const { all, ops, askAt } = generate(seed);
      for (const f of FIELDS) (askAt[f] === 0 ? seen.earliest : askAt[f] === Infinity ? seen.never : seen.late).add(f);
      const engine = createEngine(TEST_SCHEMA);
      for (const op of ops) {
        const before = op.op === 'removeNode' || op.op === 'removePair' || op.op === 'clearField' ? all.filter((id) => engine.record(G, id) !== undefined).length : 0;
        const r = run(engine, op);
        if ('error' in r) { seen.errors.add(`${r.error}:${r.point ?? ''}`); continue; }
        if (op.op === 'createNode') seen.created++;
        else if (op.op === 'build') seen.built++;
        else if (op.op === 'removeNode') seen.removed++;
        const lost = before - (before > 0 ? all.filter((id) => engine.record(G, id) !== undefined).length : 0);
        if (before > 0 && (op.op === 'removeNode' ? lost >= 2 : lost >= 1)) seen.cascades++;
        if ((op.op === 'subjectsOf' && (r.value as string[]).length > 0) || (op.op === 'countSubjectsOf' && (r.value as number) > 0)) seen.reverseNonEmpty++;
      }
    }
    assert.ok(seen.created > 100, `creations: ${seen.created}`);
    assert.ok(seen.built > 30, `builds: ${seen.built}`);
    assert.ok(seen.removed > 20, `node removals: ${seen.removed}`);
    assert.ok(seen.cascades > 5, `removals that took an embedded node with them: ${seen.cascades}`);
    assert.ok(seen.reverseNonEmpty > 25, `reverse reads that found a subject: ${seen.reverseNonEmpty}`);
    for (const set of [seen.earliest, seen.late, seen.never]) assert.ok(set.size > 0, 'a reverse asked at the start, late and never are all drawn');
    for (const e of ['Refused:', 'Undecided:Enforcement', 'Undecided:Existence']) assert.ok(seen.errors.has(e), `${e} was never thrown (${[...seen.errors].join(', ')})`);
  });
});
