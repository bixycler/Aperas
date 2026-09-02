/**
 * ApeironNgn's `a.b.c` prop-access interface (Aperas-apeironngn-design.md §3 "Schema = class").
 *
 * `wrap(store, id)` dispatches to the right concrete class (`classes.ts`'s `CLASS_BY_KIND`, keyed
 * off the id's own prefix) and returns a `Proxy` over an instance of it. The `get`/`set` traps
 * read/write through that class's own `static SHAPE` (`shape.ts`) — not match-count inference —
 * so a `Set`-typed field with exactly one value stays a one-element array, and an assignment
 * validates against the field's declared cardinality/storage-kind before touching the `Store`.
 *
 * A note on "lazy," now that the engine is real rather than hypothetical: the design's caveat
 * about needing `valueOf`/`Symbol.toPrimitive`-style deferred forcing was framed against a
 * still-open question of whether Oxigraph's Node binding would be sync or async. It's confirmed
 * sync (`oxigraph` skill) — there's no I/O gap for a Promise-like wrapper to hide, so no such
 * wrapper exists here. The laziness that actually matters survives anyway, at the right
 * granularity: wrapping a neighbor as a Node proxy touches only the one triple needed to name it —
 * none of *its* other fields are read until something actually asks for them.
 */

import type { Store, Quad } from 'oxigraph';
import { quad } from 'oxigraph';
import { generateNodeId } from '../snowflake';
import {
  nodeIri,
  idFromNodeIri,
  predIri,
  encodeLiteral,
  decodeLiteral,
  isLiteralTerm,
  isNamedNodeTerm,
  PARENT_PRED,
  SIBLING_INDEX_PRED,
} from './vocab';
import { classForId, type ApeironInstance } from './classes';
import { SHAPE_BY_KIND, type FieldSpec } from './shape';

export interface ApeironNode {
  /** Escape hatch: the raw node id (e.g. `"BlockNode/00C..."`), never proxied further. */
  readonly id: string;
  /** Reified containment (Aperas-apeironngn-design.md §3): reverse-queries the `parent` index,
   *  sorted by `siblingIndex`. Each returned child is itself a fresh, unmaterialized Node — only
   *  `parent`/`siblingIndex` were read to produce this list. */
  readonly children: ApeironNode[];
  [field: string]: unknown;
}

function childrenOf(store: Store, id: string): ApeironNode[] {
  const parentMatches = store.match(null, PARENT_PRED, nodeIri(id), null);
  const withIndex = parentMatches.map((m) => {
    const childId = idFromNodeIri(String(m.subject.value));
    const idxMatches = store.match(nodeIri(childId), SIBLING_INDEX_PRED, null, null);
    const idx = idxMatches.length > 0 && isLiteralTerm(idxMatches[0].object) ? Number(idxMatches[0].object.value) : 0;
    return { childId, idx };
  });
  withIndex.sort((a, b) => a.idx - b.idx);
  return withIndex.map(({ childId }) => wrap(store, childId));
}

function decodeTerm(store: Store, m: Quad): unknown {
  const obj = m.object;
  if (isLiteralTerm(obj)) return decodeLiteral(obj);
  if (isNamedNodeTerm(obj)) return wrap(store, idFromNodeIri(obj.value));
  return undefined;
}

function readField(store: Store, id: string, field: string, spec: FieldSpec): unknown {
  if (spec.cardinality === 'orderedContainment') return childrenOf(store, id);
  const matches = store.match(nodeIri(id), predIri(field), null, null);
  if (spec.cardinality === 'set') return matches.map((m) => decodeTerm(store, m));
  if (matches.length === 0) return undefined;
  return decodeTerm(store, matches[0]);
}

/** Any of: a raw id string, an `ApeironNode` (reads `.id`), or a plain object already carrying
 *  `@id`/`id` (e.g. from a freshly-parsed JSON-LD literal) — the shapes a caller might reasonably
 *  hand to a `reference`-kind field. */
function idOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeof v.id === 'string') return v.id;
    if (typeof v['@id'] === 'string') return v['@id'] as string;
  }
  throw new Error(`ApeironNgn: can't resolve a node reference from ${JSON.stringify(value)}`);
}

function clearField(store: Store, id: string, field: string): void {
  for (const m of store.match(nodeIri(id), predIri(field), null, null)) store.delete(m);
}

/** Mints a fresh embedded subdocument (only `StringProp` exists today) and writes its own
 *  literal fields as quads on its own new id — `${parentId}/props/${type}/<snowflake>` mirrors the
 *  shape historically seen from TerminusDB's own subdocument id generation, though ApeironNgn owns
 *  this convention itself now, not TerminusDB. */
