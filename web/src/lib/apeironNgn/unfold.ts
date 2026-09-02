/**
 * ApeironNgn implementation of `kg:unfold`/`kg:fold` (Aperas-apeironngn-design.md §4 rollout — the
 * first write path, "simplest — one boolean field"). Sets `unfolded` through `node.ts`'s `set`
 * trap (validated against `BaseNode`'s `SHAPE`, same as any other field write) then persists via
 * `dehydrate.ts`'s `dehydrateToJsonLd` — no fetch-then-resubmit shuffle needed the way
 * `kgCli.ts`'s `setUnfolded` requires for TerminusDB's `updateDocument`, since a `Store` write is
 * already in place.
 */

import type { Store } from 'oxigraph';
import { wrap } from './node';
import { nodeExists } from './vocab';

/** Returns `false` if `id` doesn't exist in the store — caller decides how to report that. */
export function setUnfolded(store: Store, id: string, value: boolean): boolean {
  if (!nodeExists(store, id)) return false;
  const node = wrap(store, id);
  node.unfolded = value;
  return true;
}
