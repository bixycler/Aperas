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
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseMarkdownTree } from './astParser';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ArtifactRecord {
  path: string;
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

/**
 * Registers or refreshes the lightweight ArtifactNode for a single file. Idempotent — a
 * no-op re-run (unchanged content) skips the KG write entirely rather than bumping
 * lastTrackedAt, so repeated/unscoped sweeps (e.g. the post-index-change hook) don't spam
 * a commit per artifact when nothing on disk actually changed.
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
    path: artifactPath,
    fileHash,
    lastTrackedAt: new Date().toISOString(),
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

/**
 * Registers/refreshes ArtifactNodes for every file under AperasKG/artifacts/.
 */
export async function trackAllArtifacts(client: any): Promise<TrackResult[]> {
  const files = listArtifactFiles();
  const results: TrackResult[] = [];
  for (const file of files) {
    results.push(await trackArtifact(client, file));
  }
  return results;
}

export async function getArtifactRecord(client: any, artifactPath: string): Promise<ArtifactRecord | null> {
  try {
    const doc = await client.getDocument({ type: 'ArtifactNode', id: `ArtifactNode/${artifactPath}` });
    // A missing document doesn't throw — it resolves with the raw 404 response body as a
    // string (confirmed live), which `doc ?? null` would otherwise treat as a truthy record.
    if (!doc || typeof doc === 'string') {
      return null;
    }
    return doc;
  } catch (err) {
    return null;
  }
}

/**
 * AST-parses and commits a tracked artifact into a fractal tree of BlockNodes, only if its file
 * hash has changed since the last ingestion. Returns null when skipped as a no-op.
 *
 * Note: block identity is now Snowflake-generated (see snowflake.ts), not content-addressed —
 * every call mints entirely new ids for the whole tree. Cross-ingestion identity matching (reusing
 * an existing block's id for unchanged content on re-ingestion) is not yet implemented — see
 * AperasKG/artifacts/Aperas-core-ontology-design.md §1.C history in Appendix F — so re-ingesting an
 * already-ingested artifact currently orphans its entire previous tree, not just the changed parts.
 * Acceptable for now since ingestion is meant for uningested artifacts; re-ingestion of an edited
 * artifact is a last-resort path this function doesn't yet implement correctly.
 */
export async function ingestArtifact(client: any, artifactPath: string): Promise<{ blockCount: number } | null> {
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

  const rootBlock = parseMarkdownTree(content);

  // A quick count function just for logging
  function countBlocks(node: any): number {
    return 1 + (node.children || []).reduce((sum: number, child: any) => sum + countBlocks(child), 0);
  }
  const blockCount = countBlocks(rootBlock);

  console.log(`[Aperas Artifacts] Ingesting '${artifactPath}' as fractal tree (${blockCount} blocks)...`);

  const now = new Date().toISOString();

  // We can just update the ArtifactNode and provide the full `root` nested tree!
  // TerminusDB will recursively ingest all the BlockNodes into the graph automatically.
  await client.updateDocument(
    {
      "@type": "ArtifactNode",
      path: artifactPath,
      fileHash: record.fileHash,
      lastTrackedAt: record.lastTrackedAt,
      ingestedHash: record.fileHash,
      lastIngestedAt: now,
      root: rootBlock
    },
    {},
    client.db(),
    `Ingest artifact '${artifactPath}' and its fractal tree`,
    undefined,
    undefined,
    undefined,
    true
  );

  return { blockCount };
}

/**
 * Ingests every tracked artifact whose file hash has changed since its last ingestion.
 */
export async function ingestAllArtifacts(client: any): Promise<Array<{ path: string; blockCount: number }>> {
  const files = listArtifactFiles();
  const results: Array<{ path: string; blockCount: number }> = [];
  for (const file of files) {
    const result = await ingestArtifact(client, file);
    if (result) {
      results.push({ path: file, ...result });
    }
  }
  return results;
}
