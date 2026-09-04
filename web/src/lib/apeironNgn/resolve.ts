/**
 * ApeironNgn implementation of `kg:resolve`'s read-only tier (Aperas-apeironngn-design.md §4
 * rollout) — the deep-path grammar (folder/file/heading/title, `.`/`..`/leading `/`, exact-then-
 * prefix matching) minus `--create-holder`. Mirrors `nodeRef.ts`'s `resolveNodeRefDetail`/
 * `descend`/`resolveTokens` but reading through `wrap()` instead of `client.getDocument`, and
 * fully synchronous.
 *
 * §4 rollout step 3: per-hop child matching is `TreeNode.findChild` (`node.ts`) now, not this
 * file's own kind-switching helper — the direct payoff of the `TreeNode`/`treeChildren` refactor.
 * `findChild` matches any kind of child (`BlockNode` heading, or a `FolderNode`/`ArtifactNode` one
 * level down the structural tree), so a leading run of NAME tokens resolves the same way whether
 * it's walking folders/files or headings — one hop-by-hop descent from the root `FolderNode`. That
 * relies on the tree already being consistent at resolution time, which `kgIngest.ts`'s
 * `runIngest` now guarantees deliberately: every artifact is tracked and the folder tree rebuilt
 * *before* any content gets parsed or any wikilink resolved (`resolveCreate.ts`'s own module doc
 * has the incident this fixed — a tree hop used to run mid-ingestion, before an artifact being
 * ingested was attached into its own parent folder's children yet).
 *
 * Scope cut, deliberately: no `--create-holder`/`--titles` (write path, its own future rollout
 * step per §4), so no `trace`/`ResolveDetail` bookkeeping either — the plain (non-createHolder)
 * mode this covers only ever prints the resolved id itself (`kgCli.ts`'s `resolve` command), never
 * the per-segment trace. Reuses `nodeRef.ts`'s pure `slugify`/`tokenize`/`pathToNameTokens` and
 * `tree.ts`'s `findByExactPath` directly — nothing to port for any of them.
 */

import type { Store } from 'oxigraph';
import { wrap } from './node';
import type { TreeNode } from './node';
import { nodeExists } from './vocab';
import { findByExactPath } from './tree';
import { tokenize, pathToNameTokens, type Token } from '../nodeRef';

const BARE_SNOWFLAKE_RE = /^[0-9A-HJKMNP-TV-Z]{13}$/;
const FULL_NODE_ID_RE = /^(BlockNode|ArtifactNode|FolderNode)\//;

/** Tiers 1-2 (`directResolve.ts`'s equivalent): a full node id passes through unchanged; a bare
 *  snowflake code is tried as BlockNode, then ArtifactNode, then FolderNode. */
function resolveDirectOrSnowflake(store: Store, ref: string): string | null {
  if (FULL_NODE_ID_RE.test(ref)) return ref;
  if (!BARE_SNOWFLAKE_RE.test(ref)) return null;

  for (const kind of ['BlockNode', 'ArtifactNode', 'FolderNode']) {
    const candidate = `${kind}/${ref}`;
    if (nodeExists(store, candidate) && !(wrap(store, candidate) as unknown as TreeNode).tombstonedAt) return candidate;
  }
  return null;
}

/** §2.1's `..` at the artifact/folder tier: not a field on the node, a property of the stored
 *  `path` string — trim the last segment and re-resolve via `findByExactPath`. */
function resolveFromFolderPath(store: Store, folderPath: string, restTokens: Token[]): string | null {
  return resolveTokens(store, [...pathToNameTokens(folderPath), ...restTokens]);
}

/** §3 entry point: anchor at the true root `FolderNode` and hand off to §4's hop-by-hop descent —
 *  `descend`'s `findChild` call handles folder/file segments exactly like heading segments, so
 *  there's nothing left for this function to special-case ahead of it. */
function resolveTokens(store: Store, tokens: Token[]): string | null {
  const rootId = findByExactPath(store, '.');
  if (!rootId) return null;
  return descend(store, rootId, tokens);
}

/** §4 + §2.1's nav tokens, starting from an already-resolved node. No holder creation here — a
 *  miss just declines (`return null`), same as any other unresolvable segment. */
function descend(store: Store, startId: string, tokens: Token[]): string | null {
  let currentId = startId;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token.kind === 'self') continue;

    if (token.kind === 'up') {
      const kind = FULL_NODE_ID_RE.exec(currentId)?.[1];
      if (kind === 'BlockNode') {
        const node = wrap(store, currentId) as unknown as TreeNode & { parent?: TreeNode };
        const parent = node.parent;
        if (!parent) {
          throw new Error(`'..' from ${currentId} has nowhere to go — no parent recorded (may need re-ingestion).`);
        }
        currentId = parent.id;
        // A top-level heading's `.parent` already points straight at the owning `ArtifactNode`
        // (merged with its document content — Aperas-apeironngn-design.md — no separate root
        // block in between anymore), so one hop is always enough here.
        if (!currentId.startsWith('BlockNode/')) {
          const landed = wrap(store, currentId) as unknown as { path?: string };
          return resolveFromFolderPath(store, landed.path as string, tokens.slice(i + 1));
        }
        continue;
      }
      // Already at the artifact/folder tier.
      const node = wrap(store, currentId) as unknown as { path?: string };
      const path = node.path as string;
      const segments = path === '.' ? [] : path.split('/');
      if (segments.length === 0) {
        throw new Error(`'..' from '${path}' — already at the artifacts root.`);
      }
      const parentPath = segments.slice(0, -1).join('/') || '.';
      return resolveFromFolderPath(store, parentPath, tokens.slice(i + 1));
    }

    // token.kind === 'name'
    if (!nodeExists(store, currentId)) return null;
    const node = wrap(store, currentId) as unknown as TreeNode;
    const match = node.findChild(token.text); // throws on ambiguity, same as before
    if (!match) return null; // miss — no --create-holder in this tier
    currentId = match.id;
  }

  return currentId;
}

export interface ResolveOpts {
  /** §2.1: resolves first (through the full algorithm), then `ref` is a slug-descent relative
   *  to it. Ignored when `ref` itself is absolute (leading `/`). */
  base?: string;
}

/**
 * The read-only deep-path resolver: direct id / bare snowflake code (tiers 1-2, always tried
 * first) then the deep path grammar (§2-4). Resolves to a full node id, or `null` on an ordinary
 * miss; *throws* for a genuine usage error (an ambiguous segment, an unresolvable `..`), same
 * distinction `nodeRef.ts`'s `resolveNodeRefOrNull` draws.
 */
export function resolveDeepPath(store: Store, ref: string, opts: ResolveOpts = {}): string | null {
  const absolute = ref.startsWith('/');
  const effectiveRef = absolute ? ref.slice(1) : ref;

  const direct = resolveDirectOrSnowflake(store, effectiveRef);
  if (direct) return direct;

  const pathTokens = tokenize(effectiveRef);

  if (!absolute && opts.base !== undefined) {
    const baseId = resolveDeepPath(store, opts.base);
    if (!baseId) return null;
    return descend(store, baseId, pathTokens);
  }

  return resolveTokens(store, pathTokens);
}
