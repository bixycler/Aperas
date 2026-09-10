/**
 * Aperas Phase 1: Fractal AST Transducer
 *
 * Parses raw Markdown content into an unbounded-depth tree of BlockNodes.
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
  props?: PropEntry[];
  /** Raw `[[code]]` occurrences found in this block's own `text` — ephemeral, resolved into real
   *  `BlockNode.links` entries by `artifacts.ts` (which has DB access this pure parser doesn't);
   *  never written to the DB itself. See Aperas-markdown-fractal-mapping-design.md §4 and
   *  Aperas-apeironngn-design.md §4 Step 8 (occurrence positions, target-deduped `Link`s). Never
   *  scanned from `title` — see `LINK_URL_RE`'s neighboring doc comment on why a heading's own
   *  title line is excluded from link-scanning entirely. */
  linkCodes?: LinkOccurrence[];
}

/** One `[[code]]` occurrence found while scanning a block's own text (`collectLinkCodes` below).
 *  `position` is the occurrence's start offset *relative to the owning block's own trimmed
 *  `text`* — deliberately block-relative, never file-relative (Aperas-apeironngn-design.md §4
 *  Step 8): a file-relative offset drifts with every edit before it, the same fragility git
 *  patches need fuzzy context-matching to cope with, and precisely what the fractal block
 *  architecture exists to avoid by construction. See `relativeOffset` below for the conversion. */
export interface LinkOccurrence {
  code: string;
  position: number;
  /** Set only for a bare `#fragment` link (no `[[...]]`/`aperas://` marker) — syntactically
   *  identical to an ordinary, unrelated same-page anchor link, so `apeironNgn/artifacts.ts`'s
   *  resolver must additionally verify the resolved candidate actually carries a matching
   *  `class="aperas-anchor"` tag before accepting it (AperasKG/artifacts/design/linking.md's
   *  Anchor-Matching Requirement), and a miss here is routine (not a dangling-link warning) —
   *  most `#fragment` links in the corpus are ordinary anchors, not internal references at all. */
  requiresAnchorMatch?: boolean;
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

/** Like `rawSlice`, but also exposes exactly where the trimmed text actually starts (as an
 *  absolute file offset) — the one extra number `relativeOffset` below needs to convert a
 *  descendant node's own absolute offset into one relative to *this* trimmed slice. */
function sliceWithOffset(node: any, markdown: string): { text: string; trimmedStart: number } {
  const startOffset = node.position?.start?.offset ?? 0;
  const endOffset = node.position?.end?.offset ?? markdown.length;
  const raw = markdown.slice(startOffset, endOffset);
  return { text: raw.trim(), trimmedStart: startOffset + (raw.length - raw.trimStart().length) };
}

function rawSlice(node: any, markdown: string): string {
  return sliceWithOffset(node, markdown).text;
}

/** Converts `descendantNode`'s own absolute file offset into one relative to `containerNode`'s
 *  own trimmed rawSlice/text (Aperas-apeironngn-design.md §4 Step 8) — `containerNode` is always
 *  the specific mdast node whose own `rawSlice` became a block's `text`, so this is exactly the
 *  coordinate space a reader already has in hand when reading `node.text`. */
function relativeOffset(containerNode: any, descendantNode: any, markdown: string): number {
  const { trimmedStart } = sliceWithOffset(containerNode, markdown);
  return (descendantNode.position?.start?.offset ?? 0) - trimmedStart;
}

const LINK_URL_RE = /^\[\[(.+)\]\]$/;

/** See `apeironNgn/resolveCreate.ts`'s identical constants — duplicated here rather than imported
 *  since this module is engine-agnostic (no `apeironNgn` dependency), and both files need the exact
 *  same two literal prefixes to recognize the same syntax. */
const APERAS_TREE_PREFIX = 'aperas://tree/';
const APERAS_ID_PREFIX = 'aperas://id/';

/** One trailing `<a name='...' class='aperas-anchor aperas-(tree|id)'></a>` on a heading's own raw
 *  line (AperasKG/artifacts/design/linking.md's Anchors section) — single-quoted attribute values
 *  only, matching every anchor this convention has ever written; not meant to accept arbitrary
 *  hand-typed HTML. Matched and stripped one at a time, working backward from line end (see
 *  `stripTrailingHeadingAnchors` below), since an already-projected heading carries *two*
 *  concatenated anchors (its tree-anchor and its id-anchor), and the add-only anchor model
 *  (AperasKG/artifacts/issues/linking.md's Open Issues — a renamed block's old anchor is never
 *  removed) means more than one tree-anchor can legitimately accumulate over a block's history. */
const TRAILING_HEADING_ANCHOR_RE = /<a name='([^']*)' class='aperas-anchor(?: aperas-(tree|id))?'><\/a>\s*$/;

