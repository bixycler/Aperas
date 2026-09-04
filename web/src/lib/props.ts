/**
 * Aperas `props` mechanism (Aperas-markdown-fractal-mapping-design.md §7).
 *
 * A generic, per-node extensible metadata slot — `BaseNode.props: Set<Prop>` — so a new
 * piece of type-conditional metadata (list numbering, a task checkbox, YAML frontmatter)
 * never needs its own schema field. `Prop` is abstract (`key` only); `StringProp` is its one
 * concrete leaf today, `value` always a string, JSON-encoded by convention for anything that
 * isn't naturally one. Shared by every writer (astParser.ts, artifacts.ts, folders.ts) and
 * reader (project.ts) so they agree on one lookup/write contract instead of each reinventing
 * the scan.
 */

export interface PropEntry {
  "@type": "StringProp";
  /** Only present when carried forward from an existing prop (`carryForwardProp` below) — a
   *  freshly-built entry has none, same as `setProp` always produced before this field existed. */
  id?: string;
  key: string;
  value: string;
}

export interface HasProps {
  props?: PropEntry[];
}

export function setProp(node: HasProps, key: string, value: string): void {
  if (!node.props) node.props = [];
  node.props.push({ "@type": "StringProp", key, value });
}

export function getProp(node: HasProps, key: string): string | undefined {
  return node.props?.find((p) => p.key === key)?.value;
}

/** `getProp`'s plural sibling, for a genuinely multi-valued key — `position` (Aperas-apeironngn-
 *  design.md §4 Step 8: a wikilink-derived `Link` carries one `position` prop per occurrence of
 *  its target in the owning block's text) is the first one, unlike single-valued props
 *  (`frontmatter`, `orderedList`) `getProp` already covers. */
export function getProps(node: HasProps, key: string): string[] {
  return (node.props ?? []).filter((p) => p.key === key).map((p) => p.value);
}

/**
 * Builds a fresh single-valued `StringProp` entry for `key`, reusing an existing prop's own id
 * when its `key` and `value` both already match `existing` — the same "carry forward only when
 * the value also matches" rule `reconcile.ts`'s `carryForwardFields` already applies to per-block
 * props (Aperas-apeironngn-design.md §4's "third bug, same family"), applied here directly for a
 * node-level singular prop (currently only `frontmatter`, on `ArtifactNode`/`FolderNode`) that
 * sits outside that tree-reconcile machinery entirely. Without this, a fresh id-less entry (what
 * `setProp` and every prior direct-literal construction produced) mints a brand-new id on every
 * write, even when the value itself never changed.
 */
export function carryForwardProp(existing: PropEntry[] | undefined, key: string, value: string): PropEntry {
  const match = existing?.find((p) => p.key === key);
  return { "@type": "StringProp", ...(match && match.value === value ? { id: match.id } : {}), key, value };
}
