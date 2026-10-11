// Small readers for a parsed or wrapped block tree, shared by the tests that look blocks up by text.

/** The first node (depth first) whose `text` contains `needle`, or null. */
export function findByText(node: any, needle: string): any {
  if (typeof node.text === 'string' && node.text.includes(needle)) return node;
  for (const child of node.children ?? []) {
    const found = findByText(child, needle);
    if (found) return found;
  }
  return null;
}

/** The first heading (depth first) whose `title` contains `needle`, or null. */
export function findHeadingByTitle(node: any, needle: string): any {
  if (node.type === 'heading' && node.title?.includes(needle)) return node;
  for (const child of node.children ?? []) {
    const found = findHeadingByTitle(child, needle);
    if (found) return found;
  }
  return null;
}

/** Every node id in the tree, the node's own first. */
export function collectIds(node: any): string[] {
  if (!node) return [];
  return [node.id as string, ...(node.children ?? []).flatMap((child: any) => collectIds(child))];
}
