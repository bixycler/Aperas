/**
 * Aperas node addressing — TerminusDB-backed half (Aperas-basic-assertion-skill-design.md §2):
 * direct addressing (a full node id, or a bare snowflake code — see directResolve.ts) vs.
 * query-based addressing (an artifact/folder path, extended to a full deep path —
 * Aperas-deep-path-resolution-design.md).
 *
 * Split out of `nodeRef.ts` (Aperas-apeironngn-design.md §4 rollout, archiving step): the pure
 * `slugify`/`tokenize`/`pathToNameTokens`/`Token` pieces stayed there since
 * `apeironNgn/node.ts`/`resolveCreate.ts`/`resolve.ts` import them directly; everything here talks
 * to a live TerminusDB `client` and moves to `.archive/` alongside `kgCli.ts`.
 *
 * Circular-import note (inherited from `nodeRef.ts`): this module imports `getArtifactRecord`/
 * `getFolderRecord` from artifactsTdb.ts/foldersTdb.ts, and artifactsTdb.ts imports
 * `resolveNodeRefOrNull`/`resolveIdToPath` back from here (for wikilink resolution) — a real
 * cycle, unlike directResolve.ts's deliberate leaf-module design. Safe here specifically because
 * every export on both sides is a plain `function` declaration (hoisted, fully defined before
 * either module's body finishes evaluating) and every cross-module call happens inside an async
 * function body at runtime, long after both modules have finished loading — never at
 * module-top-level. Confirmed live via `kg:ingest` after this was wired up.
 */

import { getArtifactRecord } from './artifactsTdb';
import { getFolderRecord } from './foldersTdb';
import { resolveDirectOrSnowflake } from './directResolveTdb';
import { generateNodeId } from './snowflake';
import { slugify, tokenize, pathToNameTokens, type Token } from './nodeRef';

const FULL_NODE_ID_RE = /^(BlockNode|ArtifactNode|FolderNode)\//;

/**
 * The reverse conversion: a full node id back to a human path (Aperas-deep-path-resolution-
 * design.md — the id→path direction that plain WOQL backlinks can't give us, since `children`/
 * `root` are `List`-typed and TerminusDB doesn't index `List` membership as a direct triple;
 * confirmed live via `t(X, 'children', Target)` returning nothing, unlike a `Set`-typed field —
 * see `Aperas-core-ontology-design.md` §3.A). Walks `BlockNode.parent` (astParser.ts's
 * `stampParents`) up to the owning `ArtifactNode`/`FolderNode`, collecting each hop's slugified
 * `title`, then prepends that node's own `path` — which already encodes its full nesting under
 * the artifacts root, so no further upward walk through folders is needed once reached.
 *
 * Returns `null` on anything unwalkable: a missing document, a `Link`/`Assertion` id (no
 * structural `parent` at all), or a `BlockNode` ingested before this field existed (`parent`
 * unset — needs re-ingestion, same as any other schema addition with existing content).
 */
export async function resolveIdToPath(client: any, id: string): Promise<string | null> {
  const segments: string[] = [];
  let currentId = id;

  for (;;) {
    const kind = FULL_NODE_ID_RE.exec(currentId)?.[1];
    if (kind === 'ArtifactNode' || kind === 'FolderNode') {
      const doc = await client.getDocument({ id: currentId }).catch(() => null);
      if (!doc || typeof doc === 'string') return null;
      return segments.length > 0 ? `${doc.path}/${segments.join('/')}` : doc.path;
    }
    if (kind !== 'BlockNode') return null; // Link/Assertion — no structural parent

    const doc = await client.getDocument({ id: currentId }).catch(() => null);
    if (!doc || typeof doc === 'string') return null;
    segments.unshift(slugify(doc.title));
    if (!doc.parent) return null;
    currentId = doc.parent;
  }
}

// ---------------------------------------------------------------------------------------------
// Deep path resolution (Aperas-deep-path-resolution-design.md §1-7): path→id, the `kg:resolve`
// direction. See that doc for the settled design this implements.
// ---------------------------------------------------------------------------------------------

async function getDoc(client: any, id: string): Promise<any | null> {
  try {
    const doc = await client.getDocument({ id });
    return doc && typeof doc !== 'string' ? doc : null;
  } catch {
    return null;
  }
}

function kindOf(id: string): 'BlockNode' | 'ArtifactNode' | 'FolderNode' | null {
  return (FULL_NODE_ID_RE.exec(id)?.[1] as any) ?? null;
}

/** ArtifactNode's one child is its `root`; FolderNode/BlockNode's children are their `children`
 *  list — both come back as plain reference id strings on a non-nested read. */
