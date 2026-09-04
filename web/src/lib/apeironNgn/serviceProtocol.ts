/**
 * ApeironNgn shared service wire protocol (Aperas-apeironngn-design.md §4 rollout step 5) —
 * newline-delimited JSON, one request per connection. `JSON.stringify` always escapes an embedded
 * `\n`, so splitting received bytes on `\n` is safe framing with no parser beyond a string split.
 */

/** How to resolve a flush conflict (`ServiceResponse`'s `conflict` field, `flushIfDirty`'s own doc
 *  comment in `service.ts`) — one shared string, not duplicated as literal text in the two places
 *  that need it: `service.ts` appends it to the error thrown by whichever request directly hits the
 *  conflict for the first time (that response never carries `conflict` — it's `ok: false`, so
 *  nothing else would ever tell that particular caller how to resolve it), and
 *  `serviceClient.ts#reportConflict` prints it once alongside every *later* response that's still
 *  carrying the same unresolved conflict (those carry only the "what diverged" description in
 *  `conflict.content`/`conflict.state`, deliberately without this repeated inline each time). */
export const CONFLICT_RESOLUTION_HINT =
  "Resolve with: npm run kg:flush -- --clobber (keep this service's pending local changes, overwrite disk) or " +
  "npm run kg:reload -- --discard (keep disk's current content, drop the pending local changes) — note the " +
  "'--' before the flag, required by npm itself.";

export type ServiceRequest =
  | { op: 'ping' }
  // The revived TDB-era `kg:import`'s equivalent: discards the in-memory `Store` and rehydrates a
  // fresh one from `AperasKG/Apeiron/` (content mirror + `.state/`) — the only way to pick up a
  // change landing on disk after the service started (e.g. a `git pull` merging someone else's
  // commit), since nothing else ever re-reads the mirror once the service is running. Flushes
  // both dirty flags first if set, so no unflushed in-memory work is silently discarded — unless
  // that flush is itself refused by a divergence (see `flush`/`clobber` below): `discard: true`
  // resolves that conflict by dropping the pending local mutation instead of trying to preserve
  // it, taking whatever's on disk as-is. The deliberate, explicit way to pick "keep the external
  // change" (`kg:reload --discard`) — never implied by an op's own bare `reload: true`, which
  // always takes the safe, preserving path.
  | { op: 'reload'; discard: boolean }
  // The other side of `discard`: resolves the same conflict in favor of the *local* mutation,
  // writing current memory over disk unconditionally when `clobber: true` — no dirty check, no
  // divergence check. Its own op rather than a flag on some unrelated mutating op's `flush`, since
  // this isn't tied to any particular mutation: it's "push out whatever's pending right now, no
  // matter what's on disk." Without `clobber`, behaves like the guarded flush every other op's
  // `flush: true` already triggers — a way to flush on demand outside of any specific mutation,
  // and to *learn about* a conflict (it throws) without side effects from some unrelated op.
  // Named `clobber`, not `force` — the name itself doesn't route around `npm run kg:flush --force`'s
  // original footgun, though: any `--flag` typed after `npm run <script>` without npm's own `--`
  // separator is swallowed by npm's own arg parser before it ever reaches the script, recognized
  // npm option or not (`kgFlush.ts`'s own doc comment has the full explanation and the correct
  // invocation).
  | { op: 'flush'; clobber: boolean }
  // `reload` — the reciprocal of `flush`: `flush` forces an immediate sync *out* to disk right
  // after a write; `reload` forces an immediate sync *in* from disk right before the op runs, so it
  // starts from the current mirror even if the service has been sitting idle since before an
  // external change landed (e.g. someone else's `git pull`). Equivalent to a `{ op: 'reload' }`
  // call immediately followed by this one, just one round trip instead of two — and safe to combine
  // with a mutation in the same request (`reload` then the op then `flush`, all one round trip),
  // since `reloadStore()` itself flushes any dirty work first rather than discarding it. Offered on
  // every op that reads the store's current content, including a candidate-listing op
  // (`titleCandidates`/`linkCandidates`) — just not on `setBlockTitle`/`addBlockLink`, each one
  // sub-step of an already-in-progress interactive session where reloading mid-loop would
  // invalidate the `blockId`s the candidate list already hands back.
  | { op: 'track'; paths: string[]; flush: boolean; reload: boolean }
  // `track: true` folds a `kg:track` refresh (against the same `paths`) in first — `kgIngest.ts`'s
  // own doc comment has the full reasoning (`ingestedHash === fileHash` doesn't know the file on
  // disk changed until something re-reads it, which only `track` does).
  | { op: 'ingest'; paths: string[]; flush: boolean; reload: boolean; track: boolean }
  // `viewRef` (Aperas-treeview-design.md §5/§8) — a `TreeView` id, or a `TreeNode`/`Link` ref for
  // `unfold`/`fold`'s own `ref`. Omitted `viewRef` resolves to the `"default"`-named view
  // (`node.ts`'s `ensureDefaultView`). A mutating `unfold`/`fold` marks the service's `stateDirty`
  // flag, flushed on its own interval — not `dirty`, the content-mirror flag `track`/`ingest`/etc.
  // use — since it only ever touches `TreeView.unfolds`, never `BlockNode`/`ArtifactNode`/
  // `FolderNode`.
  | { op: 'unfold'; ref: string; viewRef?: string; flush: boolean; reload: boolean }
  | { op: 'fold'; ref: string; viewRef?: string; flush: boolean; reload: boolean }
  | { op: 'resolve'; paths: string[]; base?: string; createHolder: boolean; titles?: string[]; flush: boolean; reload: boolean }
  | { op: 'titleCandidates'; pathArg: string; recursive: boolean; reload: boolean }
  | { op: 'setBlockTitle'; blockId: string; title: string; flush: boolean }
  | { op: 'linkCandidates'; pathArg: string; recursive: boolean; all: boolean; reload: boolean }
  | { op: 'addBlockLink'; blockId: string; targetRef: string; flush: boolean }
  | { op: 'removeBlockLink'; blockId: string; targetRef: string; flush: boolean }
  | { op: 'project'; path: string; reload: boolean }
  // `viewRef` presence drives unfolded-mode rendering — replaces the old bare `unfoldedMode`
  // boolean (§5): a `--view` flag with no target view still resolves to `"default"`, so this is
  // never actually optional in practice, but stays typed that way to match `unfold`/`fold` above.
  | { op: 'tree'; pathArg: string; maxDepth?: number; noHolders: boolean; viewRef?: string; reload: boolean }
  | { op: 'path'; idArg: string; reload: boolean };

// An unresolved divergence (see `flush`/`clobber` above) doesn't just fail the request that hit
// it — it's recorded (`contentConflict`/`stateConflict` in `service.ts`) and attached to *every*
// subsequent response, regardless of that request's own `op`, until `kg:reload --discard` or
// `kg:flush --clobber` resolves it. Otherwise a conflict the 10s/3s timer alone hits (never an
// explicit `flush`/`reload`) would sit `dirty` forever with nothing ever surfacing it — no CLI
// command would have any reason to notice. `serviceClient.ts#request` prints this on the client
// side (this process's own stdio, not the service's `stdio: 'ignore'`'d one) on every call.
export type ServiceResponse =
  | { ok: true; result: unknown; conflict?: { content?: string; state?: string } }
  | { ok: false; error: string };

export function encodeMessage(msg: unknown): string {
  return JSON.stringify(msg) + '\n';
}

export function decodeMessage<T>(line: string): T {
  return JSON.parse(line) as T;
}
