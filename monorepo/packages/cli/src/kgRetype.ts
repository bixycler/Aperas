/**
 * `aperas retype` — changes an existing block's `type` (heading depth included) **in place**,
 * preserving its identity: same node id, same `links`, same children, same parent and position.
 * A refactoring/migration channel only, never part of ordinary editing.
 *
 * Why it needs to exist at all: a block's `type` is pinned everywhere an ordinary write could touch
 * it. `kgUpdate.ts` builds both its `--text-only` and reconcile shapes with `type: target.type`, so
 * a piped input's own type is never adopted; `reconcileTree` could not pair the two sides anyway,
 * since containers match partitioned `byType` (a `listItem` and a `heading` land in different
 * buckets and never meet) and leaves match on `leafKey`, which keys a heading on `.title` and a
 * paragraph on `.text` — unequal by construction. `kg:update` separately refuses a heading depth
 * change outright. Each guard is right on its own: an ordinary edit must never silently restructure.
 * Together they left `remove` + `insert` as the only route, which tombstones the id and every
 * citation pointing at it — exactly what *Preserve identity* exists to prevent. The data model has
 * no objection to the operation itself: `reconcile.ts`'s `carryForwardFields` carries `blockId` and
 * `links` onto the *new* node and pointedly does not carry `type`, so "same identity, different
 * type" was always expressible — only the write paths forbade it.
 *
 * A heading and a non-heading block store their title in genuinely different places — a heading's
 * own `.title` field versus a lead-in term folded into the front of `.text` — so a heading-depth-only
 * change never touches `.text`, but crossing that boundary automatically migrates the title along
 * with the type, in whichever direction actually applies:
 *
 * - **heading → non-heading**: the heading's own words (its `.title`, `#` markers stripped) are
 *   folded into `.text` as a canonical `**words**: <body>` lead-in — the exact shape
 *   `findLeadInColonOffset` (`astParser.ts`) always accepts uncapped, regardless of word count,
 *   since the whole span before the colon sits inside one bold node. The new title is then the real
 *   parser's own derivation from that text (`titleFromText` below), not a hand-built guess.
 * - **non-heading → heading**: the block's *existing* lead-in term is cut back out of `.text` and
 *   becomes the heading's title; whatever follows the colon becomes the heading's own body text.
 *   Reuses `findLeadInSpliceOffset` (`astParser.ts`) — the identical colon `project.ts`'s own anchor
 *   splice relies on — so the cut lands exactly where the title was actually derived from, not a
 *   re-guessed one liable to disagree with it.
 *
 * Both directions are mechanically reversible on the *canonical* `**Term**: body` shape (converting
 * back folds/cuts the same way and reproduces the original words), though not on a lead-in this
 * command didn't itself write in some non-canonical shape — that case falls back to leaving `.text`
 * untouched and reporting `untitled`, the same as when there's no lead-in at all to find.
 */

import type { Store } from 'oxigraph';
import { resolveDeepPath } from '@aperas/core/apeironNgn/resolve';
import { wrap, findEnclosingArtifactId, type BlockNode } from '@aperas/core/apeironNgn/node';
import { nodeKindFromId } from '@aperas/core/apeironNgn/vocab';
import {
  parseMarkdownTree, headingDepth, extractLangFromFrontmatter, findLeadInSpliceOffset,
  HEADING_TREE_ANCHOR_PROP, type DocLang,
} from '@aperas/core/astParser';
import { getProp, type HasProps } from '@aperas/core/props';
import type { ApeironNode } from '@aperas/core/apeironNgn/node';
import { ensureServiceRunning, request } from './apeironNgn/serviceClient';
import { wantsHelp, printHelp } from './kgHelp';

/** Every block type this command will convert to. `list` is deliberately absent: it's a bare
 *  wrapper with no text of its own (effectively unused since the list-consumption migration), so
 *  there's nothing meaningful to re-derive a title from and no real migration wants one. */
const CONVERTIBLE_TYPES = new Set(['heading', 'paragraph', 'listItem', 'code', 'blockquote', 'html', 'table', 'thematicBreak']);

