/**
 * `kg:insert` — position, promote, or create a Block node (Aperas-crud-design.md §7), via the
 * shared ApeironNgn service. Concrete-only: never mints an abstract placeholder (that stays
 * `kg:resolve --create-holder`'s job) and never scaffolds a missing Folder/Artifact parent chain —
 * `<path>`'s parent (implied or explicit) must already exist, holder or real.
 *
 * Two modes, distinguished by whether markdown was piped to stdin:
 * - No stdin: `<path>` names an *existing* Block node. Repositions it relative to `--after`/
 *   `--before <anchor>` (the anchor's current parent becomes the node's new parent — cross-parent
 *   moves work for free) and unconditionally clears `.holder` — a no-op if it was already real, in
 *   which case this is a plain move. Omitting both flags is a bare in-place promote.
 * - Stdin piped: `<path>` names the *parent* to create under. The piped markdown is parsed via the
 *   same `parseMarkdownTree` real artifacts use; each new node's type/title/text/children come
 *   entirely from that parse (no `--type`/`--titles`). If the parse has more than one top-level
 *   block, all of them are created and inserted as a sequence at the anchor position (or appended,
 *   in order, if no anchor given) — never merged into one node, never rejected.
 */

import type { Store } from 'oxigraph';
import { resolveDeepPath } from './apeironNgn/resolve';
import { wrap, rejectSlugPathCollisions } from './apeironNgn/node';
import type { BlockNode, TreeNode } from './apeironNgn/node';
import { nodeKindFromId } from './apeironNgn/vocab';
import { displayLabel } from './apeironNgn/tree';
import { parseMarkdownTree } from './astParser';
import { ensureServiceRunning, request } from './apeironNgn/serviceClient';
import { wantsHelp, printHelp } from './kgHelp';

export interface InsertReq {
  path: string;
  base?: string;
  /** Present (even `''`) => create mode; absent => move/promote mode. Set by the CLI client only
   *  when stdin wasn't a TTY — see `readStdinIfPiped` below. */
  markdown?: string;
  after?: string;
  before?: string;
}

function resolveOne(store: Store, ref: string, base: string | undefined, label: string): string {
  let id: string | null;
  try {
    id = resolveDeepPath(store, ref, { base });
  } catch (err: any) {
    throw new Error(`${label} '${ref}': ${err.message || err}`);
  }
  if (!id) {
    throw new Error(`${label} '${ref}' isn't a tracked artifact/folder path, deep path, bare node code, or full node id.`);
  }
  return id;
}

export function runInsert(store: Store, req: InsertReq): { lines: string[] } {
  if (req.after !== undefined && req.before !== undefined) {
    throw new Error('--after and --before are mutually exclusive.');
  }
  const side: 'before' | 'after' | undefined = req.after !== undefined ? 'after' : req.before !== undefined ? 'before' : undefined;
  const anchorRef = req.after ?? req.before;

  if (req.markdown === undefined) {
    // Move/promote mode: `path` names the existing node itself.
    const targetId = resolveOne(store, req.path, req.base, 'Target');
    if (nodeKindFromId(targetId) !== 'BlockNode') {
      throw new Error(`'${req.path}' resolves to a ${nodeKindFromId(targetId)} — kg:insert only positions Block-level nodes (Aperas-crud-design.md §4.1).`);
    }
    const target = wrap(store, targetId) as unknown as BlockNode;

    if (anchorRef === undefined) {
      (target as unknown as { holder?: boolean }).holder = undefined;
      return { lines: [`aperas://id/${targetId}  [${displayLabel(targetId, target)}]  ${target.title}  (promoted in place)`] };
    }

    const anchorId = resolveOne(store, anchorRef, req.base, 'Anchor');
    if (anchorId === targetId) throw new Error('The anchor cannot be the same node as the target.');
    const anchorParent = (wrap(store, anchorId) as unknown as TreeNode).parent;
    if (!anchorParent) throw new Error(`Anchor '${anchorRef}' has no parent to insert relative to.`);
    (anchorParent as unknown as BlockNode).insertChild(targetId, anchorId, side!);
    return { lines: [`aperas://id/${targetId}  [${displayLabel(targetId, target)}]  ${target.title}  (moved ${side} ${anchorId})`] };
  }

  // Create mode: `path` names the parent.
  const parentId = resolveOne(store, req.path, req.base, 'Parent');
  const parentKind = nodeKindFromId(parentId);
  if (parentKind !== 'BlockNode' && parentKind !== 'ArtifactNode' && parentKind !== 'FolderNode') {
    throw new Error(`'${req.path}' isn't a valid parent to create under.`);
  }
  const parent = wrap(store, parentId) as unknown as BlockNode; // insertChild/appendChild: TreeNode's own overridden contract

  const { root } = parseMarkdownTree(req.markdown);
  const topLevel = root.children ?? [];
  if (topLevel.length === 0) {
    throw new Error('Piped markdown produced no content to insert.');
  }

  // Full-slug-path collision rejection (design/linking.md's Full-Path Collisions) — the same
  // writer-facing hard reject `ingestFromDisk` applies to a whole artifact's fresh parse, applied
  // here to a new subtree inserted directly into the graph: `parent.toPath()` already returns the
  // right prefix uniformly whether `parent` is a Block/Artifact/FolderNode (`toPath()`'s own kind
  // check handles the latter two). Must run before any of `topLevel` is hydrated.
  const parentPath = parent.toPath();
  if (parentPath) rejectSlugPathCollisions(store, parentPath, topLevel);

  const newIds = topLevel.map((child) => {
    const id = `BlockNode:${child.blockId}`;
    (wrap(store, id) as unknown as BlockNode).hydrateFromParsed(child);
    return id;
  });

  if (anchorRef !== undefined) {
    const anchorId = resolveOne(store, anchorRef, req.base, 'Anchor');
    let insertRef = anchorId;
    for (const newId of newIds) {
      parent.insertChild(newId, insertRef, side!);
      if (side === 'after') insertRef = newId; // chain forward so the sequence lands in parse order
      // side === 'before': every entry anchors to the same original anchor, in forward order, which
      // already accumulates in the right order (each new entry lands right before the anchor,
      // after whatever was already placed there).
    }
  } else {
    for (const newId of newIds) parent.appendChild(newId);
  }

  const lines = newIds.map((id) => {
    const node = wrap(store, id) as unknown as BlockNode;
    return `aperas://id/${id}  [${displayLabel(id, node)}]  ${node.title}  (created)`;
  });
  return { lines };
}

