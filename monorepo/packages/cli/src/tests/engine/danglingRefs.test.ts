// The ids referenced and never defined (planning/core.md, Batch 9, the engine side of Persistence; design/core.md, "Persistence"): the
// engine and the oracle give the same list for a graph, in every case by hand and in a random sequence of builds and removals over two
// graphs. An id defined in any graph is defined (the root folder's `children` names the `.threads` folder of the threads graph); a
// literal is no reference; the list is sorted by code point and holds each id once.
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '@aperas/core/apeironNgn/engine';
import type { Engine } from '@aperas/core/apeironNgn/interface';
import { Oracle } from '../support/oracle.ts';
import { noNode } from '../support/refusals.ts';
import { TEST_SCHEMA } from '../support/engineSchema.ts';
import { rng } from '../support/prng.ts';

const A = 'a.example';
const B = 'b.example';
const FLAKE = [...'0123456789ABCDEFGHJKMNPQRSTVWXYZ'];
let n = 0;
const mint = (kind: string): string => `${kind}:${(++n).toString().padStart(13, '0')}`;

let e: Engine;
let o: Oracle;
const both = (run: (x: Engine) => void): void => { run(e); run(o); };
const same = <T>(read: (x: Engine) => T, expected: T, why: string): void => {
  assert.deepEqual(read(e), expected, `engine: ${why}`);
  assert.deepEqual(read(o), expected, `oracle: ${why}`);
};

beforeEach(() => { e = createEngine(TEST_SCHEMA); o = new Oracle(e.schema); both((x) => { x.createGraph(A); x.createGraph(B); }); });

describe('danglingRefs', () => {
  test('is empty for a graph with nothing in it and for a graph that does not exist', () => {
    same((x) => x.danglingRefs(A), [], 'an empty graph');
    same((x) => x.danglingRefs('nowhere'), [], 'a graph that does not exist');
  });

  test('lists a node named and not built, once however often it is named, and drops it when it is built', () => {
    const ghost = mint('Leaf'); const a = mint('Leaf'); const b = mint('Leaf');
    both((x) => {
      x.build(A, { id: a, kind: 'Leaf', fields: { likes: [ghost], mate: ghost } });
      x.build(A, { id: b, kind: 'Leaf', fields: { likes: [ghost, a] } });
    });
    same((x) => x.danglingRefs(A), [ghost], 'named by three pairs, listed once');
    both((x) => x.build(A, { id: ghost, kind: 'Leaf', fields: {} }));
    same((x) => x.danglingRefs(A), [], 'built, no more');
  });

  test('reads a container\'s list and an embedded node alike, and no literal', () => {
    const box = mint('Box'); const item = mint('Leaf'); const owner = mint('Leaf'); const ref = `${owner}:refs:Ref:${'0'.repeat(12)}1`;
    both((x) => {
      x.build(A, { id: box, kind: 'Box', fields: { label: 'Box:0000000000000', items: [item] } });
      x.build(A, { id: owner, kind: 'Leaf', fields: { label: 'Leaf:0000000000000', refs: ref } });
    });
    same((x) => x.danglingRefs(A), [item, ref].sort(), 'the item and the embedded node are not built, a label that looks like an id is a literal');
  });

  test('counts an id defined in another graph as defined, and the pair is not dangling from either side', () => {
    const inB = mint('Leaf'); const inA = mint('Leaf'); const ghost = mint('Leaf');
    both((x) => {
      x.build(B, { id: inB, kind: 'Leaf', fields: {} });
      x.build(A, { id: inA, kind: 'Leaf', fields: { likes: [inB, ghost] } });
    });
    same((x) => x.danglingRefs(A), [ghost], 'A names a node of B and a node of none');
    same((x) => x.danglingRefs(B), [], 'B has no pair');
    both((x) => x.removeNode(B, inB));
    same((x) => x.danglingRefs(A), [inB, ghost].sort(), 'the node of B removed: it dangles');
  });

  test('is read for the graph named: a pair of another graph is not in the list', () => {
    const ghost = mint('Leaf'); const inB = mint('Leaf');
    both((x) => x.build(B, { id: inB, kind: 'Leaf', fields: { likes: [ghost] } }));
    same((x) => x.danglingRefs(A), [], 'A holds no pair');
    same((x) => x.danglingRefs(B), [ghost], 'B holds it');
  });

  test('is sorted by code point, digits before upper case and a prefix before the longer id', () => {
    const owner = mint('Leaf');
    const named = ['Stub:0000000000010', 'Box:00000000000Z0', 'Leaf:0000000000A00', 'Leaf:00000000000B0', 'Leaf:0000000000010', 'Loose:0000000000001', 'Leaf:000000000000A'];
    both((x) => x.build(A, { id: owner, kind: 'Leaf', fields: { likes: named } }));
    const expected = [...named].sort((p, q) => (p < q ? -1 : p > q ? 1 : 0));
    same((x) => x.danglingRefs(A), expected, 'by code point');
    assert.deepEqual(expected, ['Box:00000000000Z0', 'Leaf:000000000000A', 'Leaf:0000000000010', 'Leaf:00000000000B0', 'Leaf:0000000000A00', 'Loose:0000000000001', 'Stub:0000000000010'], 'the order is the one a reader expects');
  });

  test('is not changed by the read, and a build that fails adds nothing', () => {
    const a = mint('Leaf'); const ghost = mint('Leaf');
    both((x) => x.build(A, { id: a, kind: 'Leaf', fields: { likes: [ghost] } }));
    const first = e.danglingRefs(A);
    assert.deepEqual(e.danglingRefs(A), first, 'twice the same');
    const bad = { id: mint('Leaf'), kind: 'Leaf', fields: { likes: [mint('Leaf')], mate: [mint('Leaf'), mint('Leaf')] } };
    assert.throws(() => e.build(A, bad), Error);
    assert.throws(() => o.build(A, bad), Error);
    same((x) => x.danglingRefs(A), first, 'the failed build left nothing');
  });
});

