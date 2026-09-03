/**
 * ApeironNgn's class hierarchy and `a.b.c` prop-access interface (Aperas-apeironngn-design.md §3
 * "Schema = class", §4 rollout step 3: real accessors + a real inheritance tree, folding migrated
 * functions onto the classes they belong to).
 *
 * Real `extends`, one level per genuinely shared shape:
 *   ApeironInstance (store/id only)
 *     -> BaseNode (links/props/tombstonedAt/holder)
 *          -> TreeNode (title/text/key — every tree-positioned kind)
 *               -> BlockNode / ArtifactNode / FolderNode
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
  PARENT_PRED,
  SIBLING_INDEX_PRED,
} from './vocab';
import { SHAPE_BY_KIND, type FieldSpec, type ClassShape, BLOCK_NODE_SHAPE, ARTIFACT_NODE_SHAPE, FOLDER_NODE_SHAPE, LINK_SHAPE, PROP_SHAPE, PROFILE_SHAPE, TREE_VIEW_SHAPE } from './shape';
import { displayLabel, type TreeOptions } from './tree';
import { slugify } from '../nodeRef';
import { parseMarkdownTree, extractAbstract, stampParents, type ParsedBlockNode } from '../astParser';
import { reconcileTree, type ReconciliationStats } from '../reconcile';
import { getArtifactsDir, computeFileHash, countBlocks, extractLinkCodes, type PendingLinkCodes } from '../artifacts';
import { serializeBlock, renderChildren, withFrontmatter } from '../project';
import { carryForwardProp, type PropEntry } from '../props';
import type { ParsedFolderNode } from '../folders';

export interface ApeironNode {
  /** Escape hatch: the raw node id (e.g. `"BlockNode/00C..."`), never proxied further. */
  readonly id: string;
  /** Reified containment (Aperas-apeironngn-design.md §3): reverse-queries the `parent` index,
   *  sorted by `siblingIndex`. Present on `BlockNode`/`FolderNode`; absent (reads `undefined`) on
   *  everything else — `ArtifactNode`'s one "child" is its singular `root`, not a list. */
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
  const newId = `${parentId}/${field}/${type}/${generateNodeId()}`;
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
}

/** `title`/`text`/`key` — shared by every tree-positioned kind. `key` replaces the old per-class
 *  `blockId`/`artifactId`/`folderId` literal fields: each was always identical to its own id's
 *  local part by construction, so it's derived here, never its own stored triple. */
export class TreeNode extends BaseNode {
  declare title?: string;
  declare text?: string;

  get key(): string {
    return this.id.slice(this.id.indexOf('/') + 1);
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
   *  `BlockNode` with no `parent` set. */
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
      const parent = (current as unknown as BlockNode).parent;
      if (!parent) return null;
      current = parent;
    }
  }

  /** `resolve.ts`'s old `descend`/`resolveCreate.ts`'s equivalent single hop, folded — exact-then-
   *  prefix slug match among this node's `BlockNode` `treeChildren`. Read-only: returns the
   *  matched child, or `null` on a miss; throws on ambiguity, same distinction the free functions
   *  already drew. */
  findChild(text: string): TreeNode | null {
    const candidates = this.treeChildren.filter((c) => nodeKindFromId(c.id) === 'BlockNode' && c.title !== undefined);
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
  declare parent?: TreeNode;
  declare children?: TreeNode[];

  get treeChildren(): TreeNode[] {
    return this.children ?? [];
  }
  appendChild(childId: string): void {
    this.children = [...(this.children ?? []), childId as unknown as TreeNode];
  }

  /** `project.ts`'s old block-rendering half of `projectArtifactToMarkdown`, folded — a real
   *  instance's property reads are indistinguishable from a plain object's to `serializeBlock`,
   *  so nothing there needed changing. */
  toMarkdown(): string {
    return serializeBlock(this);
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
      ...(links.length ? { links } : {}),
      ...(props?.length ? { props } : {}),
      children: (this.children ?? []).map((c) => (c as unknown as BlockNode).toReconcileShape()),
    };
  }

  /** `artifacts.ts`'s old `writeBlockTree`, folded — writes a freshly-parsed-and-reconciled
   *  `ParsedBlockNode` tree into the `Store`, one node at a time. Every node already carries a
   *  real `blockId` by this point (freshly minted at parse time for a brand-new node, or carried
   *  forward from its old match by `reconcile.ts`'s `carryForwardFields`) — `this` is already
   *  `wrap()`ped at that id, nothing left to mint here. */
  hydrateFromParsed(parsed: ParsedBlockNode): void {
    this.type = parsed.type;
    this.title = parsed.title;
    this.text = parsed.text ?? undefined;
    this.parent = (parsed as any).parent;
    this.props = parsed.props?.length ? (parsed.props as unknown as ApeironNode[]) : undefined;
    this.links = (parsed as any).links?.length ? (parsed as any).links : undefined;
    for (const child of parsed.children ?? []) {
      (wrap(this.store, `BlockNode/${child.blockId}`) as unknown as BlockNode).hydrateFromParsed(child);
    }
    this.children = (parsed.children ?? []).map((c) => `BlockNode/${c.blockId}` as unknown as TreeNode);
  }
}

