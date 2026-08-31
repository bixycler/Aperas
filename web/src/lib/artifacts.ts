/**
 * Aperas Phase 0: Artifact Tracking & On-Demand Ingestion
 *
 * Lightweight ArtifactNodes (path + file hash) are registered for every file under
 * AperasKG/artifacts/ on `track`. Full AST-parse-and-commit into a fractal BlockNode
 * tree only happens on `ingest`, and only for artifacts whose file hash has changed
 * since their last ingestion — tracking is cheap and frequent, ingestion is expensive
 * and lazy. `fileHash`/`ingestedHash` are both flat hashes of raw file content (not
 * structural) — see AperasKG/artifacts/Aperas-core-ontology-design.md §1.B.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseMarkdownTree, extractAbstract, stampParents, WIKILINK_PREDICATE, type ParsedBlockNode } from './astParser';
import { generateNodeId } from './snowflake';
import { getArtifactTreeViaGraphQL } from './graphql';
import { reconcileTree, matchLeftoverByAbstract, type ReconciliationStats } from './reconcile';
import type { PropEntry } from './props';
import { resolveNodeRefOrNull, resolveIdToPath } from './nodeRef';
import { updateBlockNode } from './crud';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ArtifactRecord {
  artifactId: string;
  path: string;
  title: string;
  text?: string;
  /** Optional (not just always-present-in-practice): a holder ArtifactNode (Aperas-deep-path-
   *  resolution-design.md §7.2) has no real file on disk yet, so no hash/track-time to record —
   *  cleared to a real value once `trackArtifact` genuinely tracks it. */
  fileHash?: string;
  lastTrackedAt?: string;
  ingestedHash?: string;
  lastIngestedAt?: string;
  root?: any;
  props?: PropEntry[];
  /** BaseNode field (Aperas-agentic-query-tools-design.md §4) — carried forward across re-track
   *  the same way text/ingestedHash/root already are, so re-tracking changed content doesn't
   *  silently reset a kg:unfold'd artifact back to folded. */
  unfolded?: boolean;
}

export function getArtifactsDir(): string {
  // web/src/lib -> web -> repo root -> AperasKG/artifacts
  return resolve(__dirname, '..', '..', '..', 'AperasKG', 'artifacts');
}

/** A directory's own `README.md` is absorbed directly into its `FolderNode` (`folders.ts`'s
 *  `buildFolderTree`) and must never also be tracked/ingested as an ordinary `ArtifactNode` —
 *  shared here (not duplicated in `folders.ts`) so both file-walkers agree on one definition. */
export function isReadmeFilename(filename: string): boolean {
  return filename.toLowerCase() === 'readme.md';
}

/**
 * Recursively lists every artifact file path, relative to the artifacts directory. Excludes
 * each directory's own `README.md` — that file is absorbed into its `FolderNode`, never
 * exposed as a separate `ArtifactNode` (previously a real bug: this list had no such exclusion,
 * so `ingestAllArtifacts` ingested every README as an ordinary artifact *in addition to*
 * `folders.ts`'s own absorption, leaving a redundant, orphaned `ArtifactNode` nothing
 * referenced — see `Aperas-dev-status.md`).
 */
export function listArtifactFiles(artifactsDir: string = getArtifactsDir()): string[] {
  const files: string[] = [];

  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (entry.endsWith('.md') && !entry.startsWith('.') && !isReadmeFilename(entry)) {
        // Only tracked markdown artifacts — excludes editor swap/lock files (.foo.md.swp),
        // dotfiles, and any other transient junk that can appear alongside real content.
        files.push(relative(artifactsDir, fullPath));
      }
    }
  }

  walk(artifactsDir);
  return files;
}

export function computeFileHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export interface TrackResult {
  record: ArtifactRecord;
  /** True if this call actually wrote to the KG; false if skipped (content unchanged). */
  tracked: boolean;
}

