/**
 * Aperas Phase 1: Fractal AST Transducer
 *
 * Parses raw Markdown content into an infinitely nested tree of BlockNodes.
 * Node identity is a Snowflake-style generated id (see snowflake.ts), assigned
 * once per parsed block — not derived from content or position, per
 * AperasKG/artifacts/Aperas-core-ontology-design.md §1.A.
 *
 * The mapping from mdast's loose shape to this tight, uniform tree is settled in
 * AperasKG/artifacts/Aperas-markdown-fractal-mapping-design.md — in particular §2 (heading/
 * listItem consume, not copy, their leading paragraph) and §8 (a `list` dissolves into
 * whatever block immediately precedes it, rather than remaining its own node).
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import { generateNodeId } from './snowflake';
import { setProp, type PropEntry } from './props';

export interface ParsedBlockNode {
  "@type": "BlockNode";
  blockId: string;
  type: string;
  title: string;
  text?: string;
  children: ParsedBlockNode[];
  unfolded?: boolean;
  props?: PropEntry[];
  /** Raw `[[code]]` targets found in this block's own `title`/`text` — ephemeral, resolved
   *  into real `BlockNode.links` entries by `artifacts.ts` (which has DB access this pure
   *  parser doesn't); never written to the DB itself. See Aperas-markdown-fractal-mapping-
   *  design.md §4. */
  linkCodes?: string[];
}

// `list` is never converted as its own node except when orphaned (nothing precedes it to adopt
// into) — see convertChildren's adoption logic below. `listItem` gets the same "consume my
// leading paragraph" abstract a heading gets; `blockquote` is a true opaque leaf (its full raw
// content projected, no children) — see design doc §3.

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

function rawSlice(node: any, markdown: string): string {
  const startOffset = node.position?.start?.offset ?? 0;
  const endOffset = node.position?.end?.offset ?? markdown.length;
  return markdown.slice(startOffset, endOffset).trim();
}

const LINK_URL_RE = /^\[\[(.+)\]\]$/;

/**
 * Recursively collects internal-code link targets from a raw mdast (sub)tree: a `link` node
 * whose `url` is wrapped in `[[...]]` — the convention marking a target as an internal code
 * rather than an external URL (Aperas-markdown-fractal-mapping-design.md §4). Deliberately walks
 * mdast's own inline nodes rather than regexing the rendered text string: an `inlineCode`/`code`
 * span's contents are literal, opaque text remark never re-parses for nested constructs (e.g.
 * `` `[title]([[code]])` `` illustrating the syntax in prose is inert, not a real link) — a
 * plain string regex over raw text can't tell the difference and would wrongly match through it
 * (confirmed live: this doc's own example of the convention triggered exactly that false
 * positive before this fix). CommonMark disallows nested links, so a matched `link` node's own
 * children are never descended into either.
 */
function collectLinkCodes(mdastNode: any, out: string[] = []): string[] {
  if (mdastNode.type === 'inlineCode' || mdastNode.type === 'code') {
    return out;
  }
  if (mdastNode.type === 'link') {
    const match = LINK_URL_RE.exec(mdastNode.url ?? '');
    if (match) out.push(match[1]);
    return out;
  }
  for (const child of mdastNode.children ?? []) {
    collectLinkCodes(child, out);
  }
  return out;
}

/** Converts every `listItem` of a mdast `list` node into its own BlockNode (recursively). */
function convertListItems(listNode: any, markdown: string): ParsedBlockNode[] {
  return (listNode.children ?? [])
    .map((item: any) => convertAstNode(item, markdown))
    .filter((b: ParsedBlockNode | null): b is ParsedBlockNode => b !== null);
}

interface ChildrenResult {
  children: ParsedBlockNode[];
  /** The leading paragraph's raw text, consumed into the caller's own `text` — '' if none. */
  leadingText: string;
  /** Link codes found in the consumed leading paragraph — the caller merges these into its own
   *  `linkCodes`, since that paragraph's raw mdast node (and its inline `link` children) never
   *  becomes a `BlockNode` of its own to carry them itself. */
  leadingLinkCodes: string[];
  /** Set only when a list adopted directly into the *caller* (the `adoptionAnchor === 'parent'`
   *  case) — the caller applies these as its own `orderedList`/`startIndex` props. */
  parentListProps?: { orderedList: boolean; startIndex: number };
}

