import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(__dirname, '..', '..');
const API_PORT = 5199;

/**
 * Spawns `devApiServer.ts` (see its own doc comment for why it's a separate `tsx` process rather
 * than code living in this file) exactly once, at Vite's own dev-server startup — not per request,
 * which is what made fold/unfold feel like seconds-per-click in the first version of this bridge.
 * Proxied rather than imported: Vite's `server.proxy` is plain HTTP forwarding, needing no bundling
 * of the target at all, unlike importing a workspace TS module directly into this config file
 * (which hits Node's native loader head-on — see `devApiServer.ts`).
 */
function aperasDevApiProxy() {
  let child: ChildProcess | undefined;
  return {
    name: 'aperas-dev-api-proxy',
    configureServer() {
      child = spawn(
        process.execPath,
        [resolve(monorepoRoot, 'node_modules/.bin/tsx'), resolve(__dirname, 'devApiServer.ts'), String(API_PORT)],
        { cwd: monorepoRoot, stdio: 'inherit' },
      );
      const stop = () => child?.kill();
      process.once('exit', stop);
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    },
  };
}

export default defineConfig({
  plugins: [solid(), aperasDevApiProxy()],
  server: {
    proxy: {
      '/api': `http://127.0.0.1:${API_PORT}`,
    },
  },
});
