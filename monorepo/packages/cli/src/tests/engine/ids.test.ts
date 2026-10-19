// Ids (planning/core.md, Batch 4 step 3): `Kind:snowflake`, an embedded node's id `owner:field:Kind:snowflake`, nested
// further for the props of a link. The kind of an id is read from its last `field:Kind:` segment or from its prefix,
// and a string counts as an id only if a valid snowflake follows `Kind:` at every level. One table of strings runs
// on the engine's grammar and on the oracle's, which is written apart from it.
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, Refused } from '@aperas/core/apeironNgn/engine';
import { fieldOfId, isId, kindOfId, ownerOfId } from '@aperas/core/apeironNgn/ids';
import type { Engine } from '@aperas/core/apeironNgn/interface';
import { Oracle, Refused as OracleRefused, oracleFieldOfId, oracleIsId, oracleKindOfId, oracleOwnerOfId } from '../support/oracle.ts';
import { TEST_SCHEMA } from '../support/engineSchema.ts';

const S1 = '00D4QQ4X10001';
const S2 = '00D4QQ5D4R000';
const S3 = '0123456789ABC';

/** [the string, its kind or `undefined` when it is no id, what the row shows] */
const TABLE: [string, string | undefined, string][] = [
  // never taken for an id: a folder or an artifact named after a kind, and the other strings of a corpus
  ['FolderNode', undefined, 'a folder named after a kind'],
  ['FolderNode:', undefined, 'a folder named after a kind, with the colon'],
  ['BlockNode:notes', undefined, 'a folder named notes under a kind'],
  ['ArtifactNode:README.md', undefined, 'an artifact named after a kind'],
  ['Profile:default', undefined, 'a profile handle'],
  ['design/core.md', undefined, 'a path'],
  ['', undefined, 'the empty string'],
  [':' + S1, undefined, 'no kind'],
  // the snowflake
  ['BlockNode:' + S1.slice(0, 12), undefined, 'a snowflake of 12 characters'],
  ['BlockNode:' + S1 + '0', undefined, 'a snowflake of 14 characters'],
  ['BlockNode:' + S1.toLowerCase(), undefined, 'a lowercase snowflake'],
  ['BlockNode:00D4QQ4X1000I', undefined, 'a snowflake with I'],
  ['BlockNode:00D4QQ4X1000L', undefined, 'a snowflake with L'],
  ['BlockNode:00D4QQ4X1000O', undefined, 'a snowflake with O'],
  ['BlockNode:00D4QQ4X1000U', undefined, 'a snowflake with U'],
  ['BlockNode:00D4QQ4X1000-', undefined, 'a snowflake with a character outside the alphabet'],
  ['BlockNode:' + S1 + ':', undefined, 'a trailing colon'],
  ['BlockNode:' + S1 + '\n', undefined, 'a trailing newline'],
  [' BlockNode:' + S1, undefined, 'a leading space'],
  // the kind
  ['1Node:' + S1, undefined, 'a kind that starts with a digit'],
  ['Block-Node:' + S1, undefined, 'a kind with a character outside the name rule'],
  // an embedded id
  ['BlockNode:' + S1 + ':links:Link', undefined, 'an embedded id with no snowflake'],
  ['BlockNode:' + S1 + ':links:' + S2, undefined, 'an embedded id with a missing kind'],
  ['BlockNode:' + S1 + ':links:Link:notes', undefined, 'an embedded id whose snowflake is not one'],
  ['BlockNode:' + S1 + ':Link:' + S2, undefined, 'an embedded id with a missing field'],
  ['BlockNode:' + S1 + ':links:Link:' + S2 + ':props', undefined, 'a nested id cut short'],
  ['BlockNode:' + S1 + ':1links:Link:' + S2, undefined, 'a field that starts with a digit'],
  // ids
  ['BlockNode:' + S1, 'BlockNode', 'a kind and a snowflake'],
  ['FolderNode:' + S3, 'FolderNode', 'another kind and every character of the alphabet in use'],
  ['Foo:' + S2, 'Foo', 'a kind the schema does not hold: the grammar is schema-free'],
  ['_x1:' + S2, '_x1', 'a kind that starts with an underscore'],
  ['BlockNode:0123456789ABC'.replace('ABC', 'XYZ'), 'BlockNode', 'the end of the alphabet'],
  ['BlockNode:' + S1 + ':links:Link:' + S2, 'Link', 'an embedded node: the kind of the last segment'],
  ['BlockNode:' + S1 + ':links:Link:' + S2 + ':props:StringProp:' + S3, 'StringProp', 'a nested embedded id of two levels'],
  ['Leaf:' + S1 + ':refs:Ref:' + S2 + ':attrs:Attr:' + S3, 'Attr', 'the engine test schema, two levels'],
];

describe('the grammar of an id', () => {
  for (const [text, kind, what] of TABLE) {
    test(`engine: ${what}`, () => {
      assert.equal(kindOfId(text), kind, JSON.stringify(text));
      assert.equal(isId(text), kind !== undefined);
    });
    test(`oracle: ${what}`, () => {
      assert.equal(oracleKindOfId(text), kind, JSON.stringify(text));
      assert.equal(oracleIsId(text), kind !== undefined);
    });
  }

  test('a value that is not a string is no id', () => {
    for (const v of [undefined, null, 4, {}, ['BlockNode:' + S1]]) assert.equal(isId(v), false);
    assert.equal(kindOfId(undefined), undefined);
  });
});

