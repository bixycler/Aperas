import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from 'oxigraph';
import { resolveEffectiveApeironRoot, resolveEffectiveArtifactsRoot } from '@aperas/core/graphConfig';
import { rehydrateStore } from '@aperas/core/shell/store';
import { dehydrateToJsonLd, dehydrateStateToJsonLd } from '@aperas/core/shell/dehydrate';

/** The checkout's own graph (`<repo>/AperasKG`, the real mirror). Exported for `makeCorpusCopy`, which only reads it. */
export const REAL_GRAPH = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../../AperasKG');

const isInside = (path: string, dir: string): boolean => {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
const real = (path: string): string => (existsSync(path) ? realpathSync(path) : resolve(path));

/** Throws when `path` is, or lies inside, the real mirror (`AperasKG`), however it is spelled. */
export function assertNotRealMirror(path: string): void {
  const graph = real(REAL_GRAPH);
  if (isInside(real(path), graph) || isInside(resolve(path), REAL_GRAPH)) {
    throw new Error(`Refusing to use ${path}: it is the real mirror (${graph}). Tests use scratch roots only.`);
  }
}

export interface FixtureStore {
  store: Store;
  /** The scratch directory holding `Apeiron/` and `artifacts/`. */
  root: string;
  apeironRoot: string;
  artifactsRoot: string;
  demoDir: string;
  /** Removes the scratch directory and unsets the two root variables; safe to call twice. */
  cleanup: () => void;
}

/**
 * A tiny, empty, well-formed store with its own scratch roots. `APERAS_APEIRON_ROOT` and
 * `APERAS_ARTIFACTS_ROOT` are set for this process only (every test file is its own process) and removed
 * by `cleanup()`, which also runs on process exit. Refuses to run when either root resolves to the real
 * mirror. A test gets its store and its roots from the return value and calls `cleanup` in `after`.
 */
export function makeFixtureStore(demoDir = 'demo'): FixtureStore {
  const root = mkdtempSync(join(tmpdir(), 'aperas-test-'));
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
    process.env.APERAS_APEIRON_ROOT = apeironRoot;
    process.env.APERAS_ARTIFACTS_ROOT = artifactsRoot;
    // What the code under test will resolve must be the scratch roots, not the real ones.
    for (const [name, resolved] of [['Apeiron', resolveEffectiveApeironRoot()], ['artifacts', resolveEffectiveArtifactsRoot()]]) {
      assertNotRealMirror(resolved);
      if (!isInside(real(resolved), real(root))) throw new Error(`Refusing to run: the ${name} root resolves to ${resolved}, outside the scratch directory ${root}.`);
    }
    mkdirSync(join(apeironRoot, '.state'), { recursive: true });
    dehydrateToJsonLd(new Store(), apeironRoot); // an empty but well-formed Apeiron directory
    dehydrateStateToJsonLd(new Store(), join(apeironRoot, '.state'));
    mkdirSync(join(artifactsRoot, demoDir), { recursive: true });
    const { store } = rehydrateStore();
    process.once('exit', cleanup);
    return { store, root, apeironRoot, artifactsRoot, demoDir, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}
