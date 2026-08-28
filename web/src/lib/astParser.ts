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
  title: string;
  text?: string;
  children: ParsedBlockNode[];
  unfolded?: boolean;
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
  }

  const children: ParsedBlockNode[] = [];
  if (node.children) {
    for (const child of node.children) {
      const childBlock = convertAstNode(child, markdown);
      if (childBlock) {
        children.push(childBlock);
      }
    }
  }

  const block: ParsedBlockNode = {
    "@type": "BlockNode",
    blockId,
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
 * Parses raw Markdown content into a structured, nested tree of BlockNodes.
 */
export function parseMarkdownTree(markdown: string): ParsedBlockNode {
  const processor = unified().use(remarkParse);
  const ast = processor.parse(markdown);

  const rootBlock = convertAstNode(ast, markdown);
  return rootBlock!;
}
