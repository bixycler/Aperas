// The model-based test of literal fields (planning/core.md, Batch 4 Done when and Layer 2): the engine and the
// oracle get the same seeded random sequence of operations, `createNode`, `addPair`, `clearField`, `values`,
// `first`, `idsOfKind` and `record`, and what they answer is compared after every operation. A set's values and
// the ids of a kind are sorted before the comparison, since their order is promised to no reader, and a thrown
// error is compared by its class and its open point, not by its message. The writes stay inside the shape of the
// schema, apart from a few cases outside it, which both implementations must meet with the same error. A failing
// run names its seed and the operation, and the seed replays it.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '@aperas/core/apeironNgn/engine';
import type { Engine, Value } from '@aperas/core/apeironNgn/interface';
import type { FieldDef, SchemaSpec } from '@aperas/core/apeironNgn/schema';
import { Oracle } from '../support/oracle.ts';
import { TEST_SCHEMA } from '../support/engineSchema.ts';
import { rng } from '../support/prng.ts';

const G = 'default';
const SEEDS = Array.from({ length: 20 }, (_, i) => 101 + i);
const LENGTH = 200;

/** The test schema with a kind that holds literal sets. */
const MODEL_SCHEMA: SchemaSpec = {
  ...TEST_SCHEMA,
  kinds: [
    ...TEST_SCHEMA.kinds,
    { name: 'Bag', extends: 'Entity', fields: [{ name: 'tags', storage: 'literal', cardinality: 'set' }, { name: 'sizes', storage: 'literal', cardinality: 'set' }] },
  ],
};

type Op =
  | { op: 'createNode'; id: string; kind: string }
  | { op: 'addPair'; subject: string; field: string; value: Value }
  | { op: 'clearField'; subject: string; field: string }
  | { op: 'write'; subject: string; field: string; values: Value[] }
  | { op: 'values' | 'first'; subject: string; field: string }
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
      case 'clearField': x.clearField(G, o.subject, o.field); return { value: undefined };
      case 'write': x.clearField(G, o.subject, o.field); for (const v of o.values) x.addPair(G, o.subject, o.field, v); return { value: undefined };
      case 'values': return { value: sortedValues(x.values(G, o.subject, o.field)) };
      case 'first': { const v = x.first(G, o.subject, o.field); return { value: v === undefined ? undefined : canon(v) }; }
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

const FLAKE = [...'0123456789ABCDEFGHJKMNPQRSTVWXYZ'];