/**
 * Builds one container's `children` from its raw mdast sibling array, applying both the
 * consuming rule (§2, only when `isHeadingOrListItem`) and list adoption (§8) in a single pass.
 *
 * Adoption target tracking: `adoptionAnchor` is either `'parent'` (the leading paragraph was
 * just consumed away — a following list adopts into the container being built, i.e. into the
 * caller), a `ParsedBlockNode` of type paragraph/listItem/heading (the most recently emitted
 * valid-anchor child — a following list adopts into it directly, becoming its `children`), or
 * `null` (nothing valid immediately precedes — a following list stays its own orphaned node).
 * Anything else just processed (a list, or an opaque leaf like code/table/blockquote) resets
 * this to `null`, since only paragraph/listItem/heading are ever valid anchors (§8).
 */
function convertChildren(rawSiblings: any[], markdown: string, isHeadingOrListItem: boolean): ChildrenResult {
  const children: ParsedBlockNode[] = [];
  let leadingText = '';
  let leadingLinkCodes: string[] = [];
  let parentListProps: { orderedList: boolean; startIndex: number } | undefined;
  let adoptionAnchor: 'parent' | ParsedBlockNode | null = null;

  for (let i = 0; i < rawSiblings.length; i++) {
    const raw = rawSiblings[i];

    if (raw.type === 'list') {
      const orderedList = Boolean(raw.ordered);
      const startIndex = typeof raw.start === 'number' ? raw.start : 1;

      if (adoptionAnchor === 'parent') {
        children.push(...convertListItems(raw, markdown));
        parentListProps = { orderedList, startIndex };
      } else if (adoptionAnchor) {
        const anchor = adoptionAnchor;
        anchor.children.push(...convertListItems(raw, markdown));
        setProp(anchor, 'orderedList', String(orderedList));
        setProp(anchor, 'startIndex', String(startIndex));
      } else {
        // Orphaned — nothing valid precedes it. Reuse convertAstNode's own `list` handling
        // rather than duplicating the orphan-construction logic here.
        const orphanBlock = convertAstNode(raw, markdown)!;
        children.push(orphanBlock);
      }
      // A `list` is never itself a valid adoption anchor (§8: only paragraph/listItem/heading
      // are) — so whatever a *following* list would adopt into resets here, regardless of
      // whether this one just adopted or was orphaned. Without this, two lists directly
      // adjacent to each other (e.g. a bullet list immediately followed by an ordered list)
      // would incorrectly merge into a single adoption target, corrupting whichever
      // orderedList/startIndex was set first.
      adoptionAnchor = null;
      continue;
    }

    if (i === 0 && isHeadingOrListItem && raw.type === 'paragraph') {
      // Consuming, not copying (§2): this paragraph becomes the container's own `text` and is
      // never emitted as a separate child. A list right after it (handled on the next loop
      // iteration) adopts into the container itself, not into a paragraph node that no longer
      // exists (§8's "interaction with §2's consuming rule").
      leadingText = rawSlice(raw, markdown);
      leadingLinkCodes = collectLinkCodes(raw);
      adoptionAnchor = 'parent';
      continue;
    }

    const childBlock = convertAstNode(raw, markdown);
    if (childBlock) {
      children.push(childBlock);
      // Only paragraph/listItem/heading are valid adoption anchors (§8) — a following list
      // after a code/table/blockquote/thematicBreak/html sibling is orphaned, not adopted into
      // an unrelated opaque leaf.
      adoptionAnchor = ['paragraph', 'listItem', 'heading'].includes(childBlock.type) ? childBlock : null;
    } else {
      adoptionAnchor = null;
    }
  }

  return { children, leadingText, leadingLinkCodes, parentListProps };
}

