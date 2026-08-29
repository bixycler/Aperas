/**
 * Aperas Artifact Projection
 *
 * Serializes an ArtifactNode's ingested BlockNode tree back into Markdown — the inverse of
 * astParser.ts's parse. Design settled in AperasKG/artifacts/Aperas-artifact-projection-design.md:
 * canonical regeneration (headings/paragraphs/code round-trip exactly via their raw `title`/
 * `text`; containers like `list`/`blockquote` are regenerated as clean, valid Markdown rather
 * than reproducing original whitespace), list items always blank-line-separated regardless of
 * the source's original tight/loose style (§2), and blockquote `> ` prefixing normalized here
 * rather than at ingestion (§3).
 */

import { getArtifactTreeViaGraphQL } from './graphql';

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

/** Renders a node's children, each via `serializeBlock`, joined by a blank line. */
function renderChildren(node: any): string {
  return (node.children ?? []).map(serializeBlock).join('\n\n');
}

/**
 * Recursively serializes one BlockNode (and its subtree) back into Markdown. Dispatches on the
 * node's `type` (§5 of the design doc) — `list` delegates each child to `serializeListItem`
 * rather than this function, since a list item's marker/indent depends on its parent list's
 * `ordered`/`start`, not on anything the item carries alone.
 */
export function serializeBlock(node: any): string {
  switch (node.type) {
    case 'heading': {
      const body = renderChildren(node);
      return body ? `${node.title}\n\n${body}` : node.title;
    }
    case 'paragraph':
      return dedent(node.text ?? '', true);
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
      const inner = renderChildren(node);
      return inner
        .split('\n')
        .map((line) => stripBlockquoteMarker(line))
        .map((line) => (line ? `> ${line}` : '>'))
        .join('\n');
    }
    case 'list': {
      const ordered = Boolean(node.ordered);
      const start = typeof node.start === 'number' ? node.start : 1;
      return (node.children ?? [])
        .map((item: any, i: number) => serializeListItem(item, ordered, start + i))
        .join('\n\n');
    }
    default:
      // root, and any other container fallback: just join my children.
      return renderChildren(node);
  }
}

function serializeListItem(item: any, ordered: boolean, ordinal: number): string {
  const marker = ordered ? `${ordinal}. ` : '- ';
  const checkbox = item.checked === true ? '[x] ' : item.checked === false ? '[ ] ' : '';
  const prefix = marker + checkbox;
  const body = renderChildren(item);
  return prefix + indentContinuationLines(body, prefix.length);
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
  return serializeBlock(artifact.root);
}
