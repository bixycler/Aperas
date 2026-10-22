// What the files of a mirror say about tombstones and containment (design/core.md, "Tombstones"): a tombstone is in no `children` list. Reads the text of the
// content files as a flush writes them, so the claim is about the file and not about the memory it came from.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const KINDS = ['ArtifactNode', 'BlockNode', 'FolderNode'] as const;

type Doc = { '@id': string; tombstonedAt?: string; children?: Array<string | { '@id': string }> };

/** Reads the three content files under `apeironRoot` and tells which records are tombstones and which of them a `children` list still names (as `host -> item`). */
export function tombstonesInLists(apeironRoot: string): { tombstones: string[]; inLists: string[]; listed: number } {
  const docs: Doc[] = KINDS.flatMap((kind) => JSON.parse(readFileSync(join(apeironRoot, `${kind}.jsonld`), 'utf-8')) as Doc[]);
  const tombstones = docs.filter((d) => d.tombstonedAt !== undefined).map((d) => d['@id']);
  const dead = new Set(tombstones);
  const inLists: string[] = [];
  let listed = 0;
  for (const doc of docs) {
    for (const item of doc.children ?? []) {
      const id = typeof item === 'string' ? item : item['@id'];
      listed += 1;
      if (dead.has(id)) inLists.push(`${doc['@id']} -> ${id}`);
    }
  }
  return { tombstones, inLists, listed };
}
