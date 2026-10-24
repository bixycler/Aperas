// The memory and the time of the reference engine (`Aperas/` at its `HEAD`, the Oxigraph engine with the `free()` patch) in one process (planning/core.md,
// Batch 13, piece 6): the same loop as `mem_new.ts` (`mem_common.ts`) over the code of `Aperas/`, imported by path and never written to.
//
//   node --expose-gc --import tsx packages/cli/diagnostics/mem_ref.ts <graph-root> <dump-dir> [cycles=10] [reloads=15]
//
// `<graph-root>` holds the old-format `Apeiron/` (and `Apeiron/.state/`) and `artifacts/`; `APERAS_REF_ROOT` names the `monorepo/` of the reference (default
// `/home/will/source/Aperas/monorepo`). The modules are imported with a dynamic `import()` of their paths; each of them resolves its own `@aperas/core/...`
// and `oxigraph` from the `node_modules` beside it, so nothing of `Aperas.dev` mixes in. The sweeps are those the service runs (`tombstoneVacuousContainers`,
// `pruneUnreachableTombstones` and `pruneStaleUnfolds` at a boundary, `trackAllArtifacts` and `ingestFolderTree` for `track`/`ingest`); the reload is
// `rehydrateStore` and the old store dropped, as `reloadStore` does. Reads `<graph-root>` and `Aperas/`, writes `<dump-dir>` and nothing else. It lives outside
// `src/` and the bundle.
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { runSeries, type Adapter } from './mem_common';

const [rootArg, dumpArg, cyclesArg, reloadsArg] = process.argv.slice(2);
if (rootArg === undefined || dumpArg === undefined) {
  console.error('usage: mem_ref.ts <graph-root> <dump-dir> [cycles] [reloads]');
  process.exit(2);
}
const root = resolve(rootArg);
process.env.APERAS_ARTIFACTS_ROOT = resolve(root, 'artifacts');
const ref = resolve(process.env.APERAS_REF_ROOT ?? '/home/will/source/Aperas/monorepo', 'packages/core/src');

/* eslint-disable @typescript-eslint/no-explicit-any */
const store: any = await import(`${ref}/apeironNgn/store.ts`);
const dehydrate: any = await import(`${ref}/apeironNgn/dehydrate.ts`);
const node: any = await import(`${ref}/apeironNgn/node.ts`);
const artifacts: any = await import(`${ref}/apeironNgn/artifacts.ts`);
const folders: any = await import(`${ref}/apeironNgn/folders.ts`);
const integrity: any = await import(`${ref}/apeironNgn/linkIntegrity.ts`);

const apeiron = (r: string): string => resolve(r, 'Apeiron');

const adapter: Adapter<any> = {
  engine: 'reference (Aperas oxigraph)',
  load: (r) => {
    const result = store.rehydrateStore(apeiron(r), resolve(apeiron(r), '.state'));
    return result.store;
  },
  dump: (s, dir) => {
    const content = resolve(dir, 'Apeiron');
    const state = resolve(content, '.state');
    mkdirSync(state, { recursive: true });
    dehydrate.dehydrateToJsonLd(s, content);
    dehydrate.dehydrateStateToJsonLd(s, state);
  },
  sweeps: [
    { name: 'vacuous', run: (s) => node.tombstoneVacuousContainers(s) },
    { name: 'tombstone', run: (s) => node.pruneUnreachableTombstones(s) },
    { name: 'unfolds', run: (s) => node.pruneStaleUnfolds(s) },
    { name: 'artifact', run: (s) => { const r = artifacts.trackAllArtifacts(s, false); return { tracked: r.results.filter((x: any) => x.tracked).length, results: r.results.length, ...r.sweep, pending: r.pendingRemovals.length }; } },
    { name: 'folder', run: (s) => { const r = folders.ingestFolderTree(s, false); return { folders: r.folderCount, ...r.sweep, pending: r.pendingRemovals.length }; } },
  ],
  links: (s) => integrity.checkLinkIntegrity(s),
  release: () => { /* the service drops the old store and lets the collector and the finalizers take it */ },
};

await runSeries(adapter, { engine: adapter.engine, root, dumpDir: resolve(dumpArg), cycles: Number(cyclesArg ?? 10), reloads: Number(reloadsArg ?? 15) });