/** Props that only mean something for one particular type, dropped when converting away from it —
 *  carrying a heading's `treeAnchor` onto a `listItem` (or a `listItem`'s run/checkbox props onto a
 *  paragraph) leaves stale state that later renders wrong rather than failing loudly. */
const TYPE_SPECIFIC_PROPS: Record<string, string[]> = {
  heading: [HEADING_TREE_ANCHOR_PROP],
  listItem: ['orderedList', 'startIndex', 'checked'],
};

export interface RetypeReq {
  path: string;
  base?: string;
  /** `h1`..`h6` (heading, depth carried in the type itself) or a bare block type name. */
  to: string;
}

export interface RetypeResult {
  id: string;
  fromType: string;
  toType: string;
  fromTitle: string;
  toTitle: string;
  /** Only set (and only ever differs from the stored value) when the heading/non-heading boundary
   *  was actually crossed — a depth-only heading change, or a non-heading -> non-heading retype,
   *  always leaves `.text` alone and this is `undefined`. */
  toText?: string;
  /** True when no title could be derived at all — a heading with empty words (pathological), or a
   *  non-heading conversion whose text has no lead-in term to cut. `.text` is left untouched in
   *  this case and the title falls back to the raw id, same as the engine does everywhere else. */
  untitled: boolean;
  droppedProps: string[];
}

/** `h2` => `{ type: 'heading', depth: 2 }`; `paragraph` => `{ type: 'paragraph' }`. */
export function parseTargetType(to: string): { type: string; depth?: number } {
  const heading = /^h([1-6])$/i.exec(to);
  if (heading) return { type: 'heading', depth: Number(heading[1]) };
  if (to === 'heading') {
    throw new Error("'heading' needs its depth: use 'h1'..'h6' (e.g. --to h3), since a heading's depth is part of its type here.");
  }
  if (!CONVERTIBLE_TYPES.has(to)) {
    throw new Error(`Unknown target type '${to}'. Use h1..h6, or one of: ${[...CONVERTIBLE_TYPES].filter((t) => t !== 'heading').sort().join(', ')}.`);
  }
  return { type: to };
}

/** A heading's `.title` is its whole raw line, `#` markers included — strip them to get at the
 *  words themselves, which are what survives a depth change or a fold into a lead-in term. */
function headingWords(title: string): string {
  return title.replace(/^#+\s*/, '').trim();
}

/** The title a non-heading block would get from its own stored text, derived exactly the way the
 *  parser does it — by parsing that text and reading the resulting block's own title. `undefined`
 *  when the text yields no lead-in term at all (the caller then falls back to the raw id, as the
 *  engine does everywhere). */
function titleFromText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const { root } = parseMarkdownTree(text);
  const first = (root.children ?? [])[0];
  const derived = first?.title;
  // A parse that produced no lead-in term titles the block by its own (freshly minted, meaningless
  // here) block id — never a real title, so it's treated as "no title derived".
  if (!derived || derived === first?.blockId) return undefined;
  return derived;
}

/** `resolveLang` needs the *enclosing artifact's* own `frontmatter` prop — `lang` is never stored
 *  per-block, only derived from it on demand (`node.ts`'s own `ArtifactNode.toMarkdown`/`toReadme`
 *  do the identical lookup). A target with no enclosing artifact (a scratch/detached node) defaults
 *  to `'en'`, same as every other caller that has no better answer. */
function resolveLang(store: Store, target: BlockNode): DocLang {
  const artifactId = findEnclosingArtifactId(target);
  if (!artifactId) return 'en';
  const artifact = wrap(store, artifactId) as unknown as HasProps;
  return extractLangFromFrontmatter(getProp(artifact, 'frontmatter'));
}

/** heading -> non-heading: folds `words` into `text` as the canonical, always-accepted lead-in
 *  shape. A heading with no body becomes a bare `**words**:` — itself a already-fixed case (a colon
 *  at the very end of its own text node satisfies the space-after-colon check the same as a real
 *  space does), so this round-trips even for a heading with nothing else to say. */
