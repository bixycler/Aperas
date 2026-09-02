/**
 * ApeironNgn IRI/literal vocabulary — one place that decides how a plain JS id/value round-trips
 * to/from an Oxigraph term. See Aperas-apeironngn-design.md §3.
 */

import { namedNode, literal, type NamedNode, type Literal, type Term } from 'oxigraph';

const NODE_BASE = 'urn:aperas:node:';
const PRED_BASE = 'urn:aperas:pred:';

const XSD_INTEGER = namedNode('http://www.w3.org/2001/XMLSchema#integer');
const XSD_BOOLEAN = namedNode('http://www.w3.org/2001/XMLSchema#boolean');

/** Every top-level-addressable concrete class whose instances carry an `@id` shaped
 *  `ClassName/snowflake` — the same set `nodeRef.ts`'s `FULL_NODE_ID_RE` recognizes. `Link`/
 *  `StringProp` are deliberately excluded: both are subdocuments now (`shape.ts`'s
 *  `storageKind: 'embed'`), minted as `${parentId}/(props|links)/ClassName/<snowflake>` — they
 *  never appear as a bare top-level reference string, only nested (`SUBDOC_RE` below catches
 *  them). Used to tell a reference-shaped string value from an ordinary literal. */
const ID_PREFIX_RE = /^(BlockNode|ArtifactNode|FolderNode)\//;

export function isNodeRef(value: unknown): value is string {
  return typeof value === 'string' && ID_PREFIX_RE.test(value);
}

/** The concrete class name from an id's own prefix — the one dispatch point `node.ts`'s
 *  `CLASS_BY_KIND` and `shape.ts`'s `SHAPE_BY_KIND` are keyed by. Keyed directly off the id scheme
 *  `snowflake.ts` already mints ids by, not a separately-maintained mapping that can drift.
 *  A subdocument id (`props`' `StringProp` entries, `links`' `Link` entries) is shaped
 *  `${parentId}/(props|links)/ClassName/<snowflake>` — the *owning* node's own class prefix leads
 *  the string, so it has to be checked before the plain leading-prefix case, not after, or a
 *  subdocument id would misclassify as whatever class its parent happens to be. */
const SUBDOC_RE = /\/(?:props|links)\/([A-Za-z]+)\//;
const KIND_RE = /^(BlockNode|ArtifactNode|FolderNode)\//;
export function nodeKindFromId(id: string): string {
  const subMatch = id.match(SUBDOC_RE);
  if (subMatch) return subMatch[1];
  const m = id.match(KIND_RE);
  return m ? m[1] : 'Unknown';
}

export function nodeIri(id: string): NamedNode {
  return namedNode(NODE_BASE + id);
}

/** Whether any quad at all names `id` as its subject — the generic "does this node exist in the
 *  store" check every write path needs before mutating (`getDocument` returning `null` under
 *  TerminusDB's equivalent). */
export function nodeExists(store: import('oxigraph').Store, id: string): boolean {
  return store.match(nodeIri(id), null, null, null).length > 0;
}

export function idFromNodeIri(iri: string): string {
  if (!iri.startsWith(NODE_BASE)) throw new Error(`Not an ApeironNgn node IRI: ${iri}`);
  return iri.slice(NODE_BASE.length);
}

export function predIri(field: string): NamedNode {
  return namedNode(PRED_BASE + field);
}

export function fieldFromPredIri(iri: string): string {
  if (!iri.startsWith(PRED_BASE)) throw new Error(`Not an ApeironNgn predicate IRI: ${iri}`);
  return iri.slice(PRED_BASE.length);
}

/** Encodes a scalar (string/number/boolean) as a typed Literal — the datatype is what lets
 *  `decodeLiteral` hand back the same JS type it was given, not just a string.
 *
 *  ISO-8601 date strings (lastTrackedAt/lastIngestedAt/tombstonedAt) are deliberately *not* given
 *  an `xsd:dateTime` datatype, despite looking like an obvious fit — Oxigraph canonicalizes typed
 *  literals against their datatype's value space, live-verified to silently rewrite
 *  `"...23:02:27.480Z"` to `"...23:02:27.48Z"` (a real string, byte-for-byte, not just a display
 *  quirk) on read-back. That's a real data-fidelity bug for anything dehydrated back to JSON-LD,
 *  for a distinction (typed vs. plain string) nothing here actually relies on — dates stay plain
 *  string literals, exactly like `title`/`path`/any other string field. */
export function encodeLiteral(value: string | number | boolean): Literal {
  if (typeof value === 'number') return literal(String(value), XSD_INTEGER);
  if (typeof value === 'boolean') return literal(String(value), XSD_BOOLEAN);
  return literal(value);
}

export function decodeLiteral(term: Literal): string | number | boolean {
  const dt = term.datatype?.value;
  if (dt === XSD_INTEGER.value) return Number(term.value);
  if (dt === XSD_BOOLEAN.value) return term.value === 'true';
  return term.value;
}

export function isLiteralTerm(term: Term): term is Literal {
  return term.termType === 'Literal';
}

export function isNamedNodeTerm(term: Term): term is NamedNode {
  return term.termType === 'NamedNode';
}

/** The one field name needing reified ordered-containment (Aperas-apeironngn-design.md §3):
 *  `BlockNode.children`/`FolderNode.children` are the only `List`-typed fields in the current
 *  ontology (`schema.json`'s stale copy also lists `ArtifactNode.root`, `BlockNode.parent`, etc.
 *  as `Optional` — single-valued, not containment — so they're plain reference triples, not
 *  reified). Deliberately name-keyed rather than parsed from `schema.json`: that file has already
 *  been observed to drift from the live schema (`ordered`/`start` fields present in real data,
 *  absent from the checked-in copy) — ApeironNgn's own encoder shouldn't inherit that staleness
 *  risk by depending on it. */
export const ORDERED_CONTAINMENT_FIELD = 'children';
export const PARENT_PRED = predIri('__parent');
export const SIBLING_INDEX_PRED = predIri('__siblingIndex');