/** Prop key a heading's own tree-anchor(s) (if any) are stashed under (`setProp`) once stripped
 *  from `title` — read back by `project.ts`'s heading case to re-emit them, unchanged, ahead of a
 *  fresh `aperas-id` anchor computed from the block's own permanent id. Any *id*-anchor already on
 *  the line is deliberately dropped here rather than kept, not stashed: it's always regenerated
 *  fresh from `node.id` at projection time (same id, since ingestion never changes it), and keeping
 *  the old text here too would duplicate it on every re-projection. Kept as raw `<a ...></a>`
 *  markup (one or more, concatenated in original left-to-right order) — decomposed into individual
 *  `name` values only by `extractAnchorNames` below, when a consumer actually needs them (the
 *  full-slug-path collision check, `apeironNgn/node.ts`'s `rejectSlugPathCollisions`). */
export const HEADING_TREE_ANCHOR_PROP = 'treeAnchor';

/** Every anchor `name` embedded anywhere in `text` — a find-all counterpart to
 *  `TRAILING_HEADING_ANCHOR_RE`'s single, line-end-anchored match. Used for a list item/paragraph's
 *  own `text` (an anchor sits inline there, after the lead-in colon, not at a line boundary — see
 *  design/linking.md's Anchors section) and for a heading's `treeAnchor` prop (which can hold more
 *  than one concatenated tag under the add-only rename model). Read-only: finds every name a block
 *  currently answers to for the full-slug-path collision check (planning/linking.md's Slice 2 Task
 *  2) — never strips or rewrites anything, unlike `stripTrailingHeadingAnchors` above. */
const ANCHOR_NAME_RE = /<a name='([^']*)' class='aperas-anchor(?: aperas-(?:tree|id))?'><\/a>/g;
export function extractAnchorNames(text: string): string[] {
  return [...text.matchAll(ANCHOR_NAME_RE)].map((m) => m[1]);
}

/** The write-side counterpart to `extractAnchorNames`: removes every inline anchor tag from
 *  `text`, consuming one run of trailing whitespace along with each tag rather than leaving it
 *  behind — an inline anchor is always spliced in as `<original space> <tag> <rest>` (design/
 *  linking.md's Anchors section: right after a list item/paragraph's lead-in colon), so eating the
 *  tag's own trailing whitespace reconstructs the pre-anchor text exactly, not a double space.
 *
 *  Needed because a block's stored abstract/`text` and the same content freshly re-parsed off disk
 *  can otherwise disagree by exactly this anchor even when nothing meaningful changed: `kg:project`
 *  splices an anchor into a list item/paragraph's *rendered* markdown without ever writing that
 *  change back into the block's own stored `text` (Aperas-apeironngn-design.md's rollout notes;
 *  confirmed live — AperasKG/artifacts/discussion/cli.md's own "Resolved: scoped rename detection"
 *  entry), so any comparison that requires exact string equality between "what the graph
 *  remembers" and "what's on disk right now" needs to normalize this away first. Applied at every
 *  site that makes that comparison: `extractAbstract` below (artifact/folder abstracts) and
 *  `reconcile.ts`'s `leafKey` (block-level Gestalt matching). */
export function stripInlineAnchors(text: string): string {
  return text.replace(new RegExp(ANCHOR_NAME_RE.source + '\\s*', 'g'), '');
}

