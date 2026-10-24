// The measuring loop of `mem_new.ts` and `mem_ref.ts` (planning/core.md, Batch 13, piece 6): the memory and the time of the load, of the dump, of the sweeps and of
// the link integrity, in one process, for one engine. Run with `node --expose-gc` through `tsx` (see the two scripts); it lives outside `src/` and the bundle, as
// the sampler does, and no suite runs it.
//
// The loop is the same for both engines; an adapter says how an engine loads, dumps, sweeps and checks, and nothing in this file knows an engine:
//   1. a reading of the process after the imports;
//   2. the load: its time, then the reading (`gc()`, a pause of 50 ms, `gc()`, a pause, `gc()`, `process.memoryUsage()`);
//   3. `cycles` cycles: the dump, each sweep and the link integrity, each timed, then a reading;
//   4. `reloads` reloads: a new handle is loaded, swapped in and the old one released (what the service's reload does), each timed, then a reading.
// A reading is taken after two pauses of 50 ms of the event loop because the wasm objects the Oxigraph engine leaves to a finalizer are freed only when the loop runs its tasks, and a store the reload replaced was still counted when the pause was a `setImmediate` turn. The
// load average (`os.loadavg()`, the file `uptime` reads) is recorded at the start and at the end of each series. Prints one JSON document on stdout and the tables
// on stderr; the console output of the engine's own sweeps is counted and not printed.
import { writeSync } from 'node:fs';
import { loadavg } from 'node:os';
import { performance } from 'node:perf_hooks';

/** One engine as the loop drives it. `H` is its handle. */
export interface Adapter<H> {
  readonly engine: string;
  /** Loads the mirror at the graph root (the files of `Apeiron/` and `Apeiron/.state/`). */
  load(root: string): H;
  /** Writes the whole mirror under `dumpDir`. */
  dump(handle: H, dumpDir: string): void;
  /** The sweeps, in the order of a cycle; each gives a small summary (counts) that is recorded. */
  readonly sweeps: readonly { readonly name: string; run(handle: H): unknown }[];
  /** The link-integrity check of the whole corpus. */
  links(handle: H): unknown;
  /** Lets go of a handle that a reload replaced. */
  release(handle: H): void;
}

export interface Reading { rssMB: number; heapUsedMB: number; heapTotalMB: number; externalMB: number; arrayBuffersMB: number }
export interface Load { one: number; five: number; fifteen: number }

const MB = 1024 * 1024;
/** The pause of a reading between two `gc()`: the collector hands the finalizers of freed objects to the event loop as tasks, and a `setImmediate` turn was found not to run them (a replaced store was still counted in the reading after a reload), a timer does. */
const PAUSE_MS = 50;
const r1 = (n: number): number => Math.round(n * 10) / 10;
const r2 = (n: number): number => Math.round(n * 100) / 100;

function gcFunction(): () => void {
  const g = (globalThis as { gc?: () => void }).gc;
  if (typeof g !== 'function') {
    console.error('run with node --expose-gc (through tsx: `node --expose-gc --import tsx <script>`)');
    process.exit(2);
  }
  return g;
}

/** `gc()`, a pause of the event loop for the finalizers, `gc()`, another pause, `gc()`, then the reading in megabytes. */
export async function reading(): Promise<Reading> {
  const gc = gcFunction();
  gc();
  await new Promise<void>((done) => setTimeout(done, PAUSE_MS));
  gc();
  await new Promise<void>((done) => setTimeout(done, PAUSE_MS));
  gc();
  const m = process.memoryUsage();
  return { rssMB: r1(m.rss / MB), heapUsedMB: r1(m.heapUsed / MB), heapTotalMB: r1(m.heapTotal / MB), externalMB: r1(m.external / MB), arrayBuffersMB: r1(m.arrayBuffers / MB) };
}

/** One line of JSON on stderr as it happens, so that a crash of the process leaves what was measured before it. */
const progress = (event: string, data: unknown): void => { writeSync(2, JSON.stringify({ event, ...(data as object) }) + '\n'); };

const load = (): Load => { const [one, five, fifteen] = loadavg(); return { one: r2(one!), five: r2(five!), fifteen: r2(fifteen!) }; };

/** Times a call; the console output inside it is counted and dropped. */
function timed<T>(fn: () => T, silenced: { lines: number }): { ms: number; value: T } {
  const log = console.log, info = console.info, warn = console.warn;
  const drop = (): void => { silenced.lines++; };
  console.log = drop; console.info = drop; console.warn = drop;
  const t0 = performance.now();
  try {
    const value = fn();
    return { ms: performance.now() - t0, value };
  } finally {
    console.log = log; console.info = info; console.warn = warn;
  }
}

const summary = (value: unknown): unknown => {
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') out[k] = v;
    else if (Array.isArray(v)) out[`${k}.length`] = v.length;
    else if (v !== null && typeof v === 'object') out[k] = summary(v);
  }
  return out;
};

export interface CycleRecord { cycle: number; dumpMs: number; sweepMs: Record<string, number>; linksMs: number; cycleMs: number; after: Reading; sweepResults: Record<string, unknown>; linksResult: unknown }
export interface ReloadRecord { reload: number; loadMs: number; releaseMs: number; reloadMs: number; after: Reading }
export interface Options { engine: string; root: string; dumpDir: string; cycles: number; reloads: number }