function normalizeArtifactDoc(doc: any): ArtifactRecord {
  return {
    artifactId: doc.artifactId,
    path: doc.path,
    title: doc.title,
    ...(doc.text ? { text: doc.text } : {}),
    fileHash: doc.fileHash,
    lastTrackedAt: doc.lastTrackedAt,
    ...(doc.ingestedHash ? { ingestedHash: doc.ingestedHash } : {}),
    ...(doc.lastIngestedAt ? { lastIngestedAt: doc.lastIngestedAt } : {}),
    ...(doc.root ? { root: doc.root } : {}),
    ...(doc.props?.length ? { props: doc.props } : {}),
    ...(doc.unfolded ? { unfolded: doc.unfolded } : {})
  };
}

/**
 * Registers or refreshes the lightweight ArtifactNode for a single file. Idempotent — a
 * no-op re-run (unchanged content) skips the KG write entirely rather than bumping
 * lastTrackedAt, so repeated/unscoped sweeps (e.g. the post-index-change hook) don't spam
 * a commit per artifact when nothing on disk actually changed. Assumes `artifactPath` is
 * already known at its current path — rename detection across the whole tracked set happens
 * once, in trackAllArtifacts, before individual files are tracked.
 */
export async function trackArtifact(client: any, artifactPath: string): Promise<TrackResult> {
  const artifactsDir = getArtifactsDir();
  const content = readFileSync(join(artifactsDir, artifactPath), 'utf-8');
  const fileHash = computeFileHash(content);

  const existing = await getArtifactRecord(client, artifactPath);

  if (existing?.fileHash === fileHash) {
    console.log(`[Aperas Artifacts] Skipping '${artifactPath}' — content unchanged (hash: ${fileHash.slice(0, 12)}...)`);
    return { record: existing, tracked: false };
  }

  const record: ArtifactRecord = {
    artifactId: existing?.artifactId ?? generateNodeId(),
    path: artifactPath,
    title: basename(artifactPath),
    fileHash,
    lastTrackedAt: new Date().toISOString(),
    ...(existing?.text ? { text: existing.text } : {}),
    ...(existing?.ingestedHash ? { ingestedHash: existing.ingestedHash } : {}),
    ...(existing?.lastIngestedAt ? { lastIngestedAt: existing.lastIngestedAt } : {}),
    ...(existing?.root ? { root: existing.root } : {}),
    ...(existing?.unfolded ? { unfolded: existing.unfolded } : {})
  };

  console.log(`[Aperas Artifacts] Tracking '${artifactPath}' (hash: ${fileHash.slice(0, 12)}...)`);
  await client.updateDocument(
    { "@type": "ArtifactNode", ...record },
    {},
    client.db(),
    `Track artifact '${artifactPath}'`,
    undefined,
    undefined,
    undefined,
    true
  );
  return { record, tracked: true };
}

export interface ArtifactSweepStats {
  renamed: number;
  removed: number;
}

/**
 * Registers/refreshes ArtifactNodes for every file under AperasKG/artifacts/, first detecting
 * renames/moves across the whole tracked set (design §4 — "one mechanism, three fractal
 * layers", same abstract-similarity leftover matching used for BlockNode moves). A disk path
 * with no tracked ArtifactNode and a tracked path no longer on disk are each leftover
 * candidates; a match reuses the existing artifactId with the new path (a field update, not a
 * tombstone-and-recreate) rather than orphaning the old document and minting a fresh one.
 */
