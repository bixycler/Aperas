/**
 * ApeironNgn store access — the one place that reads and writes the Oxigraph `Store` and owns every
 * wasm object it creates.
 *
 * Every `Quad`, `NamedNode`, `Literal` and `Term` Oxigraph hands to JS is a wasm-bindgen class
 * holding a pointer into wasm linear memory; the JS garbage collector frees it only some time after
 * it is unreachable (through a `FinalizationRegistry`), and wasm linear memory only grows. A full
 * scan makes one such object per quad and per term read from it, so the unfreed ones are what made
 * the process grow by tens of megabytes per scan. The helpers here take plain strings, return plain
 * values (strings, numbers, booleans, rows of strings) and call `free()` on every object they
 * create, as soon as its value has been copied out.
 *
 * Two rules the callers rely on:
 *  - No wasm object leaves a helper: callers never hold, and so never free, a quad or a term.
 *  - A shared constant is never freed: `PARENT_PRED`, `SIBLING_INDEX_PRED`, `XSD_INTEGER` and
 *    `XSD_BOOLEAN` (`vocab.ts`) and the predicates cached here live for the process; freeing one
 *    makes every later use throw. A term is freed only if this module created it for the call.
 *
 * Fields are named by their plain field name (`'parent'`, `'path'`); the helpers build the IRIs.
 */

import { quad, type Quad, type Store, type NamedNode, type Literal } from 'oxigraph';
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
  isLiteralTerm,
  isNamedNodeTerm,
  freeWasm,
} from './vocab';

// ---------------------------------------------------------------------------------------------
// Freeing, and the predicate cache
// ---------------------------------------------------------------------------------------------

const free = freeWasm;

/** One predicate term per field name, made on first use and kept for the process (never freed). The
 *  set of field names is bounded by the schema (`SHAPE_BY_KIND`), so the cache is bounded too. It is
 *  seeded with the two shared constants so the same wasm object serves `parent`/`__siblingIndex`. */
const PRED_CACHE = new Map<string, NamedNode>([
  [PARENT_FIELD, PARENT_PRED],
  [SIBLING_INDEX_FIELD, SIBLING_INDEX_PRED],
]);

function cachedPred(field: string): NamedNode {
  let p = PRED_CACHE.get(field);
  if (!p) {
    p = predIri(field);
    PRED_CACHE.set(field, p);
  }
  return p;
}

// ---------------------------------------------------------------------------------------------
// Arguments and plain results
// ---------------------------------------------------------------------------------------------

/** The object of a quad to match or write: a reference to a node by id, or a literal value. */
export type ObjArg = { ref: string } | { lit: string | number | boolean };

/** What an object term is, as plain values. `iri` is the full IRI (`idFromNodeIri` gives the id and
 *  throws for a non-node IRI, as the former code did); `value` is `decodeLiteral`'s typed result and
 *  `lexical` the literal's own text. */
export type Obj =
  | { kind: 'ref'; iri: string }
  | { kind: 'literal'; value: string | number | boolean; lexical: string }
  | { kind: 'other' };

function objTerm(o: ObjArg): NamedNode | Literal {
  return 'ref' in o ? nodeIri(o.ref) : encodeLiteral(o.lit);
}

/** Runs `fn` over the quads matching the given subject id, field and object (each `null` for any),
 *  then frees every quad and every term this call created. `fn` must copy out what it needs: its quad
 *  is freed right after it returns, and so is anything it read from the quad. If `fn` throws, the
 *  quads not yet visited are freed too. */
function eachMatch(store: Store, subject: string | null, field: string | null, object: ObjArg | null, fn: (q: Quad) => void): void {
  const s = subject === null ? null : nodeIri(subject);
  const o = object === null ? null : objTerm(object);
  let quads: Quad[] = [];
  let i = 0;
  try {
    quads = store.match(s, field === null ? null : cachedPred(field), o, null);
    for (; i < quads.length; i++) {
      try {
        fn(quads[i]);
      } finally {
        free(quads[i]);
      }
    }
  } finally {
    for (i += 1; i < quads.length; i++) free(quads[i]);
    free(s);
    free(o);
  }
}

/** The plain form of a quad's object, freeing the terms read from it. */
function readObj(q: Quad): Obj {
  const t = q.object;
  try {
    if (isLiteralTerm(t)) return { kind: 'literal', value: decodeLiteral(t), lexical: t.value };
    if (isNamedNodeTerm(t)) return { kind: 'ref', iri: t.value };
    return { kind: 'other' };
  } finally {
    free(t);
  }
}

