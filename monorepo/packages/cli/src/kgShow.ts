/**
 * `kg:show` — raw single-node inspection, via the shared ApeironNgn service
 * (Aperas-apeironngn-design.md §4 rollout step 5). Every other read command (`kg:unfold`/
 * `kg:tree`/`kg:backlinks`) only ever shows a *rendered preview* — title plus a truncated,
 * anchor-stripped abstract — right for browsing, wrong for verifying a stored field is exactly
 * what's about to be pushed back via `kg:update`/`kg:insert`, or for reading a field no preview
 * ever shows at all (`props`, `tombstonedAt`). Before this, the only way to see a node's exact
 * stored state was a direct `BlockNode.jsonld`/`ArtifactNode.jsonld` read outside the CLI entirely
 * (issues/treeview.md's "no raw single-node inspection command").
 *
 * Reuses `dehydrate.ts`'s own `serializeDoc` — the exact per-kind shape walk that writes the
 * on-disk mirror — rather than re-implementing a second idea of "raw state" that could drift from
 * what's actually on disk.
 */

import type { Store } from 'oxigraph';
import { resolveDeepPath } from '@aperas/core/apeironNgn/resolve';
import { serializeDoc } from '@aperas/core/apeironNgn/dehydrate';
import { nodeExists } from '@aperas/core/apeironNgn/vocab';
import { ensureServiceRunning, request } from './apeironNgn/serviceClient';
import { wantsHelp, printHelp } from './kgHelp';

export function runShow(store: Store, pathArg: string): Record<string, unknown> {
  const id = resolveDeepPath(store, pathArg);
  if (!id) throw new Error(`'${pathArg}' isn't a tracked artifact/folder path, deep path, bare node code, or full node id.`);
  if (!nodeExists(store, id)) throw new Error(`Node '${id}' not found.`);
  return serializeDoc(store, id);
}

export async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (wantsHelp(rawArgs)) {
    printHelp({
      description: 'Print a node\'s exact stored fields — full text, props, tombstonedAt, and every other field as actually recorded, no truncation, no anchor stripping, no rendering.',
      usage: 'aperas show <ref> [--text] [--reload]',
      args: [
        { name: '<ref>', description: 'Tracked artifact/folder path, deep path, bare node code, or full node id to inspect.' },
      ],
      flags: [
        { name: '--text', description: "Print only the node's exact stored `text`, undecorated — meant to be redirected to a file and piped back into `kg:update`, so an untouched part of a block round-trips byte-identical rather than being retyped from a rendered preview." },
        { name: '--reload', description: 'Reload the store from disk first, in case something else (e.g. a git pull) changed it since the service started.' },
      ],
    });
    return;
  }
  const showText = rawArgs.includes('--text');
  const reload = rawArgs.includes('--reload');
  const [pathArg] = rawArgs.filter((p) => p !== '--text' && p !== '--reload');
  if (!pathArg) {
    console.error('Usage: aperas show <ref> [--text] [--reload]');
    process.exit(1);
  }

  await ensureServiceRunning();
  const doc = await request<ReturnType<typeof runShow>>({ op: 'show', pathArg, reload });
  if (showText) {
    const text = typeof doc.text === 'string' ? doc.text : '';
    process.stdout.write(text);
    if (text && !text.endsWith('\n')) process.stdout.write('\n');
    return;
  }
  console.log(JSON.stringify(doc, null, 2));
}

if (process.argv[1]?.endsWith('kgShow.ts')) {
  main().catch((err) => {
    console.error('[ApeironNgn kg:show] Failed:', err.message || err);
    process.exit(1);
  });
}
