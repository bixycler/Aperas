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
