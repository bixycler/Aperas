// The store access helpers (`core/src/apeironNgn/storeAccess.ts`): reads that return plain values and writes that
// take strings, each owning and freeing every wasm object it creates. The reads are compared with the former form
// (raw `store.match` and the terms read from its quads, never freed) over a tiny fixture store, and the shared
// constants (`PARENT_PRED`, `SIBLING_INDEX_PRED`, `XSD_*`) are shown to survive repeated use, since freeing one
// would make every later use throw.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Store, quad, namedNode } from 'oxigraph';
import {
  NODE_BASE,
  PARENT_PRED,
  SIBLING_INDEX_PRED,
  PARENT_FIELD,
  SIBLING_INDEX_FIELD,
  nodeIri,
  predIri,
  encodeLiteral,
  decodeLiteral,
  idFromNodeIri,
  fieldFromPredIri,
  nodeExists,
  nodeKindFromId,
} from '@aperas/core/apeironNgn/vocab';
import {
  objectsOf,
  subjectsWhere,
  firstSubjectWhere,
  firstLiteralOf,
  firstRefIriOf,
  countMatches,
  orderedChildIds,
  allSubjectIds,
  allObjectRefIds,
  addQuad,
  deleteMatches,
  type Obj,
  type ObjArg,
} from '@aperas/core/apeironNgn/storeAccess';
import { allIdsOfKind } from '@aperas/core/apeironNgn/dehydrate';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';
import { ingestLinkedDemo } from '../support/linkedDemo.ts';

// The former reads, kept here as the reference: raw quads, no `free()`.
const rawObj = (term: any): Obj => {
  if (term.termType === 'Literal') return { kind: 'literal', value: decodeLiteral(term), lexical: term.value };
  if (term.termType === 'NamedNode') return { kind: 'ref', iri: term.value };
  return { kind: 'other' };
};
const rawObjectsOf = (store: Store, id: string, field: string): Obj[] => store.match(nodeIri(id), predIri(field), null, null).map((m) => rawObj(m.object));
const rawOrderedChildIds = (store: Store, id: string): string[] => {
  const withIndex = store.match(null, PARENT_PRED, nodeIri(id), null).map((m) => {
    const childId = idFromNodeIri(String(m.subject.value));
    const idxMatches = store.match(nodeIri(childId), SIBLING_INDEX_PRED, null, null);
    const idx = idxMatches.length > 0 && idxMatches[0].object.termType === 'Literal' ? Number(idxMatches[0].object.value) : 0;
    return { childId, idx };
  });
  withIndex.sort((a, b) => a.idx - b.idx);
  return withIndex.map(({ childId }) => childId);
};