function childRefs(doc: any, kind: string): string[] {
  if (kind === 'ArtifactNode') return doc.root ? [doc.root] : [];
  return (doc.children ?? []).filter((c: any) => typeof c === 'string');
}

export interface ResolveOpts {
  /** §2.1: resolves first (through the full algorithm), then `ref` is a slug-descent relative
   *  to it. Ignored when `ref` itself is absolute (leading `/`). */
  base?: string;
  /** §7: on a miss, create a holder instead of declining. */
  createHolder?: boolean;
  /** §7.1: tail-aligned — one title per heading-tier segment actually being created, aligned
   *  against the *end* of the segment sequence, not the head. */
  titles?: string[];
}

export interface ResolveTraceEntry {
  id: string;
  kind: string;
  title: string;
  created: boolean;
}

export interface ResolveDetail {
  id: string;
  /** §7.1's "Output" — one entry per segment actually walked via tree descent (§4/§7), tagged
   *  existing vs. created. Empty for anything resolved purely via §3's flat path lookup, or via
   *  tier 1/2 (direct id / bare snowflake code). */
  trace: ResolveTraceEntry[];
}

/** §3: longest-prefix search for an ArtifactNode/FolderNode among the leading NAME tokens —
 *  `.`/`..` can never be part of a stored artifact/folder path, so the search stops at the
 *  first non-name token. */
async function resolveArtifactOrFolderPrefix(
  client: any,
  tokens: Token[]
): Promise<{ id: string; consumed: number } | null> {
  let nameCount = 0;
  while (nameCount < tokens.length && tokens[nameCount].kind === 'name') nameCount++;

  for (let k = nameCount; k >= 1; k--) {
    const candidate = tokens
      .slice(0, k)
      .map((t) => (t as { text: string }).text)
      .join('/');
    const artifact = await getArtifactRecord(client, candidate);
    if (artifact) return { id: `ArtifactNode/${artifact.artifactId}`, consumed: k };
    const folder = await getFolderRecord(client, candidate);
    if (folder) return { id: `FolderNode/${folder.folderId}`, consumed: k };
  }
  return null;
}

/**
 * §7.2: nothing at all resolved for the leading name-token run — imagine the whole chain,
 * folders then one artifact, anchored at whichever ancestor folder already exists (root, at
 * worst). The `.md` suffix (§7.2) is what tells a folder segment from the one artifact segment;
 * without one present anywhere in the run, there's no way to know where that boundary is, so
 * this declines rather than guessing one.
 */
async function createImaginedPrefix(
  client: any,
  tokens: Token[],
  opts: ResolveOpts,
  trace: ResolveTraceEntry[]
): Promise<string | null> {
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

  const rootFolder = await getFolderRecord(client, '.');
  if (!rootFolder) throw new Error('No root FolderNode found — run kg:ingest at least once first.');
  let anchorFullId = `FolderNode/${rootFolder.folderId}`;
  let firstNewIdx = 0;
  for (let i = 0; i < artifactIdx; i++) {
    const found = await getFolderRecord(client, fullPaths[i]);
    if (!found) break;
    anchorFullId = `FolderNode/${found.folderId}`;
    firstNewIdx = i + 1;
  }

  const artifactId = generateNodeId();
  let nested: any = {
    '@type': 'ArtifactNode',
    artifactId,
    path: fullPaths[artifactIdx],
    title: names[artifactIdx],
    holder: true,
  };
  const newArtifactFullId = `ArtifactNode/${artifactId}`;
  const newTrace: ResolveTraceEntry[] = [
    { id: newArtifactFullId, kind: 'ArtifactNode', title: names[artifactIdx], created: true },
  ];

  for (let i = artifactIdx - 1; i >= firstNewIdx; i--) {
    const folderId = generateNodeId();
    nested = {
      '@type': 'FolderNode',
      folderId,
      path: fullPaths[i],
      title: names[i],
      holder: true,
      children: [nested],
    };
    newTrace.unshift({ id: `FolderNode/${folderId}`, kind: 'FolderNode', title: names[i], created: true });
  }

  const anchorDoc = await getDoc(client, anchorFullId);
  await client.updateDocument(
    { ...anchorDoc, children: [...(anchorDoc.children ?? []), nested] },
    {},
    client.db(),
    `Imagine '${fullPaths[artifactIdx]}'`,
    undefined,
    undefined,
    undefined,
    true
  );
  trace.push(...newTrace);

  const rest = tokens.slice(artifactIdx + 1);
  if (rest.length === 0) return newArtifactFullId;
  return descend(client, newArtifactFullId, rest, opts, trace);
}