/** The value of a quad's subject, freeing the term. `null` unless it is a named node. */
function readSubjectIri(q: Quad): string | null {
  const t = q.subject;
  try {
    return isNamedNodeTerm(t) ? t.value : null;
  } finally {
    free(t);
  }
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

/** Every object of `subject`'s `field`, in the store's match order. */
export function objectsOf(store: Store, subject: string, field: string): Obj[] {
  const out: Obj[] = [];
  eachMatch(store, subject, field, null, (q) => out.push(readObj(q)));
  return out;
}

/** The ids of every subject whose `field` is `object`, in the store's match order. Throws, as
 *  `idFromNodeIri` does, for a subject that is not a node IRI. */
export function subjectsWhere(store: Store, field: string, object: ObjArg): string[] {
  const out: string[] = [];
  eachMatch(store, null, field, object, (q) => {
    const t = q.subject;
    try {
      out.push(idFromNodeIri(String(t.value)));
    } finally {
      free(t);
    }
  });
  return out;
}

/** The id of the first subject whose `field` is `object`, or `null` when none is a named node. */
export function firstSubjectWhere(store: Store, field: string, object: ObjArg): string | null {
  let found: string | null = null;
  eachMatch(store, null, field, object, (q) => {
    if (found !== null) return;
    const iri = readSubjectIri(q);
    if (iri !== null) found = idFromNodeIri(iri);
  });
  return found;
}

/** How many quads match; the subject, field and object are each `null` for any. */
export function countMatches(store: Store, subject: string | null, field: string | null, object: ObjArg | null): number {
  let n = 0;
  eachMatch(store, subject, field, object, () => {
    n += 1;
  });
  return n;
}

/** The first object of `subject`'s `field` if it is a literal, as its typed value; else `undefined`. */
export function firstLiteralOf(store: Store, subject: string, field: string): string | number | boolean | undefined {
  const first = objectsOf(store, subject, field)[0];
  return first && first.kind === 'literal' ? first.value : undefined;
}

/** The first object of `subject`'s `field` if it is a node reference, as the full IRI; else `undefined`. */
export function firstRefIriOf(store: Store, subject: string, field: string): string | undefined {
  const first = objectsOf(store, subject, field)[0];
  return first && first.kind === 'ref' ? first.iri : undefined;
}

/** Child ids of `parentId`, sorted by `siblingIndex` (reified containment, `vocab.ts`'s
 *  `PARENT_PRED`). A child with no literal index sorts at 0. */
export function orderedChildIds(store: Store, parentId: string): string[] {
  const withIndex = subjectsWhere(store, PARENT_FIELD, { ref: parentId }).map((childId) => {
    const first = objectsOf(store, childId, SIBLING_INDEX_FIELD)[0];
    const idx = first && first.kind === 'literal' ? Number(first.lexical) : 0;
    return { childId, idx };
  });
  withIndex.sort((a, b) => a.idx - b.idx);
  return withIndex.map(({ childId }) => childId);
}

/** Every distinct subject id of a node IRI in the store, in first-seen order: one scan of all quads. */
export function allSubjectIds(store: Store): string[] {
  const ids = new Set<string>();
  eachMatch(store, null, null, null, (q) => {
    const iri = readSubjectIri(q);
    if (iri !== null && iri.startsWith(NODE_BASE)) ids.add(iri.slice(NODE_BASE.length));
  });
  return [...ids];
}

/** Every distinct node id that appears as the object of some quad: one scan of all quads. */
export function allObjectRefIds(store: Store): Set<string> {
  const ids = new Set<string>();
  eachMatch(store, null, null, null, (q) => {
    const t = q.object;
    try {
      if (t.termType === 'NamedNode' && t.value.startsWith(NODE_BASE)) ids.add(t.value.slice(NODE_BASE.length));
    } finally {
      free(t);
    }
  });
  return ids;
}

// ---------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------

/** Deletes every quad matching the subject id, field and object (each `null` for any), freeing each
 *  quad after its delete (a freed quad cannot be deleted). Returns the number deleted. */
export function deleteMatches(store: Store, subject: string | null, field: string | null, object: ObjArg | null): number {
  let n = 0;
  eachMatch(store, subject, field, object, (q) => {
    store.delete(q);
    n += 1;
  });
  return n;
}

/** Adds one quad of subject id, field and object, freeing the quad and the terms made for it. */
export function addQuad(store: Store, subject: string, field: string, object: ObjArg): void {
  const s = nodeIri(subject);
  const o = objTerm(object);
  let q: Quad | undefined;
  try {
    q = quad(s, cachedPred(field), o);
    store.add(q);
  } finally {
    free(q);
    free(s);
    free(o);
  }
}
