/**
 * `aperas identity` — read/write `identity.json` (`@aperas/core/identity`), the machine-local
 * config `snowflake.ts` falls back to for its `machineNumber` when `APERAS_MACHINE_NUMBER` isn't
 * set. Deliberately doesn't touch the ApeironNgn service/store at all — `identity.json` lives
 * outside any graph (`$XDG_CONFIG_HOME/aperas/identity.json`), so there's nothing here for
 * `ensureServiceRunning()`/`request()` to do.
 */

import { getIdentityPath, readIdentity, writeIdentity } from '@aperas/core/identity';
import { wantsHelp, printHelp } from './kgHelp';

export async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (wantsHelp(rawArgs)) {
    printHelp({
      description: "Show or set this machine's identity.json (currently just machineNumber, the snowflake id generator's machine-uniqueness input).",
      usage: [
        'aperas identity show',
        'aperas identity set <n>',
      ],
      args: [
        { name: '<n>', description: 'Machine number, 0-511. Must be unique per machine generating ids against the same graph (or graph tree) — two machines sharing one number can mint colliding ids.' },
      ],
      flags: [],
    });
    return;
  }

  const [subcommand, ...rest] = rawArgs;

  switch (subcommand) {
    case 'show': {
      const identity = readIdentity();
      const envRaw = process.env.APERAS_MACHINE_NUMBER;
      console.log(`identity.json: ${getIdentityPath()}`);
      if (identity?.machineNumber !== undefined) {
        console.log(`machineNumber: ${identity.machineNumber}${envRaw !== undefined ? ' (overridden by APERAS_MACHINE_NUMBER env var, see below)' : ''}`);
      } else {
        console.log('machineNumber: not set');
      }
      if (envRaw !== undefined) {
        console.log(`APERAS_MACHINE_NUMBER env var: ${envRaw} (takes precedence over identity.json when set)`);
      }
      return;
    }
    case 'set': {
      const [rawN] = rest;
      if (!rawN || !/^\d+$/.test(rawN)) {
        console.error('Usage: aperas identity set <n>  (n is an integer, 0-511)');
        process.exit(1);
      }
      const n = Number(rawN);
      if (n < 0 || n > 511) {
        console.error(`machineNumber must be between 0 and 511, got ${n}`);
        process.exit(1);
      }
      writeIdentity({ machineNumber: n });
      console.log(`[aperas identity] Set machineNumber=${n} in ${getIdentityPath()}`);
      return;
    }
    default:
      console.error('Usage: aperas identity <show|set> ...  (--help for details)');
      process.exit(1);
  }
}

if (process.argv[1]?.endsWith('kgIdentity.ts')) {
  main().catch((err) => {
    console.error('[aperas identity] Failed:', err.message || err);
    process.exit(1);
  });
}
