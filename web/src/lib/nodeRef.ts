/**
 * Aperas node addressing (Aperas-basic-assertion-skill-design.md §2): direct addressing (a full
 * node id, or a bare snowflake code — see directResolve.ts) vs. query-based addressing (an
 * artifact/folder path). Used by `kgCli.ts` for CLI addressing.
 */

import { getArtifactRecord } from './artifacts';
import { getFolderRecord } from './folders';
import { resolveDirectOrSnowflake } from './directResolve';

/**
 * Resolves a reference to a full node id, or `null` if nothing matches — never throws, so
 * callers decide whether a miss is fatal (CLI usage exits) or best-effort.
 */
export async function resolveNodeRefOrNull(client: any, ref: string): Promise<string | null> {
  const direct = await resolveDirectOrSnowflake(client, ref);
  if (direct) return direct;

  const artifact = await getArtifactRecord(client, ref);
  if (artifact) return `ArtifactNode/${artifact.artifactId}`;
  const folder = await getFolderRecord(client, ref);
  if (folder) return `FolderNode/${folder.folderId}`;
  return null;
}
