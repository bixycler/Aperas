/**
 * Per-concrete-class field shape (Aperas-apeironngn-design.md §3 "Field shape"/"Schema = class",
 * §4 rollout step 3's hierarchy refactor). Declared once, here — not derived from TerminusDB's
 * `schema.json` (already shown to drift from the live schema) and not inferred from match count at
 * read time (can't tell a `Set` holding one value apart from an `Optional` that happens to be set).
 *
 * Composed to mirror the real class hierarchy (`node.ts`): `BASE_NODE_SHAPE` (`links`/`props`/
 * `tombstonedAt`/`holder`/`unfolded`) -> `TREE_NODE_SHAPE` (adds `title`/`text`) -> each concrete
 * leaf's own table. `blockId`/`artifactId`/`folderId` are gone — each was always identical to its
 * own id's local part by construction, so `TreeNode.key` (`node.ts`) derives it from `id` instead
 * of storing it as its own triple. Each leaf table stays fully flattened (spread, not just its own
 * new fields) since `node.ts`'s accessor generation and `dehydrate.ts`/`mintEmbedded` both consume
 * one complete per-kind table directly, rather than walking the class prototype chain.
 */

export type Cardinality = 'one' | 'optional' | 'set' | 'orderedContainment';
export type StorageKind = 'literal' | 'reference' | 'embed';

export interface FieldSpec {
  cardinality: Cardinality;
  /** Only meaningful for a node-shaped value; omitted (defaults to 'literal') for plain scalars. */
  storageKind?: StorageKind;
}

export type ClassShape = Record<string, FieldSpec>;

/** Used only by `TreeNode` and below now that `Link`/`StringProp` are leaf subdocs with no
 *  `BaseNode` in their chain — kept as its own level anyway, the real conceptual boundary
 *  ("participates in the links/props/lifecycle system") separate from `TreeNode`'s ("has a title
 *  and a position in the tree"). `links` is `storageKind: 'embed'`, not `reference`: a `Link` is a
 *  subdocument now, same shape of thing as `props`' `StringProp` (`${parentId}/links/Link/
 *  <snowflake>`, mirroring `${parentId}/props/StringProp/<snowflake>`), not an independently
 *  addressable top-level node. */
export const BASE_NODE_SHAPE: ClassShape = {
  links: { cardinality: 'set', storageKind: 'embed' },
  props: { cardinality: 'set', storageKind: 'embed' },
  tombstonedAt: { cardinality: 'optional' },
  holder: { cardinality: 'optional' },
  unfolded: { cardinality: 'optional' },
};

export const TREE_NODE_SHAPE: ClassShape = {
  ...BASE_NODE_SHAPE,
  title: { cardinality: 'one' },
  text: { cardinality: 'optional' },
};

export const BLOCK_NODE_SHAPE: ClassShape = {
  ...TREE_NODE_SHAPE,
  type: { cardinality: 'one' },
  parent: { cardinality: 'optional', storageKind: 'reference' },
  children: { cardinality: 'orderedContainment', storageKind: 'reference' },
};

export const ARTIFACT_NODE_SHAPE: ClassShape = {
  ...TREE_NODE_SHAPE,
  path: { cardinality: 'one' },
  fileHash: { cardinality: 'optional' },
  lastTrackedAt: { cardinality: 'optional' },
  ingestedHash: { cardinality: 'optional' },
  lastIngestedAt: { cardinality: 'optional' },
  root: { cardinality: 'optional', storageKind: 'reference' },
};

export const FOLDER_NODE_SHAPE: ClassShape = {
  ...TREE_NODE_SHAPE,
  path: { cardinality: 'one' },
  children: { cardinality: 'orderedContainment', storageKind: 'reference' },
};

/** No `BASE_NODE_FIELDS` here — a `Link` is exactly this shape now, nothing else, same minimal
 *  footprint as `Prop`. */
export const LINK_SHAPE: ClassShape = {
  target: { cardinality: 'one', storageKind: 'reference' },
  predicate: { cardinality: 'one' },
};

export const PROP_SHAPE: ClassShape = {
  key: { cardinality: 'one' },
  value: { cardinality: 'one' },
};

export const SHAPE_BY_KIND: Record<string, ClassShape> = {
  BlockNode: BLOCK_NODE_SHAPE,
  ArtifactNode: ARTIFACT_NODE_SHAPE,
  FolderNode: FOLDER_NODE_SHAPE,
  Link: LINK_SHAPE,
  StringProp: PROP_SHAPE,
};
