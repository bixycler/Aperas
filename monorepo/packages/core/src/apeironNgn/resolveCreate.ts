/**
 * ApeironNgn implementation of `kg:resolve --create-holder` (Aperas-apeironngn-design.md §4
 * rollout, the write-extended half of `kg:resolve`'s deep-path grammar `resolve.ts` deliberately
 * left out) — mints an *abstract* placeholder chain (`holder:true` throughout), append-only.
 * Distinct from `kg:insert` (Aperas-crud-design.md §7), which is concrete-only and never scaffolds
 * missing parent structure; this module is the one place that does.
 *
 * §4 rollout step 3: per-hop child matching is `TreeNode.findChild` and attachment is
 * `TreeNode.appendChild` (`node.ts`) now, not this file's own kind-switching helpers — the direct
 * payoff of the `TreeNode`/`treeChildren` refactor. This module's wikilink resolution
 * (`artifacts.ts`'s `resolveBlockLinks`) runs *during* artifact ingestion, so a `treeChildren`-based
 * hop here relies on the tree already being consistent at that point — `kgIngest.ts`'s `runIngest`
 * guarantees that deliberately (every artifact tracked and the folder tree rebuilt *before* any
 * content gets parsed or any wikilink resolved).
 *
 * Aperas-crud-design.md §8: fully unified now — a single `descend()` handles every tier
 * (folder/file/heading) uniformly, from the root `FolderNode` onward, whether a given segment
 * already exists, needs creating, or is a mix of both across one call. There used to be a separate
 * `createImaginedPrefix` for the "nothing at all resolves yet" case, built bottom-up (mint the
 * artifact, then wrap it in folders outward, then attach the whole chain in one shot) — removed:
 * it duplicated `descend()`'s own per-token walk for no reason once `descend()`'s miss-branch became
 * kind-aware, and its bottom-up construction was never actually reachable from a *partially*-
 * resolving path (some leading folders real, then a gap) in the first place — that case fell
 * straight into `descend()`, whose miss-branch used to assume every miss was a Block-level heading
 * regardless of tier, silently minting the wrong kind. `descend()`'s own per-token loop already
 * probes via `TreeNode.findChild` before ever considering a miss, so walking from the root this way
 * covers "fully resolves," "partially resolves then needs creating," and "nothing resolves at all"
 * uniformly, incrementally, one hop at a time — no separate anchor pre-scan needed.
 *
 * Kept as its own module rather than folded into `resolve.ts`: the read-only tier is used as a
 * plain read by four other migrated commands (`kg:unfold`/`kg:fold`/`kg:tree`'s ref resolution/
 * `kg:resolve`'s own plain mode) that have no reason to carry `--create-holder`'s trace/titles
 * machinery, matching the two-tier split the design doc itself draws.
 */

import type { Store } from 'oxigraph';
import { wrap } from './node';
import type { TreeNode, BlockNode, ArtifactNode, FolderNode } from './node';
import { nodeExists } from './vocab';
import { findByExactPath } from './tree';
import { tokenize, pathToNameTokens, type Token } from '../nodeRef';
import { generateNodeId } from '../snowflake';

const FULL_NODE_ID_RE = /^(BlockNode|ArtifactNode|FolderNode):/;
/** See `resolve.ts`'s identical constant — also requires a valid snowflake right after `Kind:`,
 *  not just the bare prefix, closing the "a real folder/artifact literally named e.g. `BlockNode`"
 *  hole (Aperas-apeironngn-design.md §4 Step 12). */
const FULL_NODE_ID_STRICT_RE = /^(BlockNode|ArtifactNode|FolderNode):[0-9A-HJKMNP-TV-Z]{13}(:.*)?$/;
const BARE_SNOWFLAKE_RE = /^[0-9A-HJKMNP-TV-Z]{13}$/;

const APERAS_ID_PREFIX = 'aperas://id/';
const APERAS_TREE_PREFIX = 'aperas://tree/';

function resolveDirectOrSnowflake(store: Store, ref: string): string | null {
  if (FULL_NODE_ID_STRICT_RE.test(ref)) return ref;
  if (!BARE_SNOWFLAKE_RE.test(ref)) return null;
  for (const kind of ['BlockNode', 'ArtifactNode', 'FolderNode']) {
    const candidate = `${kind}:${ref}`;
    if (nodeExists(store, candidate) && !(wrap(store, candidate) as unknown as TreeNode).tombstonedAt) return candidate;
  }
  return null;
}

function kindOf(id: string): 'BlockNode' | 'ArtifactNode' | 'FolderNode' | null {
  return (FULL_NODE_ID_RE.exec(id)?.[1] as any) ?? null;
}