export async function trackAllArtifacts(client: any): Promise<{ results: TrackResult[]; sweep: ArtifactSweepStats }> {
  const files = listArtifactFiles();
  const diskSet = new Set(files);

  const existingDocs: any[] = await client.getDocument({ type: 'ArtifactNode', as_list: true }).catch(() => []);
  const liveExisting = (Array.isArray(existingDocs) ? existingDocs : []).filter((d) => !d.tombstonedAt);
  const existingByPath = new Map(liveExisting.map((d) => [d.path, d]));

  const diskOnlyPaths = files.filter((f) => !existingByPath.has(f));
  const dbOnlyDocs = liveExisting.filter((d) => !diskSet.has(d.path));

  const artifactsDir = getArtifactsDir();
  const addedCandidates = diskOnlyPaths.map((path) => {
    const content = readFileSync(join(artifactsDir, path), 'utf-8');
    return { key: extractAbstract(parseMarkdownTree(content).root), item: { path, content } };
  });
  const removedCandidates = dbOnlyDocs.map((doc) => ({ key: doc.text ?? '', item: doc }));

  const { matched, stillRemoved } = matchLeftoverByAbstract(removedCandidates, addedCandidates);

  const sweep: ArtifactSweepStats = { renamed: 0, removed: 0 };

  for (const { old: oldDoc, new: added } of matched) {
    const fileHash = computeFileHash(added.content);
    console.log(`[Aperas Artifacts] Detected rename '${oldDoc.path}' -> '${added.path}'`);
    await client.updateDocument(
      {
        "@type": "ArtifactNode",
        ...normalizeArtifactDoc(oldDoc),
        path: added.path,
        title: basename(added.path),
        fileHash,
        lastTrackedAt: new Date().toISOString()
      },
      {},
      client.db(),
      `Rename tracked artifact '${oldDoc.path}' -> '${added.path}'`,
      undefined,
      undefined,
      undefined,
      true
    );
    sweep.renamed++;
  }

  for (const doc of stillRemoved) {
    console.log(`[Aperas Artifacts] Tombstoning removed artifact '${doc.path}'`);
    await client.updateDocument(
      { "@type": "ArtifactNode", ...normalizeArtifactDoc(doc), tombstonedAt: new Date().toISOString() },
      {},
      client.db(),
      `Tombstone removed artifact '${doc.path}'`,
      undefined,
      undefined,
      undefined,
      true
    );
    sweep.removed++;
  }

  const renamedIntoPaths = new Set(matched.map((m) => (m.new as { path: string }).path));
  const results: TrackResult[] = [];
  for (const file of files) {
    if (renamedIntoPaths.has(file)) continue; // already fully handled by the rename write above
    results.push(await trackArtifact(client, file));
  }

  return { results, sweep };
}

export async function getArtifactRecord(client: any, artifactPath: string): Promise<ArtifactRecord | null> {
  try {
    const docs = await client.getDocument({ type: 'ArtifactNode', query: { path: artifactPath }, as_list: true });
    const matches = Array.isArray(docs) ? docs : [docs];
    const doc = matches.find((d: any) => d && typeof d !== 'string' && !d.tombstonedAt);
    return doc ? normalizeArtifactDoc(doc) : null;
  } catch (err) {
    return null;
  }
}

// A quick count function just for logging/reporting.
function countBlocks(node: any): number {
  return 1 + (node.children || []).reduce((sum: number, child: any) => sum + countBlocks(child), 0);
}

interface PendingLinkCodes {
  blockId: string;
  codes: string[];
}

/**
 * Strips `linkCodes` off every node in the tree (it's parser-only bookkeeping — `schema.json`
 * has no such field, so leaving it in on the big write below fails schema check with
 * `unknown_property_for_type`, confirmed live), collecting `{blockId, codes}` pairs along the
 * way for `resolveBlockLinks` to resolve in its own separate pass afterward. Called *before* the
 * write; `resolveBlockLinks` itself runs *after* it (see that function's own doc comment).
 */
function extractLinkCodes(node: ParsedBlockNode, out: PendingLinkCodes[] = []): PendingLinkCodes[] {
  if (node.linkCodes && node.linkCodes.length > 0) {
    out.push({ blockId: node.blockId, codes: node.linkCodes });
  }
  delete node.linkCodes;
  for (const child of node.children ?? []) {
    extractLinkCodes(child, out);
  }
  return out;
}