describe('danglingRefs among random builds and removals over two graphs', () => {
  let findings = 0;
  for (const seed of Array.from({ length: 20 }, (_, i) => 900 + i)) {
    test(`seed ${seed}: the engine and the oracle give the same list for each graph after every step`, () => {
      const g = rng(seed);
      const flake = (): string => Array.from({ length: 13 }, () => g.pick(FLAKE)).join('');
      const kinds = ['Leaf', 'Leaf', 'Box', 'Stub', 'Shelf'];
      const pool = Array.from({ length: 14 }, () => { const kind = g.pick(kinds); return { id: `${kind}:${flake()}`, kind }; });
      const named = (): string => g.pick(pool).id;
      let nonEmpty = 0;
      for (let step = 0; step < 40; step++) {
        const graph = g.chance(0.5) ? A : B;
        const target = g.pick(pool);
        const roll = g.next();
        // Each side runs the step alone, so that an error of one does not keep the other from it; both must meet the same one.
        const attempt = (run: (x: Engine) => void): string[] => [e, o].map((x) => {
          try { run(x); return 'ok'; } catch (err) { return `${(err as Error).name}${noNode(err) ? ':no node' : ''}`; }
        });
        let outcomes: string[] = ['ok', 'ok'];
        if (roll < 0.45) {
          const fields: Record<string, string | string[]> = {};
          if (target.kind === 'Leaf' && g.chance(0.7)) fields.likes = Array.from({ length: g.int(4) }, named);
          if (target.kind === 'Leaf' && g.chance(0.4)) fields.mate = named();
          if (target.kind === 'Box' && g.chance(0.7)) fields.items = Array.from({ length: g.int(4) }, named);
          outcomes = attempt((x) => x.build(graph, { id: target.id, kind: target.kind, fields }));
        } else if (roll < 0.6) {
          outcomes = attempt((x) => x.removeNode(graph, target.id));
        } else if (roll < 0.8) {
          if (target.kind === 'Leaf') { const v = named(); outcomes = attempt((x) => x.addPair(graph, target.id, 'likes', v)); }
        } else if (target.kind === 'Box') {
          const v = named(); outcomes = attempt((x) => x.insertItem(graph, target.id, 'items', v));
        }
        assert.equal(outcomes[0], outcomes[1], `seed ${seed} step ${step}: the same outcome from both`);
        for (const gr of [A, B]) {
          const list = e.danglingRefs(gr);
          assert.deepEqual(list, o.danglingRefs(gr), `seed ${seed} step ${step}: the list of ${gr}`);
          assert.deepEqual(list, [...new Set(list)].sort((p, q) => (p < q ? -1 : p > q ? 1 : 0)), 'sorted, once each');
          if (list.length > 0) nonEmpty++;
        }
      }
      findings += nonEmpty;
    });
  }
  test('the sequences had something to find: the list was not empty at many steps', () => {
    assert.ok(findings > 100, `non-empty lists at ${findings} graph steps`);
  });
});
