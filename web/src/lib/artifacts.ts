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
import { parseMarkdownTree, extractAbstract } from './astParser';
import { generateNodeId } from './snowflake';
import { getArtifactTreeViaGraphQL } from './graphql';
import { reconcileTree, matchLeftoverByAbstract, type ReconciliationStats } from './reconcile';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ArtifactRecord {
  artifactId: string;
  path: string;
  title: string;
  text?: string;
  fileHash: string;
  lastTrackedAt: string;
  ingestedHash?: string;
  lastIngestedAt?: string;
  root?: any;
}

export function getArtifactsDir(): string {
  // web/src/lib -> web -> repo root -> AperasKG/artifacts
  return resolve(__dirname, '..', '..', '..', 'AperasKG', 'artifacts');
}

/**
 * Recursively lists every artifact file path, relative to the artifacts directory.
 */
export function listArtifactFiles(artifactsDir: string = getArtifactsDir()): string[] {
  const files: string[] = [];

  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (entry.endsWith('.md') && !entry.startsWith('.')) {
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
    ...(doc.root ? { root: doc.root } : {})
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
    ...(existing?.root ? { root: existing.root } : {})
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
    return { key: extractAbstract(parseMarkdownTree(content)), item: { path, content } };
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

  const newRoot = parseMarkdownTree(content);
  const now = new Date().toISOString();

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
      root: finalRoot
    },
    {},
    client.db(),
    `Ingest artifact '${artifactPath}' and its fractal tree`,
    undefined,
    undefined,
    undefined,
    true
  );

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
