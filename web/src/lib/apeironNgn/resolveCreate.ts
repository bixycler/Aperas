/**
 * ApeironNgn implementation of `kg:resolve --create-holder` (Aperas-apeironngn-design.md §4
 * rollout, the write-extended half of `kg:resolve`'s deep-path grammar `resolve.ts` deliberately
 * left out). Mirrors `nodeRef.ts`'s `createImaginedPrefix`/`descend`'s miss branch/
 * `resolveNodeRefDetail`'s trace bookkeeping, writing through `node.ts`'s generated accessors
 * instead of `client.updateDocument`, and persisted via `dehydrate.ts` by the caller (a CLI
 * concern, not this module's — mirrors `unfold.ts`'s old split, now `BaseNode.fold`/`.unfold`, not
 * owning persistence either).
 *
 * §4 rollout step 3: per-hop child matching is `TreeNode.findChild` and attachment is
 * `TreeNode.appendChild` (`node.ts`) now, not this file's own kind-switching helpers — the direct
 * payoff of the `TreeNode`/`treeChildren` refactor. `ArtifactNode`'s "already has a root" check
 * stays here, ahead of minting, so a rejected create doesn't leave an orphan `BlockNode` behind —
 * `appendChild`'s own version of that same check is a backstop, not the primary guard.
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

const FULL_NODE_ID_RE = /^(BlockNode|ArtifactNode|FolderNode)\//;
const BARE_SNOWFLAKE_RE = /^[0-9A-HJKMNP-TV-Z]{13}$/;

function resolveDirectOrSnowflake(store: Store, ref: string): string | null {
  if (FULL_NODE_ID_RE.test(ref)) return ref;
  if (!BARE_SNOWFLAKE_RE.test(ref)) return null;
  for (const kind of ['BlockNode', 'ArtifactNode', 'FolderNode']) {
    const candidate = `${kind}/${ref}`;
    if (nodeExists(store, candidate) && !(wrap(store, candidate) as unknown as TreeNode).tombstonedAt) return candidate;
  }
  return null;
}

function kindOf(id: string): 'BlockNode' | 'ArtifactNode' | 'FolderNode' | null {
  return (FULL_NODE_ID_RE.exec(id)?.[1] as any) ?? null;
}

function resolveArtifactOrFolderPrefix(store: Store, tokens: Token[]): { id: string; consumed: number } | null {
  let nameCount = 0;
  while (nameCount < tokens.length && tokens[nameCount].kind === 'name') nameCount++;
  for (let k = nameCount; k >= 1; k--) {
    const candidate = tokens.slice(0, k).map((t) => (t as { text: string }).text).join('/');
    const id = findByExactPath(store, candidate);
    if (id) return { id, consumed: k };
  }
  return null;
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

/** §7.2: nothing at all resolved for the leading name-token run — imagine the whole chain,
 *  folders then one artifact, anchored at whichever ancestor folder already exists (root, at
 *  worst). Builds bottom-up (artifact first, then wrapping folders outward) since a folder's
 *  `children` needs its nested id to already exist; attaches only the single outermost new id
 *  into the anchor's existing `children` via `TreeNode.appendChild`. */
