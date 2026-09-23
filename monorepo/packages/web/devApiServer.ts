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
import { createServer, type ServerResponse } from 'node:http';
import { ensureServiceRunning, request } from '@aperas/cli/apeironNgn/serviceClient';
import { handleApiRoute, readRequestBody } from '@aperas/cli/apeironNgn/apiRoutes';

const port = Number(process.argv[2] ?? 2734);

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

// Route table itself lives in `apiRoutes.ts`, shared with the production in-service listener
// (`service.ts`) so the two can't drift into two different sets of routes — this file's only job
// is to supply *how* an op gets invoked here: over the unix socket, via `request()`, since this
// bridge runs in its own separate process rather than in the service itself.
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    await ensureServiceRunning();
    const { status, body } = await handleApiRoute(
      url.pathname, url.searchParams, req.method ?? 'GET',
      () => readRequestBody(req),
      (r) => request(r),
    );
    sendJson(res, status, body);
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[aperas-dev-api] listening on http://127.0.0.1:${port}`);
});
