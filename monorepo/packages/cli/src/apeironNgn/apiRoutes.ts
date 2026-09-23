/**
 * The `/api/*` route table — one definition, shared by the dev-only bridge
 * (`packages/web/devApiServer.ts`, which calls an op over the unix socket via `serviceClient.ts#request`)
 * and the production in-service HTTP+auth listener (`service.ts`, which calls its own internal
 * `handle()` directly, in-process, no socket round trip). Extracted so the two never drift into two
 * different route tables — this routing IS the op allowlist the production listener's auth model
 * relies on (discussion/webapp.md's "Auth for the in-service listener": "deep read plus
 * `update --text-only` on one node"); anything not routed here is unreachable from either caller.
 */
import type { IncomingMessage } from 'node:http';
import type { ServiceRequest } from './serviceProtocol';
import { resolveEffectiveGraphName } from '@aperas/core/graphConfig';

export interface ApiRouteResult {
  status: number;
  body: unknown;
}

/** Both callers (`devApiServer.ts`, `service.ts`'s production listener) are plain `node:http`
 *  servers reading the same shape of request — one shared implementation rather than two. */
export function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

export async function handleApiRoute(
  pathname: string,
  searchParams: URLSearchParams,
  method: string,
  readBody: () => Promise<string>,
  callOp: (req: ServiceRequest) => Promise<unknown>,
): Promise<ApiRouteResult> {
  try {
    if (pathname === '/api/tree') {
      const pathArg = searchParams.get('path') ?? '.';
      const viewRef = searchParams.get('view') ?? 'default';
      const depth = searchParams.get('depth');
      const result = await callOp({
        op: 'tree', pathArg, viewRef, format: 'render-tree',
        noHolders: false, showTombstoned: false, reload: false,
        ...(depth !== null ? { maxDepth: Number(depth) } : {}),
      } as ServiceRequest);
      return { status: 200, body: result };
    }
    // `flush: false` here is deliberate, not an oversight: `service.ts`'s 'unfold'/'fold' cases set
    // the *content*-mirror `dirty` flag unconditionally (a defensive catch-all for the rare case
    // where resolving a bare `--view` mints a first-use `Profile`), so `flush: true` was forcing a
    // full ~1600-node content dehydrate to disk on every single fold/unfold click — the actual
    // cause of a multi-hundred-ms-per-click UI (confirmed live, timed before/after), nothing to do
    // with Solid. `TreeView`'s own fold state is genuinely ephemeral UI state with its own
    // independently-tunable flush cadence (design/webapp.md's Persistence, `service.ts`'s own
    // `flushStateIfDirty`) — it does not need, and for a browsing UI should not force, a disk write
    // on every click; the in-memory store (which every subsequent read already sees) and the
    // service's own periodic timer are what actually persist it.
    if (pathname === '/api/fold') {
      const ref = searchParams.get('ref');
      const viewRef = searchParams.get('view') ?? 'default';
      const action = searchParams.get('action');
      if (!ref || (action !== 'unfold' && action !== 'fold')) throw new Error("'ref' and 'action=unfold|fold' are required.");
      const req: ServiceRequest = action === 'unfold'
        ? { op: 'unfold', ref, viewRef, showTombstoned: false, flush: false, reload: false }
        : { op: 'fold', ref, viewRef, flush: false, reload: false };
      await callOp(req);
      return { status: 200, body: { ok: true } };
    }
    if (pathname === '/api/graph') {
      return { status: 200, body: { name: resolveEffectiveGraphName() ?? null } };
    }
    if (pathname === '/api/views') {
      const result = await callOp({ op: 'profileListView', reload: false } as ServiceRequest) as {
        views: Array<{ name: string; profileHandle?: string }>;
      };
      return { status: 200, body: result.views.map((v) => ({ name: v.name, profile: v.profileHandle ?? '?' })) };
    }
    if (pathname === '/api/backlinks') {
      const pathArg = searchParams.get('id');
      if (!pathArg) throw new Error("'id' is required.");
      const entries = await callOp({ op: 'backlinks', pathArg, includeText: true, reload: false } as ServiceRequest);
      return { status: 200, body: entries };
    }
    if (pathname === '/api/show') {
      const pathArg = searchParams.get('id');
      if (!pathArg) throw new Error("'id' is required.");
      const doc = await callOp({ op: 'show', pathArg, reload: false } as ServiceRequest) as {
        title?: string; text?: string; type?: string;
      };
      return { status: 200, body: { title: doc.title, text: doc.text, type: doc.type } };
    }
    // Slice 8's `updateText(id, text)`: always piped bare, with no leading bullet marker and no
    // heading line, so it lands as a plain non-retitling body edit for every node type —
    // `aperas update`'s own `--text-only` mode already leaves an existing listItem's `checked`/
    // `orderedList` props and a heading's title untouched under that shape (kgUpdate.ts), which is
    // exactly "the current node's own text, nothing else" this write is supposed to be. `textOnly:
    // true` is hardcoded, not read from the request, precisely because this route table is also the
    // production listener's op allowlist — nothing here can ever ask for a structural write.
    if (pathname === '/api/update' && method === 'POST') {
      const path = searchParams.get('id');
      if (!path) throw new Error("'id' is required.");
      const markdown = await readBody();
      await callOp({ op: 'update', path, markdown, textOnly: true, flush: true, reload: false } as ServiceRequest);
      return { status: 200, body: { ok: true } };
    }
    return { status: 404, body: { error: `No such route: ${pathname}` } };
  } catch (err) {
    return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
  }
}
