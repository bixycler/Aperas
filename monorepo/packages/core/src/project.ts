/**
 * Aperas Artifact Projection — engine-agnostic serializer.
 *
 * Serializes an ArtifactNode's ingested BlockNode tree back into Markdown — the inverse of
 * astParser.ts's parse. Design settled in AperasKG/artifacts/Aperas-artifact-projection-design.md
 * and Aperas-markdown-fractal-mapping-design.md: canonical (not byte-exact) regeneration,
 * list items always blank-line-separated regardless of the source's original tight/loose style,
 * blockquote `> ` prefixing normalized here, and — per the mapping design's §2/§8/§9 — a
 * heading/listItem's own `text` (its consumed leading paragraph) is emitted before its children,
 * and any contiguous run of `listItem`s among a node's children is rendered as a list using
 * *that node's own* `orderedList`/`startIndex` props, wherever in `children` the run occurs.
 *
 * Engine-agnostic (Aperas-apeironngn-design.md §4 rollout, archiving step): `apeironNgn/node.ts`
 * imports `serializeBlock`/`renderChildren`/`withFrontmatter` directly. The TerminusDB-backed
 * GraphQL fetch-then-serialize wrappers that used to live here moved to `projectTdb.ts`, headed
 * to `.archive/` with `kgCli.ts`.
 */

import { getProp } from './props';
import { HEADING_TREE_ANCHOR_PROP, findLeadInSpliceOffset, type DocLang } from './astParser';

/** `<a name='id/<ID>' class='aperas-anchor aperas-id'></a>` for `id` — the permanent anchor
 *  projection adds alongside a block's existing tree-anchor(s) (AperasKG/artifacts/design/
 *  linking.md's Anchors section), never replacing them. */
function idAnchorMarkup(id: string): string {
  return `<a name='id/${id}' class='aperas-anchor aperas-id'></a>`;
}

/** Whether `text` already carries its own `id/<idValue>` anchor — the idempotency check both the
 *  heading and list-item/paragraph cases need before adding a fresh one, so re-projecting an
 *  already-anchored block never duplicates it. `idValue` is `id` with its `Kind:` prefix included,
 *  matching exactly what `idAnchorMarkup` embeds. */
function hasIdAnchor(text: string, id: string): boolean {
  return text.includes(`name='id/${id}'`);
}

/** Splices a fresh id-anchor into `text` right after its own lead-in colon (AperasKG/artifacts/
 *  design/linking.md's Anchors section), if it has one and doesn't already carry this exact anchor —
 *  a list item/paragraph gets no title-side change (Task 3), so the anchor lives in `text` itself,
 *  as literal content, at the same colon `astParser.ts`'s `extractLeadInTitle` took the title from.
 *  A block with no lead-in colon at all is left untouched: it's still addressable via a direct
 *  `aperas://id/<ID>` graph lookup (no text-scanning involved), so no inline anchor is needed.
 *  `id` is `undefined` for a bare, not-yet-ingested `ParsedBlockNode` (which only ever carries its
 *  own scratch `blockId`, not a final graph `id` — reconciliation may still reuse an older id for
 *  it) — nothing to anchor yet in that case, left as a no-op rather than embedding a bogus value. */
function spliceIdAnchor(text: string, id: string | undefined, lang: DocLang): string {
  if (!text || typeof id !== 'string' || hasIdAnchor(text, id)) return text;
  const colonOffset = findLeadInSpliceOffset(text, lang);
  if (colonOffset === null) return text;
  const insertAt = colonOffset + 1;
  return `${text.slice(0, insertAt)} ${idAnchorMarkup(id)}${text.slice(insertAt)}`;
}

/** Prepends a re-emitted `---\n...\n---` frontmatter block, if this node's `props` (§5) carries
 *  one, ahead of its otherwise-serialized body. Applies uniformly to ArtifactNode and
 *  FolderNode — both were the exact same `frontmatter` prop scope decided in §5. Also this
 *  serializer's one exit point, so it's where a final trailing newline is guaranteed — every
 *  write-mode caller (`kgCli.ts`'s `project` command, `kgProjectNgn.ts`) writes this return value
 *  straight to disk with no `+ '\n'` of its own, and neither `serializeBlock`/`renderChildren` nor
 *  their ApeironNgn equivalents add one after the last block. */
export function withFrontmatter(body: string, node: any): string {
  const frontmatter = getProp(node, 'frontmatter');
  const result = frontmatter !== undefined ? `---\n${frontmatter}\n---\n\n${body}` : body;
  return result.endsWith('\n') ? result : `${result}\n`;
}

