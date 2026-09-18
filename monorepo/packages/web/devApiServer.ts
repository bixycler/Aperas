/**
 * The dev API's actual implementation — a standalone, long-lived Node process, run under `tsx`
 * (spawned once by `vite.config.ts`, not per-request) rather than living inside `vite.config.ts`
 * itself. That split exists because of a real wall, not a style choice: Vite's own config loader
 * bundles the config file and its close relative imports via esbuild, but externalizes a bare
 * `node_modules`-resolved specifier and lets Node's native ESM loader `import()` it directly —
 * which cannot load a raw `.ts` file at all (confirmed live: `ERR_UNKNOWN_FILE_EXTENSION` the
 * moment `vite.config.ts` itself imported `@aperas/cli/apeironNgn/serviceClient`). Running under
 * `tsx` here sidesteps that entirely — `tsx` is the same loader every `kg*.ts` entrypoint already
 * runs under, so this file is a completely ordinary `tsx`-run script from Node's point of view.
 *
 * Talks directly to the shared ApeironNgn service over its unix socket (`request`, the exact
 * function `kgTree.ts`/`kgUpdate.ts`/every other `kg*.ts` already uses) — no CLI subcommand is
 * spawned per request. That distinction is the actual fix for the "seconds per click" fold/unfold
 * latency: the first version of this dev API shelled out to `tsx packages/cli/src/aperas.ts <verb>`
 * per request, paying a fresh Node-plus-TypeScript-transpile startup on every single click, on top
 * of the service round trip that was already fast. Nothing here was ever a SolidJS cost.
 *
 * No auth: binds loopback only, reached solely via Vite's own dev-server proxy — never shipped.
 * The auth token/allowlist (planning/webapp.md's Slices 2-3) are what a real production listener
 * needs, not this.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { ensureServiceRunning, request } from '@aperas/cli/apeironNgn/serviceClient';
import type { ServiceRequest } from '@aperas/cli/apeironNgn/serviceProtocol';

const port = Number(process.argv[2] ?? 2734);

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    await ensureServiceRunning();

    if (url.pathname === '/api/tree') {
      const pathArg = url.searchParams.get('path') ?? '.';
      const viewRef = url.searchParams.get('view') ?? 'default';
      const depth = url.searchParams.get('depth');
      const result = await request<unknown>({
        op: 'tree', pathArg, viewRef, format: 'render-tree',
        noHolders: false, showTombstoned: false, reload: false,
        ...(depth !== null ? { maxDepth: Number(depth) } : {}),
      } as ServiceRequest);
      sendJson(res, 200, result);
      return;
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
    if (url.pathname === '/api/fold') {
      const ref = url.searchParams.get('ref');
      const viewRef = url.searchParams.get('view') ?? 'default';
      const action = url.searchParams.get('action');
      if (!ref || (action !== 'unfold' && action !== 'fold')) throw new Error("'ref' and 'action=unfold|fold' are required.");
      const req2: ServiceRequest = action === 'unfold'
        ? { op: 'unfold', ref, viewRef, showTombstoned: false, flush: false, reload: false }
        : { op: 'fold', ref, viewRef, flush: false, reload: false };
      await request(req2);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (url.pathname === '/api/views') {
      const result = await request<{ views: Array<{ name: string; profileHandle?: string }> }>(
        { op: 'profileListView', reload: false },
      );
      sendJson(res, 200, result.views.map((v) => ({ name: v.name, profile: v.profileHandle ?? '?' })));
      return;
    }
    if (url.pathname === '/api/backlinks') {
      const pathArg = url.searchParams.get('id');
      if (!pathArg) throw new Error("'id' is required.");
      const entries = await request<unknown>({ op: 'backlinks', pathArg, includeText: true, reload: false } as ServiceRequest);
      sendJson(res, 200, entries);
      return;
    }
    if (url.pathname === '/api/show') {
      const pathArg = url.searchParams.get('id');
      if (!pathArg) throw new Error("'id' is required.");
      const doc = await request<{ title?: string; text?: string; type?: string }>({ op: 'show', pathArg, reload: false });
      sendJson(res, 200, { title: doc.title, text: doc.text, type: doc.type });
      return;
    }
    // Slice 8's `updateText(id, text)`: always piped bare, with no leading bullet marker and no
    // heading line, so it lands as a plain non-retitling body edit for every node type —
    // `aperas update`'s own `--text-only` mode already leaves an existing listItem's `checked`/
    // `orderedList` props and a heading's title untouched under that shape (kgUpdate.ts), which is
    // exactly "the current node's own text, nothing else" this write is supposed to be.
    if (url.pathname === '/api/update' && req.method === 'POST') {
      const path = url.searchParams.get('id');
      if (!path) throw new Error("'id' is required.");
      const markdown = await readBody(req);
      await request({ op: 'update', path, markdown, textOnly: true, flush: true, reload: false });
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 404, { error: `No such route: ${url.pathname}` });
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[aperas-dev-api] listening on http://127.0.0.1:${port}`);
});