/** §3 entry point: try the flat prefix search first; if nothing at all matches and the leading
 *  token is a name, either imagine it (§7.2) or decline; if the leading token is `.`/`..` with
 *  no name to search at all, anchor at the true root FolderNode and hand off to §4/§2.1. */
async function resolveTokens(
  client: any,
  tokens: Token[],
  opts: ResolveOpts,
  trace: ResolveTraceEntry[]
): Promise<string | null> {
  const prefixMatch = await resolveArtifactOrFolderPrefix(client, tokens);
  if (prefixMatch) {
    const doc = await getDoc(client, prefixMatch.id);
    trace.push({ id: prefixMatch.id, kind: kindOf(prefixMatch.id)!, title: doc?.title ?? '', created: false });
    const rest = tokens.slice(prefixMatch.consumed);
    if (rest.length === 0) return prefixMatch.id;
    return descend(client, prefixMatch.id, rest, opts, trace);
  }

  if (tokens.length > 0 && tokens[0].kind !== 'name') {
    const root = await getFolderRecord(client, '.');
    if (!root) return null;
    return descend(client, `FolderNode/${root.folderId}`, tokens, opts, trace);
  }

  if (!opts.createHolder) return null;
  return createImaginedPrefix(client, tokens, opts, trace);
}

/** §2.1's `..` at the artifact/folder tier: not a field on the node, a property of the stored
 *  `path` string — trim the last segment and re-resolve via getFolderRecord. */
async function resolveFromFolderPath(
  client: any,
  folderPath: string,
  restTokens: Token[],
  opts: ResolveOpts,
  trace: ResolveTraceEntry[]
): Promise<string | null> {
  return resolveTokens(client, [...pathToNameTokens(folderPath), ...restTokens], opts, trace);
}

/**
 * §4 + §2.1's nav tokens + §7's holder creation, starting from an already-resolved node.
 * `opts.titles` tail-aligns against exactly the NAME tokens in `tokens` — every caller of
 * `descend` passes only the sub-sequence that constitutes (a piece of) §7.1's `S`, so a fresh
 * per-call count here is always correct, never needing cross-call bookkeeping.
 */
async function descend(
  client: any,
  startId: string,
  tokens: Token[],
  opts: ResolveOpts,
  trace: ResolveTraceEntry[]
): Promise<string | null> {
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
        const doc = await getDoc(client, currentId);
        if (!doc?.parent) {
          throw new Error(`'..' from ${currentId} has nowhere to go — no parent recorded (may need re-ingestion).`);
        }
        currentId = doc.parent;
        if (kindOf(currentId) !== 'BlockNode') {
          const landedDoc = await getDoc(client, currentId);
          return resolveFromFolderPath(client, landedDoc.path, tokens.slice(i + 1), opts, trace);
        }
        continue;
      }
      // Already at the artifact/folder tier.
      const doc = await getDoc(client, currentId);
      const segments = doc.path === '.' ? [] : doc.path.split('/');
      if (segments.length === 0) {
        throw new Error(`'..' from '${doc.path}' — already at the artifacts root.`);
      }
      const parentPath = segments.slice(0, -1).join('/') || '.';
      return resolveFromFolderPath(client, parentPath, tokens.slice(i + 1), opts, trace);
    }

    // token.kind === 'name'
    const wantTitle = nameIndex >= nameCount - titles.length ? titles[nameIndex - (nameCount - titles.length)] : undefined;
    nameIndex++;

    const kind = kindOf(currentId);
    const doc = await getDoc(client, currentId);
    if (!doc || !kind) return null;

    const candidates: Array<{ id: string; title: string; type: string }> = [];
    for (const cid of childRefs(doc, kind)) {
      if (kindOf(cid) !== 'BlockNode') continue; // §4: descent only ever matches BlockNode children
      const cdoc = await getDoc(client, cid);
      if (cdoc) candidates.push({ id: cid, title: cdoc.title, type: cdoc.type });
    }

    const wantSlug = slugify(token.text);
    let matches = candidates.filter((c) => slugify(c.title) === wantSlug);
    if (matches.length === 0) {
      // A heading's leading `#`/`##` marker slugifies to leading dashes under §5's blanket rule
      // (harmless for exact match — both sides get the same treatment) but would defeat prefix
      // matching's whole point (matching on content, not markup): virtually every heading's
      // slugified form starts with a run of dashes a caller has no reason to know or type.
      // Stripped here, content-first, syntax-second — confirmed live: without this, `setup` never
      // prefix-matches `## Setup Guide` (slugifies to `---setup-guide`), making §4's prefix tier
      // useless for the dominant addressable-content case.
      matches = candidates.filter((c) => slugify(c.title).replace(/^-+/, '').startsWith(wantSlug));
    }

    if (matches.length > 1) {
      throw new Error(
        `'${token.text}' is ambiguous among: ${matches.map((m) => `${m.id} ("${m.title}")`).join(', ')}`
      );
    }

    if (matches.length === 1) {
      currentId = matches[0].id;
      trace.push({ id: currentId, kind: matches[0].type, title: matches[0].title, created: false });
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
    const literal = {
      '@type': 'BlockNode',
      blockId,
      type: 'heading',
      title: wantTitle,
      children: [],
      unfolded: false,
      holder: true,
      parent: currentId,
    };

    // ArtifactNode's one "child" is its singular `root`, not a `children` List — the write
    // shape has to match, and a node that already has a root can't gain a second one this way
    // (there's no structural slot for a sibling at that tier; a real edit adds *inside* the
    // existing root instead). Confirmed live: writing `children` onto an ArtifactNode fails
    // schema check (`unknown_property_for_type`) — not just a style choice.
    if (kind === 'ArtifactNode') {
      if (doc.root) {
        throw new Error(
          `${currentId} already has a root block — can't create '${wantTitle}' as a second one; ` +
          `a holder can only be added *inside* existing content, not beside its single root.`
        );
      }
      await client.updateDocument(
        { ...doc, root: literal },
        {}, client.db(), `Create holder root BlockNode '${wantTitle}' for ${currentId}`,
        undefined, undefined, undefined, true
      );
    } else {
      await client.updateDocument(
        { ...doc, children: [...(doc.children ?? []), literal] },
        {}, client.db(), `Create holder BlockNode '${wantTitle}' under ${currentId}`,
        undefined, undefined, undefined, true
      );
    }
    currentId = newId;
    trace.push({ id: currentId, kind: 'heading', title: wantTitle, created: true });
  }

  return currentId;
}