function createImaginedPrefix(store: Store, tokens: Token[], opts: CreateOpts, trace: ResolveTraceEntry[]): string | null {
  let nameCount = 0;
  while (nameCount < tokens.length && tokens[nameCount].kind === 'name') nameCount++;
  const names = tokens.slice(0, nameCount).map((t) => (t as { text: string }).text);

  const artifactIdx = names.findIndex((n) => n.toLowerCase().endsWith('.md'));
  if (artifactIdx === -1) {
    throw new Error(
      `Nothing under '${names.join('/')}' is tracked, and none of its segments end in '.md' — ` +
      `--create-holder needs a filename to know where the artifact boundary is.`
    );
  }

  const fullPaths = names.slice(0, artifactIdx + 1).map((_, i) => names.slice(0, i + 1).join('/'));

  const rootFolderId = findByExactPath(store, '.');
  if (!rootFolderId) throw new Error('No root FolderNode found — run kg:ingest at least once first.');
  let anchorId = rootFolderId;
  let firstNewIdx = 0;
  for (let i = 0; i < artifactIdx; i++) {
    const found = findByExactPath(store, fullPaths[i]);
    if (!found) break;
    anchorId = found;
    firstNewIdx = i + 1;
  }

  const artifactId = generateNodeId();
  const newArtifactFullId = `ArtifactNode/${artifactId}`;
  const artifact = wrap(store, newArtifactFullId) as unknown as ArtifactNode;
  artifact.path = fullPaths[artifactIdx];
  artifact.title = names[artifactIdx];
  artifact.holder = true;

  const newTrace: ResolveTraceEntry[] = [
    { id: newArtifactFullId, kind: 'ArtifactNode', title: names[artifactIdx], created: true },
  ];

  let outermostNewId = newArtifactFullId;
  for (let i = artifactIdx - 1; i >= firstNewIdx; i--) {
    const folderId = generateNodeId();
    const folderFullId = `FolderNode/${folderId}`;
    const folder = wrap(store, folderFullId) as unknown as FolderNode;
    folder.path = fullPaths[i];
    folder.title = names[i];
    folder.holder = true;
    folder.children = [outermostNewId as unknown as TreeNode];
    newTrace.unshift({ id: folderFullId, kind: 'FolderNode', title: names[i], created: true });
    outermostNewId = folderFullId;
  }

  const anchor = wrap(store, anchorId) as unknown as TreeNode;
  anchor.appendChild(outermostNewId);
  trace.push(...newTrace);

  const rest = tokens.slice(artifactIdx + 1);
  if (rest.length === 0) return newArtifactFullId;
  return descend(store, newArtifactFullId, rest, opts, trace);
}

function resolveTokens(store: Store, tokens: Token[], opts: CreateOpts, trace: ResolveTraceEntry[]): string | null {
  const prefixMatch = resolveArtifactOrFolderPrefix(store, tokens);
  if (prefixMatch) {
    const node = wrap(store, prefixMatch.id) as unknown as TreeNode;
    trace.push({ id: prefixMatch.id, kind: kindOf(prefixMatch.id)!, title: node.title ?? '', created: false });
    const rest = tokens.slice(prefixMatch.consumed);
    if (rest.length === 0) return prefixMatch.id;
    return descend(store, prefixMatch.id, rest, opts, trace);
  }

  if (tokens.length > 0 && tokens[0].kind !== 'name') {
    const rootId = findByExactPath(store, '.');
    if (!rootId) return null;
    return descend(store, rootId, tokens, opts, trace);
  }

  if (!opts.createHolder) return null;
  return createImaginedPrefix(store, tokens, opts, trace);
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

    const match = node.findChild(token.text) as unknown as BlockNode | null; // throws on ambiguity, same as before
    if (match) {
      currentId = match.id;
      trace.push({ id: currentId, kind: match.type!, title: match.title!, created: false });
      continue;
    }

    // Miss.
    if (!opts.createHolder) return null;
    if (wantTitle === undefined) {
      throw new Error(
        `'${token.text}' would need to be created, but no title was supplied for it — --titles is tail-aligned, supply one more entry.`
      );
    }

    // ArtifactNode's one "child" is its singular `root`, not a `children` list — a node that
    // already has a root can't gain a second one this way (same schema-shape constraint
    // `nodeRef.ts` documents against real TerminusDB behavior). Checked *before* minting, so a
    // rejected create doesn't leave an orphan BlockNode behind.
    if (kind === 'ArtifactNode' && (node as unknown as ArtifactNode).root !== undefined) {
      throw new Error(
        `${currentId} already has a root block — can't create '${wantTitle}' as a second one; ` +
        `a holder can only be added *inside* existing content, not beside its single root.`
      );
    }

    const blockId = generateNodeId();
    const newId = `BlockNode/${blockId}`;
    const holder = wrap(store, newId) as unknown as BlockNode;
    holder.type = 'heading';
    holder.title = wantTitle;
    holder.children = [];
    holder.unfolded = false;
    holder.holder = true;
    holder.parent = currentId as unknown as TreeNode;

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
