// Loads a mirror with the new engine and dumps it, in a child process of the cutover rehearsal (`scripts/cutover-rehearsal.py`).
//
//   tsx packages/cli/diagnostics/mirror_loaddump.ts <graph-root> <dump-dir>
//
// `<graph-root>` holds `Apeiron/` (and `Apeiron/.state/`); the load is the shell's own (`loadMirror` over the mapping that the default table of
// settings gives, with relative directories), the dump goes to `<dump-dir>` through `dumpMirror` under the same mapping. Reads the first, writes
// the second and nothing else. Prints one line of JSON on stdout: the files of the mapping, the counts of the load and the times of the load and
// of the dump in milliseconds. It always exits 0 once it has loaded; a file that is not a JSON array stops the load (status 1, the message on
// stderr). It lives outside `src/` and the bundle, as the sampler does.
import { performance } from 'node:perf_hooks';
import { MAIN_GRAPH, THREADS_GRAPH, VIEWS_GRAPH } from '@aperas/core/graphConfig';
import { createEngine } from '@aperas/core/apeironNgn/engine';
import { APERAS_SCHEMA } from '@aperas/core/shell/aperasSchema';
import { dumpMirror } from '@aperas/core/shell/mirrorDump';
import { mirrorMapping } from '@aperas/core/shell/mirrorFiles';
import { loadMirror } from '@aperas/core/shell/mirrorLoad';

const [root, dumpDir] = process.argv.slice(2);
if (root === undefined || dumpDir === undefined) {
  console.error('usage: mirror_loaddump.ts <graph-root> <dump-dir>');
  process.exit(2);
}

const mapping = mirrorMapping([
  { graph: MAIN_GRAPH, directory: 'Apeiron', flushIntervalMs: 10_000 },
  { graph: THREADS_GRAPH, directory: 'Apeiron/.state', flushIntervalMs: 3_000 },
  { graph: VIEWS_GRAPH, directory: 'Apeiron/.state', flushIntervalMs: 3_000 },
]);

const engine = createEngine(APERAS_SCHEMA);
const t0 = performance.now();
const load = loadMirror(engine, root, mapping);
const t1 = performance.now();
dumpMirror(engine, dumpDir, mapping);
const t2 = performance.now();

console.log(JSON.stringify({
  files: mapping.map((m) => m.file),
  documents: load.documents,
  embedded: load.embedded,
  errors: load.errors.length,
  warnings: load.warnings.length,
  rejected: load.rejected.length,
  dangling: load.dangling.length,
  firstProblems: [...load.errors.map((e) => `${e.subject}: ${e.message}`), ...load.warnings, ...load.rejected.map((r) => `rejected ${r.id}`), ...load.dangling.map((d) => `dangling ${d}`)].slice(0, 5),
  loadMs: Math.round(t1 - t0),
  dumpMs: Math.round(t2 - t1),
}));