function convertAstNode(node: any, markdown: string): ParsedBlockNode | null {
  // We only turn structural/block elements into BlockNodes. Inline elements (text, strong, link)
  // are just part of the parent's `text`. `table` is deliberately opaque (text = rawText, same
  // as code/thematicBreak/html) — no per-row/per-cell decomposition (Aperas-markdown-fractal-
  // mapping-design.md §4). `yaml` (frontmatter, when remark-frontmatter is active) is
  // deliberately absent from this list — it's extracted separately by parseMarkdownTree, never
  // part of the BlockNode tree at all (§5).
  const isStructural = ['root', 'paragraph', 'heading', 'listItem', 'code', 'blockquote', 'list', 'thematicBreak', 'html', 'table'].includes(node.type);

  if (!isStructural) {
    return null;
  }

  const rawText = rawSlice(node, markdown);
  const blockId = generateNodeId();

  let title = blockId; // fallback title (to be replaced by AI agent in the future)
  let text = rawText;
  let linkCodes: string[] = [];

  if (node.type === 'heading') {
    title = rawText;
    text = '';
    // The heading's own title line can itself contain a link — collected from `node` directly
    // since groupByHeadings only adds a `headingChildren` bucket alongside it, never touching
    // `node.children` (the heading's actual inline title content).
    linkCodes = collectLinkCodes(node);
  } else if (node.type === 'root') {
    title = 'Document Root';
    text = '';
  } else if (node.type === 'listItem') {
    text = '';
  }
  // paragraph/code/thematicBreak/html/table fall through to the leaf default (text = rawText).
  // blockquote also falls through — its full content is projected, not summarized (§3).

  const block: ParsedBlockNode = {
    "@type": "BlockNode",
    blockId,
    type: node.type,
    title,
    children: [],
    unfolded: false
  };

  if (node.type === 'blockquote') {
    // Opaque leaf (§3) — no children at all, regardless of what's nested inside. Still prose,
    // so its own inline links are collected the same as a paragraph's.
    linkCodes = collectLinkCodes(node);
  } else if (node.type === 'list') {
    // Reached only for an orphaned list (convertChildren's own adoption branches never call
    // convertAstNode on a `list` node when a valid adoption anchor exists).
    block.children = convertListItems(node, markdown);
    setProp(block, 'orderedList', String(Boolean(node.ordered)));
    setProp(block, 'startIndex', String(typeof node.start === 'number' ? node.start : 1));
  } else if (node.type === 'paragraph') {
    // Opaque leaf — `children` stays empty here. A paragraph *may* still end up with adopted
    // listItem children (§8), but that's applied by the *caller's* convertChildren after this
    // block already exists, not here.
    linkCodes = collectLinkCodes(node);
  } else if (node.type === 'code' || node.type === 'thematicBreak' || node.type === 'html' || node.type === 'table') {
    // Opaque leaves with no meaningful inline `link` content of their own (code/HTML source
    // isn't inline-parsed at all; table stays fully opaque, no per-cell decomposition — §4) —
    // no link extraction here.
  } else {
    // root, heading, listItem: structural containers.
    const rawSiblings = node.type === 'heading' ? (node.headingChildren ?? []) : groupByHeadings(node.children ?? []);
    const isHeadingOrListItem = node.type === 'heading' || node.type === 'listItem';
    const { children, leadingText, leadingLinkCodes, parentListProps } = convertChildren(rawSiblings, markdown, isHeadingOrListItem);
    block.children = children;
    if (isHeadingOrListItem) {
      text = leadingText;
      linkCodes = [...linkCodes, ...leadingLinkCodes];
      if (parentListProps) {
        setProp(block, 'orderedList', String(parentListProps.orderedList));
        setProp(block, 'startIndex', String(parentListProps.startIndex));
      }
    }
  }

  if (node.type === 'listItem' && node.checked !== null && node.checked !== undefined) {
    setProp(block, 'checked', String(Boolean(node.checked)));
  }

  if (text) {
    block.text = text;
  }

  if (linkCodes.length > 0) {
    block.linkCodes = linkCodes;
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

export interface ParsedMarkdown {
  root: ParsedBlockNode;
  /** Raw YAML frontmatter body (delimiters stripped, not parsed into key/value pairs — §5),
   *  when the file starts with a `---\n...\n---` block. Never part of the BlockNode tree. */
  frontmatter?: string;
}

/**
 * Parses raw Markdown content into a structured, nested tree of BlockNodes, plus any leading
 * YAML frontmatter extracted separately (file-level metadata, not a block — §5).
 */
export function parseMarkdownTree(markdown: string): ParsedMarkdown {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml']);
  const ast = processor.parse(markdown);

  const yamlNode: any = (ast.children ?? []).find((c: any) => c.type === 'yaml');
  const frontmatter = typeof yamlNode?.value === 'string' ? (yamlNode.value as string) : undefined;

  const rootBlock = convertAstNode(ast, markdown);
  return { root: rootBlock!, ...(frontmatter !== undefined ? { frontmatter } : {}) };
}
