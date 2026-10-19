// The orders (planning/core.md, Batch 4 step 5): one comparison of ids by plain code point, the only one that orders
// ids; a keyed comparison for the sorts of the design, a tie broken by id; and a shuffle of the order of insertion that
// leaves the sorted output as it was.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '@aperas/core/apeironNgn/engine';
import { compareByKey, compareIds, MIXED_KEYS_POINT } from '@aperas/core/apeironNgn/order';
import { Undecided, Refused } from '@aperas/core/apeironNgn/errors';
import { Oracle } from '../support/oracle.ts';
import { TEST_SCHEMA } from '../support/engineSchema.ts';
import { rng } from '../support/prng.ts';

describe('compareIds orders by plain code point', () => {
  test('digits come before upper case, upper case before lower case, and a prefix before the longer string', () => {
    assert.ok(compareIds('0', 'A') < 0);
    assert.ok(compareIds('9', 'A') < 0);
    assert.ok(compareIds('Z', 'a') < 0);
    assert.ok(compareIds('Leaf:A', 'Leaf:AB') < 0);
    assert.ok(compareIds('Leaf:AB', 'Leaf:A') > 0);
    assert.equal(compareIds('Leaf:A', 'Leaf:A'), 0);
    assert.ok(compareIds('Box:Z', 'Leaf:0') < 0, 'the kind is compared first');
  });

  test('a pair on which localeCompare and the code-point order disagree', () => {
    assert.ok(compareIds('B', 'a') < 0, 'code point: B (66) before a (97)');
    assert.ok('B'.localeCompare('a') > 0, 'locale: a before B, which is why localeCompare orders no id');
    const ids = ['b', 'A', 'a', 'B', '0'];
    assert.deepEqual([...ids].sort(compareIds), ['0', 'A', 'B', 'a', 'b']);
  });

  test('for ids, which are ASCII by their grammar, the comparison of the strings with < is the code-point order', () => {
    const codePoint = (a: string, b: string): number => { const x = [...a].map((c) => c.codePointAt(0)!); const y = [...b].map((c) => c.codePointAt(0)!); for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!; return x.length - y.length; };
    const g = rng(3);
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ:abcdefghijklmnopqrstuvwxyz_';
    for (let i = 0; i < 500; i++) {
      const a = Array.from({ length: g.int(8) }, () => g.pick([...alphabet])).join('');
      const b = Array.from({ length: g.int(8) }, () => g.pick([...alphabet])).join('');
      assert.equal(Math.sign(compareIds(a, b)), Math.sign(codePoint(a, b)), `${a} ${b}`);
    }
  });
});

describe('compareByKey: the key is the caller\'s, a tie is broken by id', () => {
  const keys: Record<string, number | string | undefined> = { a: 2, b: 1, c: 2, d: 10, e: 9 };
  const byNumber = compareByKey((id) => keys[id]);

  test('numbers compare as numbers, and a tie is broken by compareIds', () => {
    assert.deepEqual(['d', 'c', 'e', 'a', 'b'].sort(byNumber), ['b', 'a', 'c', 'e', 'd']);
    assert.ok(byNumber('d', 'e') > 0, '10 after 9, as numbers and not as strings');
  });

  test('strings compare by code point', () => {
    const k: Record<string, string> = { x: 'b', y: 'B', z: 'a' };
    assert.deepEqual(['x', 'y', 'z'].sort(compareByKey((id) => k[id])), ['y', 'z', 'x']);
  });

  test('a list in which every key is absent comes out in the order of compareIds', () => {
    assert.deepEqual(['c', 'a', 'b'].sort(compareByKey(() => undefined)), ['a', 'b', 'c']);
  });

  test('a pair in which exactly one key is absent is Undecided, whichever side it is on', () => {
    const k: Record<string, number | undefined> = { a: 1, b: undefined };
    const cmp = compareByKey((id) => k[id]);
    const mixed = (e: unknown): boolean => e instanceof Undecided && e.point === MIXED_KEYS_POINT && e.point === 'The order of links without a position';
    assert.throws(() => cmp('a', 'b'), mixed);
    assert.throws(() => cmp('b', 'a'), mixed);
    assert.throws(() => ['b', 'a'].sort(cmp), mixed);
  });

  test('a number and a string as keys of one sort are refused', () => {
    const k: Record<string, number | string> = { a: 1, b: 'x' };
    assert.throws(() => compareByKey((id) => k[id])('a', 'b'), Refused);
  });
});

describe('the order of insertion does not show in a sorted read', () => {
  const G = 'default';
  const flake = (g: ReturnType<typeof rng>): string => Array.from({ length: 13 }, () => g.pick([...'0123456789ABCDEFGHJKMNPQRSTVWXYZ'])).join('');

  for (const seed of [11, 12, 13, 14, 15, 16]) {
    test(`seed ${seed}: the nodes of a graph created in several permutations of one list`, () => {
      const g = rng(seed);
      const kinds = ['Leaf', 'Stub', 'Box'];
      const list = Array.from(new Set(Array.from({ length: 24 }, () => `${g.pick(kinds)}:${flake(g)}`)));
      const kindOf = (id: string): string => id.slice(0, id.indexOf(':'));
      const oracle = new Oracle(createEngine(TEST_SCHEMA).schema);
      for (const id of list) oracle.createNode(G, id, kindOf(id));
      let first: Record<string, string[]> | undefined;
      for (let round = 0; round < 5; round++) {
        const engine = createEngine(TEST_SCHEMA);
        for (const id of g.shuffle(list)) engine.createNode(G, id, kindOf(id));
        const read = Object.fromEntries(kinds.map((k) => [k, engine.idsOfKind(G, k).sort(compareIds)]));
        first ??= read;
        assert.deepEqual(read, first, `seed ${seed} round ${round}`);
        for (const k of kinds) assert.deepEqual(read[k], oracle.idsOfKind(G, k).sort(compareIds), `the oracle, kind ${k}`);
      }
    });
  }
});