function mintEmbedded(store: Store, parentId: string, entry: Record<string, unknown>): string {
  const type = (entry['@type'] as string) ?? 'StringProp';
  const newId = `${parentId}/props/${type}/${generateNodeId()}`;
  const shape = SHAPE_BY_KIND[type];
  if (!shape) throw new Error(`ApeironNgn: no shape declared for embedded type '${type}'`);
  for (const [k, v] of Object.entries(entry)) {
    if (k === '@type' || k === '@id' || k === 'id') continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      store.add(quad(nodeIri(newId), predIri(k), encodeLiteral(v)));
    }
  }
  return newId;
}

function writeField(store: Store, id: string, field: string, spec: FieldSpec, value: unknown): void {
  if (spec.cardinality === 'orderedContainment') {
    if (!Array.isArray(value)) throw new Error(`ApeironNgn: '${field}' is ordered containment — expected an array.`);
    // Detach every current child first (both the parent/index quads live on the child's own id).
    for (const m of store.match(null, PARENT_PRED, nodeIri(id), null)) {
      const childId = String(m.subject.value);
      store.delete(m);
      for (const idxQuad of store.match(nodeIri(idFromNodeIri(childId)), SIBLING_INDEX_PRED, null, null)) {
        store.delete(idxQuad);
      }
    }
    value.forEach((entry, index) => {
      const childId = idOf(entry);
      store.add(quad(nodeIri(childId), PARENT_PRED, nodeIri(id)));
      store.add(quad(nodeIri(childId), SIBLING_INDEX_PRED, encodeLiteral(index)));
    });
    return;
  }

  clearField(store, id, field);

  if (value === null || value === undefined) {
    if (spec.cardinality === 'one') throw new Error(`ApeironNgn: '${field}' is required — can't clear it.`);
    return;
  }

  const storageKind = spec.storageKind ?? 'literal';
  const writeOne = (entry: unknown) => {
    if (storageKind === 'literal') {
      if (typeof entry !== 'string' && typeof entry !== 'number' && typeof entry !== 'boolean') {
        throw new Error(`ApeironNgn: '${field}' expects a literal value, got ${JSON.stringify(entry)}`);
      }
      store.add(quad(nodeIri(id), predIri(field), encodeLiteral(entry)));
    } else if (storageKind === 'reference') {
      const refId = typeof entry === 'string' || (entry && typeof entry === 'object' && !('@type' in (entry as object)))
        ? idOf(entry)
        : mintEmbedded(store, id, entry as Record<string, unknown>); // a fresh literal object for a reference field (e.g. a new Link)
      store.add(quad(nodeIri(id), predIri(field), nodeIri(refId)));
    } else {
      // embed
      const refId = entry && typeof entry === 'object' && ((entry as any)['@id'] || (entry as any).id)
        ? idOf(entry)
        : mintEmbedded(store, id, entry as Record<string, unknown>);
      store.add(quad(nodeIri(id), predIri(field), nodeIri(refId)));
    }
  };

  if (spec.cardinality === 'set') {
    if (!Array.isArray(value)) throw new Error(`ApeironNgn: '${field}' is a Set — expected an array, got ${JSON.stringify(value)}`);
    for (const entry of value) writeOne(entry);
  } else {
    writeOne(value);
  }
}

/** Wraps one node id as a lazy `a.b.c`-navigable, shape-enforced proxy over `store`. */
export function wrap(store: Store, id: string): ApeironNode {
  const Cls = classForId(id);
  const instance = new Cls(store, id) as ApeironInstance;
  return new Proxy(instance, {
    get(target, prop) {
      if (prop === 'id') return id;
      if (typeof prop !== 'string') return undefined;
      const spec = (target.constructor as typeof Cls).SHAPE[prop];
      if (!spec) return undefined; // unknown field: exploratory read, not relied on for anything round-tripped
      return readField(store, id, prop, spec);
    },
    set(target, prop, value) {
      if (typeof prop !== 'string') return false;
      const spec = (target.constructor as typeof Cls).SHAPE[prop];
      if (!spec) throw new Error(`ApeironNgn: '${prop}' isn't a declared field on ${target.constructor.name}.`);
      writeField(store, id, prop, spec, value);
      return true;
    },
  }) as unknown as ApeironNode;
}

/** The general backlink pattern (Aperas-kg-foundational-design.md §3.2): every subject with
 *  `field` pointing at this node, regardless of whether `field` is reified containment or a plain
 *  reference — the one query shape `parentId`/`resolveIdToPath`'s reverse-lookup gap under
 *  TerminusDB had no equivalent for. */
export function backlinks(store: Store, id: string, field: string): ApeironNode[] {
  return store.match(null, predIri(field), nodeIri(id), null).map((m) => wrap(store, idFromNodeIri(String(m.subject.value))));
}
