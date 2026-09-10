/**
 * `identity.json` — machine-local settings (AperasKG/artifacts/design/packaging.md's Configuration
 * section). Deliberately never inside any graph/repo: lives at `$XDG_CONFIG_HOME/aperas/identity.json`
 * (or `~/.config/aperas/identity.json` when `XDG_CONFIG_HOME` isn't set), the same place any other
 * CLI tool's machine-local preferences would go. `aperas.config.json` (`graphConfig.ts`) is this
 * file's opposite: shared, committed, describes a *graph*, not a machine — the two are kept apart
 * on purpose (AperasKG/artifacts/discussion/packaging.md's "Settled: graph discovery..." note): a
 * machine number that must differ across machines by construction would silently collide on every
 * clone if it were ever committed alongside the former.
 *
 * Currently the one thing this holds is `machineNumber` (`snowflake.ts`'s id-generator input,
 * replacing the old env-var-only `APERAS_MACHINE_NUMBER` lookup) — a plain object, not a class, so
 * adding another machine-local setting later is just another field.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export interface Identity {
  machineNumber?: number;
}

function getConfigDir(): string {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  return xdgConfigHome ? resolve(xdgConfigHome, 'aperas') : resolve(homedir(), '.config', 'aperas');
}

export function getIdentityPath(): string {
  return join(getConfigDir(), 'identity.json');
}

/** Returns `undefined` if the file doesn't exist, or exists but isn't valid JSON — either way,
 *  callers treat that identically to "nothing configured yet," never a hard failure. */
export function readIdentity(): Identity | undefined {
  const path = getIdentityPath();
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return undefined;
  }
}

/** Merges `patch` onto whatever's already there (creating the file/directory if needed) — never a
 *  wholesale replace, so setting `machineNumber` today doesn't clobber some other machine-local
 *  setting a future version of this file might also hold. */
export function writeIdentity(patch: Identity): void {
  const path = getIdentityPath();
  mkdirSync(dirname(path), { recursive: true });
  const merged = { ...readIdentity(), ...patch };
  writeFileSync(path, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
}
