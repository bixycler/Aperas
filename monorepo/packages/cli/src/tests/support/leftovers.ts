// What a refused command may leave behind, read three ways (design/core.md, "A refused command leaves nothing behind"): the census of live blocks that no container lists
// (a block made by the command, hydrated, and never placed), the dump of the whole graph (every document of every kind, as a flush writes them), and the same dump after a flush
// to a scratch root and a reload from it. A test takes `mark(store)` before the refused call and `assertNothingLeft(store, mark, why)` after it.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '@aperas/core/shell/db';
import { openDb } from '@aperas/core/shell/db';
import { dumpDocuments, dumpMirror } from '@aperas/core/shell/mirrorDump';

/** The live nodes of the block kinds (`BlockNode`, `ArtifactNode`, `FolderNode`) of every graph that no container lists, apart from the artifacts and the folders that stand at the top of the tree. */
export function parentless(store: Db): string[] {
  const marker = store.engine.schema.roles.tombstone;
  const out: string[] = [];
  for (const graph of store.graphs) {
    for (const id of store.engine.idsOfKind(graph, 'BlockNode')) {
      if (!id.startsWith('BlockNode:')) continue;
      if (marker !== undefined && store.engine.first(graph, id, marker) !== undefined) continue;
      const listed = store.graphs.some((g) => store.engine.subjectsOf(g, 'children', id).length > 0);
      if (!listed) out.push(id);
    }
  }
  return out.sort();
}

/** The ids of every record of every kind in every graph, sorted: what exists, whether a container lists it or not. */
export function recordIds(store: Db): string[] {
  const ids = new Set<string>();
  for (const graph of store.graphs) for (const kind of store.engine.schema.kinds) for (const id of store.engine.idsOfKind(graph, kind.name)) ids.add(id);
  return [...ids].sort();
}

/** Every document of every kind in every graph, as the dump writes it, as one text. */
export function graphDump(store: Db): string {
  const parts: string[] = [];
  for (const { graph, kind } of store.mapping) parts.push(`${graph} ${kind}\n${JSON.stringify(dumpDocuments(store.engine, graph, kind, store.graphs))}`);
  return parts.join('\n');
}

/** The graph dump of a fresh handle opened on a mirror that this one was flushed to: what a reload of the flushed files shows. */
export function reloadedDump(store: Db): string {
  const root = mkdtempSync(join(tmpdir(), 'aperas-leftovers-'));
  try {
    dumpMirror(store.engine, root, store.mapping);
    const { db, load } = openDb(join(root, 'Apeiron'));
    assert.deepEqual([load.rejected, load.errors], [[], []], 'the flushed mirror loads in full');
    return graphDump(db);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export interface Mark { dump: string; reloaded: string; parentless: string[]; ids: string[] }

/** The state to compare a refused call against. */
export function mark(store: Db): Mark {
  return { dump: graphDump(store), reloaded: reloadedDump(store), parentless: parentless(store), ids: recordIds(store) };
}

/**
 * After a call that threw in the middle of a change to nodes that were there already (an ingestion that fails after it has written the artifact's own fields): no record that was not at the
 * mark, no live block without a container, and the flush-and-reload shows the memory. What the call changed in the nodes of the mark stays, so the dump is not compared with the mark's.
 */
export function assertNoRecordsLeft(store: Db, before: Mark, why: string): void {
  assert.deepEqual(recordIds(store), before.ids, `${why}: records the refused call made are still there`);
  assert.deepEqual(parentless(store), before.parentless, `${why}: live blocks with no container`);
  assert.equal(reloadedDump(store), graphDump(store), `${why}: the flushed and reloaded graph differs from the memory`);
}

/** After a refused call: no live block without a container beyond those at the mark, the graph dump is the one at the mark, and a flush followed by a reload shows the same. */
export function assertNothingLeft(store: Db, before: Mark, why: string): void {
  assert.deepEqual(recordIds(store), before.ids, `${why}: records the refused call made are still there`);
  assert.deepEqual(parentless(store), before.parentless, `${why}: live blocks with no container`);
  assert.equal(graphDump(store), before.dump, `${why}: the graph dump changed`);
  assert.equal(reloadedDump(store), before.reloaded, `${why}: the flushed and reloaded graph differs`);
}
