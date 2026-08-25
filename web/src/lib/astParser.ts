/**
 * Aperas Phase 0: Unified.js AST Transducer & Offset Tracker
 * 
 * Parses raw Markdown content into coarse AST block trees (BlockNodes)
 * tracking exact character start and end offsets for lazy inline span reification.
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { visit } from 'unist-util-visit';

export interface ParsedBlock {
  blockId: string;
  docId: string;
  nodeType: string;
  content: string;
  startOffset: number;
  endOffset: number;
  parentBlockId?: string;
}

export interface ParsedDocument {
  docId: string;
  title: string;
  rawMarkdown: string;
  blocks: ParsedBlock[];
  createdAt: string;
}

/**
 * Parses raw Markdown content into a structured ParsedDocument with block offset metadata.
 */
export function parseMarkdownDocument(docId: string, title: string, markdown: string): ParsedDocument {
  const processor = unified().use(remarkParse);
  const ast = processor.parse(markdown);

  const blocks: ParsedBlock[] = [];
  let blockCounter = 0;

  visit(ast, (node: any) => {
    // We target block-level nodes: paragraph, heading, list, listItem, code, blockquote
    const isBlockType = [
      'paragraph',
      'heading',
      'listItem',
      'code',
      'blockquote'
    ].includes(node.type);

    if (isBlockType && node.position) {
      blockCounter++;
      const blockId = `${docId}_block_${blockCounter}`;

      // Extract raw substring using exact character offsets
      const startOffset = node.position.start.offset ?? 0;
      const endOffset = node.position.end.offset ?? markdown.length;
      const content = markdown.slice(startOffset, endOffset);

      blocks.push({
        blockId,
        docId,
        nodeType: node.type,
        content,
        startOffset,
        endOffset
      });
    }
  });

  return {
    docId,
    title,
    rawMarkdown: markdown,
    blocks,
    createdAt: new Date().toISOString()
  };
}

/**
 * Extracts a reified inline span slice from a parent block given sub-clause character offsets.
 */
export function createReifiedSpan(
  parentBlock: ParsedBlock,
  spanId: string,
  relativeStart: number,
  relativeEnd: number,
  predicate?: string
) {
  const absoluteStart = parentBlock.startOffset + relativeStart;
  const absoluteEnd = parentBlock.startOffset + relativeEnd;
  const spanText = parentBlock.content.slice(relativeStart, relativeEnd);

  return {
    "@type": "SpanNode",
    spanId,
    blockId: parentBlock.blockId,
    text: spanText,
    startOffset: absoluteStart,
    endOffset: absoluteEnd,
    ...(predicate ? { predicate } : {})
  };
}
