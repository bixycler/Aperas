/**
 * `kg:resolve` — the full deep-path grammar, `--create-holder` included, via the shared ApeironNgn
 * service (Aperas-apeironngn-design.md §4 rollout step 5). Plain mode reuses `resolve.ts`'s
 * read-only resolver; `--create-holder` uses `resolveCreate.ts`'s write-extended one.
 */

import type { Store } from 'oxigraph';
import { resolveDeepPath } from './apeironNgn/resolve';
import { resolveDeepPathDetail } from './apeironNgn/resolveCreate';
import { wrap } from './apeironNgn/node';
import { displayLabel } from './apeironNgn/tree';
import { ensureServiceRunning, request } from './apeironNgn/serviceClient';

function resolvePlain(store: Store, paths: string[], base?: string) {
  const lines: string[] = [];
  for (const pathArg of paths) {
    let id: string | null;
    try {
      id = resolveDeepPath(store, pathArg, { base });
    } catch (err: any) {
      throw new Error(`'${pathArg}': ${err.message || err}`);
    }
    if (!id) throw new Error(`'${pathArg}' isn't a tracked artifact/folder path, deep path, bare node code, or full node id.`);
    const node = wrap(store, id);
    lines.push(`${id}  [${displayLabel(id, node)}]  ${(node.title as string) ?? ''}`);
  }
  return { lines };
}

function resolveCreateHolder(store: Store, pathArg: string, base: string | undefined, titles: string[]) {
  let detail;
  try {
    detail = resolveDeepPathDetail(store, pathArg, { base, createHolder: true, titles });
  } catch (err: any) {
    throw new Error(`'${pathArg}': ${err.message || err}`);
  }
  if (!detail) throw new Error(`'${pathArg}' isn't a tracked artifact/folder path, deep path, bare node code, or full node id.`);
  const lines = detail.trace.map((entry) => `${entry.id}  [${entry.kind}]  ${entry.title}  ${entry.created ? '(created holder)' : '(existing)'}`);
  return { lines };
}

export function runResolve(store: Store, req: { paths: string[]; base?: string; createHolder: boolean; titles?: string[] }) {
  if (req.createHolder) return resolveCreateHolder(store, req.paths[0], req.base, req.titles ?? []);
  return resolvePlain(store, req.paths, req.base);
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const flush = rawArgs.includes('--flush');
  const paths = rawArgs.filter((p) => p !== '--flush');

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
    console.error('Usage: kg:resolve -- [--base <path>] <path> [<path>...]');
    console.error('       kg:resolve -- [--base <path>] --create-holder <path> --titles <title> [<title>...]');
    process.exit(1);
  }

  if (createHolder && rest.length !== 1) {
    console.error('[ApeironNgn kg:resolve] --create-holder takes exactly one <path> (Aperas-deep-path-resolution-design.md §1).');
    process.exit(1);
  }

  await ensureServiceRunning();
  const result = await request<ReturnType<typeof runResolve>>({ op: 'resolve', paths: rest, base, createHolder, titles, flush });
  for (const line of result.lines) console.log(line);
}

if (process.argv[1]?.endsWith('kgResolve.ts')) {
  main().catch((err) => {
    console.error('[ApeironNgn kg:resolve] Failed:', err.message || err);
    process.exit(1);
  });
}