/** A heading's markdown depth — its `title`'s leading run of `#` characters, counted (`1` for
 *  `# Foo`, `2` for `## Foo`, ...) — `0` for anything else (no leading `#` at all, or no title).
 *  The one shared reading of "how deep is this heading," used wherever depth has to agree across
 *  two separately-parsed nodes: `kg:update`'s direct-heading-retitle guard (refuses a depth
 *  change rather than silently reinterpreting one) and `reconcile.ts`'s heading positional-
 *  fallback match (buckets candidates by depth first, so a `##` can never fool-match a `#`). */
export function headingDepth(title: string | undefined): number {
  return /^#+/.exec(title ?? '')?.[0].length ?? 0;
}

/** Strips every trailing anchor tag from a heading's raw line (working backward from the end, so
 *  any number of concatenated anchors are all found, not just one), returning the clean `title` and
 *  the concatenated markup of whichever were tagged `aperas-tree` — an `aperas-id` anchor (or a
 *  bare `aperas-anchor` with no recognized subtype) is matched and discarded, not returned, per
 *  `HEADING_TREE_ANCHOR_PROP`'s own doc comment. */
function stripTrailingHeadingAnchors(rawLine: string): { title: string; treeAnchorMarkup?: string } {
  let line = rawLine;
  const treeAnchors: string[] = [];
  for (;;) {
    const match = TRAILING_HEADING_ANCHOR_RE.exec(line);
    if (!match) break;
    if (match[2] === 'tree') treeAnchors.unshift(`<a name='${match[1]}' class='aperas-anchor aperas-tree'></a>`);
    line = line.slice(0, match.index).replace(/\s+$/, '');
  }
  return { title: line, treeAnchorMarkup: treeAnchors.length ? treeAnchors.join('') : undefined };
}

/** A document's own written language, read from its frontmatter (`extractLangFromFrontmatter`
 *  below) — the first three supported are English, Japanese, and Vietnamese. Affects only
 *  lead-in-term extraction so far (`findLeadInColonOffset`): which length unit its cap uses
 *  (word count for a space-delimited script, character count for Japanese, which has none). */
export type DocLang = 'en' | 'vi' | 'ja';
const SUPPORTED_LANGS: readonly DocLang[] = ['en', 'vi', 'ja'];

/**
 * Reads a `lang:` line out of a document's own raw YAML frontmatter — never fully YAML-parsed
 * (§5's own design keeps frontmatter opaque; this is a single deliberately-narrow regex read, not
 * a general parse), defaulting to `'en'` when absent or unrecognized, since that's the language
 * every existing doc in the corpus is actually written in. Called both at parse time
 * (`parseMarkdownTree` below) and at projection time (`project.ts`, off the artifact's stored
 * `frontmatter` prop) — the one shared reading of the same field, so both sides always agree.
 */
