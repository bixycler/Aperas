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
 * `getArtifactsDir()`/`getApeironExportDir()` (`artifacts.ts`/`apeironNgn/store.ts`) both fall back
 * to their own hardcoded, hop-counted path when no `aperas.config.json` is found anywhere above the
 * starting directory — this repo's own dev setup is deliberately left config-free, relying on that
 * fallback, so this migration doesn't force every existing checkout to add a config file just to
 * keep working.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

  return { apeironRoot, artifactsRoot, parent, configPath };
}

/** The fallback graph root when no `aperas.config.json` is found anywhere above the caller — this
 *  repo's own dev checkout, deliberately left config-free (see this file's own doc comment above).
 *  Anchored to this module's own on-disk location rather than `process.cwd()`, so it resolves the
 *  same directory no matter where a command happens to be invoked from — the same `existsSync`
 *  dev-vs-built branch `serviceLock.ts`/`artifacts.ts`/`apeironNgn/store.ts` used to each carry a
 *  copy of, now centralized here as the one place that does this hop-count at all. */
function resolveFallbackGraphRoot(): string {
  const isDev = existsSync(resolve(__dirname, 'apeironNgn'));
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