/** Strips one optional leading `> ` (with or without the trailing space) from a single line. */
function stripBlockquoteMarker(line: string): string {
  return line.replace(/^>\s?/, '');
}

/**
 * Strips whatever common leading whitespace lines 2+ share, leaving line 1 untouched and every
 * relative (meaningful) indentation difference between lines intact. Needed because a raw
 * multi-line leaf's `text` slice only has its *first* line's container-required indentation
 * stripped (that's simply where the node's position offset starts) — every subsequent line
 * keeps its literal original-file column (confirmed live: a `blockquote`'s continuation line,
 * and identically a nested `code` fence's later lines, both carry this). Left un-dedented, a
 * nested container's own re-indentation (`indentContinuationLines`) adds on top of that stale
 * absolute indent instead of establishing a clean baseline — for a fenced code block this
 * desyncs the closing fence from the opening one, breaking fence-matching on re-parse (confirmed
 * live against a real multi-line code block nested in a list item).
 */
function dedent(text: string, skipFirstLine: boolean): string {
  const lines = text.split('\n');
  if (lines.length <= 1) return text;
  const targetLines = skipFirstLine ? lines.slice(1) : lines;
  const indents = targetLines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.length - line.trimStart().length);
  const minIndent = indents.length ? Math.min(...indents) : 0;
  if (minIndent === 0) return text;
  const strip = (line: string) => (line.trim().length > 0 ? line.slice(minIndent) : line);
  return skipFirstLine ? [lines[0], ...lines.slice(1).map(strip)].join('\n') : lines.map(strip).join('\n');
}

