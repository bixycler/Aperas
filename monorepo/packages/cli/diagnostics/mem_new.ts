// The memory and the time of the new engine in one process (planning/core.md, Batch 13, piece 6): the load, ten cycles of dump, sweeps and link integrity, and
// a loop of reloads, with `gc()` before every reading (the loop is `mem_common.ts`).
//
//   node --expose-gc --import tsx packages/cli/diagnostics/mem_new.ts <graph-root> <dump-dir> [cycles=10] [reloads=15]
//
// `<graph-root>` holds the migrated `Apeiron/` (and `Apeiron/.state/`) and `artifacts/`; the sweeps of artifacts and of folders read `artifacts/` through
// `APERAS_ARTIFACTS_ROOT`, which this script sets to `<graph-root>/artifacts`. The mapping is the default table with relative directories, so that the dump goes
// to `<dump-dir>` and never over the mirror. Reads `<graph-root>`, writes `<dump-dir>` and nothing else. The sweeps are those the service runs
// (`tombstoneVacuousContainers` and `sweepTombstones` at a boundary, `trackAllArtifacts` and `ingestFolderTree` for `track`/`ingest`); the reload is `openDb`,
// the swap and `closeDb` of the old handle, as `reloadStore` does. It lives outside `src/` and the bundle.
import { resolve } from 'node:path';
import { MAIN_GRAPH, THREADS_GRAPH, VIEWS_GRAPH, type GraphSettings } from '@aperas/core/graphConfig';
import { closeDb, openDb, type Db } from '@aperas/core/shell/db';
import { dumpMirror } from '@aperas/core/shell/mirrorDump';
import { trackAllArtifacts } from '@aperas/core/shell/artifacts';
import { ingestFolderTree } from '@aperas/core/shell/folders';
import { checkLinkIntegrity } from '@aperas/core/shell/linkIntegrity';
import { sweepTombstones, tombstoneVacuousContainers } from '@aperas/core/shell/node';
import { runSeries, type Adapter } from './mem_common';

const [rootArg, dumpArg, cyclesArg, reloadsArg] = process.argv.slice(2);
if (rootArg === undefined || dumpArg === undefined) {
  console.error('usage: mem_new.ts <graph-root> <dump-dir> [cycles] [reloads]');
  process.exit(2);
}
const root = resolve(rootArg);
process.env.APERAS_ARTIFACTS_ROOT = resolve(root, 'artifacts');

const settings: GraphSettings[] = [
  { graph: MAIN_GRAPH, directory: 'Apeiron', flushIntervalMs: 10_000 },
  { graph: THREADS_GRAPH, directory: 'Apeiron/.state', flushIntervalMs: 3_000 },
  { graph: VIEWS_GRAPH, directory: 'Apeiron/.state', flushIntervalMs: 3_000 },
];

const adapter: Adapter<Db> = {
  engine: 'new (js-apeironngn)',
  load: (r) => {
    const opened = openDb(r, settings);
    if (opened.load.errors.length > 0 || opened.load.rejected.length > 0) throw new Error(`the load was not in full: ${opened.load.errors.length} errors, ${opened.load.rejected.length} rejected`);
    return opened.db;
  },
  dump: (db, dir) => { dumpMirror(db.engine, dir, db.mapping); },
  sweeps: [
    { name: 'vacuous', run: (db) => tombstoneVacuousContainers(db) },
    { name: 'tombstone', run: (db) => sweepTombstones(db) },
    { name: 'artifact', run: (db) => { const r = trackAllArtifacts(db, false); return { tracked: r.results.filter((x) => x.tracked).length, results: r.results.length, ...r.sweep, pending: r.pendingRemovals.length }; } },
    { name: 'folder', run: (db) => { const r = ingestFolderTree(db, false); return { folders: r.folderCount, ...r.sweep, pending: r.pendingRemovals.length }; } },
  ],
  links: (db) => checkLinkIntegrity(db),
  release: (db) => { closeDb(db); },
};

await runSeries(adapter, { engine: adapter.engine, root, dumpDir: resolve(dumpArg), cycles: Number(cyclesArg ?? 10), reloads: Number(reloadsArg ?? 15) });
