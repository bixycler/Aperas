// The embedded-id rule on the ordered writes (planning/core.md, Batch 8 step 5 and its follow-up; design/core.md, "Containment"):
// `insertItem` into an ordered embed field meets the rule `addPair` meets, so the value is an id of a node the host embeds in that
// field, and a node cannot be held by two owners through the list. No schema of the project declares an ordered embed field, so the
// schema here does. The second part is the `moveItem` refusal of an embedded id in the containment field: the id is never in the list,
// so its refusal and the refusal of "not in the list" are both `Refused`; the message tells them apart. Every case is given to the
// engine and to the oracle.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '@aperas/core/apeironNgn/engine';
import type { Engine } from '@aperas/core/apeironNgn/interface';
import type { SchemaSpec } from '@aperas/core/apeironNgn/schema';
import { Oracle } from '../support/oracle.ts';
import { refusedInShape } from '../support/refusals.ts';
import { TEST_SCHEMA } from '../support/engineSchema.ts';

const G = 'default';
let n = 0;
const flake = (): string => (++n).toString().padStart(13, '0');
const mint = (kind: string): string => `${kind}:${flake()}`;
const refusedWith = (re: RegExp) => (err: unknown): boolean => refusedInShape(err) && re.test((err as Error).message);

const SPEC: SchemaSpec = {
  kinds: [
    {
      name: 'Pack',
      fields: [
        { name: 'parts', storage: 'embed', cardinality: 'ordered', embeds: 'Part' },
        { name: 'spares', storage: 'embed', cardinality: 'ordered', embeds: 'Part' },
      ],
    },
    { name: 'Part', fields: [{ name: 'tag', storage: 'literal', cardinality: 'optional' }] },
    { name: 'Big', extends: 'Part', fields: [] },
    { name: 'Other', fields: [] },
  ],
};

describe('insertItem into an ordered embed field', () => {
  const make = (): { engines: Engine[]; a: string; b: string; part: string } => {
    const e = createEngine(SPEC); const o = new Oracle(e.schema);
    const a = mint('Pack'); const b = mint('Pack'); const part = `${a}:parts:Part:${flake()}`;
    for (const x of [e, o]) { x.createNode(G, a, 'Pack'); x.createNode(G, b, 'Pack'); x.createNode(G, part, 'Part'); }
    return { engines: [e, o], a, b, part };
  };

  test('takes an id of a node the host embeds in that field, at the end or at a place', () => {
    const { engines, a } = make();
    for (const x of engines) {
      const p1 = `${a}:parts:Part:${flake()}`; const p2 = `${a}:parts:Part:${flake()}`; const big = `${a}:parts:Big:${flake()}`;
      x.createNode(G, p1, 'Part'); x.createNode(G, p2, 'Part'); x.createNode(G, big, 'Big');
      x.insertItem(G, a, 'parts', p1); x.insertItem(G, a, 'parts', p2, 0); x.insertItem(G, a, 'parts', big, 1);
      assert.deepEqual(x.items(G, a, 'parts'), [p2, big, p1]);
    }
  });

  test('refuses the embedded node of another owner, and a node cannot be held by two owners', () => {
    const { engines, a, b, part } = make();
    for (const x of engines) {
      x.insertItem(G, a, 'parts', part);
      assert.throws(() => x.insertItem(G, b, 'parts', part), refusedInShape, 'a second owner');
      assert.throws(() => x.insertItem(G, b, 'parts', part, 0), refusedInShape, 'a second owner, at a place');
      assert.deepEqual(x.items(G, b, 'parts'), []);
      assert.deepEqual(x.items(G, a, 'parts'), [part]);
      assert.deepEqual(x.subjectsOf(G, 'parts', part), [a]);
    }
  });

  test('refuses an id of another field of the host, a top-level id and a string that is no id, and changes nothing', () => {
    const { engines, a, part } = make();
    for (const x of engines) {
      const inSpares = `${a}:spares:Part:${flake()}`; const top = mint('Part');
      x.createNode(G, inSpares, 'Part'); x.createNode(G, top, 'Part');
      for (const id of [inSpares, top, 'not an id at all', `${a}:parts:Part:${flake()}`.replace(a, mint('Pack'))]) {
        assert.throws(() => x.insertItem(G, a, 'parts', id), refusedInShape, id);
      }
      x.insertItem(G, a, 'parts', part);
      assert.deepEqual(x.items(G, a, 'parts'), [part]);
      assert.deepEqual(x.subjectsOf(G, 'parts', inSpares), []);
    }
  });

  test('is refusedInShape for an embedded node of a kind other than the field embeds', () => {
    const { engines, a } = make();
    for (const x of engines) {
      const wrong = `${a}:parts:Other:${flake()}`;
      x.createNode(G, wrong, 'Other');
      assert.throws(() => x.insertItem(G, a, 'parts', wrong), refusedInShape);
      assert.deepEqual(x.items(G, a, 'parts'), []);
    }
  });

  test('gives the outcome addPair gives, for the same value, each on a fresh store', () => {
    // 'Refused' is a value that is no id of a node the host embeds in the field; 'Refused (kind)' is an id of one, of a kind other than the field embeds.
    const outcome = (run: () => void): string => {
      try { run(); return 'ok'; } catch (err) { return (err as Error).name + (/ embeds/.test((err as Error).message) ? ' (kind)' : ''); }
    };
    const host = mint('Pack'); const other = mint('Pack');
    const values = [`${host}:parts:Part:${flake()}`, `${host}:parts:Big:${flake()}`, `${other}:parts:Part:${flake()}`, `${host}:spares:Part:${flake()}`,
      `${host}:parts:Other:${flake()}`, mint('Part'), 'not an id'];
    const seen = new Set<string>();
    for (const v of values) {
      const via = (write: (x: Engine) => void): string[] => [createEngine(SPEC), new Oracle(createEngine(SPEC).schema)].map((x) => {
        x.createNode(G, host, 'Pack');
        return outcome(() => write(x));
      });
      const pair = via((x) => x.addPair(G, host, 'parts', v));
      const item = via((x) => x.insertItem(G, host, 'parts', v));
      assert.deepEqual(item, pair, `the value ${v}`);
      assert.equal(item[0], item[1], `the engine and the oracle, the value ${v}`);
      seen.add(item[0]!);
    }
    assert.deepEqual([...seen].sort(), ['Refused', 'Refused (kind)', 'ok'], 'the values reach all three outcomes');
  });
});

describe('moveItem of an embedded id in the containment field', () => {
  test('is refusedInShape for being an embedded node, not for being absent from the list', () => {
    const e = createEngine(TEST_SCHEMA); const o = new Oracle(e.schema);
    const box = mint('Box'); const leaf = mint('Leaf'); const owner = mint('Leaf');
    const embedded = `${owner}:refs:Ref:${flake()}`; const norecord = `${owner}:refs:Ref:${flake()}`;
    for (const x of [e, o]) {
      x.createNode(G, box, 'Box'); x.createNode(G, leaf, 'Leaf'); x.createNode(G, owner, 'Leaf'); x.createNode(G, embedded, 'Ref');
      x.insertItem(G, box, 'items', leaf);
      for (const id of [embedded, norecord]) {
        assert.throws(() => x.moveItem(G, box, 'items', id, 0), refusedWith(/embedded node/), `moveItem of ${id}`);
      }
      // An id that is no embedded id and is not in the list is refusedInShape for the list.
      assert.throws(() => x.moveItem(G, box, 'items', mint('Leaf'), 0), refusedWith(/is not in items/));
      assert.deepEqual(x.items(G, box, 'items'), [leaf]);
    }
  });
});
