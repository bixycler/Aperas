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
import { resolveDeepPath } from '@aperas/core/apeironNgn/resolve';
import { wrap, type TreeNode, type BlockNode, type Link, type TreeView, type ApeironNode } from '@aperas/core/apeironNgn/node';
import { nodeKindFromId, nodeExists } from '@aperas/core/apeironNgn/vocab';
import { displayLabel } from '@aperas/core/apeironNgn/tree';
import { truncateForPreviewWithHint } from '@aperas/core/astParser';
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

function isTombstoned(node: { tombstonedAt?: string } | undefined): boolean {
  return node?.tombstonedAt !== undefined;
}

/** `(tombstoned)` tag, same wording `node.ts`'s own renderers use — this file has its own,
 *  separate preview-printing path (see `previewText`'s own doc comment), so it needs its own copy
 *  rather than importing a private helper. */
function tombstoneTag(node: { tombstonedAt?: string } | undefined): string {
  return isTombstoned(node) ? '  (tombstoned)' : '';
}

interface UnfoldChildEntry {
  id: string;
  label: string;
  text: string;
  children?: UnfoldChildEntry[];
}

/** One node's own children/links as a flat list of one-line previews — the exact same shape
 *  `runUnfold` builds for the plain-`TreeNode` case, factored out so the `Link` branch below can
 *  reuse it to actually list its target's children (not just a `foldTag` count of them).
 *
 *  Tombstoned entries are hidden by default (`showTombstoned` false), matching `kg:tree`'s own
 *  default (issues/treeview.md's "both `unfold` and `tree` should hide them by default") — a
 *  tombstoned child used to render identically to a live sibling here, with no marker at all,
 *  indistinguishable and easy to misread as anomalous. `showTombstoned: true` reveals them, tagged. */
function previewChildren(store: Store, node: TreeNode, showTombstoned: boolean): UnfoldChildEntry[] {
  const children = node.treeChildren
    .filter((child) => showTombstoned || !isTombstoned(child as unknown as { tombstonedAt?: string }))
    .map((child) => {
      const childId = child.id;
      if (!nodeExists(store, childId)) return { id: childId, label: '?', text: '<not found>' };
      return { id: childId, label: displayLabel(childId, child), text: `${previewText(child)}${tombstoneTag(child as unknown as { tombstonedAt?: string })}${foldTag(child)}` };
    });
  const links = ((node.links as unknown as Link[] | undefined) ?? [])
    .filter((link) => showTombstoned || !isTombstoned((link.target as unknown as { tombstonedAt?: string } | undefined)))
    .map((link) => {
      const target = link.target as unknown as TreeNode | undefined;
      return { id: link.id, label: 'Link', text: target ? `${link.predicate as unknown as string} → ${target.id}  ${previewText(target)}${tombstoneTag(target as unknown as { tombstonedAt?: string })}${foldTag(target)}` : '<no target>' };
    });
  return [...children, ...links];
}

/** `view: null` — the `peek` (no `--view` at all) case: resolves and previews `pathArg` without
 *  touching any `TreeView` state. Every other branch below only ever reads `id`/`store`, never
 *  `view`, so this is the only line that needs to change.
 *
 *  `showTombstoned` — same default-hidden posture as `kg:tree` (issues/treeview.md): unfolding a
 *  tombstoned node directly is refused (not just silently empty, since this command's whole job is
 *  revealing the *one* thing it was pointed at) unless the flag is passed; its children/link
 *  targets are filtered by `previewChildren` regardless. */
export function runUnfold(store: Store, pathArg: string, view: TreeView | null, showTombstoned: boolean = false) {
  // No try/catch around ref resolution here, deliberately — matches `kgCli.ts`'s plain
  // `resolveNodeRef`, which also lets an ambiguous-segment throw propagate uncaught.
  const id = resolveUnfoldRef(store, pathArg);
  if (!id) throw new Error(`'${pathArg}' isn't a tracked artifact/folder path, deep path, bare node code, or full node id.`);
  if (!nodeExists(store, id)) throw new Error(`Node '${id}' not found.`);
  if (!showTombstoned && isTombstoned(wrap(store, id) as unknown as { tombstonedAt?: string })) {
    throw new Error(`'${pathArg}' (${id}) is tombstoned — pass --tombstoned to reveal it.`);
  }

  view?.unfold(id);

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
        ? [{ id: target.id, label: displayLabel(target.id, target), text: `${previewText(target, { full: true })}${tombstoneTag(target as unknown as { tombstonedAt?: string })}`, children: previewChildren(store, target, showTombstoned) }]
        : [],
    };
  }

  const node = wrap(store, id) as unknown as TreeNode;
  return { id, label: displayLabel(id, node), title: `${previewText(node, { full: true })}${tombstoneTag(node as unknown as { tombstonedAt?: string })}`, children: previewChildren(store, node, showTombstoned) };
}

export async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (wantsHelp(rawArgs)) {
    printHelp({
      description: "Add one TreeNode/Link ref to a TreeView's unfolds set — only that one ref; the view's own rendering decides what becomes visible as a result. Prints the target's title plus each immediate child's/link's abstract as a preview of what just got revealed.",
      usage: 'aperas unfold <ref> [--view <viewRef>] [--tombstoned] [--flush] [--reload]',
      args: [
        { name: '<ref>', description: 'TreeNode (deep path, bare node code, or full id) or Link (bare id only — a Link has no path of its own) to reveal.' },
      ],
      flags: [
        { name: '--view <viewRef>', description: 'TreeView to modify (mints the "default" view on first use if omitted after the flag). Omitting the flag entirely is a read-only peek — nothing is unfolded or mutated.' },
        { name: '--tombstoned', description: 'Reveal a tombstoned target/child/link (tagged (tombstoned)) — refused/hidden entirely by default.' },
        { name: '--flush', description: 'Force an immediate sync to disk after this call, instead of waiting for the normal flush timer.' },
        { name: '--reload', description: 'Reload the store from disk first, in case something else (e.g. a git pull) changed it since the service started.' },
      ],
    });
    return;
  }
  const flush = rawArgs.includes('--flush');
  const reload = rawArgs.includes('--reload');
  const showTombstoned = rawArgs.includes('--tombstoned');
  const withoutFlush = rawArgs.filter((p) => p !== '--flush' && p !== '--reload' && p !== '--tombstoned');
  const viewFlagIdx = withoutFlush.indexOf('--view');
  // Distinct from `viewRef` being `undefined`: that also happens when `--view` is typed with no
  // name following it, which keeps the bootstrap-and-mutate default-view behavior (`resolveTreeView`
  // treats a missing name the same as `"default"`). Only the flag's outright *absence* means peek.
  const peek = viewFlagIdx === -1;
  const viewRef = viewFlagIdx !== -1 ? withoutFlush[viewFlagIdx + 1] : undefined;
  const withoutFlags = viewFlagIdx !== -1
    ? withoutFlush.filter((_, i) => i !== viewFlagIdx && i !== viewFlagIdx + 1)
    : withoutFlush;
  const [pathArg] = withoutFlags;
  if (!pathArg) {
    console.error('Usage: aperas unfold <ref> [--view <viewRef>] [--tombstoned] [--flush] [--reload]');
    process.exit(1);
  }

  await ensureServiceRunning();
  const result = await request<ReturnType<typeof runUnfold>>({ op: 'unfold', ref: pathArg, viewRef, peek, showTombstoned, flush, reload });

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