const FENCE_RE = /^(```|~~~)/;

function indentContinuationLines(text: string, prefixWidth: number): string {
  const pad = ' '.repeat(prefixWidth);
  return text
    .split('\n')
    .map((line, i) => (i === 0 ? line : pad + line))
    .join('\n');
}

/**
 * Renders a node's children, joined by a blank line — but a contiguous run of `listItem`
 * children (anywhere among `children`, not just at the end) is rendered as one list, using *that
 * run's own first item's* `orderedList`/`startIndex` props — never the enclosing node's, since one
 * node can host more than one run (two authored lists separated by an intervening leaf, or two
 * dissolved orphan lists landing directly adjacent with no separator at all — see design/
 * list-consumption.md). A run therefore ends not just where the `listItem` type run stops, but
 * also wherever the *next* item carries its own explicit `orderedList` prop — a run-leader signal
 * every list's first converted item carries uniformly (astParser.ts), marking the start of a new,
 * adjacent run even though the type hasn't changed. Everything else renders one block at a time
 * via the ordinary per-type dispatch.
 *
 * Tombstoned children are filtered out first: a tombstone is never spliced out of `children`
 * (Aperas-crud-design.md §6) so GC/referrer-tracking can still see it, so every renderer — this one
 * included — must skip it explicitly rather than relying on it being absent.
 */
export function renderChildren(node: any, lang: DocLang = 'en'): string {
  const children = (node.children ?? []).filter((c: any) => !c.tombstonedAt);
  const parts: string[] = [];
  let i = 0;
  while (i < children.length) {
    if (children[i].type === 'listItem') {
      let j = i + 1;
      while (j < children.length && children[j].type === 'listItem' && getProp(children[j], 'orderedList') === undefined) j++;
      const orderedList = getProp(children[i], 'orderedList') === 'true';
      const startIndex = Number(getProp(children[i], 'startIndex') ?? '1');
      const run = children.slice(i, j);
      // Dense/tight list — items joined by a single newline, not a blank line, regardless of the
      // source's own original tight/loose style (canonical regeneration, per this module's own
      // doc comment). A loose list wraps each item's content in its own `<p>` on render; nothing
      // here needs that, and the corpus's own convention is tight.
      parts.push(run.map((item: any, k: number) => serializeListItem(item, orderedList, startIndex + k, lang)).join('\n'));
      i = j;
    } else {
      parts.push(serializeBlock(children[i], lang));
      i++;
    }
  }
  return parts.join('\n\n');
}

/**
 * Recursively serializes one BlockNode (and its subtree) back into Markdown. Dispatches on the
 * node's `type`. There is no `list` case: no `BlockNode` is ever typed `list` (astParser.ts never
 * produces one — a list's items always land as flat/nested `listItem` children of whatever it
 * attaches to), so every `listItem` run is handled generically by `renderChildren`.
 */
export function serializeBlock(node: any, lang: DocLang = 'en'): string {
  switch (node.type) {
    case 'heading': {
      const treeAnchor = getProp(node, HEADING_TREE_ANCHOR_PROP) ?? '';
      // Unconditional whenever an id exists (Task 3, AperasKG/artifacts/planning/linking.md):
      // `node.id` is always a real permanent id post-ingestion, and the same id every time, so
      // appending it here can never duplicate — there's nothing left in `title` for it to already
      // be present in, since parsing strips (and drops) any old id-anchor rather than keeping it
      // (see `astParser.ts`'s `stripTrailingHeadingAnchors`). A bare, not-yet-ingested
      // `ParsedBlockNode` has no `.id` at all (only its own scratch `blockId`) — nothing to anchor
      // yet, so this is skipped rather than embedding a bogus value.
      const idAnchor = typeof node.id === 'string' ? idAnchorMarkup(node.id) : '';
      const anchors = `${treeAnchor}${idAnchor}`;
      // Exactly one space before the first anchor (matching the established written convention,
      // e.g. `## Heading <a name=...>`), never carried over from the source line's own original
      // whitespace: `astParser.ts`'s `stripTrailingHeadingAnchors` trims that away when stripping,
      // so it isn't there to preserve even if it wanted to be.
      const titleLine = anchors ? `${node.title} ${anchors}` : node.title;
      const parts = [titleLine];
      if (node.text) parts.push(node.text);
      const body = renderChildren(node, lang);
      if (body) parts.push(body);
      return parts.join('\n\n');
    }
    case 'paragraph': {
      // Opaque leaf whose own content is `text`, but may also host an adopted list (§8) as
      // `children` — rendered after its own text, if present. Id-anchor splicing (Task 3) applies
      // only here, not to the other opaque-leaf types below: `thematicBreak`/`html`/`table` don't
      // carry lead-in-colon-titled prose, so there's nothing for `spliceIdAnchor` to attach to.
      const own = dedent(spliceIdAnchor(node.text ?? '', node.id, lang), true);
      const body = renderChildren(node, lang);
      return body ? `${own}\n\n${body}` : own;
    }
    case 'thematicBreak':
    case 'html':
    case 'table': {
      // Opaque leaves whose own content is `text`.
      const own = dedent(node.text ?? '', true);
      const body = renderChildren(node, lang);
      return body ? `${own}\n\n${body}` : own;
    }
    case 'code': {
      const raw = node.text ?? '';
      // A fenced block's raw slice starts with its own ``` (or ~~~) marker on line 1, same as
      // any other leaf. An *indented* code block (CommonMark's 4-space form) is also mdast type
      // `code`, but its raw slice has no fence at all — every line, including the first, still
      // carries its original file-column indentation (confirmed live: unlike every other leaf
      // type, position offsets for an indented block don't strip anything from line 1 either,
      // since the indentation *is* the syntax marker). Re-fence it so it survives projection as
      // a code block at all, rather than silently degrading into an ordinary paragraph.
      return FENCE_RE.test(raw) ? dedent(raw, true) : `\`\`\`\n${dedent(raw, false)}\n\`\`\``;
    }
    case 'blockquote': {
      // Opaque leaf now (Aperas-markdown-fractal-mapping-design.md §3) — no children to recurse
      // into, `node.text` is the full raw slice (markers included, as the source wrote them).
      const inner: string = node.text ?? '';
      return inner
        .split('\n')
        .map((line) => stripBlockquoteMarker(line))
        .map((line) => (line ? `> ${line}` : '>'))
        .join('\n');
    }
    default:
      // root, and any other container fallback: just join my children.
      return renderChildren(node, lang);
  }
}

function serializeListItem(item: any, orderedList: boolean, ordinal: number, lang: DocLang): string {
  const marker = orderedList ? `${ordinal}. ` : '- ';
  const checkedProp = getProp(item, 'checked');
  const checkbox = checkedProp === 'true' ? '[x] ' : checkedProp === 'false' ? '[ ] ' : '';
  const prefix = marker + checkbox;
  const parts: string[] = [];
  if (item.text) parts.push(spliceIdAnchor(item.text, item.id, lang));
  const body = renderChildren(item, lang);
  if (body) parts.push(body);
  return prefix + indentContinuationLines(parts.join('\n\n'), prefix.length);
}
