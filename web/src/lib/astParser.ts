/**
 * Aperas Phase 1: Fractal AST Transducer
 *
 * Parses raw Markdown content into an infinitely nested tree of BlockNodes.
 * Node identity is a Snowflake-style generated id (see snowflake.ts), assigned
 * once per parsed block — not derived from content or position, per
 * AperasKG/artifacts/Aperas-core-ontology-design.md §1.A.
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { generateNodeId } from './snowflake';

export interface ParsedBlockNode {
  "@type": "BlockNode";
  blockId: string;
  type: string;
  title: string;
  text?: string;
  children: ParsedBlockNode[];
  unfolded?: boolean;
}

// Container-type nodes carry no content of their own — see the reconciliation design's Stage B
// ("containers have no content to compare, by design, not by omission").
const CONTAINER_TYPES = new Set(['list', 'listItem', 'blockquote']);

/**
 * Nests a flat mdast sibling array by heading depth, in one linear pass: each `heading` node
 * becomes a wrapper carrying a `headingChildren` bucket, and every subsequent sibling routes
 * into the current deepest open heading's bucket until a heading of depth <= it appears (which
 * pops back out first). Remark parses headings as flat siblings of their own section content —
 * this is what makes heading level actually define tree structure instead of a flat list.
 */
function groupByHeadings(nodes: any[]): any[] {
  const result: any[] = [];
  const stack: Array<{ depth: number; bucket: any[] }> = [];

  const currentBucket = () => (stack.length ? stack[stack.length - 1].bucket : result);

  for (const node of nodes) {
    if (node.type === 'heading') {
      while (stack.length && stack[stack.length - 1].depth >= node.depth) {
        stack.pop();
      }
      const wrapper = { ...node, headingChildren: [] as any[] };
      currentBucket().push(wrapper);
      stack.push({ depth: node.depth, bucket: wrapper.headingChildren });
    } else {
      currentBucket().push(node);
    }
  }

  return result;
}

function convertAstNode(node: any, markdown: string): ParsedBlockNode | null {
  // We only turn structural/block elements into BlockNodes. Inline elements (text, strong, link) are just part of the parent's `text`.
  const isStructural = ['root', 'paragraph', 'heading', 'listItem', 'code', 'blockquote', 'list'].includes(node.type);

  if (!isStructural) {
    return null;
  }

  const startOffset = node.position?.start?.offset ?? 0;
  const endOffset = node.position?.end?.offset ?? markdown.length;
  const rawText = markdown.slice(startOffset, endOffset).trim();

  const blockId = generateNodeId();

  let title = blockId; // fallback title (to be replaced by AI agent in the future)
  let text = rawText;

  if (node.type === 'heading') {
    // For headings, the title IS the heading, and the abstract is empty for now (children hold the body).
    title = rawText;
    text = "";
  } else if (node.type === 'root') {
    title = "Document Root";
    text = "";
  } else if (CONTAINER_TYPES.has(node.type)) {
    text = "";
  }

  // Headings' own `children` are their inline title content, already captured above via the
  // raw-text slice — their *structural* children were diverted into `headingChildren` by
  // groupByHeadings at the point they were found as a flat sibling, and are already fully
  // nested (including their own sub-headings), so they're used as-is, never re-grouped.
  const rawChildren = node.type === 'heading' ? (node.headingChildren ?? []) : groupByHeadings(node.children ?? []);

  const children: ParsedBlockNode[] = [];
  for (const child of rawChildren) {
    const childBlock = convertAstNode(child, markdown);
    if (childBlock) {
      children.push(childBlock);
    }
  }

  const block: ParsedBlockNode = {
    "@type": "BlockNode",
    blockId,
    type: node.type,
    title,
    children,
    unfolded: false
  };

  if (text) {
    block.text = text;
  }

  return block;
}

/**
 * First pre-order descendant (excluding the root itself) with non-empty `text` — the naive
 * "first paragraph" abstract used for ArtifactNode/FolderNode.text (§5 folding philosophy,
 * AI-driven summarization is a future enhancement). Root's own `text` is always blank, so the
 * abstract necessarily comes from a descendant.
 */
export function extractAbstract(root: ParsedBlockNode): string {
  function findFirst(node: ParsedBlockNode, isRoot: boolean): string | null {
    if (!isRoot && node.text) return node.text;
    for (const child of node.children) {
      const found = findFirst(child, false);
      if (found) return found;
    }
    return null;
  }
  return findFirst(root, true) ?? '';
}

/**
 * Parses raw Markdown content into a structured, nested tree of BlockNodes.
 */
export function parseMarkdownTree(markdown: string): ParsedBlockNode {
  const processor = unified().use(remarkParse);
  const ast = processor.parse(markdown);

  const rootBlock = convertAstNode(ast, markdown);
  return rootBlock!;
}
