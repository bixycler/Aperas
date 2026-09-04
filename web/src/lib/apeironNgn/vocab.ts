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
 *  them). Used to tell a reference-shaped string value from an ordinary literal. `Profile`/
 *  `TreeView` (Aperas-treeview-design.md) are top-level like `BlockNode`/`ArtifactNode`/
 *  `FolderNode` — un-suffixed naming matching `Link`/`StringProp` since neither is a `TreeNode`
 *  subclass, but still its own addressable id, not a subdocument. */
const ID_PREFIX_RE = /^(BlockNode|ArtifactNode|FolderNode|Profile|TreeView)\//;

export function isNodeRef(value: unknown): value is string {
  return typeof value === 'string' && ID_PREFIX_RE.test(value);
}

/** The concrete class name from an id's own prefix — the one dispatch point `node.ts`'s
 *  `CLASS_BY_KIND` and `shape.ts`'s `SHAPE_BY_KIND` are keyed by. Keyed directly off the id scheme
 *  `snowflake.ts` already mints ids by, not a separately-maintained mapping that can drift.
 *  A subdocument id (`props`' `StringProp` entries, `links`' `Link` entries) is shaped
 *  `${parentId}/(props|links)/ClassName/<snowflake>` — the *owning* node's own class prefix leads
 *  the string, so it has to be checked before the plain leading-prefix case, not after, or a
 *  subdocument id would misclassify as whatever class its parent happens to be.
 *
 *  Matched globally, taking the *last* occurrence, not the first — `Link` gaining its own `props`
 *  (Aperas-apeironngn-design.md §4 Step 8) means a subdocument can now nest inside another
 *  subdocument (`.../links/Link/<snowflake>/props/StringProp/<snowflake>`), the first time that's
 *  ever happened. A non-global, first-match regex would find the *outer* `/links/Link/` segment
 *  and misclassify the innermost `StringProp` as a `Link` — confirmed live: exactly this bug, a
 *  `Link.props` entry silently wrapping as a second `Link` instead of a `StringProp`, `.key`/
 *  `.value` reading back as `undefined` even though the quads themselves were written correctly.
 *  The deepest (rightmost) segment is always the id's real, immediate kind, regardless of how
 *  many subdocument levels precede it. */
const SUBDOC_RE = /\/(?:props|links)\/([A-Za-z]+)\//g;
const KIND_RE = /^(BlockNode|ArtifactNode|FolderNode|Profile|TreeView)\//;
export function nodeKindFromId(id: string): string {
  const subMatches = [...id.matchAll(SUBDOC_RE)];
  if (subMatches.length > 0) return subMatches[subMatches.length - 1][1];
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
 *  `BlockNode.children` (inherited by `ArtifactNode`/`FolderNode` too) is the only `List`-typed
 *  field in the current ontology (`schema.json`'s stale copy also lists `BlockNode.parent`,
 *  `ArtifactNode.path`, etc. as `Optional` — single-valued, not containment — so they're plain
 *  reference/literal triples, not reified). Deliberately name-keyed rather than parsed from
 *  `schema.json`: that file has already
 *  been observed to drift from the live schema (`ordered`/`start` fields present in real data,
 *  absent from the checked-in copy) — ApeironNgn's own encoder shouldn't inherit that staleness
 *  risk by depending on it. */
export const ORDERED_CONTAINMENT_FIELD = 'children';
/** Deliberately the *same* IRI `predIri('parent')` produces for `TreeNode.parent`'s own generic
 *  accessor — not a private `__parent` any more (Aperas-apeironngn-design.md §5): `TreeNode.parent`
 *  and "who reverse-queries to me as their container" used to be two independently-written quads
 *  recording the identical fact (confirmed live: every write site set both, always in sync by
 *  convention, never by construction) — real redundancy, not two different facts, so merged into
 *  one. `orderedContainment`'s reification (`writeField`, below) is now the *sole* writer: setting
 *  `.children` on a container writes this predicate (plus `SIBLING_INDEX_PRED`) on each entry, and
 *  reading it back via `.parent` is an ordinary field read, same as any other `optional` reference
 *  field. Consequence worth knowing: because the predicate is shared, an ordinary `someNode.parent =
 *  x` write (the generic field setter, not the containment path) *would* make `x`'s own `.children`
 *  include `someNode` too — reading that predicate is what `.children` does — but with no
 *  `SIBLING_INDEX_PRED` recorded, landing it at sort-index 0 among `x`'s other children. Nothing
 *  after this merge ever assigns `.parent` directly any more (every write site went through
 *  `.children`/`appendChild` already) — but if that ever changes, go through containment, not a
 *  direct `.parent =` assignment. */
export const PARENT_PRED = predIri('parent');
export const SIBLING_INDEX_PRED = predIri('__siblingIndex');