export interface ResolveTraceEntry {
  id: string;
  kind: string;
  title: string;
  created: boolean;
}

export interface CreateOpts {
  base?: string;
  createHolder?: boolean;
  titles?: string[];
}

/** Whether any *later* name token (from `fromIndex` onward) ends in `.md` — the incremental
 *  replacement for the old `createImaginedPrefix`'s upfront scan (Aperas-crud-design.md §8): before
 *  minting a new intermediate `FolderNode`, confirm the path is actually still headed toward an
 *  artifact boundary somewhere ahead, rather than silently minting an endless chain of folders that
 *  never reaches one. */
function hasLaterMdSegment(tokens: Token[], fromIndex: number): boolean {
  for (let j = fromIndex; j < tokens.length; j++) {
    const t = tokens[j];
    if (t.kind === 'name' && (t as { text: string }).text.toLowerCase().endsWith('.md')) return true;
  }
  return false;
}

/** §3 entry point: hands off entirely to `descend`, starting at the true root `FolderNode` —
 *  `descend` itself now probes/creates every tier (folder/file/heading) uniformly (Aperas-crud-
 *  design.md §8), so there's nothing left for this function to do beyond finding the root. */
function resolveTokens(store: Store, tokens: Token[], opts: CreateOpts, trace: ResolveTraceEntry[]): string | null {
  const rootId = findByExactPath(store, '.');
  if (!rootId) return null;
  return descend(store, rootId, tokens, opts, trace);
}

function resolveFromFolderPath(store: Store, folderPath: string, restTokens: Token[], opts: CreateOpts, trace: ResolveTraceEntry[]): string | null {
  return resolveTokens(store, [...pathToNameTokens(folderPath), ...restTokens], opts, trace);
}

/** §4 + §2.1's nav tokens + §7's holder creation, starting from an already-resolved node.
 *  `opts.titles` tail-aligns against exactly the NAME tokens in `tokens` — every caller passes
 *  only the sub-sequence that constitutes (a piece of) §7.1's `S`, so a fresh per-call count is
 *  always correct. */
function descend(store: Store, startId: string, tokens: Token[], opts: CreateOpts, trace: ResolveTraceEntry[]): string | null {
  const nameCount = tokens.filter((t) => t.kind === 'name').length;
  const titles = opts.titles ?? [];
  if (titles.length > nameCount) {
    throw new Error(
      `--titles has ${titles.length} entr${titles.length === 1 ? 'y' : 'ies'} but only ${nameCount} segment(s) here can use one.`
    );
  }

  let currentId = startId;
  let nameIndex = 0;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token.kind === 'self') continue;

    if (token.kind === 'up') {
      const kind = kindOf(currentId);
      if (kind === 'BlockNode') {
        const node = wrap(store, currentId) as unknown as BlockNode;
        const parent = node.parent;
        if (!parent) {
          throw new Error(`'..' from ${currentId} has nowhere to go — no parent recorded (may need re-ingestion).`);
        }
        currentId = parent.id;
        // A top-level heading's `.parent` already points straight at the owning `ArtifactNode`
        // (merged with its document content — no separate root block in between anymore), so one
        // hop is always enough here.
        if (kindOf(currentId) !== 'BlockNode') {
          const landed = wrap(store, currentId) as unknown as { path?: string };
          return resolveFromFolderPath(store, landed.path as string, tokens.slice(i + 1), opts, trace);
        }
        continue;
      }
      const node = wrap(store, currentId) as unknown as { path?: string };
      const path = node.path as string;
      const segments = path === '.' ? [] : path.split('/');
      if (segments.length === 0) {
        throw new Error(`'..' from '${path}' — already at the artifacts root.`);
      }
      const parentPath = segments.slice(0, -1).join('/') || '.';
      return resolveFromFolderPath(store, parentPath, tokens.slice(i + 1), opts, trace);
    }

    // token.kind === 'name'
    const wantTitle = nameIndex >= nameCount - titles.length ? titles[nameIndex - (nameCount - titles.length)] : undefined;
    nameIndex++;

    const kind = kindOf(currentId);
    if (!kind || !nodeExists(store, currentId)) return null;
    const node = wrap(store, currentId) as unknown as TreeNode;

    const match = node.findChild(token.text); // throws on ambiguity, same as before — any kind now, not just BlockNode
    if (match) {
      currentId = match.id;
      trace.push({ id: currentId, kind: kindOf(currentId)!, title: (match.title as string) ?? '', created: false });
      continue;
    }

    // Miss.
    if (!opts.createHolder) return null;

    if (kind === 'FolderNode') {
      // Folder/Artifact tier (Aperas-crud-design.md §8): title is always the literal token text,
      // never drawn from `--titles` — a folder/file's title is just its own filesystem name, same
      // as `trackFromDisk`/`buildFolderTree` would give it once real. `.md`-suffix decides which
      // kind this segment becomes, same rule the old `createImaginedPrefix` used.
      const parentPath = (wrap(store, currentId) as unknown as FolderNode).path as string;
      const newPath = parentPath === '.' ? token.text : `${parentPath}/${token.text}`;
      const isArtifact = token.text.toLowerCase().endsWith('.md');
      if (!isArtifact && !hasLaterMdSegment(tokens, i + 1)) {
        throw new Error(
          `Nothing under '${token.text}' is tracked, and none of the remaining segments end in '.md' — ` +
          `--create-holder needs a filename to know where the artifact boundary is.`
        );
      }
      const newId = isArtifact ? `ArtifactNode:${generateNodeId()}` : `FolderNode:${generateNodeId()}`;
      const created = wrap(store, newId) as unknown as ArtifactNode | FolderNode;
      created.path = newPath;
      created.title = token.text;
      created.holder = true;
      (wrap(store, currentId) as unknown as FolderNode).appendChild(newId);
      currentId = newId;
      trace.push({ id: currentId, kind: isArtifact ? 'ArtifactNode' : 'FolderNode', title: token.text, created: true });
      continue;
    }

    // kind === 'ArtifactNode' | 'BlockNode' — Block tier, a new heading, unchanged from before.
    if (wantTitle === undefined) {
      throw new Error(
        `'${token.text}' would need to be created, but no title was supplied for it — --titles is tail-aligned, supply one more entry.`
      );
    }

    const newId = `BlockNode:${generateNodeId()}`;
    const holder = wrap(store, newId) as unknown as BlockNode;
    holder.type = 'heading';
    holder.title = wantTitle;
    holder.children = [];
    holder.holder = true;

    // `node.appendChild(newId)` alone now also sets `holder.parent` (Aperas-apeironngn-design.md
    // §5's `parent`/`PARENT_PRED` merge) — a separate `holder.parent = currentId` write here would
    // just be setting the same quad twice.
    node.appendChild(newId);
    currentId = newId;
    trace.push({ id: currentId, kind: 'heading', title: wantTitle, created: true });
  }

  return currentId;
}