/**
 * The full deep-path resolver (Aperas-deep-path-resolution-design.md): direct id / bare
 * snowflake code (tiers 1-2, always tried first, base or not — a full id is absolute by
 * construction) then the deep path grammar (§2-4, §7). `opts.base`, when given and `ref` isn't
 * itself absolute, resolves independently first; `opts.titles` is split so the *last*
 * `min(titles.length, ref's own name-token count)` entries go to `ref`'s own tail and the rest
 * (if any) go to `base`'s own tail — equivalent to tail-aligning one combined sequence across
 * both without ever having to merge their token arrays (Aperas-deep-path-resolution-design.md
 * §7.1/§7.2).
 */
export async function resolveNodeRefDetail(
  client: any,
  ref: string,
  opts: ResolveOpts = {}
): Promise<ResolveDetail | null> {
  const absolute = ref.startsWith('/');
  const effectiveRef = absolute ? ref.slice(1) : ref;

  const direct = await resolveDirectOrSnowflake(client, effectiveRef);
  if (direct) return { id: direct, trace: [] };

  const pathTokens = tokenize(effectiveRef);

  if (!absolute && opts.base !== undefined) {
    const pathNameCount = pathTokens.filter((t) => t.kind === 'name').length;
    const allTitles = opts.titles ?? [];
    const pathTitleCount = Math.min(allTitles.length, pathNameCount);
    const pathTitles = allTitles.slice(allTitles.length - pathTitleCount);
    const baseTitles = allTitles.slice(0, allTitles.length - pathTitleCount);

    const baseDetail = await resolveNodeRefDetail(client, opts.base, {
      createHolder: opts.createHolder,
      titles: baseTitles,
    });
    if (!baseDetail) return null;

    const trace = [...baseDetail.trace];
    const id = await descend(client, baseDetail.id, pathTokens, { createHolder: opts.createHolder, titles: pathTitles }, trace);
    return id ? { id, trace } : null;
  }

  const trace: ResolveTraceEntry[] = [];
  const id = await resolveTokens(client, pathTokens, opts, trace);
  return id ? { id, trace } : null;
}

/**
 * Resolves a reference to a full node id, or `null` if nothing matches — never throws for an
 * ordinary miss, so callers decide whether that's fatal (CLI usage exits) or best-effort; *does*
 * throw for a genuine usage error (an ambiguous segment, a miss with no title available under
 * `--create-holder`, or an unresolvable `..`) since those aren't "try something else" misses.
 */
export async function resolveNodeRefOrNull(client: any, ref: string, opts: ResolveOpts = {}): Promise<string | null> {
  const detail = await resolveNodeRefDetail(client, ref, opts);
  return detail?.id ?? null;
}
