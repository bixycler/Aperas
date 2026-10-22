// What the shell reads from an id (planning/core.md, Batch 11 step 2; design/core.md, "Ids"): the kind of a node, from the grammar the engine reads ids by
// (`apeironNgn/ids`), and whether a string is a reference to a top-level node.
import { kindOfId, ownerOfId } from '@aperas/core/apeironNgn/ids';

/** The kinds a top-level id carries: the ones with a document of their own. A `Link` or a `StringProp` is only ever embedded, inside the id of its owner. */
const TOP_LEVEL_KINDS: ReadonlySet<string> = new Set(['BlockNode', 'ArtifactNode', 'FolderNode', 'Profile', 'TreeView']);
const ID_PREFIX = /^(BlockNode|ArtifactNode|FolderNode|Profile|TreeView):/;

/** Whether a string is a reference to a top-level node, by its prefix: used to tell a reference from an ordinary literal. */
export function isNodeRef(value: unknown): value is string {
  return typeof value === 'string' && ID_PREFIX.test(value);
}

/**
 * The concrete class name from an id: the kind of its last `field:Kind:snowflake` segment, which is the immediate kind however deeply the node is
 * embedded (`BlockNode:x:links:Link:y:props:StringProp:z` is a `StringProp`). `Unknown` for a string that is not an id, and for a top-level id of a
 * kind with no document of its own.
 */
export function nodeKindFromId(id: string): string {
  const kind = kindOfId(id);
  if (kind === undefined) {
    // Not an id by the grammar (a short or foreign snowflake): the prefix, and the last embedded segment, still say what class it was meant for.
    const parts = [...id.matchAll(/:(?:props|links|preferences):([A-Za-z]+):/g)];
    if (parts.length > 0) return parts[parts.length - 1]![1]!;
    const m = id.match(ID_PREFIX);
    return m ? m[1]! : 'Unknown';
  }
  if (ownerOfId(id) !== undefined) return kind;
  return TOP_LEVEL_KINDS.has(kind) ? kind : 'Unknown';
}