function foldWordsIntoText(words: string, text: string | undefined): string {
  return text ? `**${words}**: ${text}` : `**${words}**:`;
}

/** non-heading -> heading: the inverse cut. `null` when `text` has no lead-in colon to find at all
 *  (the caller degrades to the id-fallback case then, same as anywhere else with nothing to derive
 *  from). A lead-in that isn't a single, fully-bold span is kept verbatim rather than guessed at —
 *  only the canonical shape this command itself produces is unwrapped back to bare words. */
function cutLeadInFromText(text: string | undefined, lang: DocLang): { words: string; rest?: string } | null {
  if (!text) return null;
  const offset = findLeadInSpliceOffset(text, lang);
  if (offset === null) return null;
  const rawLeadIn = text.slice(0, offset).trim();
  if (rawLeadIn === '') return null;
  const rest = text.slice(offset + 1).replace(/^ /, '');
  const bold = /^\*\*(.+)\*\*$/.exec(rawLeadIn);
  return { words: bold ? bold[1] : rawLeadIn, rest: rest.length > 0 ? rest : undefined };
}

export function runRetype(store: Store, req: RetypeReq): RetypeResult {
  const { type: toType, depth } = parseTargetType(req.to);

  let targetId: string | null;
  try {
    targetId = resolveDeepPath(store, req.path, { base: req.base });
  } catch (err: any) {
    throw new Error(`Target '${req.path}': ${err.message || err}`);
  }
  if (!targetId) {
    throw new Error(`Target '${req.path}' isn't a tracked artifact/folder path, deep path, bare node code, or full node id.`);
  }
  const kind = nodeKindFromId(targetId);
  if (kind !== 'BlockNode') {
    throw new Error(`'${req.path}' resolves to a ${kind} — retype only converts BlockNodes; an ArtifactNode/FolderNode's kind is structural, not a block type.`);
  }
  const target = wrap(store, targetId) as unknown as BlockNode;
  if (target.tombstonedAt) {
    throw new Error(`'${req.path}' is tombstoned — retype only converts live nodes.`);
  }

  const fromType = target.type as string;
  const fromTitle = (target.title as string) ?? '';
  const fromText = target.text as string | undefined;
  const fromDepth = fromType === 'heading' ? headingDepth(fromTitle) : undefined;
  if (fromType === toType && fromDepth === depth) {
    throw new Error(`'${req.path}' is already ${req.to} — nothing to convert.`);
  }

  let toTitle: string;
  let toText = fromText;
  let untitled = false;

  if (fromType === 'heading' && toType === 'heading') {
    // Depth-only: words carried across verbatim, text never enters into it.
    const words = headingWords(fromTitle);
    toTitle = `${'#'.repeat(depth!)} ${words}`.trim();
    untitled = words === '' || words === targetId || words === target.key;
  } else if (fromType === 'heading') {
    // Crossing out of `heading`: fold the title into text as a lead-in, unless there's nothing to
    // fold (a heading with empty words is pathological, but degrade gracefully rather than write
    // garbage into `.text`).
    const words = headingWords(fromTitle);
    if (words === '') {
      toTitle = target.key;
      untitled = true;
    } else {
      toText = foldWordsIntoText(words, fromText);
      const derived = titleFromText(toText);
      toTitle = derived ?? target.key;
      untitled = derived === undefined;
    }
  } else if (toType === 'heading') {
    // Crossing into `heading`: cut the existing lead-in back out, if there is one.
    const cut = cutLeadInFromText(fromText, resolveLang(store, target));
    if (cut) {
      toTitle = `${'#'.repeat(depth!)} ${cut.words}`.trim();
      toText = cut.rest;
      untitled = false;
    } else {
      toTitle = `${'#'.repeat(depth!)} ${target.key}`.trim();
      untitled = true;
      // toText stays fromText — nothing was found to cut, so nothing is touched.
    }
  } else {
    // Neither side is a heading: title storage doesn't change shape at all, so this is exactly the
    // ordinary re-derivation `kg:update` already does on a non-heading target — text untouched.
    const derived = titleFromText(fromText);
    toTitle = derived ?? target.key;
    untitled = derived === undefined;
  }

  // Props belonging to the type being left behind go with it; everything else is carried untouched.
  const dropKeys = new Set(TYPE_SPECIFIC_PROPS[fromType] ?? []);
  const droppedProps: string[] = [];
  if (dropKeys.size > 0) {
    const existing = (target.props as unknown as Array<{ key?: string }> | undefined) ?? [];
    const kept = existing.filter((p) => {
      const drop = p.key !== undefined && dropKeys.has(p.key);
      if (drop) droppedProps.push(p.key!);
      return !drop;
    });
    if (droppedProps.length > 0) {
      target.props = kept.length ? (kept as unknown as ApeironNode[]) : undefined;
    }
  }

  const textChanged = toText !== fromText;
  target.type = toType;
  target.title = toTitle;
  if (textChanged) target.text = toText;

  return { id: targetId, fromType, toType, fromTitle, toTitle, toText: textChanged ? toText : undefined, untitled, droppedProps };
}