/** `isTTY` alone isn't reliable — confirmed live: a non-interactive harness (no controlling
 *  terminal at all, nothing actually piped either) also reads `isTTY` as falsy, so relying on it
 *  alone put a bare `kg:insert <path>` into create mode with empty content instead of falling back
 *  to move/promote. Content presence is the real signal: no legitimate create ever has zero bytes
 *  of markdown, so an empty read (regardless of why) means "nothing was piped." */
async function readStdinIfPiped(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const content = Buffer.concat(chunks).toString('utf-8');
  return content.length > 0 ? content : undefined;
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (wantsHelp(rawArgs)) {
    printHelp({
      description: 'Position, promote, or (with piped markdown) create a Block node.',
      usage: [
        'kg:insert -- [--base <path>] <path> [--after <anchor>|--before <anchor>]',
        'cat new-node.md | kg:insert -- [--base <path>] <parent-path> [--after <anchor>|--before <anchor>]',
      ],
      args: [
        { name: '<path>', description: 'No stdin: the existing node to move/promote. With piped markdown: the parent to create under.' },
      ],
      flags: [
        { name: '--base <path>', description: 'Base path deep-path resolution is relative to.' },
        { name: '--after <anchor>', description: 'Position immediately after this sibling.' },
        { name: '--before <anchor>', description: 'Position immediately before this sibling.' },
        { name: '--flush', description: 'Force an immediate sync to disk after this call, instead of waiting for the normal flush timer.' },
        { name: '--reload', description: 'Reload the store from disk first, in case something else (e.g. a git pull) changed it since the service started.' },
      ],
    });
    return;
  }
  const flush = rawArgs.includes('--flush');
  const reload = rawArgs.includes('--reload');
  const args = rawArgs.filter((a) => a !== '--flush' && a !== '--reload');

  const baseIdx = args.indexOf('--base');
  const base = baseIdx !== -1 ? args[baseIdx + 1] : undefined;
  const afterIdx = args.indexOf('--after');
  const after = afterIdx !== -1 ? args[afterIdx + 1] : undefined;
  const beforeIdx = args.indexOf('--before');
  const before = beforeIdx !== -1 ? args[beforeIdx + 1] : undefined;

  const consumed = new Set<number>();
  if (baseIdx !== -1) { consumed.add(baseIdx); consumed.add(baseIdx + 1); }
  if (afterIdx !== -1) { consumed.add(afterIdx); consumed.add(afterIdx + 1); }
  if (beforeIdx !== -1) { consumed.add(beforeIdx); consumed.add(beforeIdx + 1); }
  const rest = args.filter((_, i) => !consumed.has(i));

  const [path] = rest;
  if (!path) {
    console.error('Usage: kg:insert -- [--base <path>] <path> [--after <anchor>|--before <anchor>]');
    process.exit(1);
  }

  const markdown = await readStdinIfPiped();

  await ensureServiceRunning();
  const result = await request<ReturnType<typeof runInsert>>({ op: 'insert', path, base, markdown, after, before, flush, reload });
  for (const line of result.lines) console.log(line);
}

if (process.argv[1]?.endsWith('kgInsert.ts')) {
  main().catch((err) => {
    console.error('[ApeironNgn kg:insert] Failed:', err.message || err);
    process.exit(1);
  });
}
