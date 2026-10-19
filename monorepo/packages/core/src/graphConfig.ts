/**
 * `aperas.config.json` discovery (AperasKG/artifacts/design/packaging.md's Configuration section):
 * a shared, committed file describing one graph's place in a tree (corp > teams > members, each
 * mergeable into its parent). Found by walking up from a starting directory the same way `git`
 * finds `.git` — the nearest one wins, so a member's own graph is found before its team's, a
 * team's before its corp's, etc.
 *
 * Deliberately minimal: this module only resolves `graph`/`parent` pointers into absolute paths
 * (or leaves `parent` as a URL untouched) — it doesn't walk up into the parent itself, or implement
 * anything about what "merge into the parent" means. That's a separate, later design (AperasKG/
 * artifacts/discussion/packaging.md's "Settled: graph discovery..." note) — this is just enough to
 * make one level of the tree discoverable and point at the next.
 *
 * `getArtifactsDir()`/`getApeironExportDir()` (`artifacts.ts`/`shell/store.ts`) both fall back
 * to their own hardcoded, hop-counted path when no `aperas.config.json` is found anywhere above the
 * starting directory — this repo's own dev setup is deliberately left config-free, relying on that
 * fallback, so this migration doesn't force every existing checkout to add a config file just to
 * keep working.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isGraphName } from './apeironNgn/graphName';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILENAME = 'aperas.config.json';

export interface GraphConfig {
  /** Absolute path to this graph's Apeiron root (the JSON-LD mirror). */
  apeironRoot: string;
  /** Absolute path to this graph's artifacts root (the markdown tree). */
  artifactsRoot: string;
  /** The parent graph this one is meant to eventually merge into — a path (resolved absolute,
   *  relative to the config file's own directory) or a URL, verbatim; `undefined` for a root
   *  graph (e.g. the corp level) with nothing above it. Not walked or dereferenced here. */
  parent?: string;
  /** Human-readable display name for this graph (e.g. the webapp's `<h1>` and page title). */
  name?: string;
  /** Live-block-count cap for a `.threads/`-scoped artifact (design/aperas-skill.md's Threads),
   *  past which every further write to it reports a warning until it's pruned. `undefined` when
   *  unset in config — `resolveEffectiveThreadSizeCap`'s hardcoded default applies then. */
  threadSizeCap?: number;
  /** Where `aperas.config.json` itself was found — mostly for diagnostics/error messages. */
  configPath: string;
}

/** `graph` takes either shape: a plain path (shorthand — both `artifacts/` and `Apeiron/`
 *  co-located directly under it) or an explicit `{ apeiron, artifacts }` pair, for a graph whose
 *  data and markdown tree aren't co-located (AperasKG/artifacts/discussion/packaging.md's
 *  "Resolved: two-path graph config..." note). */
interface RawGraphConfig {
  graph: string | { apeiron: string; artifacts: string };
  parent?: string;
  name?: string;
  threadSizeCap?: number;
}

function isUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

function findConfigFile(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parentDir = dirname(dir);
    if (parentDir === dir) return null; // reached the filesystem root
    dir = parentDir;
  }
}

/**
 * Walks up from `startDir` (default: `process.cwd()`) looking for `aperas.config.json`, returning
 * `null` if none is found anywhere above it (the caller's own hardcoded fallback applies then).
 * Throws on a found-but-unreadable/malformed file — a config that exists but can't be parsed
 * should never silently fall back to the wrong graph.
 */
export function resolveGraphConfig(startDir: string = process.cwd()): GraphConfig | null {
  const configPath = findConfigFile(startDir);
  if (!configPath) return null;

  let raw: RawGraphConfig;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (err: any) {
    throw new Error(`${configPath} isn't valid JSON: ${err.message || err}`);
  }

  const configDir = dirname(configPath);
  let apeironRoot: string;
  let artifactsRoot: string;
  if (typeof raw.graph === 'string' && raw.graph.length > 0) {
    const graphRoot = resolve(configDir, raw.graph);
    apeironRoot = resolve(graphRoot, 'Apeiron');
    artifactsRoot = resolve(graphRoot, 'artifacts');
  } else if (raw.graph && typeof raw.graph === 'object' && raw.graph.apeiron && raw.graph.artifacts) {
    apeironRoot = resolve(configDir, raw.graph.apeiron);
    artifactsRoot = resolve(configDir, raw.graph.artifacts);
  } else {
    throw new Error(
      `${configPath}'s "graph" field must be either a path (shorthand for co-located artifacts/Apeiron) ` +
      `or an { "apeiron": "...", "artifacts": "..." } pair.`
    );
  }

  const parent = raw.parent === undefined
    ? undefined
    : (isUrl(raw.parent) ? raw.parent : resolve(configDir, raw.parent));

  const name = typeof raw.name === 'string' ? raw.name : undefined;
  const threadSizeCap = typeof raw.threadSizeCap === 'number' ? raw.threadSizeCap : undefined;

  return { apeironRoot, artifactsRoot, parent, name, threadSizeCap, configPath };
}

