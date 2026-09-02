/**
 * ApeironNgn implementation of `kg:resolve`'s read-only tier (Aperas-apeironngn-design.md §4
 * rollout) — the deep-path grammar (folder/file/heading/title, `.`/`..`/leading `/`, exact-then-
 * prefix matching) minus `--create-holder`. Mirrors `nodeRef.ts`'s `resolveNodeRefDetail`/
 * `descend`/`resolveTokens` but reading through `wrap()` instead of `client.getDocument`, and
 * fully synchronous.
 *
 * Scope cut, deliberately: no `--create-holder`/`--titles` (write path, its own future rollout
 * step per §4), so no `trace`/`ResolveDetail` bookkeeping either — the plain (non-createHolder)
 * mode this covers only ever prints the resolved id itself (`kgCli.ts`'s `resolve` command), never
 * the per-segment trace. Reuses `nodeRef.ts`'s pure `slugify`/`tokenize`/`pathToNameTokens` and
 * `tree.ts`'s `findByExactPath` directly — nothing to port for any of them.
 */

import type { Store } from 'oxigraph';
import { wrap, type ApeironNode } from './node';
import { nodeExists, nodeKindFromId } from './vocab';
import { findByExactPath } from './tree';
import { slugify, tokenize, pathToNameTokens, type Token } from '../nodeRef';

const BARE_SNOWFLAKE_RE = /^[0-9A-HJKMNP-TV-Z]{13}$/;
const FULL_NODE_ID_RE = /^(BlockNode|ArtifactNode|FolderNode)\//;

/** Tiers 1-2 (`directResolve.ts`'s equivalent): a full node id passes through unchanged; a bare
 *  snowflake code is tried as BlockNode, then ArtifactNode, then FolderNode. */
function resolveDirectOrSnowflake(store: Store, ref: string): string | null {
  if (FULL_NODE_ID_RE.test(ref)) return ref;
  if (!BARE_SNOWFLAKE_RE.test(ref)) return null;

  for (const kind of ['BlockNode', 'ArtifactNode', 'FolderNode']) {
    const candidate = `${kind}/${ref}`;
    if (nodeExists(store, candidate) && wrap(store, candidate).tombstonedAt !== true) return candidate;
  }
  return null;
}

function kindOf(id: string): 'BlockNode' | 'ArtifactNode' | 'FolderNode' | null {
  return (FULL_NODE_ID_RE.exec(id)?.[1] as any) ?? null;
}

/** ArtifactNode's one child is its `root`; FolderNode/BlockNode's children are their `children`
 *  reified list — both come back as already-wrapped `ApeironNode`s. */
function childNodes(node: ApeironNode, kind: string): ApeironNode[] {
  if (kind === 'ArtifactNode') {
    const root = node.root as ApeironNode | undefined;
    return root ? [root] : [];
  }
  return node.children as ApeironNode[];
}

/** §3: longest-prefix search for an ArtifactNode/FolderNode among the leading NAME tokens. A
 *  single `path`-literal lookup replaces `nodeRef.ts`'s separate artifact-then-folder tries —
 *  `path` is only declared on those two classes, so any match is inherently one or the other. */
function resolveArtifactOrFolderPrefix(store: Store, tokens: Token[]): { id: string; consumed: number } | null {
  let nameCount = 0;
  while (nameCount < tokens.length && tokens[nameCount].kind === 'name') nameCount++;

  for (let k = nameCount; k >= 1; k--) {
    const candidate = tokens
      .slice(0, k)
      .map((t) => (t as { text: string }).text)
      .join('/');
    const id = findByExactPath(store, candidate);
    if (id) return { id, consumed: k };
  }
  return null;
}

/** §2.1's `..` at the artifact/folder tier: not a field on the node, a property of the stored
 *  `path` string — trim the last segment and re-resolve via `findByExactPath`. */
function resolveFromFolderPath(store: Store, folderPath: string, restTokens: Token[]): string | null {
  return resolveTokens(store, [...pathToNameTokens(folderPath), ...restTokens]);
}

/** §3 entry point: try the flat prefix search first; if nothing matches and the leading token is
 *  `.`/`..` with no name to search at all, anchor at the true root FolderNode and hand off to §4.
 *  A leading name with nothing at all matching declines outright — `--create-holder`'s "imagine
 *  the whole chain" fallback (§7.2) isn't part of this read-only tier. */
function resolveTokens(store: Store, tokens: Token[]): string | null {
  const prefixMatch = resolveArtifactOrFolderPrefix(store, tokens);
  if (prefixMatch) {
    const rest = tokens.slice(prefixMatch.consumed);
    if (rest.length === 0) return prefixMatch.id;
    return descend(store, prefixMatch.id, rest);
  }

  if (tokens.length > 0 && tokens[0].kind !== 'name') {
    const rootId = findByExactPath(store, '.');
    if (!rootId) return null;
    return descend(store, rootId, tokens);
  }

  return null;
}

/** §4 + §2.1's nav tokens, starting from an already-resolved node. No holder creation here — a
 *  miss just declines (`return null`), same as any other unresolvable segment. */
function descend(store: Store, startId: string, tokens: Token[]): string | null {
  let currentId = startId;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token.kind === 'self') continue;

    if (token.kind === 'up') {
      const kind = kindOf(currentId);
      if (kind === 'BlockNode') {
        const node = wrap(store, currentId);
        const parent = node.parent as ApeironNode | undefined;
        if (!parent) {
          throw new Error(`'..' from ${currentId} has nowhere to go — no parent recorded (may need re-ingestion).`);
        }
        currentId = parent.id;
        if (kindOf(currentId) !== 'BlockNode') {
          const landed = wrap(store, currentId);
          return resolveFromFolderPath(store, landed.path as string, tokens.slice(i + 1));
        }
        continue;
      }
      // Already at the artifact/folder tier.
      const node = wrap(store, currentId);
      const path = node.path as string;
      const segments = path === '.' ? [] : path.split('/');
      if (segments.length === 0) {
        throw new Error(`'..' from '${path}' — already at the artifacts root.`);
      }
      const parentPath = segments.slice(0, -1).join('/') || '.';
      return resolveFromFolderPath(store, parentPath, tokens.slice(i + 1));
    }

    // token.kind === 'name'
    const kind = kindOf(currentId);
    if (!kind || !nodeExists(store, currentId)) return null;
    const node = wrap(store, currentId);

    const candidates: Array<{ id: string; title: string }> = [];
    for (const child of childNodes(node, kind)) {
      if (kindOf(child.id) !== 'BlockNode') continue; // §4: descent only ever matches BlockNode children
      if (child.title === undefined) continue;
      candidates.push({ id: child.id, title: child.title as string });
    }

    const wantSlug = slugify(token.text);
    let matches = candidates.filter((c) => slugify(c.title) === wantSlug);
    if (matches.length === 0) {
      // Leading `#`/`##` marker stripped before prefix matching — see nodeRef.ts's own comment
      // on why (content-first, syntax-second).
      matches = candidates.filter((c) => slugify(c.title).replace(/^-+/, '').startsWith(wantSlug));
    }

    if (matches.length > 1) {
      throw new Error(
        `'${token.text}' is ambiguous among: ${matches.map((m) => `${m.id} ("${m.title}")`).join(', ')}`
      );
    }

    if (matches.length === 1) {
      currentId = matches[0].id;
      continue;
    }

    return null; // miss — no --create-holder in this tier
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
