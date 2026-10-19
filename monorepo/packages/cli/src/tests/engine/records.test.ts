// Records and literal fields (planning/core.md, Batch 4 steps 1, 2 and 4, and the engine side of Persistence): a
// record for each node, a literal field as a plain property of it, the cardinalities declared and never inferred,
// the master map and the collections by kind. Hand-written cases; the random sequences against the oracle are in
// `literals.model.test.ts`.
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, NotBuiltError, Undecided, WAITING_ON } from '@aperas/core/apeironNgn/engine';
import type { Engine } from '@aperas/core/apeironNgn/interface';
import type { SchemaSpec } from '@aperas/core/apeironNgn/schema';
import { Oracle, Undecided as OracleUndecided } from '../support/oracle.ts';
import { TEST_SCHEMA } from '../support/engineSchema.ts';

const G = 'default';
let n = 0;
/** A valid id of a kind, a new one at each call. */
const mint = (kind: string): string => `${kind}:${(++n).toString().padStart(13, '0')}`;
let e: Engine;
const mk = (kind: string, engine: Engine = e): string => { const id = mint(kind); engine.createNode(G, id, kind); return id; };

/** An error of the engine and the same error of the oracle: the class and the open point, not the message. */
const undecided = (point: string) => (err: unknown): boolean => err instanceof Undecided && err.point === point;
const oracleUndecided = (point: string) => (err: unknown): boolean => err instanceof OracleUndecided && err.point === point;

beforeEach(() => { e = createEngine(TEST_SCHEMA); });

describe('a record and its literal fields', () => {
  test('a literal is written and read as the schema declares it for the kind, an inherited field included', () => {
    const leaf = mk('Leaf');
    e.addPair(G, leaf, 'label', 'one'); e.addPair(G, leaf, 'rank', 7); e.addPair(G, leaf, 'flag', false); e.addPair(G, leaf, 'note', 'n');
    assert.deepEqual(e.values(G, leaf, 'label'), ['one'], 'label is declared on Entity, three levels up');
    assert.equal(e.first(G, leaf, 'label'), 'one');
    assert.equal(e.first(G, leaf, 'rank'), 7);
    assert.equal(e.first(G, leaf, 'flag'), false, 'a false is a value');
    assert.deepEqual(e.values(G, leaf, 'retiredAt'), []);
    assert.equal(e.first(G, leaf, 'retiredAt'), undefined);
    const loose = mk('Loose');
    e.addPair(G, loose, 'name', 'x');
    assert.equal(e.first(G, loose, 'name'), 'x');
    assert.deepEqual(e.values(G, loose, 'label'), [], 'a field the kind does not declare reads empty');
  });

  test('a write of a field is a clear and then the adds, and adding a value already present changes nothing', () => {
    const leaf = mk('Leaf');
    e.addPair(G, leaf, 'label', 'a');
    e.addPair(G, leaf, 'label', 'a');
    assert.deepEqual(e.values(G, leaf, 'label'), ['a']);
    e.clearField(G, leaf, 'label');
    assert.deepEqual(e.values(G, leaf, 'label'), []);
    e.addPair(G, leaf, 'label', 'b');
    assert.deepEqual(e.values(G, leaf, 'label'), ['b']);
    e.clearField(G, leaf, 'rank'); // clearing a field with no value changes nothing
    e.clearField(G, leaf, 'label'); // and a `one` field may be left with no value: nothing checks "exactly one"
    assert.deepEqual(e.record(G, leaf)!.fields, []);
  });

  test('a value is kept as given: "1", 1, "true" and true are four values', () => {
    const SET: SchemaSpec = { kinds: [{ name: 'Bag', fields: [{ name: 'tags', storage: 'literal', cardinality: 'set' }] }] };
    const engine = createEngine(SET);
    const bag = mk('Bag', engine);
    for (const v of ['1', 1, 'true', true, '1', 1, true]) engine.addPair(G, bag, 'tags', v);
    assert.deepEqual(engine.values(G, bag, 'tags'), ['1', 1, 'true', true]);
    assert.equal(engine.first(G, bag, 'tags'), '1');
    engine.addPair(G, bag, 'tags', '2024-01-01');
    assert.ok(engine.values(G, bag, 'tags').includes('2024-01-01'), 'a string that looks like a date stays a string');
  });

  test('values and record give copies, so a caller cannot alter the store', () => {
    const SET: SchemaSpec = { kinds: [{ name: 'Bag', fields: [{ name: 'tags', storage: 'literal', cardinality: 'set' }] }] };
    const engine = createEngine(SET);
    const bag = mk('Bag', engine);
    engine.addPair(G, bag, 'tags', 'x');
    (engine.values(G, bag, 'tags') as unknown[]).push('y');
    (engine.record(G, bag)!.fields[0]!.values as unknown[]).push('z');
    assert.deepEqual(engine.values(G, bag, 'tags'), ['x']);
    assert.deepEqual(engine.record(G, bag)!.fields, [{ name: 'tags', values: ['x'] }]);
  });

  test('a field may be named __proto__, constructor or toString', () => {
    const PROTO: SchemaSpec = {
      kinds: [{ name: 'Odd', fields: [
        { name: '__proto__', storage: 'literal', cardinality: 'optional' },
        { name: 'constructor', storage: 'literal', cardinality: 'set' },
        { name: 'toString', storage: 'literal', cardinality: 'optional' },
      ] }],
    };
    const engine = createEngine(PROTO);
    const odd = mk('Odd', engine);
    assert.deepEqual(engine.values(G, odd, 'constructor'), [], 'nothing is read from the prototype');
    assert.deepEqual(engine.record(G, odd)!.fields, []);
    engine.addPair(G, odd, '__proto__', 'p'); engine.addPair(G, odd, 'constructor', 'c'); engine.addPair(G, odd, 'constructor', 'd'); engine.addPair(G, odd, 'toString', 's');
    assert.equal(engine.first(G, odd, '__proto__'), 'p');
    assert.deepEqual(engine.values(G, odd, 'constructor'), ['c', 'd']);
    assert.equal(engine.first(G, odd, 'toString'), 's');
    assert.deepEqual(engine.record(G, odd)!.fields, [{ name: '__proto__', values: ['p'] }, { name: 'constructor', values: ['c', 'd'] }, { name: 'toString', values: ['s'] }]);
    assert.equal(({} as Record<string, unknown>).constructor, Object, 'and the prototype of Object is untouched');
  });

  test('reads of a subject that is not there: empty, undefined, undefined', () => {
    const gone = mint('Leaf');
    assert.deepEqual(e.values(G, gone, 'label'), []);
    assert.equal(e.first(G, gone, 'label'), undefined);
    assert.equal(e.record(G, gone), undefined);
    const leaf = mk('Leaf');
    assert.deepEqual(e.values('elsewhere', leaf, 'label'), [], 'a node lives in one graph');
    assert.equal(e.record('elsewhere', leaf), undefined);
  });
});

