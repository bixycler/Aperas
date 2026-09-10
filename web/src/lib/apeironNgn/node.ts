/**
 * ApeironNgn's class hierarchy and `a.b.c` prop-access interface (Aperas-apeironngn-design.md §3
 * "Schema = class", §4 rollout step 3: real accessors + a real inheritance tree, folding migrated
 * functions onto the classes they belong to).
 *
 * Real `extends`, one level per genuinely shared shape:
 *   ApeironInstance (store/id only)
 *     -> BaseNode (links/props/tombstonedAt/holder)
 *          -> TreeNode (title/text/key — every tree-positioned kind)
 *               -> BlockNode (type/parent/children) -> ArtifactNode (merged with its own root
 *                    content — same fields and methods, unmodified, not a separate wrapper)
 *               -> FolderNode (deliberately not a BlockNode — never merged with anything, own
 *                    independent `path`/`children`; see `shape.ts`'s own doc comment for why)
 *   ApeironInstance -> Link, ApeironInstance -> StringProp   (leaf subdocs, data only)
 *   ApeironInstance -> Profile, ApeironInstance -> TreeView  (Aperas-treeview-design.md — an i-view
 *     over the TreeNode/Link graph; `unfolded`'s old per-node flag moved into `TreeView.unfolds`)
 *
 * `wrap(store, id)` dispatches to the right concrete class (`CLASS_BY_KIND`, keyed off the id's own
 * prefix via `vocab.ts`'s `nodeKindFromId`) and returns a real, `Object.seal`ed instance of it —
 * no `Proxy`. Each leaf class's fields are real `get`/`set` accessor properties, generated once
 * per class at module load from its own flattened `SHAPE` (`shape.ts`), calling the shared
 * `readField`/`writeField` helpers below. `Object.seal` is what preserves "an unknown field read
 * returns `undefined`, an unknown field write throws" without any trap logic: a sealed instance
 * rejects a brand-new own-property in strict mode (a real `TypeError`, not `node.ts`'s old custom
 * message — an internal-invariant check a script author would hit while developing, not a
 * documented CLI-facing contract, so accepted as a trade rather than preserved byte-for-byte).
 */

import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
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
  nodeKindFromId,
  nodeExists,
  PARENT_PRED,
  SIBLING_INDEX_PRED,
} from './vocab';
import { SHAPE_BY_KIND, type FieldSpec, type ClassShape, BLOCK_NODE_SHAPE, ARTIFACT_NODE_SHAPE, FOLDER_NODE_SHAPE, LINK_SHAPE, PROP_SHAPE, PROFILE_SHAPE, TREE_VIEW_SHAPE } from './shape';
import { allIdsOfKind } from './dehydrate';
import { displayLabel, type TreeOptions } from './tree';
import { slugify } from '../nodeRef';
import { parseMarkdownTree, extractAbstract, truncateForPreview, truncateForPreviewWithHint, WIKILINK_PREDICATE, extractLangFromFrontmatter, extractAnchorNames, HEADING_TREE_ANCHOR_PROP, type ParsedBlockNode, type DocLang } from '../astParser';
import { reconcileTree, type ReconciliationStats } from '../reconcile';
import { getArtifactsDir, computeFileHash, countBlocks, extractLinkCodes, type PendingLinkCodes } from '../artifacts';
import { serializeBlock, renderChildren, withFrontmatter } from '../project';
import { carryForwardProp, getProp, getProps, type PropEntry, type HasProps } from '../props';
import type { ParsedFolderNode } from '../folders';

export interface ApeironNode {
  /** Escape hatch: the raw node id (e.g. `"BlockNode:00C..."`), never proxied further. */
  readonly id: string;
  /** Reified containment (Aperas-apeironngn-design.md §3): reverse-queries the `parent` index,
   *  sorted by `siblingIndex`. Present on `BlockNode`/`ArtifactNode`/`FolderNode`; absent (reads
   *  `undefined`) on everything else. */
  readonly children?: ApeironNode[];
  [field: string]: unknown;
}

// ---------------------------------------------------------------------------------------------
// Low-level field read/write — what each generated accessor calls. Unchanged in spirit from the
// old `Proxy` traps, just invoked from real `get`/`set` accessor properties instead.
// ---------------------------------------------------------------------------------------------

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

/** A true incremental append for reified `orderedContainment` — writes only `childId`'s own
 *  `__parent`/`__siblingIndex` triples, touching no other child's data. `TreeNode.appendChild`'s
 *  old implementation went through the generic `this.children = [...(this.children ?? []),
 *  childId]` setter instead, which (per `writeField`'s `orderedContainment` branch) detaches
 *  *every* current child of the parent first, then rewrites all of them from the array it read —
 *  correct when nothing else can observe the gap in between, but for a single append that's a lot
 *  of needless churn, and a genuine hazard the moment the "read current children" step can ever
 *  miss one that's real (a stale/incomplete view of the store) — a miss there doesn't just fail to
 *  include it, it permanently deletes its containment on the very next write, even though nothing
 *  touched that child's own fields. Also detaches `childId`'s own prior containment first (if it
 *  already had a different parent) — the old full-rewrite path never did this either, since it only
 *  ever cleared the *target* parent's existing children, not whatever the moving child used to
 *  belong to — so this closes that gap too, for free, without querying or touching any sibling. */
function appendOrderedChild(store: Store, parentId: string, childId: string): void {
  const childSubject = nodeIri(childId);
  for (const m of store.match(childSubject, PARENT_PRED, null, null)) store.delete(m);
  for (const m of store.match(childSubject, SIBLING_INDEX_PRED, null, null)) store.delete(m);
  const siblingCount = store.match(null, PARENT_PRED, nodeIri(parentId), null).length;
  store.add(quad(childSubject, PARENT_PRED, nodeIri(parentId)));
  store.add(quad(childSubject, SIBLING_INDEX_PRED, encodeLiteral(siblingCount)));
}

/** The **(p)** channel's primitive (Aperas-crud-design.md §7, alongside `appendOrderedChild`
 *  above) — positions `childId` immediately before/after `anchorId` among `parentId`'s children,
 *  instead of always at the tail. Unlike `appendOrderedChild`'s deliberately-incremental single-id
 *  write, this is a full rewrite: inserting anywhere but the tail shifts every later sibling's own
 *  `siblingIndex`, so there's no cheaper correct alternative — the same convention `TreeNode`'s
 *  generic `children` setter (`writeField`'s `orderedContainment` branch) already uses everywhere
 *  else a position changes. Handles a same-parent reorder and a cross-parent move identically:
 *  `childId`'s own prior containment (wherever it pointed, including this same parent) is always
 *  detached first, then the whole finalized order is written fresh. Throws if `anchorId` isn't
 *  currently a child of `parentId` — no silent fallback to append, since that would silently
 *  discard the caller's actual positioning intent. */
function insertOrderedChild(store: Store, parentId: string, childId: string, anchorId: string, side: 'before' | 'after'): void {
  const parentMatches = store.match(null, PARENT_PRED, nodeIri(parentId), null);
  const withIndex = parentMatches.map((m) => {
    const id = idFromNodeIri(String(m.subject.value));
    const idxMatches = store.match(nodeIri(id), SIBLING_INDEX_PRED, null, null);
    const idx = idxMatches.length > 0 && isLiteralTerm(idxMatches[0].object) ? Number(idxMatches[0].object.value) : 0;
    return { id, idx };
  });
  withIndex.sort((a, b) => a.idx - b.idx);
  const currentIds = withIndex.map(({ id }) => id).filter((id) => id !== childId);

  const anchorPos = currentIds.indexOf(anchorId);
  if (anchorPos === -1) {
    throw new Error(`insertOrderedChild: anchor '${anchorId}' is not a child of '${parentId}'.`);
  }
  const finalIds = [...currentIds];
  finalIds.splice(side === 'before' ? anchorPos : anchorPos + 1, 0, childId);

  for (const m of store.match(nodeIri(childId), PARENT_PRED, null, null)) store.delete(m);
  for (const m of store.match(nodeIri(childId), SIBLING_INDEX_PRED, null, null)) store.delete(m);
  for (const id of currentIds) {
    for (const m of store.match(nodeIri(id), PARENT_PRED, null, null)) store.delete(m);
    for (const m of store.match(nodeIri(id), SIBLING_INDEX_PRED, null, null)) store.delete(m);
  }

  finalIds.forEach((id, index) => {
    store.add(quad(nodeIri(id), PARENT_PRED, nodeIri(parentId)));
    store.add(quad(nodeIri(id), SIBLING_INDEX_PRED, encodeLiteral(index)));
  });
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

/** Mints a fresh embedded subdocument (`StringProp` under `props`, `Link` under `links`) and
 *  writes its own literal fields as quads on its own new id — `${parentId}/(props|links)/${type}/
 *  <snowflake>`. Generic per `SHAPE_BY_KIND`, not type-specific: this is what lets a fresh `Link`
 *  literal (`{ predicate, target }`) mint correctly on its own now that `links` is `storageKind:
 *  'embed'` (`BaseNode.addLink`), the same path `props` already used. */
function mintEmbedded(store: Store, parentId: string, field: string, entry: Record<string, unknown>): string {
  const type = (entry['@type'] as string) ?? (field === 'links' ? 'Link' : 'StringProp');
  const newId = `${parentId}:${field}:${type}:${generateNodeId()}`;
  const shape = SHAPE_BY_KIND[type];
  if (!shape) throw new Error(`ApeironNgn: no shape declared for embedded type '${type}'`);
  for (const [k, v] of Object.entries(entry)) {
    if (k === '@type' || k === '@id' || k === 'id') continue;
    if (v === null || v === undefined) continue;
    // Reference-kind fields checked *before* the literal branch below, regardless of whether `v`
    // is a bare id string or an object carrying one (`idOf` handles both) -- `BaseNode.addLink`'s
    // normal calling convention (`{ predicate, target: <string id> }`) passes a plain string for
    // `target`, which a string-first check would wrongly encode as a literal instead of a node
    // reference (silently breaking every freshly-minted `Link.target`: it decodes back as a bare
    // string on read, not a wrapped node, so `.target.id`/backlinks on it come back `undefined`).
    if (shape[k]?.storageKind === 'reference') {
      store.add(quad(nodeIri(newId), predIri(k), nodeIri(idOf(v))));
    } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      store.add(quad(nodeIri(newId), predIri(k), encodeLiteral(v)));
    }
  }
  return newId;
}

/** Recursively deletes `id`'s own quads — and, for any of its own `storageKind: 'embed'` fields,
 *  whatever those point at too. Originally written for an orphaned embedded subdocument no longer
 *  referenced by anything (`Link`/`StringProp`, Aperas-apeironngn-design.md §4 Step 8), but written
 *  generically off `SHAPE_BY_KIND` from the start, so it works unmodified as the *general* "actually
 *  delete this node" primitive — including a top-level `BlockNode`/`ArtifactNode`/`FolderNode` a
 *  mark-and-sweep pass (`pruneUnreachableTombstones`, below) has determined is a tombstoned node
 *  nothing live points to any more. Merely detaching a forward reference (what `clearField` alone
 *  does) leaves the deleted node's own quads sitting in the store forever: invisible to
 *  `dehydrateToJsonLd` (nothing references it any more, so nothing ever walks to it), but very real
 *  memory in the long-lived service process (`service.ts`) that holds one `Store` alive across every
 *  `kg:track`/`kg:ingest` call for its entire uptime, not a fresh one per command — and, per §5's own
 *  WASM-memory note, a *permanent* one: WebAssembly linear memory only grows, so a peak this avoided
 *  can never be handed back to the OS short of restarting the process regardless. Confirmed live as
 *  the mechanism behind exactly this leak, pre-generalization: a wikilink `Link` dropped by
 *  `BlockNode.hydrateFromParsed` on re-ingestion kept its own `target`/`predicate`/`props` quads
 *  sitting orphaned, `Link.props`'s own `position` `StringProp`s included (one level of embedding
 *  deeper than anything `props`/`links` previously nested). */
function hardDeleteNode(store: Store, id: string): void {
  const shape = SHAPE_BY_KIND[nodeKindFromId(id)];
  if (shape) {
    for (const [field, spec] of Object.entries(shape)) {
      if (spec.storageKind !== 'embed') continue;
      for (const m of store.match(nodeIri(id), predIri(field), null, null)) {
        if (isNamedNodeTerm(m.object)) hardDeleteNode(store, idFromNodeIri(m.object.value));
      }
    }
  }
  removeDanglingUnfolds(store, id);
  for (const m of store.match(nodeIri(id), null, null, null)) store.delete(m);
}

/** Sweeps every `TreeView`'s `unfolds` set for a reference to `deletedId` and removes it —
 *  `unfolds` is the *only* `reference`-kind field anywhere in the schema whose target can be a
 *  `Link`/`StringProp` (a top-level kind is only ever referenced via `Link.target`/`children`/
 *  `parent`, all handled by `pruneUnreachableTombstones`'s own reachability walk, not by dangling
 *  *this* field), so a hard delete (`hardDeleteNode`, above — the only way any node ever actually
 *  disappears) is the only event that could leave `unfolds` naming something gone. Called from
 *  `hardDeleteNode` itself, right before it deletes `deletedId`'s own quads (which only clear quads
 *  with `deletedId` as *subject* — an incoming `unfolds` reference has `deletedId` as *object*, so
 *  it's untouched unless swept separately here) — every deletion path (wikilink regeneration, Step
 *  9's tombstone-consistency cleanup, `pruneUnreachableTombstones`'s GC) gets this for free, with no
 *  new call site needed anywhere. */
