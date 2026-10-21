// A copy of the real mirror for the corpus checks. The corpus checks need the real data's size and shape for
// their meaning, so they read the real `Apeiron/` directory once, into scratch roots, and work on the copy:
// nothing in a test reads or writes the real mirror in place, and `makeFixtureStore` keeps refusing the real
// roots. The copy is the mirror as it is on disk, which lags the service's memory by up to its flush interval.
// The copy is migrated by the six rules of `scripts/migrate-mirror.py` (run on the copy, never on the real mirror): the load of the engine
// cannot read a mirror that has not been migrated.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDb, type Db } from '@aperas/core/shell/db';
import type { LoadResult } from '@aperas/core/shell/mirrorLoad';
import { REAL_GRAPH, assertNotRealMirror } from './fixture.ts';

const MIGRATE = resolve(import.meta.dirname, '../../../../../scripts/migrate-mirror.py');

export interface CorpusCopy {
  /** The migrated copy, loaded: the whole mirror in a handle. */
  store: Db;
  /** The result of the load: documents and embedded entries built, and what it rejected or refused. */
  load: LoadResult;
  /** The records built: the documents and the embedded entries. */
  recordCount: number;
  documentCount: number;
  danglingRefs: string[];
  /** The scratch directory holding the copy's `Apeiron/` and an empty `artifacts/`. */
  root: string;
  apeironRoot: string;
  artifactsRoot: string;
  /** The real mirror's `Apeiron/` directory the copy was made from (read only). */
  sourceApeironRoot: string;
  /** Removes the scratch directory and unsets the two root variables; safe to call twice. */
  cleanup: () => void;
}

/**
 * Copies the real `Apeiron/` (content mirror and `.state/`) into a fresh scratch directory, migrates the copy, points
 * `APERAS_APEIRON_ROOT` and `APERAS_ARTIFACTS_ROOT` at the copy and an empty artifacts directory for this process
 * only, and loads the copy. The real files are only read. `cleanup()` removes the scratch directory and
 * also runs on process exit. Refuses to run when a scratch root would be inside the real mirror.
 */
export function makeCorpusCopy(): CorpusCopy {
  const sourceApeironRoot = join(REAL_GRAPH, 'Apeiron');
  if (!existsSync(sourceApeironRoot)) throw new Error(`No real mirror to copy: ${sourceApeironRoot} does not exist.`);
  const root = mkdtempSync(join(tmpdir(), 'aperas-corpus-'));
  const apeironRoot = join(root, 'Apeiron');
  const artifactsRoot = join(root, 'artifacts');
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    delete process.env.APERAS_APEIRON_ROOT;
    delete process.env.APERAS_ARTIFACTS_ROOT;
    rmSync(root, { recursive: true, force: true });
  };
  try {
    assertNotRealMirror(root);
    assertNotRealMirror(apeironRoot);
    assertNotRealMirror(artifactsRoot);
    cpSync(sourceApeironRoot, apeironRoot, { recursive: true, dereference: true });
    const migrated = spawnSync('python3', [MIGRATE, root], { encoding: 'utf8' });
    if (migrated.status !== 0) throw new Error(`migrate-mirror.py exited ${migrated.status}: ${migrated.stdout}${migrated.stderr}`);
    mkdirSync(artifactsRoot, { recursive: true });
    process.env.APERAS_APEIRON_ROOT = apeironRoot;
    process.env.APERAS_ARTIFACTS_ROOT = artifactsRoot;
    const { db, load } = openDb(apeironRoot);
    process.once('exit', cleanup);
    return { store: db, load, recordCount: load.documents + load.embedded, documentCount: load.documents, danglingRefs: [...load.dangling], root, apeironRoot, artifactsRoot, sourceApeironRoot, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}
