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

// Every concrete instance class mirrored to/from AperasKG/Apeiron/ — one file per class.
// Export order doesn't matter (each class is read independently); import order does, see
// IMPORT_COMMIT_GROUPS below.
const INSTANCE_CLASSES = ['BlockNode', 'Link', 'ArtifactNode', 'FolderNode', 'Assertion'] as const;

// Import commit groups: each group is written as one combined batched commit (see importJsonLd).
// A document must not reference an id from a class that hasn't been committed yet *in an earlier
// group* — except within its own group, where forward references are fine. `BlockNode` and `Link`
// are their own group, not two separate ones, because they form a genuine two-way reference cycle
// (`BlockNode.links` -> `Link` id, `Link.target` -> a `BlockNode` id — the same cycle
// `crud.ts`'s `findLinkIdsTargeting` already documents for deletion) and TerminusDB checks
// referential integrity per commit, not across commits: live-verified, a `BlockNode` referencing a
// not-yet-existing `Link` id fails even when that exact `Link` is created in the very next separate
// call, but succeeds when both are submitted together in one call, in either order. Everything
// after that is a one-way dependency on already-committed groups, as before: `ArtifactNode`
// (`root` -> `BlockNode`), then `FolderNode` (`children` -> `Artifact`/`Folder`/`BlockNode`), then
// `Assertion` last (`source`/`target` can point at any of the above).
const IMPORT_COMMIT_GROUPS: readonly (readonly string[])[] = [
  ['BlockNode', 'Link'],
  ['ArtifactNode'],
  ['FolderNode'],
  ['Assertion'],
];

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
 * duplicated) — one batched `updateDocument` call per IMPORT_COMMIT_GROUPS entry, in that
 * dependency order, so cross-document references always point at something already
 * committed (or, within the same group's batch, committed in the same call). Used to
 * bootstrap a fresh database or restore state from the git-tracked snapshot rather than
 * from a TerminusDB backup — see Aperas-architecture.md §5.
 *
 * A commit is only worth what it changes — before writing a given group, each of its
 * classes' content hash (`hashDocSet`, the same idempotency check `client.ts` already uses
 * for schema apply) is compared against what's already live; the whole group is skipped
 * (no TerminusDB commit at all) only when every class in it is unchanged. When any one
 * class in a multi-class group (`BlockNode`+`Link`) did change, the *other* class is still
 * included in that same commit even if unchanged itself — safe (upserting identical
 * content is a no-op) and necessary on a from-empty bootstrap, where splitting them would
 * reintroduce the forward-reference failure the grouping exists to avoid.
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
  for (const group of IMPORT_COMMIT_GROUPS) {
    const instancesByType: Record<string, any[]> = {};
    let anyChanged = false;

    for (const type of group) {
      const docs: any[] = JSON.parse(readFileSync(join(dir, `${type}.jsonld`), 'utf-8'));
      const instances = docs.filter((d) => d['@type'] !== '@context');
      counts[type] = instances.length;
      instancesByType[type] = instances;

      if (instances.length === 0) {
        skipped.push(type);
        continue;
      }
      const existing = await fetchInstances(client, type);
      if (existing.length > 0 && hashDocSet(existing) === hashDocSet(instances)) {
        skipped.push(type);
      } else {
        anyChanged = true;
      }
    }

    if (!anyChanged) continue;
    const combined = group.flatMap((type) => instancesByType[type]);
    if (combined.length === 0) continue;

    await client.updateDocument(
      combined,
      {},
      client.db(),
      `Import ${group.join(' + ')} from AperasKG/Apeiron/`,
      undefined,
      undefined,
      undefined,
      true
    );
  }

  return { dir, counts, skipped };
}