function removeDanglingUnfolds(store: Store, deletedId: string): void {
  const deletedIri = nodeIri(deletedId);
  for (const viewId of allIdsOfKind(store, 'TreeView')) {
    for (const m of store.match(nodeIri(viewId), predIri('unfolds'), deletedIri, null)) {
      store.delete(m);
    }
  }
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

  const storageKind = spec.storageKind ?? 'literal';

  // Embed-kind fields *own* whatever they reference — nothing else can address a `Link`/
  // `StringProp` independently — so reassigning one needs to delete whichever currently-referenced
  // subdocuments won't survive into `value`, not just detach them (`hardDeleteNode`'s own doc
  // comment). Deliberately scoped to `embed` only: a `reference`-kind field (`parent`, `children`)
  // points at an independently-addressable document that reassigning must never delete.
  if (storageKind === 'embed') {
    const survivingValues = value === null || value === undefined ? [] : Array.isArray(value) ? value : [value];
    const survivingIds = new Set<string>();
    for (const entry of survivingValues) {
      const survivingId = typeof entry === 'string' ? entry : (entry as any)?.['@id'] ?? (entry as any)?.id;
      if (typeof survivingId === 'string') survivingIds.add(survivingId);
    }
    for (const m of store.match(nodeIri(id), predIri(field), null, null)) {
      if (!isNamedNodeTerm(m.object)) continue;
      const oldId = idFromNodeIri(m.object.value);
      if (!survivingIds.has(oldId)) hardDeleteNode(store, oldId);
    }
  }

  clearField(store, id, field);

  if (value === null || value === undefined) {
    if (spec.cardinality === 'one') throw new Error(`ApeironNgn: '${field}' is required — can't clear it.`);
    return;
  }

  const writeOne = (entry: unknown) => {
    if (storageKind === 'literal') {
      if (typeof entry !== 'string' && typeof entry !== 'number' && typeof entry !== 'boolean') {
        throw new Error(`ApeironNgn: '${field}' expects a literal value, got ${JSON.stringify(entry)}`);
      }
      store.add(quad(nodeIri(id), predIri(field), encodeLiteral(entry)));
    } else if (storageKind === 'reference') {
      const refId = typeof entry === 'string' || (entry && typeof entry === 'object' && !('@type' in (entry as object)))
        ? idOf(entry)
        : mintEmbedded(store, id, field, entry as Record<string, unknown>); // a fresh literal object for a reference field
      store.add(quad(nodeIri(id), predIri(field), nodeIri(refId)));
    } else {
      // embed — a bare string (e.g. reconcile.ts's carryForwardFields handing back an existing
      // Link's own id, materialized as a plain ref-id string by toReconcileShape) means "this
      // subdocument already exists, reuse it," exactly like an object already carrying `@id`/`id`
      // — only a plain literal object with neither means "mint a fresh one."
      const refId = typeof entry === 'string' || (entry && typeof entry === 'object' && ((entry as any)['@id'] || (entry as any).id))
        ? idOf(entry)
        : mintEmbedded(store, id, field, entry as Record<string, unknown>);
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

// ---------------------------------------------------------------------------------------------
// The class hierarchy
// ---------------------------------------------------------------------------------------------

export class ApeironInstance {
  static SHAPE: ClassShape = {};
  readonly store: Store;
  readonly id: string;
  constructor(store: Store, id: string) {
    this.store = store;
    this.id = id;
  }
}

/** `links`/`props`/`tombstonedAt`/`holder` — used only by `TreeNode` and below now that `Link`/
 *  `StringProp` don't extend it (kept as its own level anyway: a real conceptual boundary,
 *  "participates in the links/props/lifecycle system", separate from `TreeNode`'s "has a title
 *  and a position in the tree"). No `unfolded` field here anymore — fold state moved to
 *  `TreeView.unfolds` (Aperas-treeview-design.md), per-view instead of a single flag every viewer
 *  shares. */
export class BaseNode extends ApeironInstance {
  declare links?: ApeironNode[];
  declare props?: ApeironNode[];
  declare tombstonedAt?: string;
  declare holder?: boolean;

  /** The direct payoff of `links` becoming `storageKind: 'embed'`: a fresh `{ predicate, target }`
   *  literal mints correctly on its own now, so this replaces the old "mint a `Link/<snowflake>`
   *  id, `wrap()` it, set `target`/`predicate`, attach by id" workaround `kg:link`/
   *  `resolveBlockLinks` both used to need. */
  addLink(predicate: string, target: string): void {
    this.links = [...(this.links ?? []), { predicate, target } as unknown as ApeironNode];
  }

  /** `resolveBlockLinks`'s (`artifacts.ts`) own way of minting a wikilink-derived `Link` — one per
   *  distinct target, never one per raw `[[code]]` occurrence (Aperas-apeironngn-design.md §4
   *  Step 8: `.links` is a real traversal axis alongside `children`, so two edges to the same
   *  target is a graph-correctness smell, not just a display nit). `positions` (block-relative
   *  offsets, one per occurrence of `target` in this block's text) become one `{key: 'position',
   *  value: '<offset>'}` prop per entry. Reintroduces the "mint id, wrap, set fields" half of the
   *  workaround `addLink`'s own doc comment says `links` becoming `storageKind: 'embed'` retired —
   *  necessarily so this time: `mintEmbedded` only writes an entry's own top-level reference/
   *  literal fields, it doesn't recurse into a nested `Set`-typed one, so a single-call
   *  `{predicate, target, props}` literal can't mint its `props` correctly.
   *
   *  Deliberately does *not* attach the fresh `Link` to `this.links` itself (the "attach by id"
   *  half of that old workaround) — `resolveBlockLinks` calls this only for a target/position-set
   *  that has no reusable match among this block's existing wikilink `Link`s, then assembles the
   *  *whole* surviving id list (reused + freshly minted) and writes `.links` once. That single
   *  write is what makes `writeField`'s own embed-diff (`hardDeleteNode`) clean up whatever
   *  didn't survive — a stale wikilink whose target disappeared, or one superseded by a fresh mint
   *  for the same target with different positions — without this method needing to delete
   *  anything itself. */
  mintWikilink(target: string, positions: number[]): string {
    const linkId = `${this.id}:links:Link:${generateNodeId()}`;
    const link = wrap(this.store, linkId) as unknown as Link;
    link.predicate = WIKILINK_PREDICATE;
    link.target = target as unknown as TreeNode;
    link.props = positions.map((position) => ({ '@type': 'StringProp', key: 'position', value: String(position) })) as unknown as ApeironNode[];
    return linkId;
  }
}

/** `title`/`text`/`key`/`parent` — shared by every tree-positioned kind. `key` replaces the old
 *  per-class `blockId`/`artifactId`/`folderId` literal fields: each was always identical to its own
 *  id's local part by construction, so it's derived here, never its own stored triple. `parent` is
 *  populated automatically as a side effect of whichever container's `children` write includes this
 *  node — `vocab.ts`'s `PARENT_PRED` doc comment has the full mechanism and why it's never assigned
 *  directly. */
export class TreeNode extends BaseNode {
  declare title?: string;
  declare text?: string;
  declare parent?: TreeNode;

  get key(): string {
    return this.id.slice(this.id.indexOf(':') + 1);
  }

  /** Every concrete child, in tree order. No default here — every concrete class below overrides
   *  it (`BlockNode`/`FolderNode`: `children`; `ArtifactNode`: `root`, wrapped in an array). A
   *  bare `TreeNode` is never instantiated directly (`classForId` only ever dispatches to a leaf
   *  class), so a call reaching this base implementation is a real bug, not a normal miss. */
  get treeChildren(): TreeNode[] {
    throw new Error(`ApeironNgn: '${this.constructor.name}' doesn't override treeChildren.`);
  }

  /** Mirror of `treeChildren`'s read side — appends one new child id, however this concrete kind
   *  actually stores it. Same "every concrete class overrides it" contract as `treeChildren`. */
  appendChild(_childId: string): void {
    throw new Error(`ApeironNgn: '${this.constructor.name}' doesn't override appendChild.`);
  }

  /** `kg:insert`'s primitive (Aperas-crud-design.md §7) — positions `childId` next to `anchorId`
   *  among this node's children instead of always at the tail. Overridden by `BlockNode`/
   *  `FolderNode` (both can parent positioned Block children — a Folder's README content is
   *  ordered content same as any artifact's); `ArtifactNode` inherits `BlockNode`'s. Not overridden
   *  by anything else, since only those three kinds have `children` at all. */
  insertChild(_childId: string, _anchorId: string, _side: 'before' | 'after'): void {
    throw new Error(`ApeironNgn: '${this.constructor.name}' doesn't override insertChild.`);
  }

  /** `tree.ts`'s old `renderTree`, folded — kind-generic via `treeChildren` instead of
   *  `childIds(node, kind)`'s manual branch. `opts.view` (Aperas-treeview-design.md §5) switches to
   *  the view-based renderer; omitted, this keeps the plain title-only/always-recurse default. */
  renderTree(opts: TreeOptions = {}): string[] {
    if (opts.view) return renderTreeWithView(this.store, this.id, opts.view, opts);
    const lines: string[] = [];
    renderTreeLines(this, 0, opts, lines);
    return lines;
  }

  /** `path.ts`'s old `resolveIdToPath`, folded. Walks `.parent` up to the owning
   *  `ArtifactNode`/`FolderNode`, collecting each hop's slugified `title`, then prepends that
   *  node's own `path`. Returns `null` on anything unwalkable: a missing document, or a
   *  `BlockNode` with no `parent` set. An artifact and its document content are the same node now
   *  (`ArtifactNode extends BlockNode`, merged) — a heading directly under it is `<artifact>/
   *  <heading>`, one hop, with nothing synthetic in between to skip. */
  toPath(): string | null {
    const segments: string[] = [];
    let current: TreeNode = this;
    for (;;) {
      const kind = nodeKindFromId(current.id);
      if (kind === 'ArtifactNode' || kind === 'FolderNode') {
        const path = (current as unknown as { path?: string }).path;
        if (path === undefined) return null;
        return segments.length > 0 ? `${path}/${segments.join('/')}` : path;
      }
      if (kind !== 'BlockNode') return null; // a subdoc (Link/StringProp) — no structural parent
      if (current.title === undefined) return null;
      segments.unshift(slugify(current.title));
      if (!current.parent) return null;
      current = current.parent;
    }
  }

  /** `resolve.ts`'s old `descend`/`resolveCreate.ts`'s equivalent single hop, folded — exact-then-
   *  prefix slug match among this node's `treeChildren`, whatever kind they are (a `BlockNode`
   *  heading, or a `FolderNode`/`ArtifactNode` one level down the structural tree — both declare
   *  `title` on `TreeNode` itself, so one match rule covers every hop of the deep-path grammar,
   *  not just the heading tier). Read-only: returns the matched child, or `null` on a miss; throws
   *  on ambiguity, same distinction the free functions already drew. */
  findChild(text: string): TreeNode | null {
    const candidates = this.treeChildren.filter((c) => c.title !== undefined);
    const wantSlug = slugify(text);
    let matches = candidates.filter((c) => slugify(c.title!) === wantSlug);
    if (matches.length === 0) {
      matches = candidates.filter((c) => slugify(c.title!).replace(/^-+/, '').startsWith(wantSlug));
    }
    if (matches.length > 1) {
      throw new Error(`'${text}' is ambiguous among: ${matches.map((m) => `${m.id} ("${m.title}")`).join(', ')}`);
    }
    return matches[0] ?? null;
  }

  /** `collect.ts`'s old `collectBlockNodes`, folded onto `TreeNode` (not `BlockNode` alone — the
   *  starting point can be any tree-positioned kind; only `BlockNode` descendants are collected).
   *  Without `recursive`, only `this` itself is visited (and only collected if it's a
   *  `BlockNode`); with `recursive`, every kind along the way is walked but only `BlockNode`s are
   *  collected. */
  collectDescendants(recursive: boolean): Array<{ id: string; node: TreeNode }> {
    const out: Array<{ id: string; node: TreeNode }> = [];
    const visit = (node: TreeNode, isRoot: boolean): void => {
      if (nodeKindFromId(node.id) === 'BlockNode') out.push({ id: node.id, node });
      if (isRoot && !recursive) return;
      for (const child of node.treeChildren) visit(child, false);
    };
    visit(this, true);
    return out;
  }
}

export class BlockNode extends TreeNode {
  declare type?: string;
  declare children?: TreeNode[];

  get treeChildren(): TreeNode[] {
    return this.children ?? [];
  }
  appendChild(childId: string): void {
    appendOrderedChild(this.store, this.id, childId);
  }

  /** `kg:insert`'s own primitive (Aperas-crud-design.md §7) — positions `childId` next to
   *  `anchorId` among `this`'s children, and unconditionally clears `childId`'s own `.holder`:
   *  asserting a position is itself sufficient promotion signal (§4.2 (p)), independent of whether
   *  `childId` was ever a placeholder — a no-op clear for an already-real node being plainly moved. */
  insertChild(childId: string, anchorId: string, side: 'before' | 'after'): void {
    insertOrderedChild(this.store, this.id, childId, anchorId, side);
    (wrap(this.store, childId) as unknown as BaseNode).holder = undefined;
  }

  /** `project.ts`'s old block-rendering half of `projectArtifactToMarkdown`, folded — a real
   *  instance's property reads are indistinguishable from a plain object's to `serializeBlock`,
   *  so nothing there needed changing. Return type is `string | null` only so `ArtifactNode`'s
   *  override (nullable — "nothing ingested yet") stays override-compatible; an ordinary
   *  `BlockNode` always has a `type` and never actually returns `null` here. `lang` (linking.md's
   *  Task 1 — lead-in-term extraction/id-anchor splicing need to know which script's length-cap
   *  unit applies) defaults to `'en'` for a plain nested `BlockNode` called directly, which has no
   *  frontmatter of its own to read one from; `ArtifactNode`'s own override below is what actually
   *  computes it, from the owning document's frontmatter, and passes it down through this call. */
  toMarkdown(lang: DocLang = 'en'): string | null {
    return serializeBlock(this, lang);
  }

  /** `artifacts.ts`'s old `materializeBlockTree`, folded — the old (already-ingested) tree,
   *  rebuilt as a plain nested object in exactly the shape `reconcile.ts` expects (`type`/`title`/
   *  `text`/`children`/`blockId`, `links` as bare ref-id strings). Still produces a `blockId` key
   *  in its output — that's `reconcile.ts`'s external contract, unaffected by `key` replacing the
   *  old stored field internally. `props` is included as `{id, key, value}` triples (not the
   *  JSON-LD `@id`/`@type` shape) — `carryForwardFields`'s own consumer shape, matching by `key`
   *  against the fresh parse's props so an unchanged value keeps its stable id. No `unfolded` here
   *  — that per-node flag is gone (Aperas-treeview-design.md), so there's nothing left to carry
   *  forward for it. */
  toReconcileShape(): any {
    const links = (this.links as ApeironNode[] | undefined)?.map((l) => l.id) ?? [];
    const props = (this.props as any[] | undefined)?.map((p) => ({ id: p.id, key: p.key, value: p.value }));
    return {
      blockId: this.key,
      type: this.type,
      title: this.title,
      ...(this.text !== undefined ? { text: this.text } : {}),
      ...(this.holder ? { holder: true } : {}),
      ...(links.length ? { links } : {}),
      ...(props?.length ? { props } : {}),
      children: (this.children ?? []).map((c) => (c as unknown as BlockNode).toReconcileShape()),
    };
  }

  /** `artifacts.ts`'s old `writeBlockTree`, folded — writes a freshly-parsed-and-reconciled
   *  `ParsedBlockNode` tree into the `Store`, one node at a time. Every node already carries a
   *  real `blockId` by this point (freshly minted at parse time for a brand-new node, or carried
   *  forward from its old match by `reconcile.ts`'s `carryForwardFields`) — `this` is already
   *  `wrap()`ped at that id, nothing left to mint here.
   *
   *  Carries `links` forward unconditionally now — manual `kg:link` *and* wikilink `Link`s alike.
   *  Earlier this dropped every carried-forward `WIKILINK_PREDICATE` entry unconditionally here
   *  (the fix for a real duplication bug: `resolveBlockLinks`, run right after this, used to
   *  unconditionally append a fresh wikilink `Link` on top of whatever survived, so an unchanged
   *  `[[wikilink]]` grew one more duplicate every re-ingestion). That fix is now one layer further
   *  down instead: `resolveBlockLinks` has since gained its own reuse-or-remint logic (a snapshot
   *  of each block's *old* wikilink `Link`s — id, target, positions — taken by `ingestFromDisk`
   *  just before this method runs), so it needs the carried-forward ids still live here in order to
   *  reuse an exact-match one's identity, and writes `.links` itself exactly once with the final
   *  surviving set — `writeField`'s embed-diff cleans up whatever that write doesn't include.
   *
   *  No explicit `this.parent = ...` here any more (Aperas-apeironngn-design.md §5's `parent`/
   *  `PARENT_PRED` merge): `this.children = [...]` below already stamps each child's `parent` as a
   *  side effect of the containment write, using final (already-reconciled) ids — the separate
   *  early stamp this used to need, and the "must re-run after reconciliation reassigns ids" bug
   *  class it was prone to (`astParser.ts`'s old `stampParents`), doesn't exist any more; there's no
   *  earlier stamp to go stale.
   *
   *  Always clears `this`'s own `.holder` (Aperas-crud-design.md §6) — `this` reaching this method
   *  at all means real content is being written to it right now, whether for the first time or as a
   *  Stage-A-matched placeholder finally being promoted (channel (i)): `carryForwardFields`
   *  (reconcile.ts) never copies `.holder` onto the reconciled plain-object tree this method reads
   *  from, but that alone never touched the real stored quad — this write is what actually does.
   *  Safe unconditionally *only* because of the per-child skip just below — a still-unmatched
   *  holder child (spliced back in place by `reconcile.ts`'s own fix, §5, rather than promoted)
   *  never reaches its own `hydrateFromParsed` call at all, so it never hits this line either. */
  hydrateFromParsed(parsed: ParsedBlockNode): void {
    this.type = parsed.type;
    this.title = parsed.title;
    this.text = parsed.text ?? undefined;
    this.props = parsed.props?.length ? (parsed.props as unknown as ApeironNode[]) : undefined;
    const carriedLinkIds = ((parsed as any).links as string[] | undefined) ?? [];
    this.links = carriedLinkIds.length ? (carriedLinkIds as unknown as ApeironNode[]) : undefined;
    this.holder = undefined;
    for (const child of parsed.children ?? []) {
      // A holder-flagged entry here is one §5's reconciliation splice preserved in place, still
      // unmatched — the exact same store node it always was, just repositioned. Never re-hydrate
      // it: that would wrongly clear its own `.holder` above, "promoting" it despite no real
      // content having actually arrived. Its id still gets wired into `this.children` below, same
      // as any other child.
      if ((child as any).holder) continue;
      (wrap(this.store, `BlockNode:${child.blockId}`) as unknown as BlockNode).hydrateFromParsed(child);
    }
    this.children = (parsed.children ?? []).map((c) => `BlockNode:${c.blockId}` as unknown as TreeNode);
  }
}

/** Merged with what used to be a separate synthetic root `BlockNode` per artifact — an
 *  `ArtifactNode` *is* its own document content now (`extends BlockNode`), not a thin wrapper
 *  pointing at one via a `root` reference. `treeChildren`/`findChild`/`appendChild` all come
 *  straight from `BlockNode` unmodified: a top-level heading is an ordinary child, appending one
 *  is an ordinary ordered-containment append, no "already has a root" singular-child case to
 *  guard. `text` is a derived abstract/preview (`extractAbstract`, copied from the first
 *  descendant with content — deliberately duplicated with whatever's already in `children`, not
 *  consumed away from it), never `this`'s own leading paragraph the way a heading's `text` is. */
export class ArtifactNode extends BlockNode {
  declare path?: string;
  declare fileHash?: string;
  declare lastTrackedAt?: string;
  declare ingestedHash?: string;
  declare lastIngestedAt?: string;
  /** Hash of the markdown `kg:project` actually wrote to disk, last time it wrote anything
   *  (Aperas-crud-design.md §15) — distinct from `ingestedHash`, which tracks the opposite
   *  direction's own baseline (last content reconciled *from* disk, or refreshed by `kg:update` to
   *  mean "graph is ahead of disk"). Sole purpose: `kg:track --reverse` compares this against a
   *  fresh `toMarkdown()` hash to detect drift, without ever writing to disk itself. */
  declare projectedHash?: string;

  /** `artifacts.ts`'s old `trackArtifact`'s per-node half, folded — registers or refreshes this
   *  lightweight ArtifactNode against `artifactPath`'s current file content, skipping when the
   *  hash hasn't changed. Takes the path explicitly (not `this.path`) since a brand-new,
   *  not-yet-tracked instance has no `path` of its own yet. */
  trackFromDisk(artifactPath: string): { tracked: boolean } {
    const content = readFileSync(join(getArtifactsDir(), artifactPath), 'utf-8');
    const fileHash = computeFileHash(content);
    // Both must hold for a real no-op: a pure rename (matched by trackAllArtifacts/
    // trackArtifactsScoped's own Gestalt/exact-key matching) is the common case where content is
    // byte-identical across the move — `fileHash` alone would wrongly call that "unchanged" and
    // skip the `this.path` write below, silently leaving this node stuck at its old, now-missing
    // path while the caller believes the rename succeeded (confirmed live: this is why a
    // content-preserving rename previously reported success while actually leaving the old node
    // untouched and creating a fresh duplicate at the new path instead).
    if (this.fileHash === fileHash && this.path === artifactPath) {
      console.log(`[ApeironNgn Artifacts] Skipping '${artifactPath}' — content unchanged (hash: ${fileHash.slice(0, 12)}...)`);
      return { tracked: false };
    }
    this.path = artifactPath;
    this.title = basename(artifactPath);
    this.fileHash = fileHash;
    this.lastTrackedAt = new Date().toISOString();
    // Aperas-crud-design.md §6: a path match here is channel (i)'s whole promotion story for
    // Folder/Artifact — unconditional, same reasoning as BlockNode.hydrateFromParsed's own clear.
    this.holder = undefined;
    console.log(`[ApeironNgn Artifacts] Tracking '${artifactPath}' (hash: ${fileHash.slice(0, 12)}...)`);
    return { tracked: true };
  }

  /** `project.ts`'s old `projectArtifactToMarkdown`'s render half, folded. `null` when this
   *  artifact has no content yet. `super.toMarkdown()` is `BlockNode`'s own (`serializeBlock(this)`)
   *  — dispatching on `this.type` (still `'root'`, unchanged from the old synthetic wrapper's own
   *  type) hits `serializeBlock`'s container-fallback case, rendering `children` with nothing of
   *  `this`'s own emitted first, exactly as it did through the old `this.root.toMarkdown()`
   *  indirection.
   *
   *  Checks `children.length`, not `ingestedHash` (an earlier version of this guard did, back when
   *  a real disk-based ingest was the only way content ever arrived) — `kg:insert` (Aperas-crud-
   *  design.md §7) can now populate a holder `ArtifactNode`'s children directly, with `ingestedHash`
   *  staying `undefined` forever since `ingestFromDisk` never runs on it. `children` itself is
   *  never `undefined` for `orderedContainment` (always a real, possibly-empty array by
   *  construction), so an empty one is the actually-correct "nothing to render yet" signal. */
  toMarkdown(): string | null {
    if ((this.children ?? []).length === 0) return null;
    const lang = extractLangFromFrontmatter(getProp(this as unknown as HasProps, 'frontmatter'));
    return withFrontmatter(super.toMarkdown(lang)!, this);
  }

  /** `artifacts.ts`'s old `ingestArtifact`'s per-node half, folded — AST-parses and commits this
   *  artifact into a fractal tree of `BlockNode`s, only if its file hash has changed since the
   *  last ingestion. Reads `artifactPath` from `this.path` (always set by the time ingestion
   *  runs — tracking is a prerequisite). Returns `pendingLinks` for the caller to resolve
   *  afterward (`artifacts.ts`'s `resolveBlockLinks` — a multi-block sweep, stays free) rather
   *  than resolving them here: the implicit `[[wikilink]]` base needs an already-persisted
   *  `.parent` chain, so link resolution has to run *after* the tree write completes, not as
   *  part of it. Also returns `oldLinkTargets` (this artifact's *previous* per-block resolved
   *  target sets, before anything in this ingestion runs) for that same later caller to diff
   *  against — reconciliation itself can't see whether a block's *link resolution outcome*
   *  changed, only whether its own text/structure did: `resolveBlockLinks` runs after this
   *  method returns, so no block's *new* links exist yet at this point, matched or not. Same
   *  reasoning for `oldWikilinksByBlock` (id/target/positions, not just target ids) — the only
   *  chance to see a matched block's *existing* wikilink `Link`s before `hydrateFromParsed`'s own
   *  carry-forward and `resolveBlockLinks`'s reuse-or-remint decision both run on them.
   *
   *  `force` (Aperas-crud-design.md §14): reconciliation against real disk content can only ever
   *  discover a removal the same way it always has — anything not in the fresh parse is gone. That
   *  includes content that only ever existed in-graph (via `kg:insert`/`kg:update`) and was simply
   *  never projected back to disk yet — reconciliation has no way to tell the two apart. Rather than
   *  applying such a removal silently, a non-empty `tombstones` list is held back unapplied when
   *  `force` is false: nothing is written (no `hydrateFromParsed`, no `applyTombstone`, hashes left
   *  exactly as they were), and the tombstone previews are returned as `pendingConfirmation` instead
   *  for the caller to surface and re-run with `force: true` once confirmed.
   *
   *  `bypassUnchangedCheck` (AperasKG/artifacts/history/linking.md's Milestones — the cross-artifact
   *  dangling-reference retry sweep, `artifacts.ts`'s `retryDanglingRefs`): this artifact's own text
   *  genuinely hasn't changed, but something *it* links to just came into existence elsewhere, so its
   *  link resolution needs a fresh pass regardless. Deliberately a separate parameter, not a matter
   *  of just clearing `ingestedHash` externally first — `hadContent` below reads that same field to
   *  mean "was this artifact ever ingested before" (reconcile vs. fresh-mint every block), and
   *  clearing it to force past the skip would also make a real, previously-ingested artifact look
   *  brand new, discarding every existing block's identity instead of reconciling against it. */
  ingestFromDisk(force: boolean = false, bypassUnchangedCheck: boolean = false): (IngestResult & {
    pendingLinks: PendingLinkCodes[];
    oldLinkTargets: Map<string, Set<string>>;
    oldWikilinksByBlock: Map<string, Array<{ id: string; target: string; positions: number[] }>>;
    pendingConfirmation?: Array<{ blockId: string; type?: string; title?: string }>;
  }) | null {
    if (!bypassUnchangedCheck && this.ingestedHash === this.fileHash) {
      console.log(`[ApeironNgn Artifacts] '${this.path}' unchanged since last ingestion — skipping.`);
      return null;
    }

    const artifactPath = this.path!;
    const content = readFileSync(join(getArtifactsDir(), artifactPath), 'utf-8');
    const { root: newRoot, frontmatter } = parseMarkdownTree(content);
    const now = new Date().toISOString();
    // Carry the existing `frontmatter` StringProp's id forward when its value hasn't changed —
    // without this, `mintEmbedded` mints a fresh one on every single ingestion regardless (the
    // same "prop-id churn" bug class §4's rollout narrative already fixed for per-block props,
    // just not yet for this artifact-level singular one).
    const props = frontmatter !== undefined
      ? [carryForwardProp(this.props as unknown as PropEntry[] | undefined, 'frontmatter', frontmatter)]
      : undefined;

    let finalRoot: ParsedBlockNode = newRoot;
    let reconciliation: ReconciliationStats | null = null;

    // Whether this artifact already has ingested content from a previous run. `children` can't
    // answer this — `orderedContainment` always reads back as a real (possibly empty) array, never
    // `undefined` — so this reads the same "ever ingested" signal `ingestedHash` already exists
    // for. `this` plays the role the separate root `BlockNode` used to play, so reconciling
    // against "the old tree" now means reconciling against `this`'s own current state, via the
    // very same `toReconcileShape` every ordinary `BlockNode` already has (inherited, not
    // overridden).
    const hadContent = this.ingestedHash !== undefined;
    const oldLinkTargets = new Map<string, Set<string>>();
    const oldWikilinksByBlock = new Map<string, Array<{ id: string; target: string; positions: number[] }>>();
    if (hadContent) {
      const oldTree = this.toReconcileShape();
      console.log(`[ApeironNgn Artifacts] Reconciling '${artifactPath}' against its previously ingested tree...`);
      const { finalTree, tombstones, stats } = reconcileTree(oldTree, newRoot, now);
      if (tombstones.length > 0 && !force) {
        console.log(`[ApeironNgn Artifacts] '${artifactPath}' would remove ${tombstones.length} node(s) — held back pending confirmation (re-run with --force to apply).`);
        return {
          blockCount: 0,
          reconciliation: stats,
          pendingLinks: [],
          oldLinkTargets,
          oldWikilinksByBlock,
          pendingConfirmation: tombstones.map((t) => ({ blockId: t.blockId, type: t.type, title: t.title })),
        };
      }
      finalRoot = finalTree;
      reconciliation = stats;
      for (const tombstone of tombstones) applyTombstone(this.store, tombstone);
      console.log(`[ApeironNgn Artifacts] Reconciliation: ${stats.matched} matched, ${stats.moved} moved, ${stats.changed} changed, ${stats.added} added, ${stats.removed} removed.`);
      collectLinkTargetsByBlock(this, oldLinkTargets);
      collectOldWikilinksByBlock(this, oldWikilinksByBlock);
    }

    // `finalRoot` itself is never materialized as its own document any more — only its `children`
    // are real `BlockNode`s. Its own `blockId`/`parent` (whether freshly minted by this parse, or
    // carried forward from `oldTree` by `reconcileTree`'s `carryForwardFields`) are simply
    // discarded — nothing needs to stamp `.parent` onto the parsed tree any more (§5's `parent`/
    // `PARENT_PRED` merge): `this.children = ...` inside `hydrateFromParsed`, below, stamps each
    // direct child's real `parent` straight to `this.id` as a side effect of the containment write.

    const pendingLinks = extractLinkCodes(finalRoot);
    const blockCount = (finalRoot.children ?? []).reduce((sum, c) => sum + countBlocks(c), 0);
    console.log(`[ApeironNgn Artifacts] Ingesting '${artifactPath}' as fractal tree (${blockCount} blocks)...`);

    // Full-slug-path collision rejection (design/linking.md's Full-Path Collisions; planning/
    // linking.md's Slice 2 Task 2) — must run against this still-unmodified store, before anything
    // below writes a single block, so a rejected document leaves no partial write behind.
    rejectSlugPathCollisions(this.store, artifactPath, finalRoot.children ?? []);

    const title = basename(artifactPath);
    const text = extractAbstract(newRoot);

    this.hydrateFromParsed(finalRoot);

    this.title = title;
    this.text = text || undefined;
    this.ingestedHash = this.fileHash;
    this.lastIngestedAt = now;
    this.props = props as unknown as ApeironNode[];

    return { blockCount, reconciliation, pendingLinks, oldLinkTargets, oldWikilinksByBlock };
  }
}

export interface IngestResult {
  blockCount: number;
  reconciliation: ReconciliationStats | null;
}

/** Applies one `reconcile.ts` tombstone record — an unmatched old subtree node, already fully
 *  detached from `finalTree`'s own structure, so this only needs to set its own fields (`children:
 *  []` clears whatever it used to point at; nothing re-attaches it). `links`/`props` both cleared
 *  too — a dead, unaddressable node has no more use for a manual `kg:link`, a resolved wikilink
 *  `Link`, or a prop than for its own children (Aperas-apeironngn-design.md §5's tombstone-
 *  consistency open question — `props` was the one field this left live, inconsistently with the
 *  stated rationale for the other two). */
export function applyTombstone(store: Store, tombstone: any): void {
  const node = wrap(store, `BlockNode:${tombstone.blockId}`) as unknown as BlockNode;
  node.type = tombstone.type;
  node.title = tombstone.title;
  node.text = tombstone.text ?? undefined;
  node.children = [];
  node.links = undefined;
  node.props = undefined;
  node.tombstonedAt = tombstone.tombstonedAt;
}

/** Tombstones `node`'s entire *live* subtree in place, depth-first — the artifact-removal
 *  counterpart to `applyTombstone` above, used when a whole tracked file disappears from disk
 *  (`artifacts.ts`'s artifact-tombstone path). That path never runs `reconcileTree`, so there are
 *  no captured old-shape tombstone records to replay — just one live tree to mark dead, all at
 *  once. Recurses into `children` *before* clearing them on `node` itself so every descendant gets
 *  its own `tombstonedAt`/cleared `children`/`links`/`props`, closing the gap this path used to
 *  have entirely (previously it set nothing but the top `ArtifactNode`'s own `tombstonedAt`,
 *  leaving its whole block subtree — and every one of those blocks' own links/props — fully live
 *  and permanently unreferenced; Aperas-apeironngn-design.md §5). */
export function tombstoneLiveSubtree(node: BlockNode, now: string): void {
  for (const child of node.children ?? []) {
    tombstoneLiveSubtree(child as unknown as BlockNode, now);
  }
  node.children = [];
  node.links = undefined;
  node.props = undefined;
  node.tombstonedAt = now;
}

/** Aperas-crud-design.md §6 — `kg:project`'s own purity gate for the **(o)** promotion channel:
 *  nothing today stops projecting a subtree that still has holder descendants mid-tree, silently
 *  baking placeholder content into a "real" file. Recurses through `treeChildren` regardless of
 *  kind — a holder can be a `BlockNode` heading or a nested holder `FolderNode`/`ArtifactNode`
 *  alike, all equally unwritable. */
export function hasHolderDescendant(node: TreeNode): boolean {
  for (const child of node.treeChildren) {
    if ((child as unknown as BaseNode).holder) return true;
    if (hasHolderDescendant(child)) return true;
  }
  return false;
}

/** Aperas-crud-design.md §6 — **(o)** projection's own equivalent of `astParser.ts`'s
 *  `extractAbstract`, reading the live graph instead of a freshly parsed file: walks `treeChildren`
 *  depth-first (`node` itself excluded, same as `extractAbstract`'s own `isRoot` skip), returning
 *  the first non-empty `.text` found, truncated the same way. Needed when a holder Folder/Artifact
 *  is promoted by projecting it to a real file for the first time — without this, a
 *  projected-and-thus-real node would read `.text === undefined` forever, and would fail
 *  rename-detection (`matchLeftoverByAbstract`) if it's ever later moved. */
export function deriveAbstractFromLiveChildren(node: TreeNode): string {
  function findFirst(n: TreeNode, isRoot: boolean): string | null {
    if (!isRoot && n.text) return n.text as string;
    for (const child of n.treeChildren) {
      const found = findFirst(child, false);
      if (found) return found;
    }
    return null;
  }
  const raw = findFirst(node, true) ?? '';
  return raw ? truncateForPreview(raw) : raw;
}

/** Every name a live `BlockNode` currently answers to: its own current `toPath()`, plus any anchor
 *  `name` still embedded in its `treeAnchor` prop (heading) or raw `text` (list item/paragraph only
 *  — design/linking.md's Anchors section places an embedded anchor nowhere else). Anchor-scanning
 *  is deliberately *not* applied to every other non-heading type's `text` (`code`, `blockquote`,
 *  `thematicBreak`, `html`, `table`): their raw content can legitimately contain anchor-tag-shaped
 *  substrings as illustrative prose about the convention itself (confirmed live — design/linking.md's
 *  own "Anchors" section fenced examples), which would otherwise read as a real embedded anchor and
 *  produce a false collision. [Anchor-Matching Requirement for Resolution](design/linking.md) already
 *  treats a genuine embedded anchor as a live resolvable target, so a collision against one is real,
 *  not just against the block's current title (planning/linking.md's Slice 2 Task 2,
 *  `rejectSlugPathCollisions` below). */
function liveBlockNames(node: BlockNode): string[] {
  const names: string[] = [];
  const path = node.toPath();
  if (path) names.push(path);
  if (node.type === 'heading') {
    const treeAnchor = getProp(node as unknown as HasProps, HEADING_TREE_ANCHOR_PROP);
    if (treeAnchor) names.push(...extractAnchorNames(treeAnchor));
  } else if (node.type === 'paragraph' || node.type === 'listItem') {
    const text = node.text as unknown as string | undefined;
    if (text) names.push(...extractAnchorNames(text));
  }
  return names;
}

/** `liveBlockNames`'s counterpart for a freshly-parsed `ParsedBlockNode` — nothing's hydrated yet,
 *  so there's no `.toPath()` to call; the caller's own recursive walk threads the computed path in
 *  instead (`path`). */
function parsedBlockNames(node: ParsedBlockNode, path: string): string[] {
  const names = [path];
  if (node.type === 'heading') {
    const treeAnchor = getProp(node as unknown as HasProps, HEADING_TREE_ANCHOR_PROP);
    if (treeAnchor) names.push(...extractAnchorNames(treeAnchor));
  } else if (node.type === 'paragraph' || node.type === 'listItem') {
    if (node.text) names.push(...extractAnchorNames(node.text));
  }
  return names;
}

/** Every name every still-live `BlockNode` in the store currently answers to, indexed for
 *  `rejectSlugPathCollisions` below — a fresh full scan (`allIdsOfKind` has no cheaper index to
 *  offer), acceptable since every caller of this is an occasional CLI-driven write, never a hot
 *  path. First writer wins per name; a real duplicate among *already-live* blocks would itself be
 *  a bug this check exists to prevent from happening in the first place. */
function buildLiveSlugPathIndex(store: Store): Map<string, string> {
  const liveIndex = new Map<string, string>();
  for (const id of allIdsOfKind(store, 'BlockNode')) {
    const node = wrap(store, id) as unknown as BlockNode;
    if (node.tombstonedAt) continue;
    for (const name of liveBlockNames(node)) {
      if (!liveIndex.has(name)) liveIndex.set(name, id);
    }
  }
  return liveIndex;
}

/**
 * Full-slug-path collision rejection (design/linking.md's Full-Path Collisions; planning/
 * linking.md's Slice 2 Task 2) — a writer-facing authoring constraint, not a system-managed
 * lifecycle concept: this only ever detects a violation and refuses the whole write before
 * anything is committed, never fixes or tracks anything on the writer's behalf. `children` are the
 * new (or renamed) top-level `ParsedBlockNode`(s) being introduced, and `ancestorPath` is whatever
 * sits directly above them today — an artifact's own path (`ingestFromDisk`, a whole fresh parse),
 * an arbitrary live parent's `toPath()`/`path` (`kg:insert`'s create mode, a new subtree), or a
 * renamed heading's own *parent's* path (`kg:update`'s heading-replace path, a single node whose
 * title is what's actually changing — passed as its own one-element `children` array). Throws if
 * any name a block would answer to — its own computed path, or an embedded anchor name — is already
 * claimed by a *different* block: either a sibling within this same call's own `children`, or any
 * other still-live `BlockNode` already in the store. Must run before the caller's own
 * `hydrateFromParsed`/write — after it, these blocks would already be indistinguishable from
 * "other live blocks," including (for a rename) from their own prior self, which is exactly why
 * comparisons below match by id, not by name.
 */
export function rejectSlugPathCollisions(store: Store, ancestorPath: string, children: ParsedBlockNode[]): void {
  const liveIndex = buildLiveSlugPathIndex(store);
  const seenThisCall = new Map<string, string>(); // name -> blockId, within this one call only

  const walk = (node: ParsedBlockNode, parentPath: string): void => {
    const path = `${parentPath}/${slugify(node.title)}`;
    // `node.blockId` is a bare snowflake (`generateNodeId()`'s own return, or `TreeNode.key` for a
    // renamed live node) — every id in `liveIndex`/`seenThisCall` is the full `BlockNode:<snowflake>`
    // form, so comparisons need the same prefix or a reconciled/renamed node would spuriously
    // "collide" with its own prior self.
    const fullId = `BlockNode:${node.blockId}`;
    for (const name of parsedBlockNames(node, path)) {
      const liveOwner = liveIndex.get(name);
      if (liveOwner && liveOwner !== fullId) {
        throw new Error(`Full-slug-path collision: '${name}' is already used by another live block (${liveOwner}) — rejected before writing anything. Rename one of the colliding blocks and try again.`);
      }
      const docOwner = seenThisCall.get(name);
      if (docOwner && docOwner !== fullId) {
        throw new Error(`Full-slug-path collision: '${name}' is used by two different blocks in the same write (${docOwner} and ${fullId}) — rejected before writing anything. Rename one of them and try again.`);
      }
      seenThisCall.set(name, fullId);
    }
    for (const child of node.children ?? []) walk(child, path);
  };

  for (const child of children) walk(child, ancestorPath);
}

/** Walks a real (already-persisted) `BlockNode` tree collecting each block's resolved link target
 *  ids, keyed by `key` (the bare snowflake `resolveBlockLinks`'s own `pending`/`PendingLinkCodes`
 *  already key by) — `ingestFromDisk`'s own doc comment has the full reasoning for why this has to
 *  be captured *before* this ingestion runs, from the real tree rather than `toReconcileShape()`'s
 *  plain-object copy (whose own `links` is just an array of `Link` subdocument ids, not target
 *  ids — real `TreeNode.links` accessors resolve `target` for free instead).
 *
 *  Exported (not just `ingestFromDisk`-private) because `kgUpdate.ts`/`kgInsert.ts` need the same
 *  pre-mutation snapshot for whatever subtree they're about to reconcile/hydrate — see their own
 *  doc comments for why `kg:update`/`kg:insert` skipping link resolution entirely was a real,
 *  previously-hidden gap (only `ingestArtifact` ever called `resolveBlockLinks`). */
export function collectLinkTargetsByBlock(node: TreeNode, out: Map<string, Set<string>>): void {
  const links = (node.links as unknown as Link[] | undefined) ?? [];
  if (links.length > 0) {
    const targets = new Set<string>();
    for (const link of links) {
      if (link.target) targets.add(link.target.id);
    }
    if (targets.size > 0) out.set(node.key, targets);
  }
  for (const child of node.treeChildren) {
    if (nodeKindFromId(child.id) === 'BlockNode') collectLinkTargetsByBlock(child, out);
  }
}

/** `collectLinkTargetsByBlock`'s sibling, capturing each existing wikilink `Link`'s own id and
 *  `position` list (not just its target) — what `resolveBlockLinks` needs to decide whether a
 *  freshly-resolved target/position grouping can reuse an existing `Link`'s identity instead of
 *  minting a new one (Aperas-apeironngn-design.md §5's "tractable half": wikilink `Link`s used to
 *  churn identity on every re-ingestion even when nothing changed, since `hydrateFromParsed` used
 *  to drop them all unconditionally before this could ever be checked). Must run at the same point
 *  `collectLinkTargetsByBlock` does — before `hydrateFromParsed` touches anything — since this is
 *  the only moment a matched block's *old* wikilink `Link`s are both still live and known to be
 *  old. Exported for the same reason as `collectLinkTargetsByBlock` above. */
export function collectOldWikilinksByBlock(
  node: TreeNode,
  out: Map<string, Array<{ id: string; target: string; positions: number[] }>>
): void {
  const links = (node.links as unknown as Link[] | undefined) ?? [];
  const wikilinks = links.filter((l) => l.predicate === WIKILINK_PREDICATE && l.target);
  if (wikilinks.length > 0) {
    out.set(
      node.key,
      wikilinks.map((l) => ({
        id: l.id,
        target: l.target!.id,
        positions: getProps(l as unknown as HasProps, 'position').map(Number),
      }))
    );
  }
  for (const child of node.treeChildren) {
    if (nodeKindFromId(child.id) === 'BlockNode') collectOldWikilinksByBlock(child, out);
  }
}

/** Walks `.parent` up from `node` (inclusive — `node` itself counts if it's already the
 *  `ArtifactNode`) to find the enclosing artifact's id, for `resolveBlockLinks`'s `artifactId`
 *  parameter (the `danglingRef`-prop bookkeeping it does on that node). `artifacts.ts`'s own
 *  `artifactPathOfBlock` does the identical walk but returns the artifact's `path` — this returns
 *  the id instead, since `kgUpdate.ts`/`kgInsert.ts` (unlike `ingestArtifact`, which already has
 *  its artifact's id in hand from `findLiveArtifactByPath`) only start with an arbitrary
 *  Block/ArtifactNode target and need to find their way up to it. */
export function findEnclosingArtifactId(node: TreeNode): string | null {
  let current: TreeNode | undefined = node;
  while (current) {
    if (nodeKindFromId(current.id) === 'ArtifactNode') return current.id;
    if (nodeKindFromId(current.id) !== 'BlockNode') return null;
    current = current.parent;
  }
  return null;
}

/** Deliberately `extends TreeNode` directly, not `BlockNode` — unlike `ArtifactNode`, a folder was
 *  never merged with anything (a README's content already lived straight in `FolderNode.children`,
 *  no synthetic wrapper to begin with), and everything `BlockNode` would hand it — `type`/`parent`,
 *  a `serializeBlock`-based `toMarkdown`, `hydrateFromParsed`'s `ParsedBlockNode` parameter shape —
 *  is either unused or actively wrong (`hydrateFromParsed` below takes a `ParsedFolderNode`, a
 *  genuinely different shape — sharing `BlockNode`'s name would be a real override violation, not
 *  just close-enough polymorphism). `children` is declared independently here, the same
 *  `orderedContainment` shape `BlockNode` happens to also have, for its own reason: a folder's
 *  children are a genuine 3-way `BlockNode`/`FolderNode`/`ArtifactNode` mix, so `treeChildren`/
 *  `appendChild` are this class's own, never `BlockNode`'s homogeneous default. */
export class FolderNode extends TreeNode {
  declare path?: string;
  declare children?: TreeNode[];
  /** Same role as `ArtifactNode.projectedHash` (Aperas-crud-design.md §15) — hash of the README
   *  markdown `kg:project` last actually wrote for this folder. */
  declare projectedHash?: string;

  get treeChildren(): TreeNode[] {
    return this.children ?? [];
  }
  appendChild(childId: string): void {
    appendOrderedChild(this.store, this.id, childId);
  }

  /** Same as `BlockNode.insertChild` — a Folder's README content is ordered content too. */
  insertChild(childId: string, anchorId: string, side: 'before' | 'after'): void {
    insertOrderedChild(this.store, this.id, childId, anchorId, side);
    (wrap(this.store, childId) as unknown as BaseNode).holder = undefined;
  }

  /** `project.ts`'s old `projectFolderToReadme`'s render half, folded. Nested `FolderNode`/
   *  `ArtifactNode` children are structural, not textual content — filtered out here, keyed off
   *  `nodeKindFromId` rather than GraphQL's old `_type` tag. `text` (a derived abstract, copied
   *  from — not consumed out of — the README's own content, `folders.ts`'s `buildFolderTree`) is
   *  never re-emitted here: it already duplicates something present among `children`, so pushing
   *  it into the body too would print it twice. */
  toReadme(): string {
    const blockChildren = this.treeChildren.filter((c) => nodeKindFromId(c.id) === 'BlockNode');
    const lang = extractLangFromFrontmatter(getProp(this as unknown as HasProps, 'frontmatter'));
    const body = renderChildren({ children: blockChildren }, lang);
    return withFrontmatter(body, this);
  }

  /** `folders.ts`'s old `writeFolderTree`, folded — kept as its own method (not an override of
   *  `BlockNode.hydrateFromParsed`; `FolderNode` doesn't extend `BlockNode`) since a folder's
   *  children mix `BlockNode`/`FolderNode`/`ArtifactNode` 3-ways where a block's are homogeneous,
   *  and its own parameter shape (`ParsedFolderNode`) is genuinely different from a block's
   *  (`ParsedBlockNode`) regardless. `ArtifactNode` entries are bare reference ids already
   *  (`folders.ts`'s own `buildFolderTree` never inlines them), nothing to write for those here.
   *
   *  Always clears `this.holder` (Aperas-crud-design.md §6) — reaching this method at all means a
   *  real directory was found on disk at `this`'s own path (`ingestFolderTree`/`buildFolderTree`
   *  only ever call it for a folder the disk walk actually produced), so whatever `holder:true`
   *  this `FolderNode` carried from being an imagined intermediate segment
   *  (`resolveCreate.ts`'s scaffolding) is now stale — same reasoning and same fix as
   *  `BlockNode.hydrateFromParsed`'s own clear. Unrelated to the *children*-preservation loop
   *  below, which is about a still-unmatched holder *child* surviving this call, not about `this`
   *  node's own flag. */
  hydrateFromParsed(parsed: ParsedFolderNode): void {
    this.title = parsed.title;
    this.path = parsed.path;
    this.text = parsed.text ?? undefined;
    this.props = parsed.props?.length ? (parsed.props as unknown as ApeironNode[]) : undefined;
    this.holder = undefined;

    const ids: string[] = [];
    for (const child of parsed.children) {
      if (typeof child === 'string') {
        ids.push(child); // ArtifactNode reference
      } else if ((child as any)['@type'] === 'FolderNode') {
        const c = child as ParsedFolderNode;
        (wrap(this.store, `FolderNode:${c.folderId}`) as unknown as FolderNode).hydrateFromParsed(c);
        ids.push(`FolderNode:${c.folderId}`);
      } else {
        const c = child as ParsedBlockNode;
        (wrap(this.store, `BlockNode:${c.blockId}`) as unknown as BlockNode).hydrateFromParsed(c);
        ids.push(`BlockNode:${c.blockId}`);
      }
    }

    // Preserve any currently-attached holder before overwriting — a forward-reference placeholder
    // minted by `resolveDeepPathDetail`'s `createHolder` path (`resolveCreate.ts`), a pure graph
    // construct with no file on disk to correspond to. `buildFolderTree` only ever walks the real
    // filesystem, so `parsed.children` above structurally can never include one — without this,
    // every full-tree ingest (which runs this unconditionally, on every `kg:ingest`, even a
    // single unrelated file) would silently drop every holder's containment here on the very next
    // call after it's created, even though nothing about the holder itself changed. Kind-agnostic:
    // `createImaginedPrefix`'s own holder chain (an imagined ArtifactNode + wrapping FolderNodes,
    // for a reference that resolved nothing at all) is exactly as invisible to a disk walk as a
    // single holder BlockNode is.
    const newIds = new Set(ids);
    for (const existing of this.treeChildren) {
      if (newIds.has(existing.id)) continue;
      if ((existing as unknown as { holder?: boolean }).holder) ids.push(existing.id);
    }

    this.children = ids as unknown as TreeNode[];
  }
}

/** Leaf subdoc — data only (`target`/`predicate`/`props`), never a `this` for any migrated
 *  function. `props` (Aperas-apeironngn-design.md §4 Step 8) is a `LINK_SHAPE` field, not
 *  inherited — `Link` deliberately doesn't extend `BaseNode`. */
export class Link extends ApeironInstance {
  declare target?: TreeNode;
  declare predicate?: string;
  declare props?: ApeironNode[];
}

/** Leaf subdoc — data only (`key`/`value`), never a `this` for any migrated function. */
export class StringProp extends ApeironInstance {
  declare key?: string;
  declare value?: string;
}

/** Aperas-treeview-design.md §3/§6/§7/§11 — lightweight identity, still no auth: `handle` is the
 *  stable, human-chosen addressable slug (`kg:profile`'s own addressing, distinct from this
 *  instance's own opaque `ApeironInstance.id`), `name` a display label, `kind` an open/unenforced
 *  category ("human"/"agent" suggested, not enforced — `Optional`, so "not yet known" is just
 *  left unset rather than needing its own sentinel value), `preferences` an arbitrary
 *  key/value bag (same `Set<StringProp>` shape as `BlockNode.props`, not the same field). No
 *  `views` field — a `Profile`'s owned `TreeView`s are `backlinks(store, id, 'profile')`. */
export class Profile extends ApeironInstance {
  declare handle?: string;
  declare name?: string;
  declare kind?: string;
  declare preferences?: ApeironNode[]; // StringProp
}

/** Aperas-treeview-design.md §3-§6 — an i-view: a lens over the one real `TreeNode`/`Link` graph.
 *  `unfolds` replaces the old per-node `BaseNode.unfolded` flag — fold state lives here, per view,
 *  not as a single flag every viewer shares. */
export class TreeView extends ApeironInstance {
  declare profile?: Profile;
  declare name?: string;
  declare unfolds?: ApeironNode[]; // mixed TreeNode | Link

  /** Adds exactly `ref` (a `TreeNode` or `Link` id) to this view's `unfolds` set — idempotent, and
   *  *only* `ref` (Aperas-treeview-design.md §5 — an earlier draft of that design wrongly proposed
   *  also adding every child/link; the real behavior matches the old single-flag `setUnfolded`). */
  unfold(ref: string): void {
    const current = (this.unfolds as unknown as ApeironNode[] | undefined) ?? [];
    if (current.some((n) => n.id === ref)) return;
    this.unfolds = [...current, ref as unknown as ApeironNode];
  }

  /** Removes `ref`'s own `unfolds` entry, cascading to remove anything reached *from* `ref`
   *  (structural children, then `ref`'s own links) that also has its own explicit entry — folding
   *  one path to a node doesn't fold every path to it: a `Link` elsewhere, unrelated to `ref`'s own
   *  subtree, that happens to also reach into it is left untouched (Aperas-treeview-design.md §5).
   *  Walks the full structural+link subtree under `ref` regardless of whether each node along the
   *  way is itself unfolded (an intermediate breadcrumb-only node still needs walking through to
   *  reach a deeper unfolded descendant) — a `visited` guard keeps this safe against a link cycle. */
  fold(ref: string): void {
    const current = ((this.unfolds as unknown as ApeironNode[] | undefined) ?? []).map((n) => n.id);
    const currentSet = new Set(current);
    const toRemove = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visited.has(id)) return;
      visited.add(id);
      if (currentSet.has(id)) toRemove.add(id);
      if (nodeKindFromId(id) === 'Link') return; // no further structure of its own to cascade into
      const node = wrap(this.store, id) as unknown as TreeNode;
      for (const child of node.treeChildren) visit(child.id);
      for (const link of (node.links as ApeironNode[] | undefined) ?? []) visit(link.id);
    };
    visit(ref);
    this.unfolds = current.filter((id) => !toRemove.has(id)).map((id) => id as unknown as ApeironNode);
  }
}

export const CLASS_BY_KIND: Record<string, typeof ApeironInstance> = {
  BlockNode,
  ArtifactNode,
  FolderNode,
  Link,
  StringProp,
  Profile,
  TreeView,
};

export function classForId(id: string): typeof ApeironInstance {
  const kind = nodeKindFromId(id);
  const Cls = CLASS_BY_KIND[kind];
  if (!Cls) throw new Error(`ApeironNgn: no class registered for node kind '${kind}' (id '${id}').`);
  return Cls;
}

// ---------------------------------------------------------------------------------------------
// Accessor generation — one real get/set property per SHAPE field, per leaf class.
// ---------------------------------------------------------------------------------------------

function defineAccessors(Cls: { prototype: object }, shape: ClassShape): void {
  for (const [field, spec] of Object.entries(shape)) {
    Object.defineProperty(Cls.prototype, field, {
      configurable: true,
      enumerable: true,
      get(this: ApeironInstance) {
        return readField(this.store, this.id, field, spec);
      },
      set(this: ApeironInstance, value: unknown) {
        writeField(this.store, this.id, field, spec, value);
      },
    });
  }
}

defineAccessors(BlockNode, BLOCK_NODE_SHAPE);
defineAccessors(ArtifactNode, ARTIFACT_NODE_SHAPE);
defineAccessors(FolderNode, FOLDER_NODE_SHAPE);
defineAccessors(Link, LINK_SHAPE);
defineAccessors(StringProp, PROP_SHAPE);
defineAccessors(Profile, PROFILE_SHAPE);
defineAccessors(TreeView, TREE_VIEW_SHAPE);

/** `(tombstoned)` marker for a node's rendered title line — every render site below shares it.
 *  Tombstoning (`applyTombstone`/`tombstoneLiveSubtree`, §5) clears a dead node's own `children`/
 *  `links`/`props` but never sweeps *other* documents' references to it, and actively re-sets
 *  `title` to its last-known value rather than clearing it — so a tombstoned node reached through a
 *  stale `children` pointer, or through a still-live `Link.target` elsewhere, used to render
 *  identically to a live one, with no signal anything had died (confirmed by tracing every render
 *  path — Aperas-apeironngn-design.md §5). */
function tombstoneTag(node: { tombstonedAt?: string }): string {
  return node.tombstonedAt ? '  (tombstoned)' : '';
}

/** Renders one line per node plus its subtree, title-only, always recursing (`maxDepth`/
 *  `noHolders` aside) — `TreeNode.renderTree`'s plain default when no `TreeOptions.view` is
 *  supplied. Kept as a module-scope function rather than a method so the recursion doesn't need to
 *  thread `lines`/`depth` through the public single-argument method signature. */
function renderTreeLines(node: TreeNode, depth: number, opts: TreeOptions, lines: string[]): void {
  const id = node.id;
  if (node.title === undefined) {
    lines.push(`${'│ '.repeat(depth)}${id}  [?]  <not found>`);
    return;
  }
  const isLiteralHolder = node.holder === true;
  const hidden = opts.noHolders === true && isLiteralHolder;
  if (!hidden) {
    const indent = '│ '.repeat(depth);
    const holderTag = isLiteralHolder ? '  (holder)' : '';
    lines.push(`${indent}${id}  [${displayLabel(id, node)}]  ${node.title}${holderTag}${tombstoneTag(node)}`);
  }

  const refs = node.treeChildren;
  const childDepth = hidden ? depth : depth + 1;
  if (!hidden && opts.maxDepth !== undefined && depth >= opts.maxDepth) {
    if (refs.length > 0) lines.push(`${'│ '.repeat(depth + 1)}…`);
    return;
  }
  for (const child of refs) {
    renderTreeLines(child, childDepth, opts, lines);
  }
}

// ---------------------------------------------------------------------------------------------
// View-based rendering (Aperas-treeview-design.md §4-§6) — walks the real TreeNode/Link graph,
// consulting a TreeView's `unfolds` membership at each hop. No separate view-time node type: a
// TreeView is a lens, not a parallel structure.
// ---------------------------------------------------------------------------------------------

/** Generic structural up-pointer, one hop — now a uniform `.parent` read for any kind
 *  (Aperas-apeironngn-design.md §5's `parent`/`PARENT_PRED` merge: every `TreeNode` gets it,
 *  populated automatically by whichever container's `children` write included this id). `null`
 *  means top-level (whatever `kg:tree` was pointed at — this doc's "Root"). */
function structuralParentOf(store: Store, id: string): string | null {
  const p = (wrap(store, id) as unknown as TreeNode).parent;
  return p ? p.id : null;
}

/** The one `TreeNode` a `Link` belongs to — reverse-queries the `links` predicate pointing at the
 *  link's own id, rather than parsing it out of the id string (`${ownerId}/links/Link/<snowflake>`)
 *  directly, matching how every other relational lookup in this file works. Exported for
 *  `kgBacklinks.ts`'s own reverse-lookup use (Aperas-apeironngn-design.md §4 Step 13), alongside
 *  this file's own view-rendering use above. */
export function ownerOfLink(store: Store, linkId: string): string | null {
  const m = store.match(null, predIri('links'), nodeIri(linkId), null);
  return m.length > 0 && isNamedNodeTerm(m[0].subject) ? idFromNodeIri(m[0].subject.value) : null;
}

/** `'upward'` (§13.3): the target is an ancestor of some cone already active in the current
 *  discovery chain — escaping to it would re-subsume territory that cone already covers, rather
 *  than reach genuinely new territory, so it's never given a nested cone at all; rendered as a
 *  flat, non-recursing reference instead of either a `home` or a normal `link` full expansion. */
type CanonicalPosition = { kind: 'home' } | { kind: 'link'; linkId: string } | { kind: 'upward' };

/** Whether `id` sits inside apex `apexId`'s viewcone — its entire structural subtree, `apexId`
 *  itself included (Aperas-treeview-design.md §13). Walks `.parent` up from `id`; `apexId` is
 *  reached (true) or the real top is reached without ever finding it (false). */
function isInCone(store: Store, id: string, apexId: string): boolean {
  let current: string | null = id;
  while (current !== null) {
    if (current === apexId) return true;
    current = structuralParentOf(store, current);
  }
  return false;
}

/** One node/`Link` from a `TreeView.unfolds`, resolved once up front and reused across every cone a
 *  render visits (§13 recurses into as many nested cones as there are escaping unfolded links —
 *  cheaper to resolve `Link.target`/`ownerOfLink` a single time than per cone). */
interface UnfoldedLinkEntry { linkId: string; ownerId: string; targetId: string }

/** One viewcone's own local render plan (§13): which of the view's `unfolds` entries actually sit
 *  inside this cone, and — for each such `Link` whose target escapes the cone — the nested cone it
 *  spawned, if this is the link that won the target (§13.2); an escaping link with no entry here
 *  lost that target to an earlier-discovered cone and renders as a plain pointer instead. */
interface ConeInfo {
  apexId: string;
  /** Ids inside this cone with their own `unfolds` entry, plus `apexId` itself, always — "the
   *  apex is always unfolded in its own cone" generalizes §4's "Root is always unfolded." */
  unfoldedTreeIds: Set<string>;
  /** Every `Link` in `unfolds` whose *owner* sits inside this cone — target may be inside (resolved
   *  right here) or outside (escapes; see `nestedCones`) this same cone. */
  linkEntries: Map<string, UnfoldedLinkEntry>;
  /** ancestorId -> immediate child ids that must render as breadcrumb passthrough — scoped to this
   *  cone alone; the walk stops at `apexId`, never crossing into whatever (if anything) sits above
   *  it, which is a different cone's concern, if it's part of this render at all (§4/§5/§13). */
  neededChildren: Map<string, Set<string>>;
  /** escaping linkId -> the nested `ConeInfo` zoomed to its target, present only when this link is
   *  the one that claimed that target (§13.2); absent means a container (or an equally unrelated,
   *  earlier-discovered cone) already claimed it first — rendered as a pointer, no recursion. */
  nestedCones: Map<string, ConeInfo>;
}

/** Shared across every cone a single render visits — this is what makes canonical-home resolution
 *  span cones at all (§13.2): "home always wins within its own cone" falls out of `discoverCone`
 *  registering every one of *its* structural homes before considering any of *its* links; "a
 *  container's claim beats its own nested cone's" falls out of a container's `discoverCone` call
 *  always completing (and thus registering its claims) before it ever recurses into a cone nested
 *  inside it; and "otherwise, whichever's discovered first, by luck" (§10) falls out of there being
 *  exactly one shared map for the whole recursive discovery, not one map per cone. */
interface ZoomState {
  canonical: Map<string, CanonicalPosition>;
  attemptCount: Map<string, number>;
}

/** Pass 1 of the (now recursive) 2-pass algorithm (§6/§13): discovers one cone's own render plan
 *  and, for each of its escaping links that wins its target, recurses to discover the nested cone
 *  zoomed to it — before any line is emitted anywhere. Kept fully separate from emission (pass 2,
 *  `emitNode`/`emitLinkLine` below) specifically so a target's `[*]` "reachable more than once" tag
 *  is never decided before every cone that might reach it — including one nested many levels deeper
 *  — has actually been discovered; deciding it eagerly, cone by cone, would risk a line already
 *  emitted turning out to deserve a tag it didn't get. */
function discoverCone(
  store: Store, allUnfoldedIds: string[], allLinkEntries: UnfoldedLinkEntry[], apexId: string, zs: ZoomState,
  isTopLevelApex = false, activeChain: readonly string[] = [],
): ConeInfo {
  // Every apex from the render's own initial cone down to this one, inclusive — the chain of
  // territory already being (or about to be) discovered. An escaping link whose target is an
  // ancestor of *any* of these (§13.3) points backward into that territory, not outward into
  // something new.
  const chainWithSelf = [...activeChain, apexId];

  const unfoldedTreeIds = new Set<string>();
  for (const id of allUnfoldedIds) if (isInCone(store, id, apexId)) unfoldedTreeIds.add(id);

  const linkEntries = new Map<string, UnfoldedLinkEntry>();
  for (const entry of allLinkEntries) if (isInCone(store, entry.ownerId, apexId)) linkEntries.set(entry.linkId, entry);

  // Computed before the link-resolution loop below (moved up from its old position after it) so
  // that loop can already ask "does this target get printed at its own structural position at all,
  // genuinely unfolded or not" — `hasStructuralPresence` just below.
  const neededChildren = new Map<string, Set<string>>();
  const markPath = (leafId: string): void => {
    let child = leafId;
    let parent = structuralParentOf(store, child);
    while (child !== apexId && parent !== null) {
      let set = neededChildren.get(parent);
      if (!set) { set = new Set(); neededChildren.set(parent, set); }
      if (set.has(child)) break; // already marked from here up — rest of the chain is too
      set.add(child);
      child = parent;
      parent = structuralParentOf(store, child);
    }
  };
  for (const id of unfoldedTreeIds) markPath(id);
  for (const { ownerId } of linkEntries.values()) markPath(ownerId);

  // §6: a node's structural position is its one true home whenever it's actually going to be
  // printed there for *any* reason — genuinely unfolded, a preview child of a genuinely-unfolded
  // parent, or merely a breadcrumb passthrough carrying the path to something else genuinely
  // unfolded beneath it. `neededChildren` (just built) already answers "will this print here."
  function hasStructuralPresence(id: string): boolean {
    if (id === apexId) return true;
    const parent = structuralParentOf(store, id);
    return parent !== null && (neededChildren.get(parent)?.has(id) ?? false);
  }

  // Every structural home in this cone, registered unconditionally before any link is considered —
  // this is the whole mechanism behind "within one viewcone, canon is the structural [position]":
  // a link inside the same cone can never win a target whose home is also inside it, regardless of
  // which one this loop or the next happens to visit first. The top-level apex (kg:tree's own
  // `<path>` argument, or the global Root default) always has a real structural home of its own —
  // even when it isn't itself genuinely unfolded (§13's `1{title,abstract}` is shown regardless of
  // `unfolds` membership) — and nothing else ever registers it, so it's added here explicitly, kept
  // deliberately out of `unfoldedTreeIds` itself (that set drives `emitNode`'s display tiering, and
  // the apex being previewed on its own line must never cascade "genuinely unfolded" status down
  // onto its children — only the apex's own line gets the unconditional preview, per §13's worked
  // example). A *nested* cone's apex is different: it's always a rule-b link's target, and the
  // link-entries loop below that discovers the escape already registers its home/attempt *before*
  // recursing here (lines just below) — adding it again on this side would double-count that one
  // real path and could wrongly trigger the `[*]` tie-break star.
  const homes = isTopLevelApex ? new Set([...unfoldedTreeIds, apexId]) : unfoldedTreeIds;
  for (const id of homes) {
    zs.attemptCount.set(id, (zs.attemptCount.get(id) ?? 0) + 1);
    if (!zs.canonical.has(id)) zs.canonical.set(id, { kind: 'home' });
  }

  const nestedCones = new Map<string, ConeInfo>();
  for (const [linkId, { targetId }] of linkEntries) {
    zs.attemptCount.set(targetId, (zs.attemptCount.get(targetId) ?? 0) + 1);
    if (isInCone(store, targetId, apexId)) {
      // In-cone: §6's rule, scoped to this cone alone. If the target already gets printed at its
      // own structural position for any reason (`hasStructuralPresence`), that position is home and
      // always wins, even at bare title-only tier — a `Link` recursing on top of it would just
      // duplicate content the structural position's own passthrough chain already shows. Only when
      // the target has no reason to appear here at all does the `Link` win uncontested.
      if (!zs.canonical.has(targetId)) {
        if (hasStructuralPresence(targetId)) {
          zs.canonical.set(targetId, { kind: 'home' });
          // Credits the structural home itself as a distinct claimant, on top of the link's own
          // attempt already counted above — without this, attemptCount never crosses 1 and the
          // `[*]`/`[*see ...]` pair never fires for this newly-recognized (not genuinely-unfolded)
          // home case.
          zs.attemptCount.set(targetId, (zs.attemptCount.get(targetId) ?? 0) + 1);
        } else {
          zs.canonical.set(targetId, { kind: 'link', linkId });
        }
      }
      continue;
    }
    // Escapes this cone (§13). Already claimed — by a container cone (discovered and thus
    // resolved before this one ever started), or by an unrelated cone discovered earlier in this
    // same traversal (§10's "luck," now spanning cones) — means this link renders as a pointer in
    // pass 2; nothing further to do. Not yet claimed: before zooming to it, check whether it's an
    // upward jump (§13.3) rather than genuinely new territory — an escape *into* a cone already
    // active in this same chain (an ancestor of it, or the cone itself) would just re-derive
    // territory that cone already owns, and — if that target ever becomes canonical elsewhere —
    // recurse straight back down through it, duplicating content §6 already fixed once.
    if (!zs.canonical.has(targetId)) {
      const isUpwardJump = chainWithSelf.some((activeId) => isInCone(store, activeId, targetId));
      if (isUpwardJump) {
        zs.canonical.set(targetId, { kind: 'upward' });
      } else {
        zs.canonical.set(targetId, { kind: 'link', linkId });
        nestedCones.set(linkId, discoverCone(store, allUnfoldedIds, allLinkEntries, targetId, zs, false, chainWithSelf));
      }
    }
  }

  return { apexId, unfoldedTreeIds, linkEntries, neededChildren, nestedCones };
}

/** One `TreeNode`'s line plus whatever it reveals beneath it — the three own-line tiers plus
 *  breadcrumb-passthrough child pruning (§5). `parentQualifiesForPreview` is true for the starting
 *  node and for any node reached as the plain listed child of a genuinely-unfolded parent; false
 *  for a node reached only as a breadcrumb link in someone else's chain (§5's tier-3, bare title).
 *  Structural children always stay within `cone` (a cone's own subtree can't cross a cone
 *  boundary — that's exactly what makes it a cone, §13); only `emitLinkLine` ever switches to a
 *  different (nested) `ConeInfo`. */
function emitNode(
  store: Store, id: string, cone: ConeInfo, depth: number, opts: TreeOptions,
  zs: ZoomState, starred: Set<string>, parentQualifiesForPreview: boolean, lines: string[],
): void {
  const node = wrap(store, id) as unknown as TreeNode;
  if (node.title === undefined) {
    lines.push(`${'│ '.repeat(depth)}${id}  [?]  <not found>`);
    return;
  }
  const isLiteralHolder = node.holder === true;
  const hidden = opts.noHolders === true && isLiteralHolder;
  const isGenuinelyUnfolded = cone.unfoldedTreeIds.has(id);
  // tier 1 (genuinely unfolded, regardless of parent) or tier 2 (parent qualifies) -> title+abstract;
  // tier 3 (bare breadcrumb) -> title alone. Previously just `parentQualifiesForPreview`, which
  // wrongly demoted a genuinely-unfolded node reached through a non-qualifying parent to tier 3.
  const showAbstract = parentQualifiesForPreview || isGenuinelyUnfolded;

  const childDepth = hidden ? depth : depth + 1;
  const childrenToShow = isGenuinelyUnfolded
    ? node.treeChildren
    : node.treeChildren.filter((c) => cone.neededChildren.get(id)?.has(c.id));
  const linksToShow = isGenuinelyUnfolded ? ((node.links as ApeironNode[] | undefined) ?? []) : [];

  if (!hidden) {
    const indent = '│ '.repeat(depth);
    const holderTag = isLiteralHolder ? '  (holder)' : '';
    const star = starred.has(id) ? '  [*]' : '';
    const isTextlessList = nodeKindFromId(id) === 'BlockNode' && (node as unknown as BlockNode).type === 'list';
    // `{title, abstract}` means both, on the same line -- not one or the other. `node.text` is
    // truncated here (not just at ingest time) as a safety net for an ordinary BlockNode's own
    // long paragraph, which `extractAbstract`'s ingest-time truncation never touches (that's real
    // authored content `kg:project` must reproduce exactly, not a derived preview). Separated by
    // `║` rather than plain whitespace — both are free-form prose, so a script splitting the line
    // on the first double-space (as it safely can for the `id`/`[kind]`/content fields, which
    // aren't free text) can't also assume where title ends and abstract begins.
    let content = node.title as string;
    if (showAbstract) {
      const abstract = isTextlessList
        ? `(no text of its own — see kg:unfold ${id})`
        : node.text !== undefined ? truncateForPreviewWithHint(node.text as unknown as string, id) : undefined;
      if (abstract !== undefined) content = `${node.title}  ║  ${abstract}`;
    }
    // Fold state, GUI-icon-equivalent: how much of this node's own real children/links isn't being
    // shown at this position — omitted entirely when nothing is hidden (a leaf has nothing to
    // fold; a genuinely-unfolded node with everything visible needs no flag either), same
    // "no tag when there's nothing to say" posture as `holderTag`/`star`/`tombstoneTag`.
    const hiddenCount = (node.treeChildren.length - childrenToShow.length)
      + (((node.links as ApeironNode[] | undefined)?.length ?? 0) - linksToShow.length);
    const foldTag = hiddenCount > 0 ? `  [+${hiddenCount}]` : '';
    lines.push(`${indent}${id}  [${displayLabel(id, node)}]  ${content}${holderTag}${star}${tombstoneTag(node)}${foldTag}`);
  }

  if (!hidden && opts.maxDepth !== undefined && depth >= opts.maxDepth) {
    if (childrenToShow.length > 0 || linksToShow.length > 0) lines.push(`${'│ '.repeat(depth + 1)}…`);
    return;
  }

  for (const child of childrenToShow) {
    emitNode(store, child.id, cone, childDepth, opts, zs, starred, isGenuinelyUnfolded, lines);
  }
  for (const link of linksToShow) {
    emitLinkLine(store, link.id, cone, childDepth, opts, zs, starred, lines);
  }
}

/** One `Link`'s line: a plain preview (target's title/abstract, no recursion) when the link itself
 *  isn't in `unfolds`; the target shown fully — like an unfolded `TreeNode`, §5 rule b — when it's
 *  in `unfolds` *and* it's the canonical position for that target, recursing in whichever `ConeInfo`
 *  actually owns the target (this same cone if the target's inside it, a nested one if it escaped
 *  and this link is what won it, §13); a short pointer back to wherever the canonical position
 *  actually is, otherwise (§6/§13.2). */
function emitLinkLine(
  store: Store, linkId: string, cone: ConeInfo, depth: number, opts: TreeOptions,
  zs: ZoomState, starred: Set<string>, lines: string[],
): void {
  const link = wrap(store, linkId) as unknown as Link;
  const targetId = (link.target as unknown as TreeNode | undefined)?.id;
  const indent = '│ '.repeat(depth);
  const predicate = (link.predicate as unknown as string) ?? '';
  if (!targetId) {
    lines.push(`${indent}${linkId}  [Link]  ${predicate}  <no target>`);
    return;
  }
  const targetNode = wrap(store, targetId) as unknown as TreeNode;
  const targetTitle = targetNode.title ?? '<not found>';
  // `{title, abstract}` for a preview or a "shown fully" position (§5 rule b) -- but the pointer
  // branch below stays title-only by design (it's a cross-reference note, not a content preview;
  // "a pointer line keeps the normal id [kind] title prefix", never an abstract).
  const targetAbstract = targetNode.text !== undefined ? truncateForPreviewWithHint(targetNode.text as unknown as string, targetId) : undefined;
  const targetPreview = targetAbstract !== undefined ? `${targetTitle}  ║  ${targetAbstract}` : targetTitle;
  const deadTag = tombstoneTag(targetNode);
  const head = `${indent}${linkId}  [Link]  ${predicate} → ${targetId}  `;

  if (!cone.linkEntries.has(linkId)) {
    // rule a only — a flat, one-hop preview, never subject to dedup (§4): none of the target's own
    // children/links are shown here, so (unlike the "canonical, full render" branch below, where
    // they're always all emitted) this position's fold tag is never omitted when the target has
    // any real content of its own.
    const hiddenCount = targetNode.treeChildren.length + ((targetNode.links as ApeironNode[] | undefined)?.length ?? 0);
    const foldTag = hiddenCount > 0 ? `  [+${hiddenCount}]` : '';
    lines.push(`${head}${targetPreview}${deadTag}${foldTag}`);
    return;
  }
  const canon = zs.canonical.get(targetId);
  const isCanonicalHere = canon?.kind === 'link' && canon.linkId === linkId;
  if (isCanonicalHere) {
    const star = starred.has(linkId) ? '  [*]' : '';
    lines.push(`${head}${targetPreview}${star}${deadTag}`);
    // In-cone win: `targetId` is inside `cone` itself, so its children/links render in `cone` too.
    // Escaping win: `targetId` got its own nested cone (§13), spawned exactly for this link.
    const targetCone = cone.nestedCones.get(linkId) ?? cone;
    for (const child of targetNode.treeChildren) emitNode(store, child.id, targetCone, depth + 1, opts, zs, starred, true, lines);
    for (const l of (targetNode.links as ApeironNode[] | undefined) ?? []) emitLinkLine(store, l.id, targetCone, depth + 1, opts, zs, starred, lines);
    return;
  }
  if (canon?.kind === 'upward') {
    // §13.3: an upward jump into a cone already active in the current discovery chain — no
    // recursion (it would just re-derive/re-emit territory that cone already covers), and no
    // pointer either (there's nothing already rendered at *this* target's own position to point
    // at — unlike `home`/`link`, `upward` never claims a position anywhere). Flat, non-recursing
    // reference instead, same shape as a rule-a preview, tagged to explain why it stops here.
    const hiddenCount = targetNode.treeChildren.length + ((targetNode.links as ApeironNode[] | undefined)?.length ?? 0);
    const foldTag = hiddenCount > 0 ? `  [+${hiddenCount}]` : '';
    lines.push(`${head}${targetPreview}${deadTag}${foldTag}  (outside view)`);
    return;
  }
  const pointerTo = canon?.kind === 'home' ? (targetNode.toPath() ?? targetId) : `${canon?.linkId ?? targetId} (link)`;
  lines.push(`${head}${targetTitle}${deadTag}  [*see ${pointerTo}]`);
}

/** `TreeNode.renderTree`'s `opts.view` branch — entry point for the whole view-based render
 *  (Aperas-treeview-design.md §4-§6, generalized to an arbitrary apex and recursive nested cones by
 *  §13's Viewcone Zoom: `rootId` need not be the global root — zooming to it degenerates to
 *  exactly today's flat render only when it *is*, since nothing can ever escape that cone, §13). */
function renderTreeWithView(store: Store, rootId: string, view: TreeView, opts: TreeOptions): string[] {
  const unfoldsWrapped = (view.unfolds as unknown as ApeironNode[] | undefined) ?? [];
  const allUnfoldedIds: string[] = [];
  const allLinkEntries: UnfoldedLinkEntry[] = [];
  for (const n of unfoldsWrapped) {
    if (nodeKindFromId(n.id) === 'Link') {
      const targetId = ((n as unknown as Link).target as unknown as TreeNode | undefined)?.id;
      const ownerId = ownerOfLink(store, n.id);
      if (targetId && ownerId) allLinkEntries.push({ linkId: n.id, ownerId, targetId });
    } else {
      allUnfoldedIds.push(n.id);
    }
  }

  const zs: ZoomState = { canonical: new Map(), attemptCount: new Map() };
  const rootCone = discoverCone(store, allUnfoldedIds, allLinkEntries, rootId, zs, true);
  const starred = new Set<string>();
  for (const [id, count] of zs.attemptCount) {
    if (count <= 1) continue;
    const c = zs.canonical.get(id)!;
    if (c.kind === 'upward') continue; // declining to recurse isn't a tie to flag (§13.3)
    starred.add(c.kind === 'home' ? id : c.linkId);
  }

  const lines: string[] = [];
  emitNode(store, rootId, rootCone, 0, opts, zs, starred, true, lines);
  return lines;
}

/** Finds a `Profile` by its `handle` (Aperas-treeview-design.md §11) — exact-literal lookup, same
 *  pattern as `ensureDefaultView`'s/`resolveTreeView`'s own `name` lookups. `kg:profile`'s own
 *  addressing: every subcommand takes a `handle`, never a raw node id. */
export function findProfileByHandle(store: Store, handle: string): Profile | null {
  const found = store.match(null, predIri('handle'), encodeLiteral(handle), null)
    .map((m) => idFromNodeIri(String(m.subject.value)))
    .find((id) => nodeKindFromId(id) === 'Profile');
  return found ? (wrap(store, found) as unknown as Profile) : null;
}

/** Finds a `TreeView` by its `name` (Aperas-treeview-design.md §11 — tightened from `Optional` to
 *  `One`, and now globally unique, the same "stable addressable handle" role `Profile.handle`
 *  plays). Exact-literal lookup, same pattern as `findProfileByHandle`. */
export function findTreeViewByName(store: Store, name: string): TreeView | null {
  const found = store.match(null, predIri('name'), encodeLiteral(name), null)
    .map((m) => idFromNodeIri(String(m.subject.value)))
    .find((id) => nodeKindFromId(id) === 'TreeView');
  return found ? (wrap(store, found) as unknown as TreeView) : null;
}

/** `kg:profile create-view` (Aperas-treeview-design.md §11) — mints a new, empty `TreeView` owned
 *  by an already-existing `Profile`. Unlike `ensureDefaultView`, never auto-creates the owning
 *  `Profile` — a view's owner must be set up first, same "no implicit creation" posture
 *  `kg:profile create` itself already takes. Rejects a duplicate `name`, the same uniqueness check
 *  `runProfileCreate` already applies to `handle`. */
export function createTreeView(store: Store, name: string, profileHandle: string): { id: string } {
  if (findTreeViewByName(store, name)) throw new Error(`TreeView '${name}' already exists.`);
  const profile = findProfileByHandle(store, profileHandle);
  if (!profile) throw new Error(`Profile '${profileHandle}' not found.`);
  const id = `TreeView:${generateNodeId()}`;
  const view = wrap(store, id) as unknown as TreeView;
  view.name = name;
  view.profile = profile.id as unknown as Profile;
  return { id };
}

/** `kg:profile remove-view` (Aperas-treeview-design.md §11) — deletes exactly one `TreeView` by
 *  `name`, without touching its owning `Profile` — the single-view counterpart to `removeProfile`'s
 *  all-at-once cascade. */
export function removeTreeViewByName(store: Store, name: string): { removed: boolean } {
  const view = findTreeViewByName(store, name);
  if (!view) return { removed: false };
  hardDeleteNode(store, view.id);
  return { removed: true };
}

/** Finds the `TreeView` named `"default"` (Aperas-treeview-design.md §10), creating it — and a
 *  `Profile` with `handle: "default"` to own it — on first use. The one deliberate exception to
 *  `createTreeView`'s "owner must already exist" rule. */
export function ensureDefaultView(store: Store): TreeView {
  const existing = findTreeViewByName(store, 'default');
  if (existing) return existing;

  const existingProfile = findProfileByHandle(store, 'default');
  const profileId = existingProfile?.id ?? `Profile:${generateNodeId()}`;
  if (!existingProfile) {
    const profile = wrap(store, profileId) as unknown as Profile;
    profile.handle = 'default';
    // `kind` stays unset — `Optional`, so "not yet known" doesn't need a sentinel value.
  }

  const viewId = `TreeView:${generateNodeId()}`;
  const view = wrap(store, viewId) as unknown as TreeView;
  view.name = 'default';
  view.profile = profileId as unknown as Profile;
  return view;
}

/** Resolves a `--view <viewRef>`-style CLI/service argument to a `TreeView` — every call site that
 *  used to do `viewRef !== undefined ? wrap(store, viewRef) : ensureDefaultView(store)` treated a
 *  supplied `viewRef` as a raw node id only, so the one name every doc comment advertises as always
 *  resolvable (`"default"`, the same name `ensureDefaultView` itself mints) failed to resolve when
 *  a caller actually typed it (`nodeExists(store, 'default')` is false — `'default'` isn't an id).
 *  Accepts, in order: `undefined` or the literal name `"default"` (both go through
 *  `ensureDefaultView`, so `--view default` behaves exactly like omitting `--view`, including
 *  first-use creation); a real `TreeView` id; or any other view's `name` (exact-literal lookup, the
 *  same pattern `ensureDefaultView` uses for its own name). Throws with the ref quoted verbatim if
 *  none of those match, rather than falling through to `wrap`'s own unrelated error. */
export function resolveTreeView(store: Store, ref?: string): TreeView {
  if (ref === undefined || ref === 'default') return ensureDefaultView(store);
  if (nodeExists(store, ref) && nodeKindFromId(ref) === 'TreeView') return wrap(store, ref) as unknown as TreeView;
  const byName = findTreeViewByName(store, ref);
  if (byName) return byName;
  throw new Error(`TreeView '${ref}' not found.`);
}

/** Wraps one node id as a shape-enforced instance of its concrete class — no `Proxy`. `Object.seal`
 *  is what preserves "an unknown field read returns `undefined`, an unknown field write throws"
 *  (see this file's own doc comment). */
export function wrap(store: Store, id: string): ApeironNode {
  const Cls = classForId(id);
  const instance = new Cls(store, id);
  Object.seal(instance);
  return instance as unknown as ApeironNode;
}

/** The general backlink pattern (Aperas-kg-foundational-design.md §3.2): every subject with
 *  `field` pointing at this node, regardless of whether `field` is reified containment or a plain
 *  reference — the one query shape `parentId`/`resolveIdToPath`'s reverse-lookup gap under
 *  TerminusDB had no equivalent for. */
export function backlinks(store: Store, id: string, field: string): ApeironNode[] {
  return store.match(null, predIri(field), nodeIri(id), null).map((m) => wrap(store, idFromNodeIri(String(m.subject.value))));
}

/** Mark-and-sweep GC for tombstoned top-level documents (`BlockNode`/`ArtifactNode`/`FolderNode`)
 *  that have become fully unreferenced (Aperas-apeironngn-design.md §5) — resolving the "hard half"
 *  of the Link-tombstone open question one level up, at the top-level-node scope. An earlier design
 *  considered here checked each tombstoned candidate for *any* incoming reference, dead or alive,
 *  and was rejected for the same reason refcounting can't collect a cycle: a cluster of mutually-
 *  referencing tombstoned nodes would each show a nonzero referrer count forever, from each other,
 *  even with nothing live pointing in from outside. Real mark-and-sweep instead: the mark phase
 *  starts from every *live* (`!tombstonedAt`) `ArtifactNode`/`FolderNode` — the only genuine roots,
 *  since a live `BlockNode` is always reachable transitively through its owning artifact — and walks
 *  `treeChildren` (structural descent, kind-agnostic) plus each visited node's own `Link.target`s
 *  (the one non-structural edge a tombstoned node can still be kept alive by, e.g. a still-live
 *  manual `kg:link` elsewhere — which is exactly why `kg:unlink`, not just this GC, is needed to ever
 *  let such a node go). Anything tombstoned that's never marked — including a whole disconnected
 *  dead cluster — is genuinely unreachable and gets `hardDeleteNode`d, which also sweeps its own
 *  `unfolds` entries via `removeDanglingUnfolds`.
 *
 *  Mutates the *live* store directly (not just filtering what a subsequent dehydrate writes), so
 *  both `dehydrateToJsonLd` and the separate `dehydrateStateToJsonLd` (over `TreeView`/`Profile`)
 *  see a consistent post-prune state without either needing its own special-casing — the same eager-
 *  cleanup rationale `hardDeleteNode`'s own doc comment gives for WASM's grow-only memory applies
 *  here too, just at a coarser grain. Meant to run as an explicit sweep (`service.ts`'s
 *  `reloadStore`/`clobberFlush`, both of which always flush *both* mirrors together) rather than
 *  after every mutation — cheap only in bulk, unlike `hardDeleteNode`'s own per-write embed
 *  cleanup. */
export function pruneUnreachableTombstones(store: Store): { pruned: number } {
  const live = new Set<string>();

  const mark = (node: TreeNode): void => {
    if (live.has(node.id)) return;
    live.add(node.id);
    for (const child of node.treeChildren) mark(child);
    for (const link of (node.links as unknown as Link[] | undefined) ?? []) {
      if (link.target) mark(link.target);
    }
  };

  for (const kind of ['ArtifactNode', 'FolderNode'] as const) {
    for (const id of allIdsOfKind(store, kind)) {
      const node = wrap(store, id) as unknown as TreeNode;
      if (!node.tombstonedAt) mark(node);
    }
  }

  let pruned = 0;
  for (const kind of ['BlockNode', 'ArtifactNode', 'FolderNode'] as const) {
    for (const id of allIdsOfKind(store, kind)) {
      if (live.has(id)) continue;
      const node = wrap(store, id) as unknown as TreeNode;
      if (!node.tombstonedAt) continue; // never tombstoned — not a GC candidate regardless of reachability
      hardDeleteNode(store, id);
      pruned++;
    }
  }
  return { pruned };
}

/** `kg:profile remove` (Aperas-treeview-design.md §11) — cascade-deletes every `TreeView` a
 *  `Profile` owns before removing the `Profile` itself, via the same private `hardDeleteNode`
 *  primitive `pruneUnreachableTombstones` (above) already uses. A `Profile` gone with its
 *  `TreeView`s left dangling (a `profile` reference pointing at nothing) would be a worse state
 *  than either "keep both" or "remove both" — there's no third option worth preserving. */
export function removeProfile(store: Store, handle: string): { removed: boolean; viewsRemoved: number } {
  const profile = findProfileByHandle(store, handle);
  if (!profile) return { removed: false, viewsRemoved: 0 };
  const views = backlinks(store, profile.id, 'profile');
  for (const view of views) hardDeleteNode(store, view.id);
  hardDeleteNode(store, profile.id);
  return { removed: true, viewsRemoved: views.length };
}
