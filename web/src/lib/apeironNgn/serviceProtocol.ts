/**
 * ApeironNgn shared service wire protocol (Aperas-apeironngn-design.md §4 rollout step 5) —
 * newline-delimited JSON, one request per connection. `JSON.stringify` always escapes an embedded
 * `\n`, so splitting received bytes on `\n` is safe framing with no parser beyond a string split.
 */

export type ServiceRequest =
  | { op: 'ping' }
  | { op: 'track'; paths: string[]; flush: boolean }
  | { op: 'ingest'; flush: boolean }
  // `viewRef` (Aperas-treeview-design.md §5/§8) — a `TreeView` id, or a `TreeNode`/`Link` ref for
  // `unfold`/`fold`'s own `ref`. Omitted `viewRef` resolves to the `"default"`-named view
  // (`node.ts`'s `ensureDefaultView`). A mutating `unfold`/`fold` marks the service's `stateDirty`
  // flag, flushed on its own interval — not `dirty`, the content-mirror flag `track`/`ingest`/etc.
  // use — since it only ever touches `TreeView.unfolds`, never `BlockNode`/`ArtifactNode`/
  // `FolderNode`.
  | { op: 'unfold'; ref: string; viewRef?: string; flush: boolean }
  | { op: 'fold'; ref: string; viewRef?: string; flush: boolean }
  | { op: 'resolve'; paths: string[]; base?: string; createHolder: boolean; titles?: string[]; flush: boolean }
  | { op: 'titleCandidates'; pathArg: string; recursive: boolean }
  | { op: 'setBlockTitle'; blockId: string; title: string; flush: boolean }
  | { op: 'linkCandidates'; pathArg: string; recursive: boolean; all: boolean }
  | { op: 'addBlockLink'; blockId: string; targetRef: string; flush: boolean }
  | { op: 'project'; path: string }
  // `viewRef` presence drives unfolded-mode rendering — replaces the old bare `unfoldedMode`
  // boolean (§5): a `--view` flag with no target view still resolves to `"default"`, so this is
  // never actually optional in practice, but stays typed that way to match `unfold`/`fold` above.
  | { op: 'tree'; pathArg: string; maxDepth?: number; noHolders: boolean; viewRef?: string }
  | { op: 'path'; idArg: string };

export type ServiceResponse = { ok: true; result: unknown } | { ok: false; error: string };

export function encodeMessage(msg: unknown): string {
  return JSON.stringify(msg) + '\n';
}

export function decodeMessage<T>(line: string): T {
  return JSON.parse(line) as T;
}