export class ArtifactNode extends TreeNode {
  declare path?: string;
  declare fileHash?: string;
  declare lastTrackedAt?: string;
  declare ingestedHash?: string;
  declare lastIngestedAt?: string;
  declare root?: BlockNode;

  get treeChildren(): TreeNode[] {
    return this.root ? [this.root] : [];
  }
  appendChild(childId: string): void {
    // ArtifactNode's one "child" is its singular `root`, not a `children` list — a node that
    // already has a root can't gain a second one this way (same schema-shape constraint
    // `nodeRef.ts` documents against real TerminusDB behavior).
    if (this.root !== undefined) {
      throw new Error(`ApeironNgn: '${this.id}' already has a root block — can't attach a second one.`);
    }
    this.root = childId as unknown as BlockNode;
  }

  /** `artifacts.ts`'s old `trackArtifact`'s per-node half, folded — registers or refreshes this
   *  lightweight ArtifactNode against `artifactPath`'s current file content, skipping when the
   *  hash hasn't changed. Takes the path explicitly (not `this.path`) since a brand-new,
   *  not-yet-tracked instance has no `path` of its own yet. */
  trackFromDisk(artifactPath: string): { tracked: boolean } {
    const content = readFileSync(join(getArtifactsDir(), artifactPath), 'utf-8');
    const fileHash = computeFileHash(content);
    if (this.fileHash === fileHash) {
      console.log(`[ApeironNgn Artifacts] Skipping '${artifactPath}' — content unchanged (hash: ${fileHash.slice(0, 12)}...)`);
      return { tracked: false };
    }
    this.path = artifactPath;
    this.title = basename(artifactPath);
    this.fileHash = fileHash;
    this.lastTrackedAt = new Date().toISOString();
    console.log(`[ApeironNgn Artifacts] Tracking '${artifactPath}' (hash: ${fileHash.slice(0, 12)}...)`);
    return { tracked: true };
  }

  /** `project.ts`'s old `projectArtifactToMarkdown`'s render half, folded. `null` when this
   *  artifact has no root yet (nothing ingested). */
  toMarkdown(): string | null {
    if (!this.root) return null;
    return withFrontmatter(this.root.toMarkdown(), this);
  }