/**
 * Resolves each block's raw `linkCodes` (astParser.ts — a pure, DB-less parser can only capture
 * the raw `[[code]]` text, not resolve it — collected pre-write by `extractLinkCodes`) into real
 * `BlockNode.links` entries, patched onto the already-persisted block. `Link` (the one concrete
 * `BaseLink` leaf — `schema.json`) is written as a plain embedded object with no `@id`, the same
 * way a nested `BlockNode` child already is; TerminusDB creates it as its own independent
 * document as a side effect of the update. Every `Link` created here uses the reserved
 * `WIKILINK_PREDICATE` (astParser.ts) — never `"references"`, which is `kg:link`'s own fixed
 * predicate for manually-authored entries (Aperas-interactive-summarization-design.md §7).
 *
 * **Deliberately runs *after* the tree's own big write, not before**: a `[[wikilink]]` target
 * can be a deep path (Aperas-deep-path-resolution-design.md §2.1) whose implicit base is *this
 * block's own path* — and `resolveIdToPath` (used to compute that base) only works on an
 * already-persisted `.parent` chain. Resolving before the write would see the *previous*
 * ingestion's stale tree for anything inside this same artifact (including a heading newly added
 * in this very edit) — a real chicken-and-egg bug, not just a theoretical one, since the whole
 * point of this pass is to resolve links against content that may be brand new. Running after
 * costs one extra `updateBlockNode` round trip per block that actually has a wikilink (accepted
 * — the same per-block-write cost `kg:title`/`kg:link` already pay), in exchange for seeing the
 * real, current tree, including itself, and `--create-holder` (passed unconditionally here — a
 * forward reference is exactly what it's for, Aperas-deep-path-resolution-design.md §7.3) for
 * whatever doesn't exist yet.
 *
 * Best-effort per link: a code that doesn't resolve (and can't even be imagined — no title
 * available or an ambiguous segment) is skipped with a warning, never fails the whole ingestion.
 * `updateBlockNode`'s patch is the *complete* desired `links` array, so this fetches the block's
 * current (already carried-forward, non-wikilink) links fresh and appends this pass's freshly-
 * resolved batch on top — always this block's entire current set of wikilink-derived links,
 * replacing whatever existed before rather than accumulating duplicates, while `kg:link`-authored
 * entries are left untouched. Confirmed live: re-ingesting an unchanged wikilink-bearing block
 * previously grew its `links` array by one duplicate `Link` document every single pass (same
 * target, new id, orphaning the old one) — fixed by the predicate split this builds on.
 */
async function resolveBlockLinks(client: any, pending: PendingLinkCodes[]): Promise<void> {
  for (const { blockId, codes } of pending) {
    const fullId = `BlockNode/${blockId}`;
    const basePath = await resolveIdToPath(client, fullId);
    const links: Array<{ "@type": "Link"; target: string; predicate: string }> = [];
    for (const code of codes) {
      let target: string | null = null;
      try {
        target = await resolveNodeRefOrNull(client, code, {
          base: basePath ?? undefined,
          createHolder: true,
          // Only the name segments — `--titles` tail-aligns against nameCount (Aperas-deep-path-
          // resolution-design.md §7.1), which excludes `.`/`..` navigation tokens entirely; a
          // raw `code.split('/')` would include those literally and overshoot that count.
          titles: code.split('/').filter((s) => s !== '.' && s !== '..'),
        });
      } catch (err: any) {
        console.warn(`[Aperas Artifacts] Link target '[[${code}]]' in block ${blockId} failed to resolve: ${err.message || err}`);
      }
      if (target) {
        links.push({ "@type": "Link", target, predicate: WIKILINK_PREDICATE });
      } else {
        console.warn(`[Aperas Artifacts] Link target '[[${code}]]' in block ${blockId} didn't resolve to any live node — skipping.`);
      }
    }
    if (links.length > 0) {
      const current = await client.getDocument({ id: fullId }).catch(() => null);
      const existingLinks = current && typeof current !== 'string' ? (current.links ?? []) : [];
      await updateBlockNode(client, fullId, { links: [...existingLinks, ...links] });
    }
  }
}

/**
 * AST-parses and commits a tracked artifact into a fractal tree of BlockNodes, only if its file
 * hash has changed since the last ingestion. Returns null when skipped as a no-op.
 *
 * When a prior ingestion exists, the freshly-parsed tree is reconciled against it
 * (`reconcile.ts`) instead of replacing it wholesale: matched nodes reuse their old `blockId`
 * (so any BaseLink/Assertion pointing at them stays valid), unmatched old nodes are tombstoned
 * rather than silently orphaned, and unmatched new nodes mint fresh ids as before.
 */