describe('store access helpers', () => {
  let fx: FixtureStore;
  // every (subject id, field, object) in the fixture store, from a raw scan
  let triples: { id: string; field: string; object: Obj; arg: ObjArg | null }[];
  before(() => {
    fx = makeFixtureStore('store_access_demo');
    ingestLinkedDemo(fx);
    triples = fx.store.match(null, null, null, null).map((q) => {
      const object = rawObj(q.object);
      const arg: ObjArg | null = object.kind === 'ref' ? { ref: idFromNodeIri(object.iri) } : object.kind === 'literal' ? { lit: object.value } : null;
      return { id: idFromNodeIri(String(q.subject.value)), field: fieldFromPredIri(q.predicate.value), object, arg };
    });
  });
  after(() => fx.cleanup());

  test('the fixture store is big enough to compare on', () => {
    assert.ok(triples.length > 100, `expected over 100 quads, got ${triples.length}`);
    assert.ok(triples.some((t) => t.field === PARENT_FIELD) && triples.some((t) => t.field === SIBLING_INDEX_FIELD), 'containment quads are present');
    assert.ok(triples.some((t) => t.object.kind === 'literal' && typeof t.object.value === 'number'), 'a numeric literal is present');
    assert.ok(triples.some((t) => t.object.kind === 'literal' && typeof t.object.value === 'boolean'), 'a boolean literal is present');
  });

  test('allSubjectIds, allIdsOfKind and allObjectRefIds give what the raw scan gives', () => {
    const rawSubjects = new Set<string>();
    const rawRefs = new Set<string>();
    for (const q of fx.store.match(null, null, null, null)) {
      if (q.subject.termType === 'NamedNode' && q.subject.value.startsWith(NODE_BASE)) rawSubjects.add(idFromNodeIri(q.subject.value));
      if (q.object.termType === 'NamedNode' && q.object.value.startsWith(NODE_BASE)) rawRefs.add(idFromNodeIri(q.object.value));
    }
    assert.deepEqual(allSubjectIds(fx.store), [...rawSubjects]);
    assert.deepEqual([...allObjectRefIds(fx.store)].sort(), [...rawRefs].sort());
    for (const kind of ['BlockNode', 'ArtifactNode', 'FolderNode', 'TreeView', 'Link', 'StringProp']) {
      assert.deepEqual(allIdsOfKind(fx.store, kind), [...rawSubjects].filter((id) => nodeKindFromId(id) === kind), kind);
    }
  });

  test('objectsOf, firstLiteralOf and firstRefIriOf give the objects of every subject and field', () => {
    const keys = new Set(triples.map((t) => `${t.id}\u0000${t.field}`));
    for (const key of keys) {
      const [id, field] = key.split('\u0000');
      const expected = rawObjectsOf(fx.store, id, field);
      const got = objectsOf(fx.store, id, field);
      assert.deepEqual(got, expected, `${id} ${field}`);
      const first = expected[0];
      assert.equal(firstLiteralOf(fx.store, id, field), first.kind === 'literal' ? first.value : undefined, `${id} ${field} first literal`);
      assert.equal(firstRefIriOf(fx.store, id, field), first.kind === 'ref' ? first.iri : undefined, `${id} ${field} first ref`);
    }
    assert.deepEqual(objectsOf(fx.store, 'BlockNode:NOSUCH', 'text'), []);
  });

  test('subjectsWhere, firstSubjectWhere and countMatches give the subjects and counts of every field and object', () => {
    const seen = new Set<string>();
    for (const t of triples) {
      if (!t.arg) continue;
      const key = `${t.field}\u0000${JSON.stringify(t.arg)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const objTerm = 'ref' in t.arg ? nodeIri(t.arg.ref) : encodeLiteral(t.arg.lit);
      const expected = fx.store.match(null, predIri(t.field), objTerm, null).map((m) => idFromNodeIri(String(m.subject.value)));
      assert.deepEqual(subjectsWhere(fx.store, t.field, t.arg), expected, key);
      assert.equal(firstSubjectWhere(fx.store, t.field, t.arg), expected[0] ?? null, `${key} first`);
      assert.equal(countMatches(fx.store, null, t.field, t.arg), expected.length, `${key} count`);
    }
    assert.ok(seen.size > 50, `compared ${seen.size} distinct (field, object) pairs`);
    assert.equal(firstSubjectWhere(fx.store, 'path', { lit: 'no/such/path.md' }), null);
    assert.equal(countMatches(fx.store, null, null, null), fx.store.size);
    assert.equal(countMatches(fx.store, 'BlockNode:NOSUCH', null, null), 0);
  });

  test('orderedChildIds gives the children in sibling order as before, and nodeExists agrees with the quads', () => {
    const parents = new Set(triples.filter((t) => t.field === PARENT_FIELD && t.object.kind === 'ref').map((t) => idFromNodeIri((t.object as { iri: string }).iri)));
    assert.ok(parents.size >= 3, `expected at least 3 parents, got ${parents.size}`);
    for (const id of parents) {
      const expected = rawOrderedChildIds(fx.store, id);
      assert.ok(expected.length > 0);
      assert.deepEqual(orderedChildIds(fx.store, id), expected, id);
    }
    assert.deepEqual(orderedChildIds(fx.store, 'BlockNode:NOSUCH'), []);
    for (const id of [...parents].slice(0, 5)) assert.equal(nodeExists(fx.store, id), true);
    assert.equal(nodeExists(fx.store, 'BlockNode:NOSUCH'), false);
  });

  test('the reads return plain values: no wasm object leaves a helper', () => {
    const [anyParent] = triples.filter((t) => t.field === PARENT_FIELD);
    const rows: unknown[] = [
      objectsOf(fx.store, anyParent.id, PARENT_FIELD),
      objectsOf(fx.store, anyParent.id, SIBLING_INDEX_FIELD),
      subjectsWhere(fx.store, PARENT_FIELD, anyParent.arg!),
      orderedChildIds(fx.store, idFromNodeIri((anyParent.object as { iri: string }).iri)),
      allSubjectIds(fx.store).slice(0, 5),
    ];
    const walk = (v: unknown): void => {
      if (v === null || typeof v !== 'object') return;
      assert.ok(Object.getPrototypeOf(v) === Object.prototype || Array.isArray(v), `a plain object or array, got ${v?.constructor?.name}`);
      for (const x of Object.values(v)) walk(x);
    };
    rows.forEach(walk);
  });

  test('the writes: addQuad, deleteMatches and countMatches on a scratch store', () => {
    const store = new Store();
    addQuad(store, 'BlockNode:A', 'text', { lit: 'hello' });
    addQuad(store, 'BlockNode:A', 'count', { lit: 7 });
    addQuad(store, 'BlockNode:A', 'flag', { lit: true });
    addQuad(store, 'BlockNode:A', 'unfolds', { ref: 'BlockNode:B' });
    addQuad(store, 'BlockNode:B', PARENT_FIELD, { ref: 'BlockNode:A' });
    addQuad(store, 'BlockNode:B', SIBLING_INDEX_FIELD, { lit: 0 });
    assert.equal(store.size, 6);
    // the quads are those the former form made: same terms, same datatypes
    assert.ok(store.has(quadOf('BlockNode:A', 'text', 'hello')));
    assert.deepEqual(objectsOf(store, 'BlockNode:A', 'count'), [{ kind: 'literal', value: 7, lexical: '7' }]);
    assert.deepEqual(objectsOf(store, 'BlockNode:A', 'flag'), [{ kind: 'literal', value: true, lexical: 'true' }]);
    assert.deepEqual(objectsOf(store, 'BlockNode:A', 'unfolds'), [{ kind: 'ref', iri: NODE_BASE + 'BlockNode:B' }]);
    assert.equal(countMatches(store, 'BlockNode:A', null, null), 4);
    assert.equal(deleteMatches(store, null, 'unfolds', { ref: 'BlockNode:B' }), 1);
    assert.equal(deleteMatches(store, 'BlockNode:B', SIBLING_INDEX_FIELD, null), 1);
    assert.equal(deleteMatches(store, 'BlockNode:B', PARENT_FIELD, { ref: 'BlockNode:A' }), 1);
    assert.equal(deleteMatches(store, 'BlockNode:A', null, null), 3);
    assert.equal(store.size, 0);
    assert.equal(deleteMatches(store, 'BlockNode:A', null, null), 0);
  });

  test('a write that adds the same quad twice leaves one quad, and the store stays usable', () => {
    const store = new Store();
    for (let i = 0; i < 3; i++) addQuad(store, 'BlockNode:C', 'text', { lit: 'same' });
    assert.equal(store.size, 1);
    assert.equal(countMatches(store, 'BlockNode:C', 'text', { lit: 'same' }), 1);
  });

  test('the shared constants survive repeated use of the helpers', () => {
    const store = new Store();
    for (let i = 0; i < 300; i++) {
      const id = `BlockNode:${i}`;
      addQuad(store, id, PARENT_FIELD, { ref: 'BlockNode:P' });
      addQuad(store, id, SIBLING_INDEX_FIELD, { lit: i });
      addQuad(store, id, 'flag', { lit: i % 2 === 0 });
    }
    assert.equal(orderedChildIds(store, 'BlockNode:P').length, 300);
    assert.equal(deleteMatches(store, 'BlockNode:5', PARENT_FIELD, null), 1);
    assert.equal(countMatches(store, null, PARENT_FIELD, { ref: 'BlockNode:P' }), 299);
    for (let i = 0; i < 50; i++) assert.equal(allSubjectIds(store).length, 300);
    // each shared constant still reads and still matches
    assert.equal(PARENT_PRED.value, 'urn:aperas:pred:parent');
    assert.equal(SIBLING_INDEX_PRED.value, 'urn:aperas:pred:__siblingIndex');
    assert.equal(store.match(null, PARENT_PRED, null, null).length, 299);
    assert.equal(store.match(null, SIBLING_INDEX_PRED, null, null).length, 300);
    assert.equal(encodeLiteral(3).datatype.value, 'http://www.w3.org/2001/XMLSchema#integer');
    assert.equal(encodeLiteral(true).datatype.value, 'http://www.w3.org/2001/XMLSchema#boolean');
    // and the typed values still round-trip through the stored quads
    assert.deepEqual(objectsOf(store, 'BlockNode:10', 'flag'), [{ kind: 'literal', value: true, lexical: 'true' }]);
    assert.deepEqual(objectsOf(store, 'BlockNode:11', SIBLING_INDEX_FIELD), [{ kind: 'literal', value: 11, lexical: '11' }]);
  });

  test('a read that throws on a foreign subject still leaves the store usable', () => {
    const store = new Store();
    for (let i = 0; i < 5; i++) addQuad(store, `BlockNode:${i}`, 'text', { lit: 'x' });
    store.add(quad(namedNode('http://example.org/foreign'), predIri('text'), encodeLiteral('x')));
    // `subjectsWhere` throws for a subject that is not a node IRI, as `idFromNodeIri` always has
    assert.throws(() => subjectsWhere(store, 'text', { lit: 'x' }), /Not an ApeironNgn node IRI/);
    assert.equal(countMatches(store, null, 'text', { lit: 'x' }), 6);
    assert.equal(deleteMatches(store, null, 'text', { lit: 'x' }), 6);
    assert.equal(store.size, 0);
  });
});

function quadOf(id: string, field: string, text: string) {
  return quad(nodeIri(id), predIri(field), encodeLiteral(text));
}
