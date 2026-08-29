/**
 * Aperas Phase 0: JSON-LD Substrate Import/Export
 *
 * Bidirectionally mirrors the schema and every instance document (per class) between
 * TerminusDB and AperasKG/Apeiron/ as plain, git-trackable JSON-LD files — a portable,
 * engine-agnostic round-trip of the graph, independent of TerminusDB's own storage
 * internals. See Aperas-architecture.md §5 and Aperas-design.md's "Phase 4" roadmap
 * entry for why this boundary exists.
 */

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashDocSet } from './client';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Import order matters: each class is written as one batched commit (see importJsonLd),
// and a document must not reference an id from a class that hasn't been committed yet.
// BlockNode first (its own parent/child references resolve within its own batch),
// then ArtifactNode (root -> BlockNode), then FolderNode (children -> Artifact/Folder/
// BlockNode), then Assertion last (source/target can point at any of the above).
const INSTANCE_CLASSES = ['BlockNode', 'ArtifactNode', 'FolderNode', 'Assertion'] as const;

const JSONLD_CONTEXT = {
  '@type': '@context',
  '@base': 'terminusdb:///data/',
  '@schema': 'terminusdb:///schema#'
};

export function getApeironExportDir(): string {
  // web/src/lib -> web -> repo root -> AperasKG/Apeiron
  return resolve(__dirname, '..', '..', '..', 'AperasKG', 'Apeiron');
}

function stableId(doc: any): string {
  return doc['@id'] ?? doc.blockId ?? doc.artifactId ?? doc.folderId ?? '';
}

async function fetchInstances(client: any, type: string): Promise<any[]> {
  const docs = await client.getDocument({ type, as_list: true }).catch(() => []);
  return (Array.isArray(docs) ? docs : []).filter((d) => d && typeof d !== 'string');
}

/**
 * Exports the current schema and every instance document as JSON-LD files into
 * AperasKG/Apeiron/ — one file per class plus schema.jsonld. Instances are sorted by
 * @id (falling back to their Snowflake key field) so re-exports produce clean,
 * content-driven diffs rather than reordering noise.
 */
export async function exportJsonLd(client: any): Promise<{ dir: string; counts: Record<string, number> }> {
  const dir = getApeironExportDir();
  mkdirSync(dir, { recursive: true });

  const schema: any[] = await client.getDocument({ graph_type: 'schema', as_list: true }).catch(() => []);
  writeFileSync(join(dir, 'schema.jsonld'), JSON.stringify(schema, null, 2) + '\n');

  const counts: Record<string, number> = {};
  for (const type of INSTANCE_CLASSES) {
    const instances = await fetchInstances(client, type);
    instances.sort((a, b) => stableId(a).localeCompare(stableId(b)));
    writeFileSync(join(dir, `${type}.jsonld`), JSON.stringify([JSONLD_CONTEXT, ...instances], null, 2) + '\n');
    counts[type] = instances.length;
  }

  return { dir, counts };
}

/**
 * Reads AperasKG/Apeiron/ back into TerminusDB — the inverse of exportJsonLd. Applies
 * schema.jsonld via full_replace, then upserts every instance document (each already
 * carries its own `@id`, so a matching document is updated in place rather than
 * duplicated) — one batched `updateDocument` call per class, in INSTANCE_CLASSES'
 * dependency order, so cross-document references always point at something already
 * committed (or, within a class's own batch, committed in the same call). Used to
 * bootstrap a fresh database or restore state from the git-tracked snapshot rather than
 * from a TerminusDB backup — see Aperas-architecture.md §5.
 *
 * A commit is only worth what it changes — before writing the schema or a given class,
 * its content hash (`hashDocSet`, the same idempotency check `client.ts` already uses
 * for schema apply) is compared against what's already live, and the write is skipped
 * (no TerminusDB commit at all) when nothing actually changed.
 */
export async function importJsonLd(client: any): Promise<{ dir: string; counts: Record<string, number>; skipped: string[] }> {
  const dir = getApeironExportDir();
  const skipped: string[] = [];

  const schema = JSON.parse(readFileSync(join(dir, 'schema.jsonld'), 'utf-8'));
  const existingSchema: any[] = await client.getDocument({ graph_type: 'schema', as_list: true }).catch(() => []);
  if (existingSchema.length > 0 && hashDocSet(existingSchema) === hashDocSet(schema)) {
    skipped.push('schema');
  } else {
    await client.addDocument(schema, { graph_type: 'schema', full_replace: true }, client.db(), 'Import schema from AperasKG/Apeiron/');
  }

  const counts: Record<string, number> = {};
  for (const type of INSTANCE_CLASSES) {
    const docs: any[] = JSON.parse(readFileSync(join(dir, `${type}.jsonld`), 'utf-8'));
    const instances = docs.filter((d) => d['@type'] !== '@context');
    counts[type] = instances.length;
    if (instances.length === 0) continue;

    const existing = await fetchInstances(client, type);
    if (existing.length > 0 && hashDocSet(existing) === hashDocSet(instances)) {
      skipped.push(type);
      continue;
    }

    await client.updateDocument(
      instances,
      {},
      client.db(),
      `Import ${type} from AperasKG/Apeiron/`,
      undefined,
      undefined,
      undefined,
      true
    );
  }

  return { dir, counts, skipped };
}
