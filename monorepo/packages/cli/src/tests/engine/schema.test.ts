// The meta-model and the construction that closes a schema (planning/core.md, Batch 3 step 2): the test schema is
// accepted and read back, the closed schema is a frozen copy, each inconsistent variant is refused, and an
// operation that no batch has built yet throws an error that names its batch.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, NotBuiltError, Undecided, BUILT_BY, BUILT, WAITING_ON } from '@aperas/core/apeironNgn/engine';
import { closeSchema, SchemaError, type Schema, type SchemaSpec } from '@aperas/core/apeironNgn/schema';
import { TEST_SCHEMA } from '../support/engineSchema.ts';

const kindOf = (schema: Schema, name: string) => schema.kinds.find((k) => k.name === name)!;
const orderOf = (schema: Schema, name: string): string[] => kindOf(schema, name).fields.map((f) => f.name);

type MutKind = { name: string; extends?: string; fields: Record<string, unknown>[]; order?: string[] };
type MutSpec = { kinds: MutKind[]; roles: { containment?: string; tombstone?: string; dropWithTarget?: string[]; sweep?: { roots: string[]; follow: string[] } } };

/** The test schema, cloned, then changed by `change`, which gets the kinds by name and the whole spec. */
function variant(change: (kinds: Record<string, MutKind>, spec: MutSpec) => void): SchemaSpec {
  const spec = structuredClone(TEST_SCHEMA) as unknown as MutSpec;
  change(Object.fromEntries(spec.kinds.map((k) => [k.name, k])), spec);
  return spec as unknown as SchemaSpec;
}

