/**
 * ApeironNgn implementation of `kg:tree` (Aperas-apeironngn-design.md §4 step 2: first script
 * migrated). Mirrors `kgCli.ts`'s `printTree`/`childRefs`/`displayLabel` line for line — same
 * output format, same flags — but reading from an in-process `Store` instead of TerminusDB, and
 * fully synchronous (no round trips to hide behind `await` at all, node-by-node or otherwise).
 */

import type { Store } from 'oxigraph';
import { wrap, type ApeironNode } from './node';
import { predIri, encodeLiteral, idFromNodeIri, nodeKindFromId } from './vocab';

/** `kg:path -- <path>`'s common case, not the full deep-path grammar (`resolveNodeRefDetail`) —
 *  an exact match on a `path` literal, same as `resolveArtifactOrFolderPrefix`'s single-segment
 *  case. Deep multi-segment/`.`/`..`/snowflake-code addressing is `kg:resolve`'s own migration,
 *  not duplicated here. */
export function findByExactPath(store: Store, path: string): string | null {
  const matches = store.match(null, predIri('path'), encodeLiteral(path), null);
  if (matches.length === 0) return null;
  return idFromNodeIri(String(matches[0].subject.value));
}

/** Accepts a full node id as-is, otherwise resolves as an exact artifact/folder `path`. */
export function resolveTreeRef(store: Store, ref: string): string | null {
  if (nodeKindFromId(ref) !== 'Unknown') return ref;
  return findByExactPath(store, ref);
}

export function childIds(node: ApeironNode, kind: string): string[] {
  if (kind === 'ArtifactNode') {
    const root = node.root as ApeironNode | undefined;
    return root ? [root.id] : [];
  }
  return (node.children as ApeironNode[]).map((c) => c.id);
}

export function displayLabel(id: string, node: ApeironNode): string {
  const kind = nodeKindFromId(id);
  return kind === 'BlockNode' ? (node.type as string) : kind;
}

export interface TreeOptions {
  maxDepth?: number;
  noHolders?: boolean;
  unfoldedMode?: boolean;
}

/** Sync equivalent of `kgCli.ts`'s `printTree` — see its own doc comment for `noHolders`/
 *  `unfoldedMode`/`revealed` semantics, unchanged here. */
function render(store: Store, id: string, depth: number, opts: TreeOptions, revealed: boolean, lines: string[]): void {
  const node = wrap(store, id);
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
      content = nodeKindFromId(id) === 'BlockNode' && node.type === 'list'
        ? `(no text of its own — see kg:unfold ${id})`
        : ((node.text as string) ?? '');
    } else {
      content = node.title as string;
    }
    lines.push(`${indent}${id}  [${displayLabel(id, node)}]  ${content}${holderTag}`);
  }

  const refs = childIds(node, nodeKindFromId(id));
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
  for (const childId of refs) {
    render(store, childId, childDepth, opts, childRevealed, lines);
  }
}

export function renderTree(store: Store, rootId: string, opts: TreeOptions = {}): string[] {
  const lines: string[] = [];
  render(store, rootId, 0, opts, false, lines);
  return lines;
}
