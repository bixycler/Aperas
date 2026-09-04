/**
 * `kg:unfold` — adds one `TreeNode` or `Link` ref to a `TreeView`'s `unfolds` set (only that one
 * ref — the view's own rendering, not this command, decides what becomes visible as a result;
 * Aperas-treeview-design.md §5), via the shared ApeironNgn service
 * (Aperas-apeironngn-design.md §4 rollout step 5). Prints the target's title plus its full,
 * uncapped text (the one place a node's complete text is ever shown — everywhere else, including
 * this same command's own child/link previews below it, is a capped one-line preview), then each
 * immediate child's/link's own title+capped-abstract preview of what just got revealed.
 */

import type { Store } from 'oxigraph';
import { resolveDeepPath } from './apeironNgn/resolve';
import { wrap, type TreeNode, type BlockNode, type Link, type TreeView, type ApeironNode } from './apeironNgn/node';
import { nodeKindFromId, nodeExists } from './apeironNgn/vocab';
import { displayLabel } from './apeironNgn/tree';
import { truncateForPreviewWithHint } from './astParser';
import { ensureServiceRunning, request } from './apeironNgn/serviceClient';
import { wantsHelp, printHelp } from './kgHelp';

/** `ref` for a `TreeNode` resolves the normal deep-path way; for a `Link`, only a bare id
 *  (snowflake code) is accepted — a `Link` has no `path` field and no natural slug of its own to
 *  build one from, so `resolveDeepPath`'s path-segment machinery doesn't apply to it. Since a
 *  `Link`'s own id already carries a recognizable kind prefix, `resolveDeepPath`'s "already a full
 *  node id" branch is what actually accepts it — no special-casing needed here. */
function resolveUnfoldRef(store: Store, ref: string): string | null {
  return resolveDeepPath(store, ref);
}

/** The abstract half of `previewText` below, on its own — `kgBacklinks.ts`'s `--text` flag wants
 *  just this (it prints its own `[label]`/title layout around it), not the combined `title ║
 *  abstract` string. */
export function nodeAbstract(node: TreeNode, opts: { full?: boolean } = {}): string | undefined {
  const isTextlessList = nodeKindFromId(node.id) === 'BlockNode' && (node as unknown as BlockNode).type === 'list';
  if (isTextlessList) return `(no text of its own — see kg:unfold ${node.id})`;
  if (node.text === undefined) return undefined;
  const raw = node.text as unknown as string;
  if (opts.full) {
    // The whole point of unfolding *this* node: nowhere else ever shows a node's complete text,
    // only ever a capped preview (kg:tree, and this same file's own children/links below) — so
    // the one thing actually being revealed here should never itself be truncated. Verbatim, not
    // collapsed to one line either, unlike the preview case: this is "what's really stored," not
    // a scannable summary.
    return raw;
  }
  return truncateForPreviewWithHint(raw, node.id);
}

/** Title *and* abstract for one previewed node — same combined shape as `node.ts`'s `emitNode`
 *  (Aperas-treeview-design.md's resolved `treeview-render-tiers.md` "Bug A"). This file has its
 *  own, separate preview-printing path (not `emitNode`), so it had its own separate instance of
 *  the same bug — title-only for the unfolded target itself (useless for a `paragraph`/`listItem`
 *  node, whose real content is `.text`, not a bare-id-fallback `.title`), text-only for children
 *  (silently dropping the title whenever text was present). Applied uniformly here: the unfolded
 *  target's own line, each structural child, and each link's target all go through this one
 *  helper, rather than three independently-hand-rolled formats. */
function previewText(node: TreeNode, opts: { full?: boolean } = {}): string {
  const abstract = nodeAbstract(node, opts);
  const title = (node.title as string) ?? '';
  // `║` rather than plain whitespace, matching `node.ts`'s own title/abstract separator — both
  // sides are free-form prose, so a script can't otherwise tell where one ends and the other
  // begins the way it safely can for the `id`/`[kind]` fields.
  return abstract !== undefined ? `${title}  ║  ${abstract}` : title;
}

/** Fold-state marker for one child/link-target line in this preview — GUI-icon-equivalent for how
 *  much of *that node's own* real content isn't shown here. Always non-zero for any non-leaf,
 *  since this preview is a flat, one-level listing: unlike `node.ts`'s tiered rendering, nothing
 *  previewed here ever gets its own children/links expanded in the same call. Not applied to the
 *  unfolded target's own top line — those genuinely *are* all listed immediately below, in this
 *  same output, so there's nothing hidden left to flag there. */
function foldTag(node: TreeNode): string {
  const count = node.treeChildren.length + ((node.links as unknown as ApeironNode[] | undefined)?.length ?? 0);
  return count > 0 ? `  [+${count}]` : '';
}

interface UnfoldChildEntry {
  id: string;
  label: string;
  text: string;
  children?: UnfoldChildEntry[];
}

/** One node's own children/links as a flat list of one-line previews — the exact same shape
 *  `runUnfold` builds for the plain-`TreeNode` case, factored out so the `Link` branch below can
 *  reuse it to actually list its target's children (not just a `foldTag` count of them). */