export async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (wantsHelp(rawArgs)) {
    printHelp({
      description: "Change an existing block's type in place, preserving its identity — a refactoring/migration channel, not part of ordinary editing. Crossing the heading/non-heading boundary automatically migrates the title along with it (folded into/cut back out of the lead-in term).",
      usage: 'aperas retype [--base <path>] <path> --to <type>',
      args: [
        { name: '<path>', description: 'The existing BlockNode to convert.' },
      ],
      flags: [
        { name: '--to <type>', description: "Target type: 'h1'..'h6' for a heading (depth is part of the type, so h2 -> h3 is an ordinary retype), or one of: blockquote, code, html, listItem, paragraph, table, thematicBreak." },
        { name: '--base <path>', description: 'Base path deep-path resolution is relative to.' },
        { name: '--flush', description: 'Force an immediate sync to disk after this call, instead of waiting for the normal flush timer.' },
        { name: '--reload', description: 'Reload the store from disk first, in case something else (e.g. a git pull) changed it since the service started.' },
      ],
    });
    return;
  }
  const flush = rawArgs.includes('--flush');
  const reload = rawArgs.includes('--reload');
  const args = rawArgs.filter((a) => a !== '--flush' && a !== '--reload');

  const consumed = new Set<number>();
  const baseIdx = args.indexOf('--base');
  const base = baseIdx !== -1 ? args[baseIdx + 1] : undefined;
  if (baseIdx !== -1) { consumed.add(baseIdx); consumed.add(baseIdx + 1); }
  const toIdx = args.indexOf('--to');
  const to = toIdx !== -1 ? args[toIdx + 1] : undefined;
  if (toIdx !== -1) { consumed.add(toIdx); consumed.add(toIdx + 1); }
  const [path] = args.filter((_, i) => !consumed.has(i));

  if (!path || !to) {
    console.error('Usage: aperas retype [--base <path>] <path> --to <type>');
    process.exit(1);
  }

  await ensureServiceRunning();
  const r = await request<RetypeResult>({ op: 'retype', path, base, to, flush, reload });
  console.log(`[ApeironNgn kg:retype] ${r.id}: ${r.fromType} -> ${r.toType}`);
  console.log(`  was: ${r.fromTitle}`);
  console.log(`  now: ${r.toTitle}`);
  if (r.toText !== undefined) {
    console.log(`  text now: ${r.toText}`);
  }
  if (r.droppedProps.length > 0) {
    console.log(`  dropped ${r.fromType}-only prop(s): ${r.droppedProps.join(', ')}`);
  }
  if (r.untitled) {
    console.log(`  WARNING: no title could be derived, so it now reads as its own id — nothing to fold/cut was found.`);
    console.log(`  Supply the words with a follow-up:`);
    console.log(`    printf '**<term>**: <text>' | aperas update ${r.id} --text-only`);
  }
}

if (process.argv[1]?.endsWith('kgRetype.ts')) {
  main().catch((err) => {
    console.error('[ApeironNgn kg:retype] Failed:', err.message || err);
    process.exit(1);
  });
}