export async function runSeries<H>(adapter: Adapter<H>, o: Options): Promise<void> {
  gcFunction();
  const silenced = { lines: 0 };
  const loadStart = load();
  const afterImports = await reading();

  const t0 = performance.now();
  const held: { h: H | undefined } = { h: adapter.load(o.root) };
  const loadMs = performance.now() - t0;
  const afterLoad = await reading();
  progress('load', { ms: Math.round(loadMs), load: loadStart, after: afterLoad });

  const cycles: CycleRecord[] = [];
  for (let c = 1; c <= o.cycles; c++) {
    const start = performance.now();
    // With `APERAS_MEM_STEPS=1` the first cycle takes a reading after every step, to say which step the memory of the cycle comes from (the times of that cycle are then longer).
    const steps = process.env.APERAS_MEM_STEPS === '1' && c === 1;
    const stepReadings: Record<string, Reading> = {};
    const dump = timed(() => adapter.dump(held.h!, o.dumpDir), silenced);
    if (steps) stepReadings.dump = await reading();
    const sweepMs: Record<string, number> = {};
    const sweepResults: Record<string, unknown> = {};
    for (const s of adapter.sweeps) {
      const r = timed(() => s.run(held.h!), silenced);
      sweepMs[s.name] = r.ms;
      sweepResults[s.name] = summary(r.value);
      if (steps) stepReadings[s.name] = await reading();
    }
    const links = timed(() => adapter.links(held.h!), silenced);
    if (steps) { stepReadings.links = await reading(); progress('steps', { cycle: c, stepReadings }); }
    const cycleMs = performance.now() - start;
    cycles.push({ cycle: c, dumpMs: dump.ms, sweepMs, linksMs: links.ms, cycleMs, after: await reading(), sweepResults, linksResult: summary(links.value) });
    progress('cycle', { ...cycles[cycles.length - 1]!, load: load() });
  }
  const loadMid = load();

  const reloads: ReloadRecord[] = [];
  /** One reload as the service does it: load a new handle, swap it in and release the old. The old handle lives only in this function's frame, so that nothing holds it when the reading is taken. */
  const reload = (): { loadMs: number; releaseMs: number; reloadMs: number } => {
    const s0 = performance.now();
    const next = adapter.load(o.root);
    const s1 = performance.now();
    const old = held.h!;
    held.h = next;
    adapter.release(old);
    const s2 = performance.now();
    return { loadMs: s1 - s0, releaseMs: s2 - s1, reloadMs: s2 - s0 };
  };
  for (let i = 1; i <= o.reloads; i++) {
    const timing = reload();
    reloads.push({ reload: i, ...timing, after: await reading() });
    progress('reload', { ...reloads[reloads.length - 1]!, load: load() });
  }
  // Three readings with nothing running, then the last handle let go and one more reading: whether what stays after the loop is garbage the collector has not yet found or is held.
  const settle: Reading[] = [];
  for (let i = 0; i < 3; i++) settle.push(await reading());
  if (reloads.length > 0 || cycles.length > 0) { adapter.release(held.h!); held.h = undefined; }
  const afterRelease = await reading();
  progress('settle', { settle, afterRelease });
  const loadEnd = load();

  const record = {
    engine: adapter.engine,
    root: o.root,
    node: process.version,
    cycles: o.cycles,
    reloads: o.reloads,
    loadAverage: { start: loadStart, afterCycles: loadMid, end: loadEnd },
    afterImports,
    load: { ms: Math.round(loadMs), after: afterLoad },
    cycleRecords: cycles,
    reloadRecords: reloads,
    settle,
    afterRelease,
    silencedConsoleLines: silenced.lines,
  };
  console.log(JSON.stringify(record));
  printTables(record, adapter.sweeps.map((s) => s.name));
}

const pad = (s: string | number, n: number): string => String(s).padStart(n);
const ms = (n: number): number => Math.round(n);

function printTables(rec: { engine: string; loadAverage: { start: Load; afterCycles: Load; end: Load }; afterImports: Reading; load: { ms: number; after: Reading }; cycleRecords: CycleRecord[]; reloadRecords: ReloadRecord[] }, sweeps: string[]): void {
  const out = (line: string): void => { process.stderr.write(line + '\n'); };
  out(`engine ${rec.engine}   load average (1/5/15 min) start ${rec.loadAverage.start.one}/${rec.loadAverage.start.five}/${rec.loadAverage.start.fifteen}  after cycles ${rec.loadAverage.afterCycles.one}  end ${rec.loadAverage.end.one}/${rec.loadAverage.end.five}/${rec.loadAverage.end.fifteen}`);
  const a = rec.afterImports, l = rec.load.after;
  out(`after imports: rss ${a.rssMB} heap ${a.heapUsedMB}   after load (${rec.load.ms} ms): rss ${l.rssMB} heapUsed ${l.heapUsedMB} external ${l.externalMB} arrayBuffers ${l.arrayBuffersMB}`);
  out(['cycle', 'dump', ...sweeps, 'links', 'total', 'rss', 'heap', 'ext'].map((h, i) => pad(h, i === 0 ? 5 : Math.max(7, h.length + 1))).join(' '));
  for (const c of rec.cycleRecords) {
    out([c.cycle, ms(c.dumpMs), ...sweeps.map((s) => ms(c.sweepMs[s]!)), ms(c.linksMs), ms(c.cycleMs), c.after.rssMB, c.after.heapUsedMB, c.after.externalMB].map((v, i) => pad(v, i === 0 ? 5 : Math.max(7, (['x', 'dump', ...sweeps, 'links', 'total', 'rss', 'heap', 'ext'][i] ?? '').length + 1))).join(' '));
  }
  out(['reload', 'load', 'release', 'total', 'rss', 'heap', 'ext'].map((h) => pad(h, 8)).join(' '));
  for (const r of rec.reloadRecords) out([r.reload, ms(r.loadMs), ms(r.releaseMs), ms(r.reloadMs), r.after.rssMB, r.after.heapUsedMB, r.after.externalMB].map((v) => pad(v, 8)).join(' '));
}
