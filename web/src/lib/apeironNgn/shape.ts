/**
 * Per-concrete-class field shape (Aperas-apeironngn-design.md §3 "Field shape"/"Schema = class").
 * Declared once, here — not derived from TerminusDB's `schema.json` (already shown to drift from
 * the live schema) and not inferred from match count at read time (can't tell a `Set` holding one
 * value apart from an `Optional` that happens to be set).
 */

export type Cardinality = 'one' | 'optional' | 'set' | 'orderedContainment';
export type StorageKind = 'literal' | 'reference' | 'embed';

export interface FieldSpec {
  cardinality: Cardinality;
  /** Only meaningful for a node-shaped value; omitted (defaults to 'literal') for plain scalars. */
  storageKind?: StorageKind;
}

export type ClassShape = Record<string, FieldSpec>;

const BASE_NODE_FIELDS: ClassShape = {
  links: { cardinality: 'set', storageKind: 'reference' },
  props: { cardinality: 'set', storageKind: 'embed' },
  tombstonedAt: { cardinality: 'optional' },
  holder: { cardinality: 'optional' },
  unfolded: { cardinality: 'optional' },
};

export const BLOCK_NODE_SHAPE: ClassShape = {
  ...BASE_NODE_FIELDS,
  blockId: { cardinality: 'one' },
  type: { cardinality: 'one' },
  title: { cardinality: 'one' },
  text: { cardinality: 'optional' },
  parent: { cardinality: 'optional', storageKind: 'reference' },
  children: { cardinality: 'orderedContainment', storageKind: 'reference' },
};

export const ARTIFACT_NODE_SHAPE: ClassShape = {
  ...BASE_NODE_FIELDS,
  artifactId: { cardinality: 'one' },
  path: { cardinality: 'one' },
  title: { cardinality: 'one' },
  text: { cardinality: 'optional' },
  fileHash: { cardinality: 'optional' },
  lastTrackedAt: { cardinality: 'optional' },
  ingestedHash: { cardinality: 'optional' },
  lastIngestedAt: { cardinality: 'optional' },
  root: { cardinality: 'optional', storageKind: 'reference' },
};

export const FOLDER_NODE_SHAPE: ClassShape = {
  ...BASE_NODE_FIELDS,
  folderId: { cardinality: 'one' },
  title: { cardinality: 'one' },
  path: { cardinality: 'one' },
  text: { cardinality: 'optional' },
  children: { cardinality: 'orderedContainment', storageKind: 'reference' },
};

export const LINK_SHAPE: ClassShape = {
  ...BASE_NODE_FIELDS,
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