describe('the record as Persistence reads it out', () => {
  test('the fields that hold a value, in the order the schema declares them, whatever the order of the writes', () => {
    const a = mk('Leaf'); const b = mk('Leaf');
    for (const [f, v] of [['flag', true], ['rank', 3], ['note', 'n'], ['label', 'l']] as const) e.addPair(G, a, f, v);
    for (const [f, v] of [['label', 'l'], ['note', 'n'], ['rank', 3], ['flag', true]] as const) e.addPair(G, b, f, v);
    const want = [{ name: 'label', values: ['l'] }, { name: 'note', values: ['n'] }, { name: 'rank', values: [3] }, { name: 'flag', values: [true] }];
    assert.deepEqual(e.record(G, a), { id: a, kind: 'Leaf', fields: want });
    assert.deepEqual(e.record(G, b)!.fields, want);
  });

  test('a node with no value lists no entry, and a derived entry has none for a node with no container', () => {
    const leaf = mk('Leaf');
    assert.deepEqual(e.record(G, leaf), { id: leaf, kind: 'Leaf', fields: [] });
    assert.deepEqual(e.values(G, leaf, 'label'), []);
  });

  test('a record read out and built again on another engine by createNode and addPair is equal', () => {
    const ids = [mk('Leaf'), mk('Stub'), mk('Loose'), mk('Leaf')];
    e.addPair(G, ids[0]!, 'label', 'a'); e.addPair(G, ids[0]!, 'rank', 2); e.addPair(G, ids[1]!, 'flag', false); e.addPair(G, ids[2]!, 'name', '1'); e.addPair(G, ids[3]!, 'note', 'z');
    const other = createEngine(TEST_SCHEMA);
    for (const id of ids) {
      const rec = e.record(G, id)!;
      other.createNode(G, rec.id, rec.kind);
      for (const f of rec.fields) for (const v of f.values) other.addPair(G, rec.id, f.name, v);
    }
    for (const id of ids) assert.deepEqual(other.record(G, id), e.record(G, id));
    for (const kind of ['Leaf', 'Stub', 'Loose']) assert.deepEqual(other.idsOfKind(G, kind), e.idsOfKind(G, kind));
  });
});

