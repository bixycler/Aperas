/**
 * ApeironNgn's class hierarchy and `a.b.c` prop-access interface (Aperas-apeironngn-design.md §3
 * "Schema = class", §4 rollout step 3: real accessors + a real inheritance tree, folding migrated
 * functions onto the classes they belong to).
 *
 * Real `extends`, one level per genuinely shared shape:
 *   ApeironInstance (store/id only)
 *     -> BaseNode (links/props/tombstonedAt/holder/unfolded)
 *          -> TreeNode (title/text/key — every tree-positioned kind)
 *               -> BlockNode / ArtifactNode / FolderNode
 *   ApeironInstance -> Link, ApeironInstance -> StringProp   (leaf subdocs, data only)
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
import { SHAPE_BY_KIND, type FieldSpec, type ClassShape, BLOCK_NODE_SHAPE, ARTIFACT_NODE_SHAPE, FOLDER_NODE_SHAPE, LINK_SHAPE, PROP_SHAPE } from './shape';
import { displayLabel, type TreeOptions } from './tree';
import { slugify } from '../nodeRef';
import { parseMarkdownTree, extractAbstract, stampParents, type ParsedBlockNode } from '../astParser';
import { reconcileTree, type ReconciliationStats } from '../reconcile';
import { getArtifactsDir, computeFileHash, countBlocks, extractLinkCodes, type PendingLinkCodes } from '../artifacts';
import { serializeBlock, renderChildren, withFrontmatter } from '../project';
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
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      store.add(quad(nodeIri(newId), predIri(k), encodeLiteral(v)));
    } else if (v && typeof v === 'object' && shape[k]?.storageKind === 'reference') {
      store.add(quad(nodeIri(newId), predIri(k), nodeIri(idOf(v))));
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

/** `links`/`props`/`tombstonedAt`/`holder`/`unfolded` — used only by `TreeNode` and below now
 *  that `Link`/`StringProp` don't extend it (kept as its own level anyway: a real conceptual
 *  boundary, "participates in the links/props/lifecycle system", separate from `TreeNode`'s "has
 *  a title and a position in the tree"). */
export class BaseNode extends ApeironInstance {
  declare links?: ApeironNode[];
  declare props?: ApeironNode[];
  declare tombstonedAt?: string;
  declare holder?: boolean;
  declare unfolded?: boolean;

  fold(): void {
    this.unfolded = false;
  }
  unfold(): void {
    this.unfolded = true;
  }

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
   *  `childIds(node, kind)`'s manual branch. */
  renderTree(opts: TreeOptions = {}): string[] {
    const lines: string[] = [];
    renderTreeLines(this, 0, opts, false, lines);
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
   *  `text`/`children`/`unfolded`/`blockId`, `links` as bare ref-id strings). Still produces a
   *  `blockId` key in its output — that's `reconcile.ts`'s external contract, unaffected by `key`
   *  replacing the old stored field internally. `props` is included as `{id, key, value}` triples
   *  (not the JSON-LD `@id`/`@type` shape) — `carryForwardFields`'s own consumer shape, matching
   *  by `key` against the fresh parse's props so an unchanged value keeps its stable id. */
  toReconcileShape(): any {
    const links = (this.links as ApeironNode[] | undefined)?.map((l) => l.id) ?? [];
    const props = (this.props as any[] | undefined)?.map((p) => ({ id: p.id, key: p.key, value: p.value }));
    return {
      blockId: this.key,
      type: this.type,
      title: this.title,
      ...(this.text !== undefined ? { text: this.text } : {}),
      unfolded: this.unfolded ?? false,
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
    this.unfolded = parsed.unfolded ?? false;
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
    const props = frontmatter !== undefined ? [{ '@type': 'StringProp' as const, key: 'frontmatter', value: frontmatter }] : undefined;

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
  node.unfolded = tombstone.unfolded ?? false;
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
    this.unfolded = parsed.unfolded ?? undefined;

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

export const CLASS_BY_KIND: Record<string, typeof ApeironInstance> = {
  BlockNode,
  ArtifactNode,
  FolderNode,
  Link,
  StringProp,
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

/** Renders one line per node plus its subtree — `TreeNode.renderTree`'s recursive engine, kept as
 *  a module-scope function rather than a method so the recursion doesn't need to thread `lines`/
 *  `depth`/`revealed` through the public single-argument method signature. */
function renderTreeLines(node: TreeNode, depth: number, opts: TreeOptions, revealed: boolean, lines: string[]): void {
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
    let content: string;
    if (opts.unfoldedMode && revealed) {
      content = nodeKindFromId(id) === 'BlockNode' && (node as unknown as BlockNode).type === 'list'
        ? `(no text of its own — see kg:unfold ${id})`
        : (node.text ?? '');
    } else {
      content = node.title;
    }
    lines.push(`${indent}${id}  [${displayLabel(id, node)}]  ${content}${holderTag}`);
  }

  const refs = node.treeChildren;
  const childDepth = hidden ? depth : depth + 1;
  if (!hidden && opts.maxDepth !== undefined && depth >= opts.maxDepth) {
    if (refs.length > 0) lines.push(`${'  '.repeat(depth + 1)}…`);
    return;
  }
  if (opts.unfoldedMode && node.unfolded !== true) {
    if (!hidden && refs.length > 0) lines.push(`${'  '.repeat(childDepth)}…  (folded — kg:unfold ${id} to expand)`);
    return;
  }
  const childRevealed = opts.unfoldedMode === true && node.unfolded === true;
  for (const child of refs) {
    renderTreeLines(child, childDepth, opts, childRevealed, lines);
  }
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