/** The fallback graph root when no `aperas.config.json` is found anywhere above the caller — this
 *  repo's own dev checkout, deliberately left config-free (see this file's own doc comment above).
 *  Anchored to this module's own on-disk location rather than `process.cwd()`, so it resolves the
 *  same directory no matter where a command happens to be invoked from — the same dev-vs-built
 *  branch `serviceLock.ts`/`artifacts.ts`/`shell/store.ts` used to each carry a copy of, now
 *  centralized here as the one place that does this hop-count at all. A dev checkout runs this
 *  module from its own `.ts` source under `tsx`; the built `aperas` runs it inlined into the
 *  `esbuild` bundle, a `.js` file, so the test reads this module's own URL, not any directory name. */
function resolveFallbackGraphRoot(): string {
  const isDev = import.meta.url.endsWith('.ts');
  const hops = isDev
    ? ['..', '..', '..', '..'] // packages/core/src -> core -> packages -> monorepo root -> repo root
    : ['..', '..', '..', '..']; // packages/cli/dist -> cli -> packages -> monorepo root -> repo root
  return resolve(__dirname, ...hops, 'AperasKG');
}

/**
 * Resolves the Apeiron root to actually use: `APERAS_APEIRON_ROOT` if set, else `aperas.config.json`
 * discovery from `startDir` if found, else the fixed fallback above.
 *
 * The env-var check is what lets every ordinary caller (`getApeironExportDir()`'s own default
 * parameter, called with no argument from deep inside the service — `rehydrateStore`,
 * `dehydrateToJsonLd`, etc.) resolve correctly with zero signature changes: `aperas service
 * start`/`restart` (`kgService.ts`) is the only place that ever reads `process.cwd()` for this
 * (AperasKG/artifacts/discussion/packaging.md's "Settled: no concurrency..." note), and it sets
 * this env var on the service process it spawns — every function running inside that one process,
 * however deep, sees the same already-resolved answer without needing it passed as an argument.
 * A caller that isn't `service start`/`restart` and isn't running inside a service process this
 * variable was set for should still pass an explicit `startDir` rather than relying on the
 * `process.cwd()` default baked into `resolveGraphConfig`.
 */
export function resolveEffectiveApeironRoot(startDir?: string): string {
  if (process.env.APERAS_APEIRON_ROOT) return process.env.APERAS_APEIRON_ROOT;
  const config = resolveGraphConfig(startDir);
  return config ? config.apeironRoot : resolve(resolveFallbackGraphRoot(), 'Apeiron');
}

/** Same as `resolveEffectiveApeironRoot`, for the artifacts (markdown tree) root — checks
 *  `APERAS_ARTIFACTS_ROOT` first. See that function's own doc comment for the full reasoning. */
export function resolveEffectiveArtifactsRoot(startDir?: string): string {
  if (process.env.APERAS_ARTIFACTS_ROOT) return process.env.APERAS_ARTIFACTS_ROOT;
  const config = resolveGraphConfig(startDir);
  return config ? config.artifactsRoot : resolve(resolveFallbackGraphRoot(), 'artifacts');
}

/**
 * This graph's display name (`aperas.config.json`'s "name" field), or `undefined` if none is
 * configured. Checks `APERAS_GRAPH_NAME` first, same as the two root resolvers above — and for the
 * same reason: `service.ts`'s production HTTP listener calls this with no `startDir` from *inside*
 * the long-lived service process, whose own cwd is wherever the packaged binary happens to be
 * installed, never the graph's directory. Without the env var, this would silently resolve some
 * *other* graph's name (or this repo's own fallback) rather than the one the service is actually
 * bound to — confirmed live, serving a throwaway test graph reported "AperasKG" until this was
 * added. `bindAndSpawn` (`kgService.ts`) resolves it once, correctly, from *its own* cwd (the same
 * place `apeironRoot`/`artifactsRoot` are resolved from) and passes it through `spawnService`.
 *
 * The ancestor walk alone isn't enough as a fallback, either: this repo's own dev checkout has no
 * `aperas.config.json` reachable by walking up from a typical `monorepo/`-rooted cwd, since
 * `AperasKG/` sits beside `monorepo/`, not above it (`resolveFallbackGraphRoot`'s own doc comment).
 * So when the walk finds nothing, this also checks directly beside the hardcoded fallback root —
 * the one place a config for *this* checkout could actually be sitting.
 */