function previewChildren(store: Store, node: TreeNode): UnfoldChildEntry[] {
  const children = node.treeChildren.map((child) => {
    const childId = child.id;
    if (!nodeExists(store, childId)) return { id: childId, label: '?', text: '<not found>' };
    return { id: childId, label: displayLabel(childId, child), text: `${previewText(child)}${foldTag(child)}` };
  });
  const links = ((node.links as unknown as Link[] | undefined) ?? []).map((link) => {
    const target = link.target as unknown as TreeNode | undefined;
    return { id: link.id, label: 'Link', text: target ? `${link.predicate as unknown as string} → ${target.id}  ${previewText(target)}${foldTag(target)}` : '<no target>' };
  });
  return [...children, ...links];
}

export function runUnfold(store: Store, pathArg: string, view: TreeView) {
  // No try/catch around ref resolution here, deliberately — matches `kgCli.ts`'s plain
  // `resolveNodeRef`, which also lets an ambiguous-segment throw propagate uncaught.
  const id = resolveUnfoldRef(store, pathArg);
  if (!id) throw new Error(`'${pathArg}' isn't a tracked artifact/folder path, deep path, bare node code, or full node id.`);
  if (!nodeExists(store, id)) throw new Error(`Node '${id}' not found.`);

  view.unfold(id);

  if (nodeKindFromId(id) === 'Link') {
    const link = wrap(store, id) as unknown as Link;
    const target = link.target as unknown as TreeNode | undefined;
    return {
      id,
      label: 'Link',
      title: `${link.predicate as unknown as string} → ${target?.id ?? '<no target>'}`,
      // Unfolding a Link reveals its target — that's the thing actually being unfolded here, same
      // as the plain-`TreeNode` branch below: its own line gets the full/uncapped treatment, and
      // its real children/links get listed one level deeper (not folded away into a bare count).
      children: target
        ? [{ id: target.id, label: displayLabel(target.id, target), text: previewText(target, { full: true }), children: previewChildren(store, target) }]
        : [],
    };
  }

  const node = wrap(store, id) as unknown as TreeNode;
  return { id, label: displayLabel(id, node), title: previewText(node, { full: true }), children: previewChildren(store, node) };
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (wantsHelp(rawArgs)) {
    printHelp({
      description: "Add one TreeNode/Link ref to a TreeView's unfolds set — only that one ref; the view's own rendering decides what becomes visible as a result. Prints the target's title plus each immediate child's/link's abstract as a preview of what just got revealed.",
      usage: 'kg:unfold -- <ref> [--view <viewRef>] [--flush] [--reload]',
      args: [
        { name: '<ref>', description: 'TreeNode (deep path, bare node code, or full id) or Link (bare id only — a Link has no path of its own) to reveal.' },
      ],
      flags: [
        { name: '--view <viewRef>', description: 'TreeView to modify. Defaults to the "default"-named view.' },
        { name: '--flush', description: 'Force an immediate sync to disk after this call, instead of waiting for the normal flush timer.' },
        { name: '--reload', description: 'Reload the store from disk first, in case something else (e.g. a git pull) changed it since the service started.' },
      ],
    });
    return;
  }
  const flush = rawArgs.includes('--flush');
  const reload = rawArgs.includes('--reload');
  const withoutFlush = rawArgs.filter((p) => p !== '--flush' && p !== '--reload');
  const viewFlagIdx = withoutFlush.indexOf('--view');
  const viewRef = viewFlagIdx !== -1 ? withoutFlush[viewFlagIdx + 1] : undefined;
  const withoutFlags = viewFlagIdx !== -1
    ? withoutFlush.filter((_, i) => i !== viewFlagIdx && i !== viewFlagIdx + 1)
    : withoutFlush;
  const [pathArg] = withoutFlags;
  if (!pathArg) {
    console.error('Usage: kg:unfold -- <ref> [--view <viewRef>] [--flush] [--reload]');
    process.exit(1);
  }

  await ensureServiceRunning();
  const result = await request<ReturnType<typeof runUnfold>>({ op: 'unfold', ref: pathArg, viewRef, flush, reload });

  console.log(`${result.id}  [${result.label}]  ${result.title}`);
  printUnfoldChildren(result.children, 1);
}

/** Recurses one level deeper per nested `children` array — needed for the `Link` case, where the
 *  target's own line sits at depth 1 and *its* real children/links (not just a fold-count) sit at
 *  depth 2. The plain-`TreeNode` case never nests past depth 1, so this degenerates to the old flat
 *  loop for it. */
function printUnfoldChildren(entries: ReturnType<typeof runUnfold>['children'], depth: number): void {
  for (const entry of entries) {
    console.log(`${'│ '.repeat(depth)}${entry.id}  [${entry.label}]  ${entry.text}`);
    if (entry.children) printUnfoldChildren(entry.children, depth + 1);
  }
}

if (process.argv[1]?.endsWith('kgUnfold.ts')) {
  main().catch((err) => {
    console.error('[ApeironNgn kg:unfold] Failed:', err.message || err);
    process.exit(1);
  });
}
