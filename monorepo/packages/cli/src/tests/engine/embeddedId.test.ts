// An embedded id in a containment field (planning/core.md, Batch 8 step 5; design/core.md, "Containment"): a node is owned or contained,
// never both, so an id of the embedded shape (`owner:field:Kind:snowflake`) cannot be listed in the containment field, in `addPair`,
// `insertItem`, `moveItem` and `build` alike. The refusal is read from the id alone, so it holds for an embedded node whose record is
// not there and for a graph other than the owner's. A reference field that is not the containment field takes the id as before. Each
// case runs on the engine and on the oracle, in the test schema (`items`) and in the Aperas schema (`children`).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, inspectEngine, Refused } from '@aperas/core/apeironNgn/engine';
import type { Engine } from '@aperas/core/apeironNgn/interface';
import type { SchemaSpec } from '@aperas/core/apeironNgn/schema';
import { APERAS_SCHEMA } from '@aperas/core/shell/aperasSchema';
import { Oracle, Refused as OracleRefused } from '../support/oracle.ts';
import { TEST_SCHEMA } from '../support/engineSchema.ts';
import { checkTree } from '../support/engineTree.ts';

const G = 'default';
let n = 0;
const flake = (): string => (++n).toString().padStart(13, '0');
const refused = (err: unknown): boolean => err instanceof Refused || err instanceof OracleRefused;

interface Shape { name: string; spec: SchemaSpec; container: string; field: string; item: string; owner: string; embedField: string; embedKind: string }
const SHAPES: Shape[] = [
  { name: 'the test schema', spec: TEST_SCHEMA, container: 'Box', field: 'items', item: 'Leaf', owner: 'Leaf', embedField: 'refs', embedKind: 'Ref' },
  { name: 'the Aperas schema', spec: APERAS_SCHEMA, container: 'BlockNode', field: 'children', item: 'BlockNode', owner: 'BlockNode', embedField: 'links', embedKind: 'Link' },
];

for (const shape of SHAPES) {
  describe(`an embedded id in ${shape.field}, with ${shape.name}`, () => {
    const make = (): { engines: Engine[]; box: string; leaf: string; owner: string; embedded: string } => {
      const e = createEngine(shape.spec); const o = new Oracle(e.schema);
      const box = `${shape.container}:${flake()}`; const leaf = `${shape.item}:${flake()}`; const owner = `${shape.owner}:${flake()}`;
      const embedded = `${owner}:${shape.embedField}:${shape.embedKind}:${flake()}`;
      for (const x of [e, o]) {
        x.createNode(G, box, shape.container); x.createNode(G, leaf, shape.item); x.createNode(G, owner, shape.owner);
        x.createNode(G, embedded, shape.embedKind);
      }
      return { engines: [e, o], box, leaf, owner, embedded };
    };

    test('addPair, insertItem and moveItem refuse it, with or without a record, and change nothing', () => {
      const { engines, box, leaf, owner, embedded } = make();
      const norecord = `${owner}:${shape.embedField}:${shape.embedKind}:${flake()}`;
      for (const x of engines) {
        x.insertItem(G, box, shape.field, leaf);
        for (const id of [embedded, norecord]) {
          assert.throws(() => x.addPair(G, box, shape.field, id), refused, 'addPair');
          assert.throws(() => x.insertItem(G, box, shape.field, id), refused, 'insertItem');
          assert.throws(() => x.insertItem(G, box, shape.field, id, 0), refused, 'insertItem at a place');
          assert.throws(() => x.moveItem(G, box, shape.field, id, 0), refused, 'moveItem');
        }
        assert.deepEqual(x.items(G, box, shape.field), [leaf]);
        assert.deepEqual(x.subjectsOf(G, shape.field, embedded), []);
        assert.deepEqual(x.record(G, embedded)?.fields, []);
      }
    });

    test('a build refuses it and creates nothing', () => {
      const { engines, owner, embedded } = make();
      const id = `${shape.container}:${flake()}`;
      for (const x of engines) {
        assert.throws(() => x.build(G, { id, kind: shape.container, fields: { [shape.field]: [embedded] } }), refused);
        assert.equal(x.record(G, id), undefined, 'the node of a refused build is not there');
        x.build(G, { id, kind: shape.container, fields: { [shape.field]: [owner] } }); // a top-level id is as before
        assert.deepEqual(x.items(G, id, shape.field), [owner]);
      }
    });

    test('it is refused in another graph, and an id of a top-level shape or no id is as before', () => {
      const { engines, box, leaf } = make();
      for (const x of engines) {
        x.createGraph('other');
        const inOther = `${shape.container}:${flake()}`;
        x.createNode('other', inOther, shape.container);
        const foreign = `${leaf}:${shape.embedField}:${shape.embedKind}:${flake()}`;
        assert.throws(() => x.insertItem('other', inOther, shape.field, foreign), refused);
        x.insertItem(G, box, shape.field, leaf);
        x.insertItem(G, box, shape.field, 'not an id at all'); // the containment field takes any string that is not an embedded id
        assert.deepEqual(x.items(G, box, shape.field), [leaf, 'not an id at all']);
      }
    });

    test('the node an owner embeds keeps its place under the owner, and a container lists the owner', () => {
      const { engines, box, leaf, owner, embedded } = make();
      const [e] = engines as [Engine, Oracle];
      for (const x of engines) {
        x.addPair(G, owner, shape.embedField, embedded);
        x.insertItem(G, box, shape.field, owner);
      }
      assert.equal(inspectEngine(e).treeParentOf(embedded), owner);
      assert.equal(inspectEngine(e).treeParentOf(owner), box);
      checkTree(e, [box, leaf, owner, embedded], shape.name);
    });
  });
}

describe('a reference field that is not the containment field takes an embedded id', () => {
  test('likes accepts it, in the engine and the oracle', () => {
    const e = createEngine(TEST_SCHEMA); const o = new Oracle(e.schema);
    const leaf = `Leaf:${flake()}`; const other = `Leaf:${flake()}`;
    const embedded = `${other}:refs:Ref:${flake()}`;
    for (const x of [e, o]) {
      x.createNode(G, leaf, 'Leaf'); x.createNode(G, other, 'Leaf'); x.createNode(G, embedded, 'Ref');
      x.addPair(G, leaf, 'likes', embedded);
      assert.deepEqual(x.values(G, leaf, 'likes'), [embedded]);
      assert.deepEqual(x.subjectsOf(G, 'likes', embedded), [leaf]);
    }
  });
});