export function resolveEffectiveGraphName(startDir?: string): string | undefined {
  if (process.env.APERAS_GRAPH_NAME) return process.env.APERAS_GRAPH_NAME;
  const config = resolveGraphConfig(startDir);
  if (config) return config.name;

  const fallbackConfigPath = join(resolveFallbackGraphRoot(), CONFIG_FILENAME);
  if (!existsSync(fallbackConfigPath)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(fallbackConfigPath, 'utf-8')) as RawGraphConfig;
    return typeof raw.name === 'string' ? raw.name : undefined;
  } catch {
    return undefined;
  }
}

/** Live-block-count cap for a `.threads/`-scoped artifact (design/aperas-skill.md's Threads),
 *  past which `service.ts` reports a warning on every further write to it until it's pruned. Checks
 *  `APERAS_THREAD_SIZE_CAP` first, then `aperas.config.json`'s `threadSizeCap` (walking up, and
 *  falling back to beside the fallback root, same two-step lookup `resolveEffectiveGraphName`
 *  uses), else a hardcoded default. No config file needs this field set for the warning to work. */
export function resolveEffectiveThreadSizeCap(startDir?: string): number {
  const DEFAULT_THREAD_SIZE_CAP = 200;
  if (process.env.APERAS_THREAD_SIZE_CAP) {
    const parsed = Number(process.env.APERAS_THREAD_SIZE_CAP);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const config = resolveGraphConfig(startDir);
  if (config?.threadSizeCap !== undefined) return config.threadSizeCap;

  const fallbackConfigPath = join(resolveFallbackGraphRoot(), CONFIG_FILENAME);
  if (existsSync(fallbackConfigPath)) {
    try {
      const raw = JSON.parse(readFileSync(fallbackConfigPath, 'utf-8')) as RawGraphConfig;
      if (typeof raw.threadSizeCap === 'number') return raw.threadSizeCap;
    } catch {
      // fall through to the hardcoded default
    }
  }
  return DEFAULT_THREAD_SIZE_CAP;
}

// -- The table of settings of the graphs (design/core.md, "Addressing"; planning/core.md, Batch 9 step 2) --------------------------------------
// The `graphs` key of `aperas.config.json`: an object keyed by graph name, each entry holding the directory of the graph's mirror (`mirror`)
// and its flush interval (`flushIntervalMs`). The shell has three graphs, so the table has room for those three and no other name.

/** The main graph, called `tree` until it has an identifier of its own in the configuration. */
export const MAIN_GRAPH = 'tree';
/** The graph of the thread-scoped tree nodes, a subdomain of the main graph. */
export const THREADS_GRAPH = `threads.${MAIN_GRAPH}`;
/** The graph of the views: a name of one label, because a view can index many graphs and not only the main one. */
export const VIEWS_GRAPH = 'treeviews';
/** The three graphs, in the order of the linking topology: a graph points only at the graphs before it. */
export const MIRROR_GRAPHS: readonly string[] = [MAIN_GRAPH, THREADS_GRAPH, VIEWS_GRAPH];

/** The flush interval of the main graph, and of the other two, when the table gives none. */
export const DEFAULT_MAIN_FLUSH_MS = 10_000;
export const DEFAULT_STATE_FLUSH_MS = 3_000;
/** The directory, under the main graph's, of the graphs that git ignores. */
export const STATE_DIRECTORY = '.state';

/** The settings of one graph: where its mirror is (an absolute directory) and how often it is flushed. */
export interface GraphSettings {
  readonly graph: string;
  readonly directory: string;
  readonly flushIntervalMs: number;
}

/** What the table gives: the settings of each of the three graphs in order, and the warnings the shell prints once, at start. */
export interface GraphTable {
  readonly graphs: readonly GraphSettings[];
  readonly warnings: readonly string[];
}

/** The text of the warning for a table entry keyed `tree`: the name may collide with the main graph, which has no identifier of its own. */
export const warnTreeEntry = (configPath: string): string =>
  `${configPath}: the graphs table has an entry named ${MAIN_GRAPH}; the name may collide with the main graph, which has no identifier of its own and is called ${MAIN_GRAPH} today (the entry is used)`;

/**
 * The settings of the three graphs. Where the table is absent, or an entry lacks a setting, the defaults are today's files and intervals:
 * `tree` is the effective Apeiron root (`resolveEffectiveApeironRoot`: `APERAS_APEIRON_ROOT`, the walk-up, the fixed fallback) every 10 s,
 * and `threads.tree` and `treeviews` are its `.state/` directory every 3 s. `APERAS_APEIRON_ROOT` wins for the main graph's directory, over
 * an entry of `tree`, and the `.state/` defaults follow it; an explicit `mirror` of the other two graphs wins over that default. A relative
 * `mirror` is taken from the directory of the config file, as `graph` is. The config is the nearest one above `startDir` or, when the walk
 * finds none, the one beside the fallback root, as the other resolvers do. A table that cannot be a table is an error that names the file
 * and the entry: a key that is no graph name or not one of the three, a `mirror` that is no non-empty string, an interval that is no positive
 * finite number.
 */
export function resolveGraphSettings(startDir?: string): GraphTable {
  const configPath = findConfigFile(startDir ?? process.cwd()) ?? (existsSync(join(resolveFallbackGraphRoot(), CONFIG_FILENAME)) ? join(resolveFallbackGraphRoot(), CONFIG_FILENAME) : null);
  let table: Record<string, unknown> = {};
  const warnings: string[] = [];
  if (configPath !== null) {
    let raw: { graphs?: unknown };
    try {
      raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch (err: any) {
      throw new Error(`${configPath} isn't valid JSON: ${err.message || err}`);
    }
    if (raw.graphs !== undefined) {
      if (typeof raw.graphs !== 'object' || raw.graphs === null || Array.isArray(raw.graphs)) throw new Error(`${configPath}: "graphs" must be an object keyed by graph name`);
      table = raw.graphs as Record<string, unknown>;
      for (const [name, entry] of Object.entries(table)) {
        if (!isGraphName(name)) throw new Error(`${configPath}: graphs entry ${JSON.stringify(name)} is not a graph name`);
        if (!MIRROR_GRAPHS.includes(name)) throw new Error(`${configPath}: graphs entry ${JSON.stringify(name)} is not one of the graphs of the shell (${MIRROR_GRAPHS.join(', ')})`);
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error(`${configPath}: graphs entry ${JSON.stringify(name)} must be an object`);
        const { mirror, flushIntervalMs } = entry as { mirror?: unknown; flushIntervalMs?: unknown };
        if (mirror !== undefined && (typeof mirror !== 'string' || mirror === '')) throw new Error(`${configPath}: graphs entry ${JSON.stringify(name)}: "mirror" must be a non-empty string`);
        if (flushIntervalMs !== undefined && (typeof flushIntervalMs !== 'number' || !Number.isFinite(flushIntervalMs) || flushIntervalMs <= 0)) throw new Error(`${configPath}: graphs entry ${JSON.stringify(name)}: "flushIntervalMs" must be a positive finite number`);
      }
      if (MAIN_GRAPH in table) warnings.push(warnTreeEntry(configPath));
    }
  }
  const configDir = configPath === null ? undefined : dirname(configPath);
  const mainRoot = resolveEffectiveApeironRoot(startDir);
  const stateRoot = join(mainRoot, STATE_DIRECTORY);
  const settingOf = (graph: string, fallbackDirectory: string, fallbackInterval: number): GraphSettings => {
    const entry = (table[graph] ?? {}) as { mirror?: string; flushIntervalMs?: number };
    const fromEntry = entry.mirror === undefined ? undefined : resolve(configDir!, entry.mirror);
    const directory = graph === MAIN_GRAPH && process.env.APERAS_APEIRON_ROOT ? process.env.APERAS_APEIRON_ROOT : (fromEntry ?? fallbackDirectory);
    return { graph, directory, flushIntervalMs: entry.flushIntervalMs ?? fallbackInterval };
  };
  return {
    graphs: [
      settingOf(MAIN_GRAPH, mainRoot, DEFAULT_MAIN_FLUSH_MS),
      settingOf(THREADS_GRAPH, stateRoot, DEFAULT_STATE_FLUSH_MS),
      settingOf(VIEWS_GRAPH, stateRoot, DEFAULT_STATE_FLUSH_MS),
    ],
    warnings,
  };
}