export async function ingestArtifact(client: any, artifactPath: string): Promise<{ blockCount: number; reconciliation: ReconciliationStats | null } | null> {
  const record = await getArtifactRecord(client, artifactPath);
  if (!record) {
    throw new Error(`Artifact '${artifactPath}' is not tracked yet — run track first.`);
  }
  if (record.ingestedHash === record.fileHash) {
    console.log(`[Aperas Artifacts] '${artifactPath}' unchanged since last ingestion — skipping.`);
    return null;
  }

  const artifactsDir = getArtifactsDir();
  const content = readFileSync(join(artifactsDir, artifactPath), 'utf-8');

  const { root: newRoot, frontmatter } = parseMarkdownTree(content);
  const now = new Date().toISOString();
  // Frontmatter is file-level metadata, not a block (§5) — realized as one `props` entry,
  // opaque (raw YAML body, not parsed into key/value pairs) for this stage.
  const props: PropEntry[] | undefined = frontmatter !== undefined
    ? [{ "@type": "StringProp", key: "frontmatter", value: frontmatter }]
    : undefined;

  let finalRoot = newRoot;
  let reconciliation: ReconciliationStats | null = null;

  if (record.root) {
    const oldTree = await getArtifactTreeViaGraphQL(client, artifactPath);
    if (oldTree?.root) {
      console.log(`[Aperas Artifacts] Reconciling '${artifactPath}' against its previously ingested tree...`);
      const { finalTree, tombstones, stats } = reconcileTree(oldTree.root, newRoot, now);
      finalRoot = finalTree;
      reconciliation = stats;
      for (const tombstone of tombstones) {
        await client.updateDocument(
          { "@type": "BlockNode", ...tombstone },
          {},
          client.db(),
          `Tombstone reconciled BlockNode ${tombstone.blockId}`,
          undefined,
          undefined,
          undefined,
          true
        );
      }
      console.log(`[Aperas Artifacts] Reconciliation: ${stats.unchanged} unchanged, ${stats.moved} moved, ${stats.added} added, ${stats.removed} removed.`);
    }
  }

  // Re-stamp every descendant's `parent` now, after reconciliation may have reassigned blockIds
  // (carryForwardFields) — the original parse-time stamp (astParser.ts) would otherwise leave
  // stale references to discarded pre-reassignment ids. Then the one external stamp: the tree's
  // own root has no parent yet, since nothing inside the parser knows the owning ArtifactNode.
  stampParents(finalRoot);
  (finalRoot as any).parent = `ArtifactNode/${record.artifactId}`;

  // Pulled off (and deleted from) the tree before the write below — `linkCodes` is parser-only
  // bookkeeping, not a real schema field (see extractLinkCodes's own doc comment).
  const pendingLinks = extractLinkCodes(finalRoot);

  const blockCount = countBlocks(finalRoot);
  console.log(`[Aperas Artifacts] Ingesting '${artifactPath}' as fractal tree (${blockCount} blocks)...`);

  const title = basename(artifactPath);
  const text = extractAbstract(newRoot);

  // We can just update the ArtifactNode and provide the full `root` nested tree!
  // TerminusDB will recursively ingest all the BlockNodes into the graph automatically.
  await client.updateDocument(
    {
      "@type": "ArtifactNode",
      artifactId: record.artifactId,
      path: artifactPath,
      title,
      ...(text ? { text } : {}),
      fileHash: record.fileHash,
      lastTrackedAt: record.lastTrackedAt,
      ingestedHash: record.fileHash,
      lastIngestedAt: now,
      root: finalRoot,
      ...(props ? { props } : {})
    },
    {},
    client.db(),
    `Ingest artifact '${artifactPath}' and its fractal tree`,
    undefined,
    undefined,
    undefined,
    true
  );

  // After, not before (see resolveBlockLinks's own doc comment): the tree just written is now
  // the queryable, current one — including whatever's brand new in this very edit.
  await resolveBlockLinks(client, pendingLinks);

  return { blockCount, reconciliation };
}

/**
 * Ingests every tracked artifact whose file hash has changed since its last ingestion.
 */
export async function ingestAllArtifacts(client: any): Promise<Array<{ path: string; blockCount: number; reconciliation: ReconciliationStats | null }>> {
  const files = listArtifactFiles();
  const results: Array<{ path: string; blockCount: number; reconciliation: ReconciliationStats | null }> = [];
  for (const file of files) {
    const result = await ingestArtifact(client, file);
    if (result) {
      results.push({ path: file, ...result });
    }
  }
  return results;
}
