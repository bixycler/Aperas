/**
 * Thin wrapper around `fetch()` for every `/api/*` call: attaches `X-Aperas-Token` when the
 * production listener injected one (`window.__APERAS_TOKEN__`, set server-side in `index.html` —
 * see `staticServe.ts`). Undefined in dev (the `vite dev` bridge is unauthenticated), so this is a
 * plain `fetch()` there — every call here is same-origin either way, this only ever adds a header.
 */
declare global {
  interface Window {
    __APERAS_TOKEN__?: string;
  }
}

export function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const token = window.__APERAS_TOKEN__;
  if (!token) return fetch(input, init);
  const headers = new Headers(init.headers);
  headers.set('X-Aperas-Token', token);
  return fetch(input, { ...init, headers });
}
