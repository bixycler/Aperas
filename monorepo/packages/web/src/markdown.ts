/**
 * The one markdown parser every rendering site in this package uses — `unified`+`remark-parse`+
 * `remark-gfm`, the exact same combination `core`'s own `astParser.ts` already uses to decide what
 * a table/code-fence/blockquote *is* at ingestion time (same package versions, see `package.json`).
 *
 * Before this, `Inline.tsx`, `MarkdownTable.tsx`, `MarkdownQuote.tsx` and `CodeBlock.tsx` each had
 * their own bespoke regex/string-walking re-implementation of a piece of the same spec — free to
 * disagree with the server's own `remark-gfm` parse (and with each other) on any edge case none of
 * them happened to think of (nested code spans in a table cell, GFM strikethrough, autolinks,
 * escaping). Parsing once, here, and only ever *rendering* the resulting AST by hand elsewhere,
 * removes that whole class of risk rather than adding a fifth bespoke implementation.
 *
 * `classifyBlock` mirrors how `astParser.ts` already splits a document into one graph block per
 * top-level construct: a stored block's own text is never really "some prose, then a table" at
 * this layer, so it's classified as a special block-level construct only when the *entire* text
 * parses to exactly one such node — otherwise it's ordinary prose, rendered inline.
 */
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Root, Code, Table, Blockquote } from 'mdast';

const processor = unified().use(remarkParse).use(remarkGfm);

export function parseMarkdown(text: string): Root {
  return processor.parse(text) as Root;
}

export type BlockClassification =
  | { kind: 'mermaid'; code: string }
  | { kind: 'code'; node: Code }
  | { kind: 'table'; node: Table }
  | { kind: 'quote'; node: Blockquote }
  | { kind: 'prose'; root: Root };

export function classifyBlock(text: string): BlockClassification {
  const root = parseMarkdown(text);
  if (root.children.length === 1) {
    const node = root.children[0];
    if (node.type === 'code') {
      return node.lang === 'mermaid' ? { kind: 'mermaid', code: node.value } : { kind: 'code', node };
    }
    if (node.type === 'table') return { kind: 'table', node };
    if (node.type === 'blockquote') return { kind: 'quote', node };
  }
  return { kind: 'prose', root };
}
