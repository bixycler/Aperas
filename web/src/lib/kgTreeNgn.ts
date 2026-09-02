/**
 * `kg:tree` migrated to ApeironNgn (Aperas-apeironngn-design.md §4 step 2) — same argv parsing
 * and output format as `kgCli.ts`'s `tree` command, reading from a rehydrated in-process Store
 * instead of TerminusDB. Kept as its own script, not yet wired to replace `kg:tree`, until it's
 * been diffed clean across enough real artifacts and flag combinations to trust — the same
 * live-verification discipline `kg:track && kg:ingest && build && verify:phase0 -- --db` already
 * applies elsewhere, applied to this migration itself.
 *
 * Only `--depth`/`--no-holders`/`--unfolded` argv parsing and a bare path/full-id argument are
 * supported so far — path resolution here is `findByExactPath` (an exact `path` literal match),
 * not `kgCli.ts`'s full deep-path grammar (`.`/`..`/prefix matching/bare snowflake codes) —
 * that's `kg:resolve`'s own future migration, not duplicated here.
 */

import { rehydrateStore } from './apeironNgn/store';
import { resolveTreeRef, renderTree } from './apeironNgn/tree';

function main(): void {
  const paths = process.argv.slice(2);

  const noHolders = paths.includes('--no-holders');
  const unfoldedMode = paths.includes('--unfolded');
  const withoutFlag = paths.filter((p) => p !== '--no-holders' && p !== '--unfolded');
  const depthFlagIdx = withoutFlag.indexOf('--depth');
  let maxDepth: number | undefined;
  let pathArg = '.';
  if (depthFlagIdx !== -1) {
    maxDepth = Number(withoutFlag[depthFlagIdx + 1]);
    const rest = withoutFlag.filter((_, i) => i !== depthFlagIdx && i !== depthFlagIdx + 1);
    if (rest[0]) pathArg = rest[0];
  } else if (withoutFlag[0]) {
    pathArg = withoutFlag[0];
  }

  const { store } = rehydrateStore();
  const id = resolveTreeRef(store, pathArg);
  if (!id) {
    console.error(`[ApeironNgn kg:tree] '${pathArg}' isn't a full node id or an exact tracked artifact/folder path.`);
    process.exit(1);
  }

  const lines = renderTree(store, id, { maxDepth, noHolders, unfoldedMode });
  console.log(lines.join('\n'));
}

main();