describe('the test schema', () => {
  const engine = createEngine(TEST_SCHEMA);
  const schema = engine.schema;

  test('is accepted by an engine and read back with the inherited fields first', () => {
    assert.deepEqual(schema.kinds.map((k) => k.name), ['Entity', 'Node', 'Leaf', 'Stub', 'Box', 'Shelf', 'Loose', 'Ref', 'Attr']);
    assert.deepEqual(orderOf(schema, 'Entity'), ['label', 'retiredAt', 'refs']);
    assert.deepEqual(orderOf(schema, 'Node'), ['label', 'retiredAt', 'refs', 'note', 'up']);
    assert.deepEqual(orderOf(schema, 'Leaf'), ['label', 'retiredAt', 'refs', 'note', 'up', 'rank', 'flag', 'likes', 'mate']);
    assert.deepEqual(orderOf(schema, 'Stub'), orderOf(schema, 'Leaf'), 'a kind with no field of its own reads out as its parent');
    assert.deepEqual(orderOf(schema, 'Box'), ['label', 'retiredAt', 'refs', 'note', 'up', 'items', 'pinned']);
    assert.deepEqual(orderOf(schema, 'Shelf'), ['note', 'slot', 'up', 'label', 'kept', 'retiredAt', 'refs'], 'an explicit order covers own and inherited fields, in any interleaving');
    assert.deepEqual(orderOf(schema, 'Loose'), ['name']);
    assert.equal(kindOf(schema, 'Leaf').parent, 'Node');
    assert.equal(kindOf(schema, 'Node').parent, 'Entity');
    assert.equal(kindOf(schema, 'Entity').parent, undefined);
  });

  test('a descendant of a kind with an explicit order has that order first, then its own fields', () => {
    const spec = structuredClone(TEST_SCHEMA) as unknown as MutSpec;
    spec.kinds.push({ name: 'Deep', extends: 'Shelf', fields: [{ name: 'depth', storage: 'literal', cardinality: 'optional' }] });
    assert.deepEqual(orderOf(closeSchema(spec as unknown as SchemaSpec), 'Deep'), [...orderOf(schema, 'Shelf'), 'depth']);
  });

  test('holds all three storage kinds and all four cardinalities', () => {
    const all = schema.kinds.flatMap((k) => k.fields);
    assert.deepEqual([...new Set(all.map((f) => f.storage))].sort(), ['embed', 'literal', 'reference']);
    assert.deepEqual([...new Set(all.filter((f) => !f.derived).map((f) => f.cardinality))].sort(), ['one', 'optional', 'ordered', 'set']);
  });

  test('keeps the embedded kinds, the reverse names, the partitioning mark and the derived entry', () => {
    const field = (kind: string, name: string) => kindOf(schema, kind).fields.find((f) => f.name === name)!;
    assert.equal(field('Leaf', 'refs').embeds, 'Ref', 'an embed of an inherited field');
    assert.equal(field('Ref', 'attrs').embeds, 'Attr', 'an embed that holds an embed');
    assert.equal(field('Ref', 'to').storage, 'reference', 'an embedded kind that holds a reference');
    assert.equal(field('Leaf', 'mate').reverse, 'matedBy');
    assert.equal(field('Leaf', 'likes').reverse, undefined, 'a reverse side with no name');
    assert.deepEqual([field('Box', 'items').storage, field('Box', 'items').cardinality, field('Box', 'items').partitioning, field('Box', 'items').reverse], ['reference', 'ordered', true, 'up']);
    assert.deepEqual([field('Leaf', 'up').derived, field('Leaf', 'up').cardinality, field('Leaf', 'up').storage], [true, 'optional', 'reference']);
    assert.equal(field('Leaf', 'label').cardinality, 'one');
    assert.equal(field('Stub', 'label').cardinality, 'one');
    assert.equal(field('Stub', 'label').origin, 'Entity');
    assert.equal(field('Stub', 'rank').origin, 'Leaf');
    assert.equal(field('Shelf', 'label').origin, 'Entity', 'an explicit order moves a field and keeps the kind that declared it');
    assert.equal(field('Shelf', 'slot').origin, 'Shelf');
  });

  test('holds the roles', () => {
    assert.deepEqual(schema.roles, { containment: 'items', tombstone: 'retiredAt', dropWithTarget: ['pinned'], sweep: { roots: ['Box'], follow: ['items', 'refs', 'to'] } });
  });

  test('is a frozen copy: neither the spec nor the schema can change it', () => {
    const spec = structuredClone(TEST_SCHEMA) as { kinds: { name: string; fields: unknown[] }[]; roles?: { dropWithTarget?: string[] } };
    const closed = closeSchema(spec as unknown as SchemaSpec);
    spec.kinds[0]!.name = 'Changed';
    spec.kinds[0]!.fields.length = 0;
    spec.roles!.dropWithTarget!.push('likes');
    assert.equal(closed.kinds[0]!.name, 'Entity');
    assert.equal(closed.kinds[0]!.fields.length, 3);
    assert.deepEqual(closed.roles.dropWithTarget, ['pinned']);
    assert.ok(Object.isFrozen(closed) && Object.isFrozen(closed.kinds) && Object.isFrozen(closed.kinds[0]) && Object.isFrozen(closed.kinds[0]!.fields) && Object.isFrozen(closed.kinds[0]!.fields[0]) && Object.isFrozen(closed.roles.dropWithTarget) && Object.isFrozen(closed.roles.sweep!.follow));
    assert.throws(() => { (closed.kinds[0] as { name: string }).name = 'Again'; }, TypeError);
    assert.throws(() => { (closed.roles.dropWithTarget as string[]).push('x'); }, TypeError);
  });

  test('the same spec closes to equal schemas', () => {
    assert.deepEqual(closeSchema(TEST_SCHEMA), closeSchema(structuredClone(TEST_SCHEMA) as SchemaSpec));
  });

  test('a schema with no roles, and a schema with a kind and no field, are valid', () => {
    const bare = closeSchema({ kinds: [{ name: 'Only', fields: [] }] });
    assert.deepEqual(bare.roles, { dropWithTarget: [] });
    assert.deepEqual(bare.kinds[0]!.fields, []);
    assert.deepEqual(closeSchema({ kinds: [] }).kinds, []);
  });
});