  /** `artifacts.ts`'s old `ingestArtifact`'s per-node half, folded — AST-parses and commits this
   *  artifact into a fractal tree of `BlockNode`s, only if its file hash has changed since the
   *  last ingestion. Reads `artifactPath` from `this.path` (always set by the time ingestion
   *  runs — tracking is a prerequisite). Returns `pendingLinks` for the caller to resolve
   *  afterward (`artifacts.ts`'s `resolveBlockLinks` — a multi-block sweep, stays free) rather
   *  than resolving them here: the implicit `[[wikilink]]` base needs an already-persisted
   *  `.parent` chain, so link resolution has to run *after* the tree write completes, not as
   *  part of it. */
  ingestFromDisk(): (IngestResult & { pendingLinks: PendingLinkCodes[] }) | null {
    if (this.ingestedHash === this.fileHash) {
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

    const oldRoot = this.root;
    if (oldRoot) {
      const oldTree = oldRoot.toReconcileShape();
      console.log(`[ApeironNgn Artifacts] Reconciling '${artifactPath}' against its previously ingested tree...`);
      const { finalTree, tombstones, stats } = reconcileTree(oldTree, newRoot, now);
      finalRoot = finalTree;
      reconciliation = stats;
      for (const tombstone of tombstones) applyTombstone(this.store, tombstone);
      console.log(`[ApeironNgn Artifacts] Reconciliation: ${stats.unchanged} unchanged, ${stats.moved} moved, ${stats.added} added, ${stats.removed} removed.`);
    }

    stampParents(finalRoot);
    (finalRoot as any).parent = `ArtifactNode/${this.key}`;

    const pendingLinks = extractLinkCodes(finalRoot);
    const blockCount = countBlocks(finalRoot);
    console.log(`[ApeironNgn Artifacts] Ingesting '${artifactPath}' as fractal tree (${blockCount} blocks)...`);

    const title = basename(artifactPath);
    const text = extractAbstract(newRoot);

    (wrap(this.store, `BlockNode/${finalRoot.blockId}`) as unknown as BlockNode).hydrateFromParsed(finalRoot);

    this.title = title;
    this.text = text || undefined;
    this.ingestedHash = this.fileHash;
    this.lastIngestedAt = now;
    this.root = `BlockNode/${finalRoot.blockId}` as unknown as BlockNode;
    this.props = props as unknown as ApeironNode[];

    return { blockCount, reconciliation, pendingLinks };
  }
}

export interface IngestResult {
  blockCount: number;
  reconciliation: ReconciliationStats | null;
}

/** Applies one `reconcile.ts` tombstone record — an unmatched old subtree node, already fully
 *  detached from `finalTree`'s own structure, so this only needs to set its own fields (`children:
 *  []` clears whatever it used to point at; nothing re-attaches it). */
function applyTombstone(store: Store, tombstone: any): void {
  const node = wrap(store, `BlockNode/${tombstone.blockId}`) as unknown as BlockNode;
  node.type = tombstone.type;
  node.title = tombstone.title;
  node.text = tombstone.text ?? undefined;
  node.children = [];
  node.tombstonedAt = tombstone.tombstonedAt;
}

export class FolderNode extends TreeNode {
  declare path?: string;
  declare children?: TreeNode[];

  get treeChildren(): TreeNode[] {
    return this.children ?? [];
  }
  appendChild(childId: string): void {
    this.children = [...(this.children ?? []), childId as unknown as TreeNode];
  }

  /** `project.ts`'s old `projectFolderToReadme`'s render half, folded. Nested `FolderNode`/
   *  `ArtifactNode` children are structural, not textual content — filtered out here, keyed off
   *  `nodeKindFromId` rather than GraphQL's old `_type` tag. */
  toReadme(): string {
    const blockChildren = this.treeChildren.filter((c) => nodeKindFromId(c.id) === 'BlockNode');
    const parts: string[] = [];
    if (this.text) parts.push(this.text);
    const body = renderChildren({ children: blockChildren });
    if (body) parts.push(body);
    return withFrontmatter(parts.join('\n\n'), this);
  }

