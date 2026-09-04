/**
 * Per-concrete-class field shape (Aperas-apeironngn-design.md §3 "Field shape"/"Schema = class",
 * §4 rollout step 3's hierarchy refactor). Declared once, here — not derived from TerminusDB's
 * `schema.json` (already shown to drift from the live schema) and not inferred from match count at
 * read time (can't tell a `Set` holding one value apart from an `Optional` that happens to be set).
 *
 * Composed to mirror the real class hierarchy (`node.ts`): `BASE_NODE_SHAPE` (`links`/`props`/
 * `tombstonedAt`/`holder`) -> `TREE_NODE_SHAPE` (adds `title`/`text`/`parent`) -> `BLOCK_NODE_SHAPE`
 * (adds `type`/`children`) -> `ArtifactNode` adds its own on-disk-identity fields on top of that;
 * `FolderNode` instead builds straight on `TREE_NODE_SHAPE`, with its own independent `path`/
 * `children` (and, like every `TreeNode`, `parent` for free). `unfolded` (a single boolean shared by
 * every viewer) is gone, replaced by `TreeView`'s own `unfolds` set (Aperas-treeview-design.md) —
 * fold state is per-view now, not per-node. `blockId`/`artifactId`/`folderId` are gone — each was
 * always identical to its own id's local part by construction, so `TreeNode.key` (`node.ts`)
 * derives it from `id` instead of storing it as its own triple. Each leaf table stays fully
 * flattened (spread, not just its own new fields) since `node.ts`'s accessor generation and
 * `dehydrate.ts`/`mintEmbedded` both consume one complete per-kind table directly, rather than
 * walking the class prototype chain.
 *
 * `ArtifactNode extends BlockNode`, merged with what used to be a separate synthetic root
 * `BlockNode` per artifact (Aperas-apeironngn-design.md's rollout narrative) — an artifact and its
 * document content are one node now, not two linked by a `root` reference, so it genuinely shares
 * `type`/`children` with `BlockNode`, unmodified. `FolderNode` deliberately does *not* extend
 * `BlockNode`, even though the two hierarchies look like they'd want to be symmetric: a folder was
 * never merged with anything (its README's content already lived directly in its own `children`,
 * no synthetic wrapper to begin with), and every field/method `BlockNode` would hand it beyond what
 * `TreeNode` already gives both — `type`, the mdast-`serializeBlock`-based `toMarkdown`,
 * `hydrateFromParsed`'s `ParsedBlockNode` shape — is either unused or actively wrong for it
 * (`FolderNode`'s own hydration takes a `ParsedFolderNode`, a genuinely different shape). Declaring
 * `FolderNode extends BlockNode` anyway would assert an is-a relationship that isn't true, for a
 * uniform-looking diagram rather than a real one.
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
};

/** `parent` lives here, not on `BLOCK_NODE_SHAPE`, as of Aperas-apeironngn-design.md §5's redundancy
 *  fix — every tree-positioned kind gets a real structural-parent reference now (`FolderNode`/
 *  `ArtifactNode` included, not just `BlockNode`), populated automatically as a side effect of
 *  whichever container's `children` write includes it (`vocab.ts`'s `PARENT_PRED` doc comment has
 *  the full mechanism). Never assign it directly. */
export const TREE_NODE_SHAPE: ClassShape = {
  ...BASE_NODE_SHAPE,
  title: { cardinality: 'one' },
  text: { cardinality: 'optional' },
  parent: { cardinality: 'optional', storageKind: 'reference' },
};

export const BLOCK_NODE_SHAPE: ClassShape = {
  ...TREE_NODE_SHAPE,
  type: { cardinality: 'one' },
  children: { cardinality: 'orderedContainment', storageKind: 'reference' },
};

export const ARTIFACT_NODE_SHAPE: ClassShape = {
  ...BLOCK_NODE_SHAPE,
  type: { cardinality: 'optional' }, // unset until first ingested — no separate root node to hold it instead
  path: { cardinality: 'one' },
  fileHash: { cardinality: 'optional' },
  lastTrackedAt: { cardinality: 'optional' },
  ingestedHash: { cardinality: 'optional' },
  lastIngestedAt: { cardinality: 'optional' },
};

export const FOLDER_NODE_SHAPE: ClassShape = {
  ...TREE_NODE_SHAPE,
  path: { cardinality: 'one' },
  children: { cardinality: 'orderedContainment', storageKind: 'reference' },
};

/** No full `BASE_NODE_SHAPE` here — a `Link` doesn't get `links`/`tombstonedAt`/`holder` (a link
 *  having its own outbound links, or an independent tombstone lifecycle, corresponds to nothing
 *  real; considered and rejected — Aperas-apeironngn-design.md §4 Step 8). It does get `props`,
 *  cherry-picked directly rather than via `extends BaseNode`: the same generic `Set<StringProp>`
 *  mechanism `BlockNode`/`ArtifactNode`/`FolderNode` already use for "a new piece of type-
 *  conditional metadata never needs its own schema field" (Aperas-markdown-fractal-mapping-
 *  design.md §7), applied here so a wikilink-derived `Link` can carry one `{key: 'position',
 *  value: '<offset>'}` prop per occurrence of its target in the owning block's text (a real
 *  multiset — reusing already-proven embed/mint/dehydrate machinery instead of a bespoke
 *  `positions` field), and so a manual `kg:link` entry has the same slot available for whatever
 *  it wants to carry later. `SHAPE` tables don't rely on the class hierarchy for composition
 *  (fully flattened per class), so this one extra field doesn't need `Link extends BaseNode`. */
export const LINK_SHAPE: ClassShape = {
  target: { cardinality: 'one', storageKind: 'reference' },
  predicate: { cardinality: 'one' },
  props: { cardinality: 'set', storageKind: 'embed' },
};

export const PROP_SHAPE: ClassShape = {
  key: { cardinality: 'one' },
  value: { cardinality: 'one' },
};

/** Aperas-treeview-design.md §3 — a bucket for keeping separate `TreeView`s apart ("human" vs.
 *  "agent"), nothing more. No `BASE_NODE_FIELDS`: not a `TreeNode`, no auth, no links/props of its
 *  own, same minimal footprint as `Link`/`StringProp`. */
export const PROFILE_SHAPE: ClassShape = {
  name: { cardinality: 'optional' },
};

/** Aperas-treeview-design.md §3-§6 — an i-view: a lens over the one real `TreeNode`/`Link` graph,
 *  not a parallel structure. `unfolds` replaces `BASE_NODE_SHAPE.unfolded` — fold state lives here,
 *  per view, instead of as a single flag shared by every viewer. Points at either a `TreeNode`
 *  (`BlockNode`/`ArtifactNode`/`FolderNode`) or a `Link` — both are plain bare-id references here,
 *  never minted fresh by this field (an `unfolds` write always names something that already
 *  exists), so `storageKind: 'reference'` is correct even for the `Link` case, not `'embed'`. */
export const TREE_VIEW_SHAPE: ClassShape = {
  profile: { cardinality: 'one', storageKind: 'reference' },
  name: { cardinality: 'optional' },
  unfolds: { cardinality: 'set', storageKind: 'reference' },
};

export const SHAPE_BY_KIND: Record<string, ClassShape> = {
  BlockNode: BLOCK_NODE_SHAPE,
  ArtifactNode: ARTIFACT_NODE_SHAPE,
  FolderNode: FOLDER_NODE_SHAPE,
  Link: LINK_SHAPE,
  StringProp: PROP_SHAPE,
  Profile: PROFILE_SHAPE,
  TreeView: TREE_VIEW_SHAPE,
};
