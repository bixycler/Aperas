/**
 * Aperas Phase 0: Artifact Tracking & On-Demand Ingestion
 *
 * Lightweight ArtifactNodes (path + content hash) are registered for every file under
 * AperasKG/artifacts/ on `track`. Full AST-parse-and-commit into DocumentNode/BlockNodes
 * only happens on `ingest`, and only for artifacts whose content hash has changed since
 * their last ingestion — tracking is cheap and frequent, ingestion is expensive and lazy.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseMarkdownDocument } from './astParser';
import { insertDocumentAndBlocks, deleteDocumentsIfExist } from './crud';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ArtifactRecord {
  path: string;
  contentHash: string;
  lastTrackedAt: string;
  ingestedHash?: string;
  lastIngestedAt?: string;
  docId?: string;
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
      } else {
        files.push(relative(artifactsDir, fullPath));
      }
    }
  }

  walk(artifactsDir);
  return files;
}

export function computeContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Registers or refreshes the lightweight ArtifactNode for a single file. Idempotent — a
 * no-op re-run (unchanged content) still updates lastTrackedAt but leaves ingestion state alone.
 */
export async function trackArtifact(client: any, artifactPath: string): Promise<ArtifactRecord> {
  const artifactsDir = getArtifactsDir();
  const content = readFileSync(join(artifactsDir, artifactPath), 'utf-8');
  const contentHash = computeContentHash(content);
  const now = new Date().toISOString();

  const existing = await getArtifactRecord(client, artifactPath);

  const record: ArtifactRecord = {
    path: artifactPath,
    contentHash,
    lastTrackedAt: now,
    ...(existing?.ingestedHash ? { ingestedHash: existing.ingestedHash } : {}),
    ...(existing?.lastIngestedAt ? { lastIngestedAt: existing.lastIngestedAt } : {}),
    ...(existing?.docId ? { docId: existing.docId } : {})
  };

  console.log(`[Aperas Artifacts] Tracking '${artifactPath}' (hash: ${contentHash.slice(0, 12)}...)`);
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
  return record;
}

/**
 * Registers/refreshes ArtifactNodes for every file under AperasKG/artifacts/.
 */
export async function trackAllArtifacts(client: any): Promise<ArtifactRecord[]> {
  const files = listArtifactFiles();
  const results: ArtifactRecord[] = [];
  for (const file of files) {
    results.push(await trackArtifact(client, file));
  }
  return results;
}

export async function getArtifactRecord(client: any, artifactPath: string): Promise<ArtifactRecord | null> {
  try {
    const doc = await client.getDocument({ type: 'ArtifactNode', id: `ArtifactNode/${artifactPath}` });
    return doc ?? null;
  } catch (err) {
    return null;
  }
}

/**
 * AST-parses and commits a tracked artifact into DocumentNode/BlockNodes, only if its content
 * hash has changed since the last ingestion. Returns null when skipped as a no-op.
 */
export async function ingestArtifact(client: any, artifactPath: string): Promise<{ docId: string; blockCount: number } | null> {
  const record = await getArtifactRecord(client, artifactPath);
  if (!record) {
    throw new Error(`Artifact '${artifactPath}' is not tracked yet — run track first.`);
  }
  if (record.ingestedHash === record.contentHash) {
    console.log(`[Aperas Artifacts] '${artifactPath}' unchanged since last ingestion — skipping.`);
    return null;
  }

  const artifactsDir = getArtifactsDir();
  const content = readFileSync(join(artifactsDir, artifactPath), 'utf-8');
  const docId = record.docId || artifactPath.replace(/[^a-zA-Z0-9_]/g, '_');

  if (record.docId) {
    // Re-ingestion: drop the previous document tree (doc + all its blocks, in one commit)
    // before recommitting the new one — otherwise a shrinking block count leaves orphans,
    // and a growing one can collide with block ids reused from the prior parse.
    const staleBlocks = await client.getDocument({ type: 'BlockNode', query: { docId }, as_list: true });
    const staleBlockIds = (Array.isArray(staleBlocks) ? staleBlocks : []).map((b: any) => `terminusdb:///data/${b['@id']}`);
    await deleteDocumentsIfExist(client, [`terminusdb:///data/DocumentNode/${docId}`, ...staleBlockIds], `Clear prior ingestion of '${artifactPath}' before re-ingesting`);
  }

  const parsedDoc = parseMarkdownDocument(docId, artifactPath, content);
  console.log(`[Aperas Artifacts] Ingesting '${artifactPath}' as '${docId}' (${parsedDoc.blocks.length} blocks)...`);
  await insertDocumentAndBlocks(client, parsedDoc, `Ingest artifact '${artifactPath}'`);

  const now = new Date().toISOString();
  await client.updateDocument(
    {
      "@type": "ArtifactNode",
      path: artifactPath,
      contentHash: record.contentHash,
      lastTrackedAt: record.lastTrackedAt,
      ingestedHash: record.contentHash,
      lastIngestedAt: now,
      docId
    },
    {},
    client.db(),
    `Mark artifact '${artifactPath}' ingested`,
    undefined,
    undefined,
    undefined,
    true
  );

  return { docId, blockCount: parsedDoc.blocks.length };
}

/**
 * Ingests every tracked artifact whose content hash has changed since its last ingestion.
 */
export async function ingestAllArtifacts(client: any): Promise<Array<{ path: string; docId: string; blockCount: number }>> {
  const files = listArtifactFiles();
  const results: Array<{ path: string; docId: string; blockCount: number }> = [];
  for (const file of files) {
    const result = await ingestArtifact(client, file);
    if (result) {
      results.push({ path: file, ...result });
    }
  }
  return results;
}