export function extractLangFromFrontmatter(frontmatter: string | undefined): DocLang {
  if (!frontmatter) return 'en';
  const match = /^lang:\s*['"]?(\w+)['"]?\s*$/m.exec(frontmatter);
  const value = match?.[1]?.toLowerCase();
  return (SUPPORTED_LANGS as readonly string[]).includes(value ?? '') ? (value as DocLang) : 'en';
}

const LEAD_IN_COLON_CHARS = new Set([':', '：']); // half-width, full-width (Japanese) forms
/** A lead-in term is short, but longer real examples exist in the corpus (a `Resolved` bullet's
 *  own lead-in can run to a full clause) — capped generously past that so a colon only reachable
 *  after a long run of ordinary prose (a real English sentence's own internal colon, confirmed
 *  live: neither this cap nor sentence-boundary detection alone discriminates that case, only
 *  length does) is correctly never mistaken for one. Best-effort only, not exact: a wrongly-titled
 *  block is corrected the same way any title is now — edit the lead-in term itself in the text
 *  (there's no separate out-of-band override any more; `reconcile.ts`'s `carryForwardFields`
 *  deliberately never carries a title forward, so it's always this deterministic re-extraction,
 *  nothing else). */
const MAX_LEAD_IN_WORDS = 10;
/** Japanese has no spaces to count words by — a rough character-count equivalent instead. */
const MAX_LEAD_IN_CHARS_JA = 20;

/**
 * Walks `node`'s own inline mdast children (not raw characters — the actual bug this replaced:
 * hand-rolled `**`/backtick scanning wrongly matched a colon sitting inside inline code, splicing
 * anchors into the middle of e.g. `` `Kind:snowflake` `` on projection) for the first lead-in colon
 * candidate: a `:`/`：` in plain visible text, never inside `inlineCode` (opaque data, not
 * punctuation — mirrors `collectLinkCodes`'s own inlineCode skip) and never inside a `strong`/
 * `emphasis` span (design: "the colon, outside any bold, is the sole structural delimiter").
 *
 * For a space-delimited script (`lang !== 'ja'`), a candidate additionally has to be followed by
 * whitespace — an ordinary lead-in always reads "Term: rest", space included, whereas a technical
 * string that just never got wrapped in backticks (a bare `aperas://tree/...` URL, a `key:value`
 * pair) almost never has a space right after its own colon. This catches most of what `inlineCode`
 * exclusion above can't: a colon that's real *data*, just not properly fenced as such. Nothing
 * following the colon at all (its own mdast text node ends right there — e.g. `- **Term**:` with
 * only nested list items after it, no inline "rest" on the same line) counts as satisfying this
 * too: there's no adjacent non-space character to be suspicious of, so it reads the same as a
 * genuine lead-in whose "rest of text" simply lives in child blocks instead of inline. A rejected
 * candidate doesn't end the search — scanning continues for a later, genuine one.
 *
 * Returns the accepted candidate's absolute offset, gated by `MAX_LEAD_IN_WORDS`/
 * `MAX_LEAD_IN_CHARS_JA` on the *visible* (non-code) text preceding it — `null` if no candidate
 * exists at all, or the one found fails the length cap.
 */
function findLeadInColonOffset(node: any, lang: DocLang): number | null {
  let candidateOffset: number | null = null;
  let precedingText = '';
  const requireSpaceAfter = lang !== 'ja';

  const walk = (n: any, insideStrong: boolean): boolean => {
    if (n.type === 'inlineCode' || n.type === 'code') return false; // opaque — see doc comment
    if (n.type === 'text') {
      const raw: string = n.value ?? '';
      const startOffset: number = n.position?.start?.offset ?? 0;
      for (let i = 0; i < raw.length; i++) {
        if (LEAD_IN_COLON_CHARS.has(raw[i]) && !insideStrong) {
          const followedBySpace = i + 1 >= raw.length || /\s/.test(raw[i + 1]);
          if (!requireSpaceAfter || followedBySpace) {
            candidateOffset = startOffset + i;
            return true;
          }
          // A real, non-space character follows — doesn't look like a genuine lead-in delimiter;
          // fall through and keep scanning rather than giving up on the whole block.
        }
        precedingText += raw[i];
      }
      return false;
    }
    const isStrongNode = n.type === 'strong' || n.type === 'emphasis';
    for (const child of n.children ?? []) {
      if (walk(child, insideStrong || isStrongNode)) return true;
    }
    return false;
  };
  walk(node, false);

  if (candidateOffset === null) return null;
  const withinCap = lang === 'ja'
    ? precedingText.length <= MAX_LEAD_IN_CHARS_JA
    : precedingText.trim().split(/\s+/).filter(Boolean).length <= MAX_LEAD_IN_WORDS;
  return withinCap ? candidateOffset : null;
}

/**
 * Returns the raw text before `findLeadInColonOffset`'s colon, unmodified (bold markers included,
 * mirroring how a heading's own `title = rawText` keeps its raw line as-is) — the "lead-in term" a
 * list item or paragraph uses as its title. `null` when no qualifying colon exists (the caller keeps
 * its existing `blockId` fallback) or the span before it is empty/whitespace once trimmed.
 */
function extractLeadInTitle(node: any, markdown: string, lang: DocLang): string | null {
  const offset = findLeadInColonOffset(node, lang);
  if (offset === null) return null;
  const { trimmedStart } = sliceWithOffset(node, markdown);
  const span = rawSlice(node, markdown).slice(0, offset - trimmedStart).trim();
  return span.length > 0 ? span : null;
}

/**
 * `project.ts`'s own splice point needs the identical colon `astParser.ts` extracted `title` from,
 * but by projection time there's no original mdast node or file left — only the block's already-
 * serialized `text`. Re-parsing `text` as its own tiny standalone document (it's already valid
 * CommonMark, having itself come from `rawSlice` of a real `paragraph` node) reproduces an
 * equivalent inline tree, offsets rebased to `text`'s own coordinate space — so the exact same
 * `findLeadInColonOffset` runs unmodified, no separate splice-side heuristic to keep in sync.
 */
export function findLeadInSpliceOffset(text: string, lang: DocLang): number | null {
  const processor = unified().use(remarkParse).use(remarkGfm);
  const ast = processor.parse(text) as any;
  const paragraphNode = ast.children?.[0];
  if (!paragraphNode) return null;
  return findLeadInColonOffset(paragraphNode, lang);
}

/**
 * Reserved `Link.predicate` for every `Link` auto-extracted from `[[wikilink]]` syntax
 * (Aperas-interactive-summarization-design.md §7) — distinguishes them from `kg:link`-authored
 * `Link`s, which always use `"references"`. The distinction matters structurally, not just for
 * display: `resolveBlockLinks` (artifacts.ts) regenerates the *complete* current set of
 * wikilink-derived `Link`s from a block's text on every ingest — it needs to tell those apart
 * from manually-curated ones so it only ever replaces its own kind, never a `kg:link` entry, and
 * never leaves a stale wikilink-derived `Link` (or a growing pile of duplicates) behind.
 */
export const WIKILINK_PREDICATE = '[[wikilink]]';

/**
 * Recursively collects internal-code link occurrences from a raw mdast (sub)tree: a `link` node
 * whose `url` is wrapped in `[[...]]` — the convention marking a target as an internal code
 * rather than an external URL (Aperas-markdown-fractal-mapping-design.md §4). Deliberately walks
 * mdast's own inline nodes rather than regexing the rendered text string: an `inlineCode`/`code`
 * span's contents are literal, opaque text remark never re-parses for nested constructs (e.g.
 * `` `[title]([[code]])` `` illustrating the syntax in prose is inert, not a real link) — a
 * plain string regex over raw text can't tell the difference and would wrongly match through it
 * (confirmed live: this doc's own example of the convention triggered exactly that false
 * positive before this fix). CommonMark disallows nested links, so a matched `link` node's own
 * children are never descended into either.
 *
 * `code` containing a space (routine for a deep-path segment that's a real heading's own title
 * text, e.g. `Aperas-apeironngn-design.md`'s own citations) needs the whole destination wrapped in
 * `<...>` — `[title]([[code with spaces]])` isn't a valid CommonMark bare destination, so it
 * parses as plain text, never reaching here at all; `[title](<[[code with spaces]]>)` does (the
 * `<...>` is stripped before `mdastNode.url` is set, so `LINK_URL_RE` sees it unchanged).
 *
 * `containerNode` is fixed for the whole recursion — the specific mdast node whose own `rawSlice`
 * becomes the resulting `text` (every call site below passes the same node it's about to compute
 * `text` from) — so every occurrence's `position` lands in that one coordinate space, matching
 * what a reader actually has in hand (Aperas-apeironngn-design.md §4 Step 8). Never called on a
 * `heading` node itself: a heading functions as an anchor/target in its own right (other content
 * links *to* it by title), so a link nested inside its own title text is an HTML nested-anchor
 * situation — invalid, and just as confusable in practice as the ban implies. Only a heading's
 * *consumed leading paragraph* (§2, a separate string entirely) may contain links.
 */
function collectLinkCodes(containerNode: any, markdown: string): LinkOccurrence[] {
  const out: LinkOccurrence[] = [];
  const walk = (mdastNode: any): void => {
    if (mdastNode.type === 'inlineCode' || mdastNode.type === 'code') return;
    if (mdastNode.type === 'link') {
      const url: string = mdastNode.url ?? '';
      const match = LINK_URL_RE.exec(url);
      const position = () => relativeOffset(containerNode, mdastNode, markdown);
      if (match) {
        out.push({ code: match[1], position: position() });
      } else if (url.startsWith(APERAS_TREE_PREFIX) || url.startsWith(APERAS_ID_PREFIX)) {
        out.push({ code: url, position: position() });
      } else if (url.includes('#') && !url.includes('://')) {
        // A bare `#fragment` (same-document) or `path#fragment` (cross-file) link — excludes any
        // other `scheme://` (an ordinary external URL that happens to carry a fragment, e.g.
        // `https://example.com/page#section`) up front, rather than letting every such link reach
        // the resolver only to fail. See `LinkOccurrence.requiresAnchorMatch`'s own doc comment for
        // why what's left still can't be trusted as an internal reference until the resolver checks
        // for a matching anchor.
        out.push({ code: url, position: position(), requiresAnchorMatch: true });
      }
      return;
    }
    for (const child of mdastNode.children ?? []) walk(child);
  };
  walk(containerNode);
  return out;
}

/** Converts every `listItem` of a mdast `list` node into its own BlockNode (recursively). */
function convertListItems(listNode: any, markdown: string, lang: DocLang): ParsedBlockNode[] {
  return (listNode.children ?? [])
    .map((item: any) => convertAstNode(item, markdown, lang))
    .filter((b: ParsedBlockNode | null): b is ParsedBlockNode => b !== null);
}

interface ChildrenResult {
  children: ParsedBlockNode[];
  /** The leading paragraph's raw text, consumed into the caller's own `text` — '' if none. */
  leadingText: string;
  /** The leading paragraph's own raw mdast node, alongside `leadingText` — `undefined` if none.
   *  The caller (a `listItem`) needs the real node, not just its text, to run
   *  `extractLeadInTitle`'s mdast-aware colon scan (`findLeadInColonOffset`) on it. */
  leadingNode?: any;
  /** Link occurrences found in the consumed leading paragraph — the caller merges these into its
   *  own `linkCodes`, since that paragraph's raw mdast node (and its inline `link` children) never
   *  becomes a `BlockNode` of its own to carry them itself. */
  leadingLinkCodes: LinkOccurrence[];
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
function convertChildren(rawSiblings: any[], markdown: string, isHeadingOrListItem: boolean, lang: DocLang): ChildrenResult {
  const children: ParsedBlockNode[] = [];
  let leadingText = '';
  let leadingNode: any;
  let leadingLinkCodes: LinkOccurrence[] = [];
  let parentListProps: { orderedList: boolean; startIndex: number } | undefined;
  let adoptionAnchor: 'parent' | ParsedBlockNode | null = null;

  for (let i = 0; i < rawSiblings.length; i++) {
    const raw = rawSiblings[i];

    if (raw.type === 'list') {
      const orderedList = Boolean(raw.ordered);
      const startIndex = typeof raw.start === 'number' ? raw.start : 1;

      if (adoptionAnchor === 'parent') {
        children.push(...convertListItems(raw, markdown, lang));
        parentListProps = { orderedList, startIndex };
      } else if (adoptionAnchor) {
        const anchor = adoptionAnchor;
        anchor.children.push(...convertListItems(raw, markdown, lang));
        setProp(anchor, 'orderedList', String(orderedList));
        setProp(anchor, 'startIndex', String(startIndex));
      } else {
        // Orphaned — nothing valid precedes it. Reuse convertAstNode's own `list` handling
        // rather than duplicating the orphan-construction logic here.
        const orphanBlock = convertAstNode(raw, markdown, lang)!;
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
      leadingNode = raw;
      leadingLinkCodes = collectLinkCodes(raw, markdown);
      adoptionAnchor = 'parent';
      continue;
    }

    const childBlock = convertAstNode(raw, markdown, lang);
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

  return { children, leadingText, leadingNode, leadingLinkCodes, parentListProps };
}

function convertAstNode(node: any, markdown: string, lang: DocLang): ParsedBlockNode | null {
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

  let title = blockId; // fallback title when nothing below finds a heading title or a lead-in term
  let text = rawText;
  let linkCodes: LinkOccurrence[] = [];
  let headingTreeAnchor: string | undefined;

  if (node.type === 'heading') {
    const stripped = stripTrailingHeadingAnchors(rawText);
    title = stripped.title;
    headingTreeAnchor = stripped.treeAnchorMarkup;
    text = '';
    // The heading's own title line is deliberately never scanned for links (Aperas-apeironngn-
    // design.md §4 Step 8): a heading functions as an anchor/target in its own right (other
    // content links *to* it by title), so a link nested inside its own title text is an HTML
    // nested-anchor situation — invalid, and just as confusable in practice as the ban implies.
    // Only its consumed leading paragraph (`leadingLinkCodes` below) may contain links.
  } else if (node.type === 'root') {
    title = 'Document Root';
    text = '';
  } else if (node.type === 'listItem') {
    text = '';
  } else if (node.type === 'paragraph') {
    const leadIn = extractLeadInTitle(node, markdown, lang);
    if (leadIn !== null) title = leadIn;
  } else if (node.type === 'list') {
    // Aperas-markdown-fractal-mapping-design.md §8: an orphaned list block gets "no title, no
    // text" — its content lives entirely in its (adopted) listItem children. Previously missing
    // from this chain, so it silently fell through to the leaf default below (`text = rawText`,
    // the entire raw markdown span of the list) — a real coding gap, not a design ambiguity: it
    // both stored unbounded text on any document built mostly of nested lists, and made
    // `extractAbstract`'s pre-order search stop on a list's own bogus text before ever reaching
    // the genuine first paragraph underneath (`reports/bugs/list-block-text.md`).
    text = '';
  }
  // paragraph/code/thematicBreak/html/table fall through to the leaf default (text = rawText).
  // blockquote also falls through — its full content is projected, not summarized (§3).

  const block: ParsedBlockNode = {
    "@type": "BlockNode",
    blockId,
    type: node.type,
    title,
    children: []
  };

  if (headingTreeAnchor) {
    setProp(block, HEADING_TREE_ANCHOR_PROP, headingTreeAnchor);
  }

  if (node.type === 'blockquote') {
    // Opaque leaf (§3) — no children at all, regardless of what's nested inside. Still prose,
    // so its own inline links are collected the same as a paragraph's.
    linkCodes = collectLinkCodes(node, markdown);
  } else if (node.type === 'list') {
    // Reached only for an orphaned list (convertChildren's own adoption branches never call
    // convertAstNode on a `list` node when a valid adoption anchor exists).
    block.children = convertListItems(node, markdown, lang);
    setProp(block, 'orderedList', String(Boolean(node.ordered)));
    setProp(block, 'startIndex', String(typeof node.start === 'number' ? node.start : 1));
  } else if (node.type === 'paragraph') {
    // Opaque leaf — `children` stays empty here. A paragraph *may* still end up with adopted
    // listItem children (§8), but that's applied by the *caller's* convertChildren after this
    // block already exists, not here.
    linkCodes = collectLinkCodes(node, markdown);
  } else if (node.type === 'code' || node.type === 'thematicBreak' || node.type === 'html' || node.type === 'table') {
    // Opaque leaves with no meaningful inline `link` content of their own (code/HTML source
    // isn't inline-parsed at all; table stays fully opaque, no per-cell decomposition — §4) —
    // no link extraction here.
  } else {
    // root, heading, listItem: structural containers.
    const rawSiblings = node.type === 'heading' ? (node.headingChildren ?? []) : groupByHeadings(node.children ?? []);
    const isHeadingOrListItem = node.type === 'heading' || node.type === 'listItem';
    const { children, leadingText, leadingNode, leadingLinkCodes, parentListProps } = convertChildren(rawSiblings, markdown, isHeadingOrListItem, lang);
    block.children = children;
    if (isHeadingOrListItem) {
      text = leadingText;
      linkCodes = [...linkCodes, ...leadingLinkCodes];
      if (node.type === 'listItem' && leadingNode) {
        const leadIn = extractLeadInTitle(leadingNode, markdown, lang);
        if (leadIn !== null) block.title = leadIn;
      }
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

/** Collapses embedded whitespace (newlines included) to single spaces and caps the result to
 *  `maxLen` characters, cutting at the last word boundary before the limit (never mid-word) and
 *  appending an ellipsis — a short, single-line preview regardless of how long or how many
 *  paragraphs the source text runs. Used both at ingest time (`extractAbstract` below, so a stored
 *  `ArtifactNode`/`FolderNode.text` is honestly a short preview, not an accidental full-document
 *  dump — a real, live example ran 39,413 characters before this existed) and at render time
 *  (`node.ts`'s tree rendering, as a safety net for an ordinary `BlockNode`'s own long paragraph —
 *  that one's never truncated in storage, since it's real authored content `kg:project` must
 *  reproduce exactly; only a rendered line ever shortens it). */
export function truncateForPreview(text: string, maxLen: number = 2500): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLen) return collapsed;
  const cut = collapsed.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  const truncated = lastSpace > maxLen * 0.5 ? cut.slice(0, lastSpace) : cut;
  return `${truncated}…`;
}

/** `truncateForPreview`, plus an inline pointer to the one place a cut preview's full text is ever
 *  actually shown (`kg:unfold <id>`, which reads the same node's `.text` in full, uncapped) —
 *  appended right where the cut happened, rather than leaving a bare "…" with no indication
 *  there's more or how to see it. Used wherever a node's abstract renders as a capped preview
 *  (`kg:tree`/`kg:unfold` both), never at ingest time (`extractAbstract` below): a runtime CLI hint
 *  makes no sense baked into stored content. */
export function truncateForPreviewWithHint(text: string, id: string, maxLen?: number): string {
  const truncated = truncateForPreview(text, maxLen);
  return truncated.endsWith('…') ? `${truncated} (kg:unfold ${id} for full text)` : truncated;
}

/**
 * First pre-order descendant (excluding the root itself) with non-empty `text` — the naive
 * "first paragraph" abstract used for both `ArtifactNode.text` (`node.ts`'s `ingestFromDisk`) and
 * `FolderNode.text` (`folders.ts`'s `buildFolderTree`, over a README's own parsed tree) — AI-driven
 * summarization is a future enhancement. Deliberately a copy, not a consume: unlike a heading's own
 * leading paragraph (§2), an artifact/folder is a pure container with no content of its own, so its
 * `text` is honestly a derived preview, expected to duplicate whatever the first real descendant
 * with content already is — never removed from `children` the way §2's consuming rule removes a
 * heading's. A single top-level leading-paragraph requirement was tried and dropped: a real README
 * is usually headed (`# Title` first), not a bare paragraph, so that produced an empty abstract for
 * the common case — this recurses instead. Root's own `text` is always blank, so the abstract
 * necessarily comes from a descendant. `truncateForPreview`d before returning — a genuine "short
 * preview" now, not just whatever length the first matching descendant's raw text happened to be.
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
  const raw = findFirst(root, true) ?? '';
  if (!raw) return raw;
  // Stripped before truncating, not after: an anchor tag falling inside the truncation window
  // would otherwise survive as a mangled fragment, and it shouldn't count toward the length
  // budget anyway (see `stripInlineAnchors`'s own doc comment for why this needs to happen at
  // all — a fresh parse of already-projected content carries an anchor the stored abstract never
  // did).
  return truncateForPreview(stripInlineAnchors(raw));
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
 *
 * No `.parent` stamping pass over the result any more (Aperas-apeironngn-design.md §5's `parent`/
 * `PARENT_PRED` merge retired the old `stampParents` — it existed solely to feed `node.ts`'s
 * `hydrateFromParsed`, which no longer reads a parsed-tree `.parent` at all: the real `parent`
 * quad is now a side effect of whichever container's `children` write includes a node, using
 * final, already-reconciled ids directly, with no separate early stamp to go stale).
 */
export function parseMarkdownTree(markdown: string): ParsedMarkdown {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml']);
  const ast = processor.parse(markdown);

  const yamlNode: any = (ast.children ?? []).find((c: any) => c.type === 'yaml');
  const frontmatter = typeof yamlNode?.value === 'string' ? (yamlNode.value as string) : undefined;
  const lang = extractLangFromFrontmatter(frontmatter);

  const rootBlock = convertAstNode(ast, markdown, lang)!;
  return { root: rootBlock, ...(frontmatter !== undefined ? { frontmatter } : {}) };
}
