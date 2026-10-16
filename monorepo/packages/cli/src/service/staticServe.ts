/**
 * Serves the webapp's built static assets (`packages/web/dist/`, bundled alongside the CLI binary
 * per Slice 16's packaging step) from the production listener. `index.html` gets the current
 * per-run token injected server-side — a same-origin-only bootstrap: a hostile third-party page
 * can't read this response's body, since it isn't served that page, and this listener never sends
 * the permissive CORS that would let a cross-origin script read it either.
 *
 * The webapp is a single page with no client-side router (its own navigation stays on `/`, carrying
 * state as query params — `App.tsx`'s `history.replaceState`), so there is no SPA fallback case to
 * handle here: a path that isn't a real file under `webRoot` is a genuine 404.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export interface StaticResult {
  status: number;
  headers: Record<string, string>;
  body: string | Buffer;
}

/** `pathname` comes from `new URL(...)`'s own parsing (so no raw `..`/`%2e%2e` survives from the
 *  request line as a literal path segment), but is re-normalized and re-checked against `webRoot`
 *  anyway — cheap, and the one thing standing between a mistake in this function and reading
 *  outside the intended directory. */
export async function serveStatic(webRoot: string, pathname: string, token: string): Promise<StaticResult | null> {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const root = normalize(webRoot);
  const filePath = normalize(join(root, rel));
  if (!filePath.startsWith(root)) return null; // path escape attempt
  if (!existsSync(filePath)) return null;

  const ext = extname(filePath);
  const contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream';

  if (ext === '.html') {
    const html = await readFile(filePath, 'utf-8');
    const injected = html.replace(
      '</head>',
      `<script>window.__APERAS_TOKEN__ = ${JSON.stringify(token)};</script></head>`,
    );
    // The token rotates every service run — never let a browser serve a stale one from cache.
    return { status: 200, headers: { 'content-type': contentType, 'cache-control': 'no-store' }, body: injected };
  }
  const body = await readFile(filePath);
  return { status: 200, headers: { 'content-type': contentType }, body };
}