function generate(seed: number): { pool: { id: string; kind: string }[]; ops: Op[] } {
  const g = rng(seed);
  const kinds = MODEL_SCHEMA.kinds.map((k) => k.name);
  const closed = createEngine(MODEL_SCHEMA).schema;
  const literals = (kind: string): FieldDef[] => closed.kinds.find((k) => k.name === kind)!.fields.filter((f) => f.storage === 'literal' && !f.derived && f.cardinality !== 'ordered');
  const pool: { id: string; kind: string }[] = [];
  while (pool.length < 14) {
    const kind = g.pick([...kinds, 'Bag', 'Bag', 'Leaf', 'Stub']);
    const id = `${kind}:${Array.from({ length: 13 }, () => g.pick(FLAKE)).join('')}`;
    if (!pool.some((p) => p.id === id)) pool.push({ id, kind });
  }
  const value = (): Value => {
    const t = g.int(3);
    if (t === 0) return g.pick([0, 1, -1, 2, 7, 1000, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, g.int(50)]);
    if (t === 1) return g.pick(['', '1', 'true', 'a', 'B', 'x y', '2024-01-01', `s${g.int(20)}`]);
    return g.chance(0.5);
  };
  for (const p of [0, 1, -1, 7, 1000]) assert.ok(Number.isSafeInteger(p));

  // The oracle is read to keep the writes inside the shape: a second, different value for a single-valued field is outside it.
  const ops: Op[] = [];
  const probe = new Oracle(closed);
  const record = (o: Op): void => { ops.push(o); run(probe, o); };
  for (let i = 0; i < LENGTH; i++) {
    const p = g.pick(pool);
    const t = g.int(100);
    if (t < 22) {
      const roll = g.int(100);
      if (roll < 80) record({ op: 'createNode', id: p.id, kind: p.kind });
      else if (roll < 88) record({ op: 'createNode', id: p.id, kind: g.pick(kinds) }); // a kind that may differ from the id's
      else if (roll < 94) record({ op: 'createNode', id: `${p.kind}:${p.id.slice(-12)}`, kind: p.kind }); // 12 characters: no id
      else record({ op: 'createNode', id: `${p.kind}:${p.id.slice(-13).toLowerCase()}`, kind: p.kind }); // lower case: no id
      continue;
    }
    const fields = literals(p.kind);
    const f = fields.length > 0 ? g.pick(fields) : undefined;
    if (t < 50 && f !== undefined) record({ op: 'write', subject: p.id, field: f.name, values: Array.from({ length: f.cardinality === 'set' ? 1 + g.int(3) : 1 }, value) });
    else if (t < 62 && f !== undefined) {
      const held = probe.values(G, p.id, f.name);
      const single = f.cardinality === 'one' || f.cardinality === 'optional';
      record({ op: 'addPair', subject: p.id, field: f.name, value: single && held.length > 0 ? held[0]! : value() });
    } else if (t < 68 && f !== undefined) record({ op: 'clearField', subject: p.id, field: f.name });
    else if (t < 78 && f !== undefined) record({ op: 'values', subject: p.id, field: f.name });
    else if (t < 86 && f !== undefined) record({ op: 'first', subject: p.id, field: f.name });
    else if (t < 92) record({ op: 'idsOfKind', kind: g.pick(kinds) });
    else if (t < 97) record({ op: 'record', subject: p.id });
    else { // outside the shape: both implementations meet it with the same error
      const outside = g.int(4);
      if (outside === 0) record({ op: 'addPair', subject: p.id, field: 'nonsense', value: value() });
      else if (outside === 1) record({ op: 'addPair', subject: p.id, field: 'up', value: 'Box:0000000000001' });
      else if (outside === 2 && f !== undefined) record({ op: 'addPair', subject: p.id, field: f.name, value: {} as unknown as Value });
      else if (f !== undefined && (f.cardinality === 'one' || f.cardinality === 'optional')) { record({ op: 'write', subject: p.id, field: f.name, values: [1] }); record({ op: 'addPair', subject: p.id, field: f.name, value: 2 }); }
    }
  }
  return { pool, ops };
}

describe('the engine against the oracle: literal fields', () => {
  for (const seed of SEEDS) {
    test(`seed ${seed}: ${LENGTH} operations, compared after every one`, () => {
      const { pool, ops } = generate(seed);
      const engine = createEngine(MODEL_SCHEMA);
      const oracle = new Oracle(engine.schema);
      const kinds = engine.schema.kinds.map((k) => k.name);
      let errors = 0;
      ops.forEach((op, i) => {
        const at = `seed ${seed}, operation ${i}: ${JSON.stringify(op)}`;
        const a = run(engine, op);
        const b = run(oracle, op);
        assert.deepEqual(a, b, at);
        if ('error' in a) errors++;
        for (const p of pool) assert.deepEqual(run(engine, { op: 'record', subject: p.id }), run(oracle, { op: 'record', subject: p.id }), `${at}: the record of ${p.id}`);
        for (const k of kinds) assert.deepEqual(run(engine, { op: 'idsOfKind', kind: k }), run(oracle, { op: 'idsOfKind', kind: k }), `${at}: the ids of ${k}`);
      });
      assert.ok(errors < ops.length, 'a sequence that only fails shows nothing');
    });
  }

  test('the sequences reach what they are for: creations, sets with several values, and errors of each class', () => {
    const seen = { created: 0, multi: 0, errors: new Set<string>(), tested: 0 };
    for (const seed of SEEDS) {
      const { ops } = generate(seed);
      const engine = createEngine(MODEL_SCHEMA);
      for (const op of ops) {
        const r = run(engine, op);
        if ('error' in r) seen.errors.add(`${r.error}:${r.point ?? ''}`);
        else if (op.op === 'createNode') seen.created++;
        const recs = engine.idsOfKind(G, 'Bag').map((id) => engine.record(G, id)!);
        if (op.op !== 'idsOfKind' && recs.some((rec) => rec.fields.some((f) => f.values.length > 1))) seen.multi++;
        seen.tested++;
      }
    }
    assert.ok(seen.created > 100, `creations: ${seen.created}`);
    assert.ok(seen.multi > 100, `states, after an operation, in which a set holds several values: ${seen.multi}`);
    for (const e of ['Refused:', 'Undecided:Enforcement', 'Undecided:Existence']) assert.ok(seen.errors.has(e), `${e} was never thrown (${[...seen.errors].join(', ')})`);
  });
});
