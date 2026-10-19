// The schema that the engine's tests use. Its names are not the Aperas ones, so that a test cannot pass by an engine
// that knows `children` or `tombstonedAt`. It holds: three levels of inheritance (`Leaf` extends `Node` extends
// `Entity`, an inherited field read on the grandchild) and a kind with no parent (`Loose`); all three storage kinds;
// all four cardinalities; an embed that holds an embed (`Ref.attrs`) and one that holds a reference (`Ref.to`, the
// shape of a `Link`); a reference field with a reverse name (`mate`/`matedBy`, `items`/`up`) and one without
// (`likes`); an ordered, partitioning containment field (`items`) whose reverse `up` is a derived entry; a tombstone
// marker (`retiredAt`); a field dropped with its target (`pinned`); a sweep root kind and followed fields, one of
// them the reference inside an embed (`to`); a kind with no field of its own (`Stub`);
// a kind that declares the explicit order of all its fields, own and inherited (`Shelf`); and optional literal fields for a string (`note`), a number (`rank`) and a boolean (`flag`).
import type { SchemaSpec } from '@aperas/core/apeironNgn/schema';

export const TEST_SCHEMA: SchemaSpec = {
  kinds: [
    {
      name: 'Entity',
      fields: [
        { name: 'label', storage: 'literal', cardinality: 'one' },
        { name: 'retiredAt', storage: 'literal', cardinality: 'optional' },
        { name: 'refs', storage: 'embed', cardinality: 'set', embeds: 'Ref' },
      ],
    },
    {
      name: 'Node',
      extends: 'Entity',
      fields: [
        { name: 'note', storage: 'literal', cardinality: 'optional' },
        { name: 'up', storage: 'derived' },
      ],
    },
    {
      name: 'Leaf',
      extends: 'Node',
      fields: [
        { name: 'rank', storage: 'literal', cardinality: 'optional' },
        { name: 'flag', storage: 'literal', cardinality: 'optional' },
        { name: 'likes', storage: 'reference', cardinality: 'set' },
        { name: 'mate', storage: 'reference', cardinality: 'optional', reverse: 'matedBy' },
      ],
    },
    {
      name: 'Stub',
      extends: 'Leaf',
      fields: [],
    },
    {
      name: 'Box',
      extends: 'Node',
      fields: [
        { name: 'items', storage: 'reference', cardinality: 'ordered', partitioning: true, reverse: 'up' },
        { name: 'pinned', storage: 'reference', cardinality: 'set' },
      ],
    },
    {
      // Declares the order of all its fields, own and inherited: not the inherited first.
      name: 'Shelf',
      extends: 'Node',
      fields: [
        { name: 'slot', storage: 'literal', cardinality: 'optional' },
        { name: 'kept', storage: 'reference', cardinality: 'set' },
      ],
      order: ['note', 'slot', 'up', 'label', 'kept', 'retiredAt', 'refs'],
    },
    { name: 'Loose', fields: [{ name: 'name', storage: 'literal', cardinality: 'one' }] },
    {
      name: 'Ref',
      fields: [
        { name: 'to', storage: 'reference', cardinality: 'one' },
        { name: 'attrs', storage: 'embed', cardinality: 'set', embeds: 'Attr' },
      ],
    },
    {
      name: 'Attr',
      fields: [
        { name: 'k', storage: 'literal', cardinality: 'one' },
        { name: 'v', storage: 'literal', cardinality: 'one' },
      ],
    },
  ],
  roles: {
    containment: 'items',
    tombstone: 'retiredAt',
    dropWithTarget: ['pinned'],
    sweep: { roots: ['Box'], follow: ['items', 'refs', 'to'] },
  },
};