export interface ResolveDetail {
  id: string;
  trace: ResolveTraceEntry[];
}

/**
 * The full deep-path resolver, `--create-holder` included: direct id / bare snowflake code (tiers
 * 1-2) then the deep path grammar (§2-4, §7). `opts.base`, when given and `ref` isn't itself
 * absolute, resolves independently first; `opts.titles` is split so the *last*
 * `min(titles.length, ref's own name-token count)` entries go to `ref`'s own tail and the rest (if
 * any) go to `base`'s own tail.
 */
export function resolveDeepPathDetail(store: Store, ref: string, opts: CreateOpts = {}): ResolveDetail | null {
  if (ref.startsWith(APERAS_ID_PREFIX)) return { id: ref.slice(APERAS_ID_PREFIX.length), trace: [] };
  if (ref.startsWith(APERAS_TREE_PREFIX)) {
    const trace: ResolveTraceEntry[] = [];
    const id = resolveTokens(store, tokenize(ref.slice(APERAS_TREE_PREFIX.length)), opts, trace);
    return id ? { id, trace } : null;
  }

  const absolute = ref.startsWith('/');
  const effectiveRef = absolute ? ref.slice(1) : ref;

  const direct = resolveDirectOrSnowflake(store, effectiveRef);
  if (direct) return { id: direct, trace: [] };

  const pathTokens = tokenize(effectiveRef);

  if (!absolute && opts.base !== undefined) {
    const pathNameCount = pathTokens.filter((t) => t.kind === 'name').length;
    const allTitles = opts.titles ?? [];
    const pathTitleCount = Math.min(allTitles.length, pathNameCount);
    const pathTitles = allTitles.slice(allTitles.length - pathTitleCount);
    const baseTitles = allTitles.slice(0, allTitles.length - pathTitleCount);

    const baseDetail = resolveDeepPathDetail(store, opts.base, { createHolder: opts.createHolder, titles: baseTitles });
    if (!baseDetail) return null;

    const trace = [...baseDetail.trace];
    const id = descend(store, baseDetail.id, pathTokens, { createHolder: opts.createHolder, titles: pathTitles }, trace);
    return id ? { id, trace } : null;
  }

  const trace: ResolveTraceEntry[] = [];
  const id = resolveTokens(store, pathTokens, opts, trace);
  return id ? { id, trace } : null;
}
