/**
 * `kg:resolve`, migrated to ApeironNgn (Aperas-apeironngn-design.md §4 rollout) — the full deep-
 * path grammar, `--create-holder` included, reading/writing a rehydrated in-process Store instead
 * of TerminusDB. Plain mode reuses `resolve.ts`'s read-only resolver; `--create-holder` uses
 * `resolveCreate.ts`'s write-extended one and dehydrates the change back to
 * `AperasKG/Apeiron/`'s JSON-LD mirror afterward (no git commit — a separate, existing step).
 */

import { rehydrateStore } from './apeironNgn/store';
import { dehydrateToJsonLd } from './apeironNgn/dehydrate';
import { resolveDeepPath } from './apeironNgn/resolve';
import { resolveDeepPathDetail } from './apeironNgn/resolveCreate';
import { wrap } from './apeironNgn/node';
import { displayLabel } from './apeironNgn/tree';

function main(): void {
  const paths = process.argv.slice(2);

  const baseIdx = paths.indexOf('--base');
  const base = baseIdx !== -1 ? paths[baseIdx + 1] : undefined;
  const createHolder = paths.includes('--create-holder');
  const titlesIdx = paths.indexOf('--titles');
  const titles = titlesIdx !== -1 ? paths.slice(titlesIdx + 1) : undefined;

  const consumed = new Set<number>();
  if (baseIdx !== -1) { consumed.add(baseIdx); consumed.add(baseIdx + 1); }
  if (titlesIdx !== -1) { for (let i = titlesIdx; i < paths.length; i++) consumed.add(i); }
  const createHolderIdx = paths.indexOf('--create-holder');
  if (createHolderIdx !== -1) consumed.add(createHolderIdx);
  const rest = paths.filter((_, i) => !consumed.has(i));

  if (rest.length === 0) {
    console.error('Usage: kg:resolve:ngn -- [--base <path>] <path> [<path>...]');
    console.error('       kg:resolve:ngn -- [--base <path>] --create-holder <path> --titles <title> [<title>...]');
    process.exit(1);
  }

  if (createHolder && rest.length !== 1) {
    console.error('[ApeironNgn kg:resolve] --create-holder takes exactly one <path> (Aperas-deep-path-resolution-design.md §1).');
    process.exit(1);
  }

  const { store } = rehydrateStore();

  if (createHolder) {
    const pathArg = rest[0];
    let detail;
    try {
      detail = resolveDeepPathDetail(store, pathArg, { base, createHolder, titles: titles ?? [] });
    } catch (err: any) {
      console.error(`[ApeironNgn kg:resolve] '${pathArg}': ${err.message || err}`);
      process.exit(1);
    }
    if (!detail) {
      console.error(`[ApeironNgn kg:resolve] '${pathArg}' isn't a tracked artifact/folder path, deep path, bare node code, or full node id.`);
      process.exit(1);
    }
    for (const entry of detail.trace) {
      console.log(`${entry.id}  [${entry.kind}]  ${entry.title}  ${entry.created ? '(created holder)' : '(existing)'}`);
    }
    dehydrateToJsonLd(store);
    return;
  }

  for (const pathArg of rest) {
    let id: string | null;
    try {
      id = resolveDeepPath(store, pathArg, { base });
    } catch (err: any) {
      console.error(`[ApeironNgn kg:resolve] '${pathArg}': ${err.message || err}`);
      process.exit(1);
    }
    if (!id) {
      console.error(`[ApeironNgn kg:resolve] '${pathArg}' isn't a tracked artifact/folder path, deep path, bare node code, or full node id.`);
      process.exit(1);
    }
    const node = wrap(store, id);
    console.log(`${id}  [${displayLabel(id, node)}]  ${(node.title as string) ?? ''}`);
  }
}

main();