describe('a schema that is inconsistent is refused', () => {
  const refused: [string, SchemaSpec, RegExp][] = [
    ['a kind declared twice', variant((_k, s) => { s.kinds.push({ name: 'Leaf', fields: [] }); }), /declared twice/],
    ['a kind whose name is not a name', variant((_k, s) => { s.kinds.push({ name: 'a:b', fields: [] }); }), /not a name/],
    ['a field whose name is not a name', variant((k) => { k.Loose!.fields.push({ name: 'x y', storage: 'literal', cardinality: 'one' }); }), /not a name/],
    ['a parent kind that is unknown', variant((k) => { k.Leaf!.extends = 'Nowhere'; }), /not a kind/],
    ['a kind that extends itself', variant((k) => { k.Loose!.extends = 'Loose'; }), /inheritance cycle/],
    ['an inheritance cycle', variant((k) => { k.Entity!.extends = 'Leaf'; }), /inheritance cycle/],
    ['a field declared twice in a kind', variant((k) => { k.Loose!.fields.push({ name: 'name', storage: 'literal', cardinality: 'optional' }); }), /declares name twice/],
    ['a field redeclared in a descendant', variant((k) => { k.Leaf!.fields.push({ name: 'label', storage: 'literal', cardinality: 'one' }); }), /redeclared from Entity/],
    ['a field redeclared in a descendant, loosened to optional', variant((k) => { k.Stub!.fields.push({ name: 'label', storage: 'literal', cardinality: 'optional' }); }), /redeclared from Entity/],
    ['an order that names a field twice', variant((k) => { k.Shelf!.order = ['note', 'slot', 'up', 'label', 'kept', 'retiredAt', 'refs', 'note']; }), /orders note twice/],
    ['an order that names a field the kind does not have', variant((k) => { k.Shelf!.order = ['note', 'slot', 'up', 'label', 'kept', 'retiredAt', 'refs', 'rank']; }), /orders rank, which is not one of its fields/],
    ['an order that leaves an inherited field out', variant((k) => { k.Shelf!.order = ['note', 'slot', 'up', 'label', 'kept', 'retiredAt']; }), /leaves refs out of its order/],
    ['an order that leaves an own field out', variant((k) => { k.Shelf!.order = ['note', 'up', 'label', 'kept', 'retiredAt', 'refs']; }), /leaves slot out of its order/],
    ['an embed field with no embedded kind', variant((k) => { k.Entity!.fields[2] = { name: 'refs', storage: 'embed', cardinality: 'set' }; }), /names no known embedded kind/],
    ['an embed field with an unknown embedded kind', variant((k) => { k.Entity!.fields[2] = { name: 'refs', storage: 'embed', cardinality: 'set', embeds: 'Nowhere' }; }), /names no known embedded kind/],
    ['an embedded kind on a field that is not an embed field', variant((k) => { k.Loose!.fields.push({ name: 'x', storage: 'reference', cardinality: 'set', embeds: 'Ref' }); }), /not an embed field/],
    ['a storage kind that is unknown', variant((k) => { k.Loose!.fields.push({ name: 'x', storage: 'blob' as never, cardinality: 'one' }); }), /storage kind/],
    ['a cardinality that is unknown', variant((k) => { k.Loose!.fields.push({ name: 'x', storage: 'literal', cardinality: 'orderedContainment' as never }); }), /cardinality/],
    ['a reverse name that is also a field', variant((k) => { k.Leaf!.fields[3] = { name: 'mate', storage: 'reference', cardinality: 'optional', reverse: 'note' }; }), /also the name of a field/],
    ['two fields with the same reverse name', variant((k) => { k.Leaf!.fields[2] = { name: 'likes', storage: 'reference', cardinality: 'set', reverse: 'matedBy' }; }), /same reverse name/],
    ['a reverse name on a literal field', variant((k) => { k.Loose!.fields.push({ name: 'x', storage: 'literal', cardinality: 'one', reverse: 'xs' }); }), /literal field and has no reverse side/],
    ['a reverse name that is not a name', variant((k) => { k.Leaf!.fields[3] = { name: 'mate', storage: 'reference', cardinality: 'optional', reverse: 'a b' }; }), /not a name/],
    ['a derived entry that is the reverse name of no field', variant((k) => { k.Loose!.fields.push({ name: 'nobody', storage: 'derived' }); }), /reverse name of no field/],
    ['a derived entry that restates an inherited field', variant((k) => { k.Leaf!.fields.push({ name: 'label', storage: 'derived' }); k.Leaf!.fields.push({ name: 'up', storage: 'derived' }); }), /redeclares|reverse name of no field/],
    ['a partitioning mark on a literal field', variant((k) => { k.Loose!.fields.push({ name: 'x', storage: 'literal', cardinality: 'one', partitioning: true }); }), /cannot be partitioning/],
    ['a containment field that no kind declares', variant((_k, s) => { s.roles.containment = 'nowhere'; }), /no kind declares/],
    ['a containment field that is a literal', variant((_k, s) => { s.roles.containment = 'note'; }), /ordered, partitioning reference/],
    ['a containment field that is not ordered', variant((k) => { k.Box!.fields[0] = { name: 'items', storage: 'reference', cardinality: 'set', partitioning: true, reverse: 'up' }; }), /ordered, partitioning reference/],
    ['a containment field that is not partitioning', variant((k) => { k.Box!.fields[0] = { name: 'items', storage: 'reference', cardinality: 'ordered', reverse: 'up' }; }), /ordered, partitioning reference/],
    ['a containment field that is an embed field', variant((_k, s) => { s.roles.containment = 'refs'; }), /ordered, partitioning reference/],
    ['a tombstone marker that is not optional', variant((_k, s) => { s.roles.tombstone = 'label'; }), /optional literal/],
    ['a tombstone marker that is not a literal', variant((_k, s) => { s.roles.tombstone = 'likes'; }), /optional literal/],
    ['a tombstone marker that no kind declares', variant((_k, s) => { s.roles.tombstone = 'nowhere'; }), /no kind declares/],
    ['a field dropped with its target that is not a reference', variant((_k, s) => { s.roles.dropWithTarget = ['note']; }), /must be a reference field/],
    ['a field dropped with its target that no kind declares', variant((_k, s) => { s.roles.dropWithTarget = ['nowhere']; }), /no kind declares/],
    ['a field dropped with its target named twice', variant((_k, s) => { s.roles.dropWithTarget = ['pinned', 'pinned']; }), /twice/],
    ['a sweep root that is not a kind', variant((_k, s) => { s.roles.sweep = { roots: ['Nowhere'], follow: ['items'] }; }), /not a kind/],
    ['a sweep root named twice', variant((_k, s) => { s.roles.sweep = { roots: ['Box', 'Box'], follow: ['items'] }; }), /twice/],
    ['a sweep field that no kind declares', variant((_k, s) => { s.roles.sweep = { roots: ['Box'], follow: ['nowhere'] }; }), /no kind declares/],
    ['a sweep field that is a literal', variant((_k, s) => { s.roles.sweep = { roots: ['Box'], follow: ['note'] }; }), /literal field/],
    ['a sweep field named twice', variant((_k, s) => { s.roles.sweep = { roots: ['Box'], follow: ['items', 'items'] }; }), /twice/],
  ];
  for (const [name, spec, message] of refused) {
    test(`refuses ${name}`, () => {
      assert.throws(() => closeSchema(spec), (e: unknown) => e instanceof SchemaError && message.test(e.message), name);
      assert.throws(() => createEngine(spec), SchemaError);
    });
  }
});

describe('an operation that no batch has built', () => {
  const engine = createEngine(TEST_SCHEMA);

  test('throws an error that names its batch', () => {
    assert.throws(() => engine.portTree('default', { field: 'items', value: 'Leaf:0' }), (e: unknown) => e instanceof NotBuiltError && e.batch === 'Batch 14');
  });

  test('every operation of the interface has its batch, and every batch names an operation', () => {
    assert.deepEqual(Object.keys(engine).filter((k) => k !== 'schema').sort(), Object.keys(BUILT_BY).sort());
    for (const name of Object.keys(BUILT_BY) as (keyof typeof BUILT_BY)[]) {
      if (BUILT.has(name)) continue; // built: the engine tests hold it
      if (WAITING_ON[name] !== undefined) {
        assert.throws(() => (engine[name] as (...a: unknown[]) => unknown)(), (e: unknown) => e instanceof Undecided && e.point === WAITING_ON[name], name);
        continue;
      }
      assert.throws(() => (engine[name] as (...a: unknown[]) => unknown)(), (e: unknown) => e instanceof NotBuiltError && e.batch === BUILT_BY[name], name);
    }
  });
});
