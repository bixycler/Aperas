/**
 * The checks every request to the production in-service HTTP listener must pass, per
 * discussion/webapp.md's "Auth for the in-service listener": the threat is the browser (any page
 * the user has open can reach a TCP listener), not the network. Four controls: `Host` (rejects
 * anything but this exact loopback address:port — the anti-DNS-rebinding control), `Origin` (an
 * allowlist of exactly this listener's own origin, defence in depth), the per-run token (the actual
 * trust boundary — a custom header forces a CORS preflight, which stops a cross-origin request from
 * ever being *sent*, independent of the token's own value), and the op allowlist itself
 * (`apiRoutes.ts`'s route table — enforced by routing, not here).
 *
 * The token check is skipped for non-API requests (the static webapp shell): the very first
 * `GET /` that fetches `index.html` can't carry a token it doesn't have yet — the page is what
 * hands the token to the browser in the first place (`staticServe.ts`). Host/Origin still apply to
 * every request alike, so the static path is no more a DNS-rebinding vector than the API is.
 */
import { timingSafeEqual } from 'node:crypto';

export interface ListenerAuthContext {
  token: string;
  port: number;
}

export type AuthResult = { ok: true } | { ok: false; status: number; error: string };

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/** The one origin this listener ever grants — used both to check an incoming `Origin` header and
 *  to answer a CORS preflight. Accepts either loopback spelling a browser might use. */
export function allowedOrigins(port: number): string[] {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
}

export function checkAuth(
  headers: { host?: string; origin?: string; 'x-aperas-token'?: string },
  ctx: ListenerAuthContext,
  requireToken: boolean,
): AuthResult {
  const expectedHosts = [`127.0.0.1:${ctx.port}`, `localhost:${ctx.port}`];
  if (!headers.host || !expectedHosts.includes(headers.host)) {
    return { ok: false, status: 400, error: 'Host must be this listener\'s own loopback address.' };
  }
  if (headers.origin !== undefined && !allowedOrigins(ctx.port).includes(headers.origin)) {
    return { ok: false, status: 403, error: 'Origin not allowed.' };
  }
  if (requireToken) {
    const token = headers['x-aperas-token'];
    if (!token || !safeEqual(token, ctx.token)) {
      return { ok: false, status: 401, error: 'Missing or invalid token.' };
    }
  }
  return { ok: true };
}
