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
 * payoff of the `TreeNode`/`treeChildren` refactor. This module's wikilink resolution
 * (`artifacts.ts`'s `resolveBlockLinks`) runs *during* artifact ingestion, so a `treeChildren`-based
 * hop here relies on the tree already being consistent at that point — `kgIngest.ts`'s `runIngest`
 * guarantees that deliberately (every artifact tracked and the folder tree rebuilt *before* any
 * content gets parsed or any wikilink resolved), after an earlier version of this file resolved a
 * link back into its own still-unattached folder and threw trying to invent a `document-root`
 * heading. An artifact and its document content are the same node now (`ArtifactNode extends
 * BlockNode`, merged — Aperas-apeironngn-design.md) — `ArtifactNode.findChild`/`.appendChild` are
 * `BlockNode`'s own plain versions, unmodified, so a miss on the artifact tier here is an ordinary
 * "create a new top-level heading" case, not an error; there's no separate root to guard against a
 * second one of, so nothing here needs to special-case that anymore either.
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

/** §3 entry point: a real, read-only, hop-by-hop probe over the leading NAME tokens via
 *  `TreeNode.findChild` — the same mechanism headings use, now safe to reuse for folder/file
 *  segments too since `runIngest` guarantees the tree is already consistent by the time this runs
 *  (see the module doc). Never mints anything itself; a genuine "nothing real matches at all"
 *  falls to `createImaginedPrefix` when `--create-holder` is set. */
function resolveTokens(store: Store, tokens: Token[], opts: CreateOpts, trace: ResolveTraceEntry[]): string | null {
  const rootId = findByExactPath(store, '.');
  if (!rootId) return null;

  let currentId = rootId;
  let consumed = 0;
  while (consumed < tokens.length && tokens[consumed].kind === 'name' && nodeExists(store, currentId)) {
    const node = wrap(store, currentId) as unknown as TreeNode;
    const match = node.findChild((tokens[consumed] as { text: string }).text); // throws on ambiguity
    if (!match) break;
    currentId = match.id;
    trace.push({ id: currentId, kind: kindOf(currentId)!, title: (match.title as string) ?? '', created: false });
    consumed++;
  }

  if (consumed > 0) {
    const rest = tokens.slice(consumed);
    if (rest.length === 0) return currentId;
    return descend(store, currentId, rest, opts, trace);
  }

  if (tokens.length > 0 && tokens[0].kind !== 'name') {
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
    if (wantTitle === undefined) {
      throw new Error(
        `'${token.text}' would need to be created, but no title was supplied for it — --titles is tail-aligned, supply one more entry.`
      );
    }

    const blockId = generateNodeId();
    const newId = `BlockNode/${blockId}`;
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