  /** `folders.ts`'s old `writeFolderTree`, folded — kept as its own override rather than sharing
   *  `BlockNode`'s method of the same name, since a folder's children mix `BlockNode`/
   *  `FolderNode`/`ArtifactNode` 3-ways where a block's are homogeneous. `ArtifactNode` entries
   *  are bare reference ids already (`folders.ts`'s own `buildFolderTree` never inlines them),
   *  nothing to write for those here. */
  hydrateFromParsed(parsed: ParsedFolderNode): void {
    this.title = parsed.title;
    this.path = parsed.path;
    this.text = parsed.text ?? undefined;
    this.props = parsed.props?.length ? (parsed.props as unknown as ApeironNode[]) : undefined;

    const ids: string[] = [];
    for (const child of parsed.children) {
      if (typeof child === 'string') {
        ids.push(child); // ArtifactNode reference
      } else if ((child as any)['@type'] === 'FolderNode') {
        const c = child as ParsedFolderNode;
        (wrap(this.store, `FolderNode/${c.folderId}`) as unknown as FolderNode).hydrateFromParsed(c);
        ids.push(`FolderNode/${c.folderId}`);
      } else {
        const c = child as ParsedBlockNode;
        (wrap(this.store, `BlockNode/${c.blockId}`) as unknown as BlockNode).hydrateFromParsed(c);
        ids.push(`BlockNode/${c.blockId}`);
      }
    }
    this.children = ids as unknown as TreeNode[];
  }
}

/** Leaf subdoc — data only (`target`/`predicate`), never a `this` for any migrated function. */
export class Link extends ApeironInstance {
  declare target?: TreeNode;
  declare predicate?: string;
}

/** Leaf subdoc — data only (`key`/`value`), never a `this` for any migrated function. */
export class StringProp extends ApeironInstance {
  declare key?: string;
  declare value?: string;
}

/** Aperas-treeview-design.md §3/§6/§7 — a bucket for keeping separate `TreeView`s apart ("human"
 *  vs. "agent"), nothing more. No auth, no identity beyond the label. */
export class Profile extends ApeironInstance {
  declare name?: string;
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

/** Renders one line per node plus its subtree, title-only, always recursing (`maxDepth`/
 *  `noHolders` aside) — `TreeNode.renderTree`'s plain default when no `TreeOptions.view` is
 *  supplied. Kept as a module-scope function rather than a method so the recursion doesn't need to
 *  thread `lines`/`depth` through the public single-argument method signature. */
function renderTreeLines(node: TreeNode, depth: number, opts: TreeOptions, lines: string[]): void {
  const id = node.id;
  if (node.title === undefined) {
    lines.push(`${'  '.repeat(depth)}${id}  [?]  <not found>`);
    return;
  }
  const isLiteralHolder = node.holder === true;
  const hidden = opts.noHolders === true && isLiteralHolder;
  if (!hidden) {
    const indent = '  '.repeat(depth);
    const holderTag = isLiteralHolder ? '  (holder)' : '';
    lines.push(`${indent}${id}  [${displayLabel(id, node)}]  ${node.title}${holderTag}`);
  }

  const refs = node.treeChildren;
  const childDepth = hidden ? depth : depth + 1;
  if (!hidden && opts.maxDepth !== undefined && depth >= opts.maxDepth) {
    if (refs.length > 0) lines.push(`${'  '.repeat(depth + 1)}…`);
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

/** Generic structural up-pointer, one hop. A `BlockNode` carries its own explicit `parent` field
 *  (set at ingest time, `hydrateFromParsed`/`ingestFromDisk`'s `stampParents`), pointing at
 *  whichever `TreeNode` structurally contains it — another `BlockNode`, or the owning
 *  `ArtifactNode` for a root block. An `ArtifactNode`/`FolderNode` has no such explicit field of
 *  its own; when nested under a `FolderNode`, it's found the same way `childrenOf` finds children
 *  in the down direction — reverse-querying the reified `__parent` triple every orderedContainment
 *  member carries — just read from the child's own side instead of the parent's. `null` means
 *  top-level (whatever `kg:tree` was pointed at — this doc's "Root"). */
function structuralParentOf(store: Store, id: string): string | null {
  if (nodeKindFromId(id) === 'BlockNode') {
    const p = (wrap(store, id) as unknown as BlockNode).parent;
    return p ? p.id : null;
  }
  const m = store.match(nodeIri(id), PARENT_PRED, null, null);
  return m.length > 0 && isNamedNodeTerm(m[0].object) ? idFromNodeIri(m[0].object.value) : null;
}

/** The one `TreeNode` a `Link` belongs to — reverse-queries the `links` predicate pointing at the
 *  link's own id, rather than parsing it out of the id string (`${ownerId}/links/Link/<snowflake>`)
 *  directly, matching how every other relational lookup in this file works. */
function ownerOfLink(store: Store, linkId: string): string | null {
  const m = store.match(null, predIri('links'), nodeIri(linkId), null);
  return m.length > 0 && isNamedNodeTerm(m[0].subject) ? idFromNodeIri(m[0].subject.value) : null;
}

type CanonicalPosition = { kind: 'home' } | { kind: 'link'; linkId: string };

interface ViewRenderContext {
  /** `TreeNode` ids with their own `unfolds` entry — plus the render's own starting id, which
   *  behaves as always-unfolded ("Root is always unfolded for full coverage", §4). */
  unfoldedTreeIds: Set<string>;
  /** Every `Link` id in `unfolds`, resolved to its owner/target. */
  linkOwnerAndTarget: Map<string, { ownerId: string; targetId: string }>;
  /** Per target node id, which single position (a home, or one specific `Link`) is canonical
   *  (§6) — home always wins when present; among competing `Link`s with no qualifying home,
   *  whichever is encountered first while building this map wins (an unresolvable tie, "luck," not
   *  a structural rule — §6/§10). */
  canonical: Map<string, CanonicalPosition>;
  /** Ids (a home node id, or a canonical `Link`'s own id) that get the `[*]` "reachable more than
   *  one way" tag — the canonical position's target had more than one qualifying attempt. */
  starred: Set<string>;
  /** ancestorId -> immediate child ids that must render as breadcrumb passthrough, for an ancestor
   *  that isn't itself genuinely unfolded (§4/§5). */
  neededChildren: Map<string, Set<string>>;
}

function buildViewRenderContext(store: Store, view: TreeView, rootId: string): ViewRenderContext {
  const unfoldsWrapped = (view.unfolds as unknown as ApeironNode[] | undefined) ?? [];
  const unfoldedTreeIds = new Set<string>();
  const linkOwnerAndTarget = new Map<string, { ownerId: string; targetId: string }>();

  for (const n of unfoldsWrapped) {
    if (nodeKindFromId(n.id) === 'Link') {
      const targetId = ((n as unknown as Link).target as unknown as TreeNode | undefined)?.id;
      const ownerId = ownerOfLink(store, n.id);
      if (targetId && ownerId) linkOwnerAndTarget.set(n.id, { ownerId, targetId });
    } else {
      unfoldedTreeIds.add(n.id);
    }
  }
  unfoldedTreeIds.add(rootId); // "Root is always unfolded for full coverage"

  const canonical = new Map<string, CanonicalPosition>();
  const attemptCount = new Map<string, number>();
  for (const id of unfoldedTreeIds) {
    canonical.set(id, { kind: 'home' });
    attemptCount.set(id, (attemptCount.get(id) ?? 0) + 1);
  }
  for (const [linkId, { targetId }] of linkOwnerAndTarget) {
    attemptCount.set(targetId, (attemptCount.get(targetId) ?? 0) + 1);
    if (!canonical.has(targetId)) canonical.set(targetId, { kind: 'link', linkId });
  }
  const starred = new Set<string>();
  for (const [targetId, count] of attemptCount) {
    if (count <= 1) continue;
    const c = canonical.get(targetId)!;
    starred.add(c.kind === 'home' ? targetId : c.linkId);
  }

  const neededChildren = new Map<string, Set<string>>();
  const markPath = (leafId: string): void => {
    let child = leafId;
    let parent = structuralParentOf(store, child);
    while (parent) {
      let set = neededChildren.get(parent);
      if (!set) { set = new Set(); neededChildren.set(parent, set); }
      if (set.has(child)) break; // already marked from here up — rest of the chain is too
      set.add(child);
      child = parent;
      parent = structuralParentOf(store, child);
    }
  };
  for (const id of unfoldedTreeIds) markPath(id);
  for (const { ownerId } of linkOwnerAndTarget.values()) markPath(ownerId);

  return { unfoldedTreeIds, linkOwnerAndTarget, canonical, starred, neededChildren };
}

/** One `TreeNode`'s line plus whatever it reveals beneath it — the three own-line tiers plus
 *  breadcrumb-passthrough child pruning (§5). `parentQualifiesForPreview` is true for the starting
 *  node and for any node reached as the plain listed child of a genuinely-unfolded parent; false
 *  for a node reached only as a breadcrumb link in someone else's chain (§5's tier-3, bare title). */
function renderViewLines(
  store: Store, id: string, depth: number, opts: TreeOptions, ctx: ViewRenderContext,
  parentQualifiesForPreview: boolean, lines: string[],
): void {
  const node = wrap(store, id) as unknown as TreeNode;
  if (node.title === undefined) {
    lines.push(`${'  '.repeat(depth)}${id}  [?]  <not found>`);
    return;
  }
  const isLiteralHolder = node.holder === true;
  const hidden = opts.noHolders === true && isLiteralHolder;
  const isGenuinelyUnfolded = ctx.unfoldedTreeIds.has(id);
  const showAbstract = parentQualifiesForPreview; // tier 1/2 -> abstract; tier 3 -> bare title only

  if (!hidden) {
    const indent = '  '.repeat(depth);
    const holderTag = isLiteralHolder ? '  (holder)' : '';
    const star = ctx.starred.has(id) ? '  [*]' : '';
    const isTextlessList = nodeKindFromId(id) === 'BlockNode' && (node as unknown as BlockNode).type === 'list';
    const content = !showAbstract ? node.title : isTextlessList ? `(no text of its own — see kg:unfold ${id})` : (node.text ?? node.title);
    lines.push(`${indent}${id}  [${displayLabel(id, node)}]  ${content}${holderTag}${star}`);
  }

  const childDepth = hidden ? depth : depth + 1;
  const childrenToShow = isGenuinelyUnfolded
    ? node.treeChildren
    : node.treeChildren.filter((c) => ctx.neededChildren.get(id)?.has(c.id));
  const linksToShow = isGenuinelyUnfolded ? ((node.links as ApeironNode[] | undefined) ?? []) : [];

  if (!hidden && opts.maxDepth !== undefined && depth >= opts.maxDepth) {
    if (childrenToShow.length > 0 || linksToShow.length > 0) lines.push(`${'  '.repeat(depth + 1)}…`);
    return;
  }

  for (const child of childrenToShow) {
    renderViewLines(store, child.id, childDepth, opts, ctx, isGenuinelyUnfolded, lines);
  }
  for (const link of linksToShow) {
    renderLinkLine(store, link.id, childDepth, opts, ctx, lines);
  }
}

/** One `Link`'s line: a plain preview (target's title/abstract, no recursion) when the link itself
 *  isn't in `unfolds`; the target shown fully — like an unfolded `TreeNode`, §5 rule b — when it
 *  is *and* it's the canonical position for that target; a short pointer back to wherever the
 *  canonical position actually is, otherwise (§6). */
function renderLinkLine(store: Store, linkId: string, depth: number, opts: TreeOptions, ctx: ViewRenderContext, lines: string[]): void {
  const link = wrap(store, linkId) as unknown as Link;
  const targetId = (link.target as unknown as TreeNode | undefined)?.id;
  const indent = '  '.repeat(depth);
  const predicate = (link.predicate as unknown as string) ?? '';
  if (!targetId) {
    lines.push(`${indent}${linkId}  [Link]  ${predicate}  <no target>`);
    return;
  }
  const targetNode = wrap(store, targetId) as unknown as TreeNode;
  const targetTitle = targetNode.title ?? '<not found>';
  const head = `${indent}${linkId}  [Link]  ${predicate} → ${targetId}  `;
  const attempt = ctx.linkOwnerAndTarget.has(linkId);

  if (!attempt) {
    lines.push(`${head}${targetTitle}`); // plain preview, never subject to dedup (§4)
    return;
  }
  const canon = ctx.canonical.get(targetId);
  const isCanonicalHere = canon?.kind === 'link' && canon.linkId === linkId;
  if (isCanonicalHere) {
    const star = ctx.starred.has(linkId) ? '  [*]' : '';
    lines.push(`${head}${targetTitle}${star}`);
    for (const child of targetNode.treeChildren) renderViewLines(store, child.id, depth + 1, opts, ctx, true, lines);
    for (const l of (targetNode.links as ApeironNode[] | undefined) ?? []) renderLinkLine(store, l.id, depth + 1, opts, ctx, lines);
    return;
  }
  const pointerTo = canon?.kind === 'home' ? (targetNode.toPath() ?? targetId) : `${canon?.linkId ?? targetId} (link)`;
  lines.push(`${head}${targetTitle}  (see ${pointerTo})`);
}

/** `TreeNode.renderTree`'s `opts.view` branch — entry point for the whole view-based render. */
function renderTreeWithView(store: Store, rootId: string, view: TreeView, opts: TreeOptions): string[] {
  const ctx = buildViewRenderContext(store, view, rootId);
  const lines: string[] = [];
  renderViewLines(store, rootId, 0, opts, ctx, true, lines);
  return lines;
}

/** Finds the `TreeView` named `"default"` (Aperas-treeview-design.md §10), creating it — and a
 *  `Profile` named `"default"` to own it — on first use. Exact-literal lookup on `name`, the same
 *  pattern `tree.ts`'s `findByExactPath` already uses for `ArtifactNode`/`FolderNode.path`. */
export function ensureDefaultView(store: Store): TreeView {
  const existing = store.match(null, predIri('name'), encodeLiteral('default'), null)
    .map((m) => idFromNodeIri(String(m.subject.value)))
    .find((id) => nodeKindFromId(id) === 'TreeView');
  if (existing) return wrap(store, existing) as unknown as TreeView;

  const existingProfile = store.match(null, predIri('name'), encodeLiteral('default'), null)
    .map((m) => idFromNodeIri(String(m.subject.value)))
    .find((id) => nodeKindFromId(id) === 'Profile');
  const profileId = existingProfile ?? `Profile/${generateNodeId()}`;
  if (!existingProfile) {
    const profile = wrap(store, profileId) as unknown as Profile;
    profile.name = 'default';
  }

  const viewId = `TreeView/${generateNodeId()}`;
  const view = wrap(store, viewId) as unknown as TreeView;
  view.name = 'default';
  view.profile = profileId as unknown as Profile;
  return view;
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
