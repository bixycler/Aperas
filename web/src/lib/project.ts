/**
 * Aperas Artifact Projection
 *
 * Serializes an ArtifactNode's ingested BlockNode tree back into Markdown — the inverse of
 * astParser.ts's parse. Design settled in AperasKG/artifacts/Aperas-artifact-projection-design.md
 * and Aperas-markdown-fractal-mapping-design.md: canonical (not byte-exact) regeneration,
 * list items always blank-line-separated regardless of the source's original tight/loose style,
 * blockquote `> ` prefixing normalized here, and — per the mapping design's §2/§8/§9 — a
 * heading/listItem's own `text` (its consumed leading paragraph) is emitted before its children,
 * and any contiguous run of `listItem`s among a node's children is rendered as a list using
 * *that node's own* `orderedList`/`startIndex` props, wherever in `children` the run occurs.
 */

import { getArtifactTreeViaGraphQL, getFolderTreeViaGraphQL } from './graphql';
import { getProp } from './props';

/** Prepends a re-emitted `---\n...\n---` frontmatter block, if this node's `props` (§5) carries
 *  one, ahead of its otherwise-serialized body. Applies uniformly to ArtifactNode and
 *  FolderNode — both were the exact same `frontmatter` prop scope decided in §5. */
function withFrontmatter(body: string, node: any): string {
  const frontmatter = getProp(node, 'frontmatter');
  return frontmatter !== undefined ? `---\n${frontmatter}\n---\n\n${body}` : body;
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
 * children (anywhere among `children`, not just at the end — §8) is rendered as one list using
 * *this* node's own `orderedList`/`startIndex` props, since a list-hosting node (an orphaned
 * `list` block, or whatever adopted the list per §8) is the sole owner of that list's numbering.
 * Everything else renders one block at a time via the ordinary per-type dispatch.
 */
function renderChildren(node: any): string {
  const children = node.children ?? [];
  const parts: string[] = [];
  let i = 0;
  while (i < children.length) {
    if (children[i].type === 'listItem') {
      let j = i;
      while (j < children.length && children[j].type === 'listItem') j++;
      const orderedList = getProp(node, 'orderedList') === 'true';
      const startIndex = Number(getProp(node, 'startIndex') ?? '1');
      const run = children.slice(i, j);
      parts.push(run.map((item: any, k: number) => serializeListItem(item, orderedList, startIndex + k)).join('\n\n'));
      i = j;
    } else {
      parts.push(serializeBlock(children[i]));
      i++;
    }
  }
  return parts.join('\n\n');
}

/**
 * Recursively serializes one BlockNode (and its subtree) back into Markdown. Dispatches on the
 * node's `type`. `list` has no case of its own — an orphaned list block's entire `children` is
 * one contiguous `listItem` run, already handled generically by `renderChildren`'s default case.
 */
export function serializeBlock(node: any): string {
  switch (node.type) {
    case 'heading': {
      const parts = [node.title];
      if (node.text) parts.push(node.text);
      const body = renderChildren(node);
      if (body) parts.push(body);
      return parts.join('\n\n');
    }
    case 'paragraph':
    case 'thematicBreak':
    case 'html':
    case 'table': {
      // These are opaque leaves whose own content is `text`, but a paragraph specifically may
      // also host an adopted list (§8) as `children` — rendered after its own text, if present.
      const own = dedent(node.text ?? '', true);
      const body = renderChildren(node);
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
      return renderChildren(node);
  }
}

function serializeListItem(item: any, orderedList: boolean, ordinal: number): string {
  const marker = orderedList ? `${ordinal}. ` : '- ';
  const checkedProp = getProp(item, 'checked');
  const checkbox = checkedProp === 'true' ? '[x] ' : checkedProp === 'false' ? '[ ] ' : '';
  const prefix = marker + checkbox;
  const parts: string[] = [];
  if (item.text) parts.push(item.text);
  const body = renderChildren(item);
  if (body) parts.push(body);
  return prefix + indentContinuationLines(parts.join('\n\n'), prefix.length);
}

/**
 * Fetches an ArtifactNode's ingested tree and serializes it back to Markdown. Always fully
 * "unfolded" — file serialization ignores each block's `unfolded` view-state, since the
 * physical file has to contain the whole document body regardless (design doc §0/intro).
 * Returns null when the artifact isn't found.
 */
export async function projectArtifactToMarkdown(client: any, path: string): Promise<string | null> {
  const artifact = await getArtifactTreeViaGraphQL(client, path);
  if (!artifact?.root) return null;
  return withFrontmatter(serializeBlock(artifact.root), artifact);
}

/**
 * Serializes a FolderNode's own content (its README's consumed leading text, plus its
 * README-derived block children) back into `README.md` Markdown. `renderChildren` never
 * switches on `node.type` itself — only `serializeBlock`'s dispatch does — so it works directly
 * against a FolderNode with no wrapper needed. Nested `FolderNode`/`ArtifactNode` references in
 * `children` are structural, not textual content — they were never part of the README's own
 * source, so they're filtered out here (Aperas-markdown-fractal-mapping-design.md §6).
 */
export function serializeFolderToReadme(folder: any): string {
  const blockChildren = (folder.children ?? []).filter((c: any) => c._type === undefined);
  const parts: string[] = [];
  if (folder.text) parts.push(folder.text);
  const body = renderChildren({ ...folder, children: blockChildren });
  if (body) parts.push(body);
  return withFrontmatter(parts.join('\n\n'), folder);
}

/**
 * Fetches a FolderNode's content and serializes it back to a `README.md`. Returns null when the
 * folder isn't found.
 */
export async function projectFolderToReadme(client: any, path: string): Promise<string | null> {
  const folder = await getFolderTreeViaGraphQL(client, path);
  if (!folder) return null;
  return serializeFolderToReadme(folder);
}