/** [the string, its owner and the field of the owner that holds it, both `undefined` for a top-level id and for a string that is no id, what the row shows] */
const OWNERS: [string, string | undefined, string | undefined, string][] = [
  ['Leaf:' + S1, undefined, undefined, 'a top-level id'],
  ['Leaf:' + S1 + ':refs:Ref:' + S2, 'Leaf:' + S1, 'refs', 'a one-level embedded id'],
  ['Leaf:' + S1 + ':refs:Ref:' + S2 + ':attrs:Attr:' + S3, 'Leaf:' + S1 + ':refs:Ref:' + S2, 'attrs', 'a two-level embedded id, whose owner is itself embedded'],
  ['BlockNode:' + S1 + ':links:Link:' + S2 + ':props:StringProp:' + S3 + ':more:Deep:' + S1, 'BlockNode:' + S1 + ':links:Link:' + S2 + ':props:StringProp:' + S3, 'more', 'three levels'],
  ['FolderNode', undefined, undefined, 'a string that is no id'],
  ['Leaf:' + S1 + ':refs:Ref', undefined, undefined, 'an embedded id missing its snowflake'],
  ['Leaf:' + S1 + ':refs:Ref:short', undefined, undefined, 'an embedded id with a bad snowflake'],
  ['x:' + S1 + ':refs:Ref:' + S2 + ':', undefined, undefined, 'a trailing colon'],
  ['', undefined, undefined, 'the empty string'],
];

describe('the owner of an embedded id is read from the id, and the engine and the oracle read it alike', () => {
  for (const [text, owner, field, what] of OWNERS) {
    test(`engine: ${what}`, () => {
      assert.equal(ownerOfId(text), owner, JSON.stringify(text));
      assert.equal(fieldOfId(text), field, JSON.stringify(text));
    });
    test(`oracle: ${what}`, () => {
      assert.equal(oracleOwnerOfId(text), owner, JSON.stringify(text));
      assert.equal(oracleFieldOfId(text), field, JSON.stringify(text));
    });
  }

  test('a value that is not a string has no owner', () => {
    for (const v of [undefined, null, 4, {}]) { assert.equal(ownerOfId(v), undefined); assert.equal(fieldOfId(v), undefined); }
  });
});

describe('createNode checks the id and the kind', () => {
  const sides: [string, () => Engine][] = [
    ['engine', () => createEngine(TEST_SCHEMA)],
    ['oracle', () => new Oracle(createEngine(TEST_SCHEMA).schema)],
  ];
  const refused = (e: unknown): boolean => e instanceof Refused || e instanceof OracleRefused;
  let x: Engine;

  for (const [name, make] of sides) {
    describe(name, () => {
      beforeEach(() => { x = make(); });
      const G = 'default';

      test('refuses an id that fails the grammar, and creates nothing', () => {
        for (const [text, kind] of TABLE) {
          if (kind !== undefined) continue;
          assert.throws(() => x.createNode(G, text, 'Leaf'), refused, JSON.stringify(text));
        }
        assert.deepEqual(x.idsOfKind(G, 'Leaf'), []);
      });

      test('refuses a kind that is not a kind of the schema, even when the id carries it', () => {
        assert.throws(() => x.createNode(G, 'Foo:' + S2, 'Foo'), refused);
        assert.throws(() => x.createNode(G, 'Leaf:' + S2, 'Nowhere'), refused);
      });

      test('refuses a kind that differs from the kind of the id, an embedded id included', () => {
        assert.throws(() => x.createNode(G, 'Leaf:' + S1, 'Stub'), refused);
        assert.throws(() => x.createNode(G, 'Leaf:' + S1 + ':refs:Ref:' + S2, 'Leaf'), refused);
        assert.deepEqual(x.idsOfKind(G, 'Stub'), []);
      });

      test('refuses an id already taken', () => {
        x.createNode(G, 'Leaf:' + S1, 'Leaf');
        assert.throws(() => x.createNode(G, 'Leaf:' + S1, 'Leaf'), refused);
        assert.deepEqual(x.idsOfKind(G, 'Leaf'), ['Leaf:' + S1]);
      });

      test('refuses a graph that does not exist', () => {
        assert.throws(() => x.createNode('elsewhere', 'Leaf:' + S1, 'Leaf'), refused);
      });

      test('accepts an embedded id whether or not its owner exists', () => {
        const ref = 'Leaf:' + S1 + ':refs:Ref:' + S2;
        x.createNode(G, ref, 'Ref');
        assert.deepEqual(x.idsOfKind(G, 'Ref'), [ref]);
        x.createNode(G, ref + ':attrs:Attr:' + S3, 'Attr');
        assert.deepEqual(x.idsOfKind(G, 'Attr'), [ref + ':attrs:Attr:' + S3]);
      });

      test('keeps the id as given', () => {
        x.createNode(G, 'Leaf:' + S3, 'Leaf');
        assert.deepEqual(x.record(G, 'Leaf:' + S3), { id: 'Leaf:' + S3, kind: 'Leaf', fields: [] });
      });
    });
  }

  test('an id is unique across all graphs, in the oracle and in the engine', () => {
    const x = createEngine(TEST_SCHEMA);
    for (const m of [x, new Oracle(x.schema)] as Engine[]) {
      m.createGraph('other');
      m.createNode('default', 'Leaf:' + S1, 'Leaf');
      assert.throws(() => m.createNode('other', 'Leaf:' + S1, 'Leaf'), (e: unknown) => e instanceof OracleRefused || e instanceof Refused);
    }
  });
});