describe('cardinalities are declared and never inferred from the data', () => {
  const CARD: SchemaSpec = {
    kinds: [
      { name: 'Bag', fields: [{ name: 'tag', storage: 'literal', cardinality: 'set' }] },
      { name: 'Slot', fields: [{ name: 'tag', storage: 'literal', cardinality: 'optional' }] },
      { name: 'Must', fields: [{ name: 'tag', storage: 'literal', cardinality: 'one' }] },
    ],
  };

  test('the same data, one value, is a set under one declaration and meets Enforcement under another', () => {
    const engine = createEngine(CARD);
    const oracle = new Oracle(engine.schema);
    const bag = mk('Bag', engine); const slot = mk('Slot', engine); const must = mk('Must', engine);
    for (const [kind, id] of [['Bag', bag], ['Slot', slot], ['Must', must]] as const) { oracle.createNode(G, id, kind); engine.addPair(G, id, 'tag', 'x'); oracle.addPair(G, id, 'tag', 'x'); }
    engine.addPair(G, bag, 'tag', 'y');
    assert.deepEqual(engine.values(G, bag, 'tag'), ['x', 'y']);
    for (const id of [slot, must]) {
      assert.throws(() => engine.addPair(G, id, 'tag', 'y'), undecided('Enforcement'));
      assert.throws(() => oracle.addPair(G, id, 'tag', 'y'), oracleUndecided('Enforcement'));
      engine.addPair(G, id, 'tag', 'x'); // the value it holds: nothing changes
      assert.deepEqual(engine.values(G, id, 'tag'), ['x']);
      engine.clearField(G, id, 'tag');
      engine.addPair(G, id, 'tag', 'y'); // a write is a clear and then the add
      assert.equal(engine.first(G, id, 'tag'), 'y');
    }
  });
});

describe('Enforcement and Existence wait on their open points, each in one function', () => {
  const o = (): Oracle => new Oracle(createEngine(TEST_SCHEMA).schema);

  test('both implementations throw Undecided for a write outside the shape', () => {
    const oracle = o();
    const a = mk('Leaf'); oracle.createNode(G, a, 'Leaf');
    const cases: [string, (x: Engine) => void][] = [
      ['a field the kind does not declare', (x) => x.addPair(G, a, 'name', 'x')],
      ['a field the kind does not declare, cleared', (x) => x.clearField(G, a, 'name')],
      ['a derived entry', (x) => x.addPair(G, a, 'up', 'Box:0000000000001')],
      ['a derived entry, cleared', (x) => x.clearField(G, a, 'up')],
      ['an object for a literal field', (x) => x.addPair(G, a, 'label', {} as unknown as string)],
      ['a number for a reference field', (x) => x.addPair(G, a, 'mate', 4 as unknown as string)],
      ['a second value for an optional field', (x) => { x.addPair(G, a, 'rank', 1); x.addPair(G, a, 'rank', 2); }],
    ];
    for (const [name, run] of cases) {
      assert.throws(() => run(e), undecided('Enforcement'), name);
      assert.throws(() => run(oracle), oracleUndecided('Enforcement'), name);
    }
  });

  test('both implementations throw Undecided for a write to a subject with no node', () => {
    const oracle = o();
    const gone = mint('Leaf');
    assert.throws(() => e.addPair(G, gone, 'label', 'x'), undecided('Existence'));
    assert.throws(() => oracle.addPair(G, gone, 'label', 'x'), oracleUndecided('Existence'));
    assert.throws(() => e.clearField(G, gone, 'label'), undecided('Existence'));
    assert.throws(() => oracle.clearField(G, gone, 'label'), oracleUndecided('Existence'));
    assert.throws(() => e.addPair('elsewhere', gone, 'label', 'x'), undecided('Existence'));
  });

  test('exists and size stay in the engine and throw Undecided, which is not NotBuiltError', () => {
    const a = mk('Leaf');
    for (const run of [() => e.exists(G, a), () => e.size(G)]) {
      assert.throws(run, (err: unknown) => err instanceof Undecided && err.point === 'Existence' && !(err instanceof NotBuiltError));
    }
    assert.deepEqual(WAITING_ON, { exists: 'Existence', size: 'Existence' });
  });
});

describe('the master map and the collections by kind', () => {
  test('idsOfKind lists the nodes of exactly that kind, in order of insertion', () => {
    const l1 = mk('Leaf'); const s1 = mk('Stub'); const l2 = mk('Leaf'); const b1 = mk('Box');
    assert.deepEqual(e.idsOfKind(G, 'Leaf'), [l1, l2]);
    assert.deepEqual(e.idsOfKind(G, 'Stub'), [s1]);
    assert.deepEqual(e.idsOfKind(G, 'Box'), [b1]);
    for (const above of ['Node', 'Entity']) assert.deepEqual(e.idsOfKind(G, above), [], `no ${above} node is a Leaf node's kind`);
  });

  test('an unknown kind or a graph with nothing in it gives an empty list', () => {
    mk('Leaf');
    assert.deepEqual(e.idsOfKind(G, 'Nowhere'), []);
    assert.deepEqual(e.idsOfKind(G, 'Attr'), []);
    assert.deepEqual(e.idsOfKind('elsewhere', 'Leaf'), []);
  });

  test('the list is a copy, and a record is found by its id in the one master map', () => {
    const l = mk('Leaf');
    e.idsOfKind(G, 'Leaf').push('x');
    assert.deepEqual(e.idsOfKind(G, 'Leaf'), [l]);
    assert.equal(e.record(G, l)!.id, l);
  });
});
