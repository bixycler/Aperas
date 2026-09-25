/**
 * `aperas skill` — installs the two end-user-facing skills bundled with this package (`aperas`,
 * `kg-doc-ingest`) into an agent's skill directory. Without this, an agent working against an
 * installed `aperas` binary has the CLI but none of the graph-first discipline the skill encodes
 * (dense linking, deep read/write, the update/insert edge cases) — found live installing `aperas`
 * into a fresh project with no equivalent of this repo's own `.claude/skills/aperas`.
 *
 * `build.mjs` copies `skills/aperas`/`skills/kg-doc-ingest` (this repo's own skill sources — not
 * its other, dev-only skills) to `dist/skills/`, sibling to the bundle; `resolveSkillsRoot` below
 * finds that in a built/packaged install, falling back to the source location for dev (`tsx`) runs,
 * the same built-vs-source shape as `service.ts#resolveWebRoot`.
 */

import { existsSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { wantsHelp, printHelp } from './kgHelp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS = ['aperas', 'kg-doc-ingest'];
// Every host below expects the same `<dot-dir>/skills/<name>/SKILL.md` layout Claude Code does —
// confirmed for `.claude`/`.agents` (this repo's own `.agents/skills/` mirrors `.claude/skills/`
// verbatim, one already proven to work for Antigravity), assumed but unverified for the rest.
const HOSTS = ['claude', 'agents', 'codex', 'cursor', 'opencode'] as const;
type Host = (typeof HOSTS)[number];

function resolveSkillsRoot(): string {
  const builtPath = resolve(__dirname, 'skills');
  if (existsSync(builtPath)) return builtPath;
  return resolve(__dirname, '..', '..', '..', '..', 'skills'); // src -> cli -> packages -> monorepo -> repo root
}

function runInstall(rawArgs: string[]): void {
  const global = rawArgs.includes('--global');
  const force = rawArgs.includes('--force');
  const hostFlagIdx = rawArgs.indexOf('--host');
  const hostArg = hostFlagIdx >= 0 ? rawArgs[hostFlagIdx + 1] : 'claude';
  if (!(HOSTS as readonly string[]).includes(hostArg)) {
    throw new Error(`--host must be one of: ${HOSTS.join(', ')} (got '${hostArg}').`);
  }
  const dotDir = `.${hostArg as Host}`;
  const targetDir = global ? join(homedir(), dotDir, 'skills') : join(process.cwd(), dotDir, 'skills');

  const skillsRoot = resolveSkillsRoot();
  mkdirSync(targetDir, { recursive: true });

  for (const skill of SKILLS) {
    const src = join(skillsRoot, skill);
    const dest = join(targetDir, skill);
    if (existsSync(dest)) {
      if (!force) {
        throw new Error(`${dest} already exists — pass --force to overwrite it.`);
      }
      rmSync(dest, { recursive: true, force: true });
    }
    cpSync(src, dest, { recursive: true });
    console.log(`[aperas skill] Installed ${skill} -> ${dest}`);
  }
}

export async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (wantsHelp(rawArgs)) {
    printHelp({
      description: "Install this package's bundled skills (aperas, kg-doc-ingest) into an agent's skill directory, so it knows how to work the CLI's graph correctly.",
      usage: 'aperas skill install [--host claude|agents|codex|cursor|opencode] [--global] [--force]',
      args: [
        { name: 'install', description: 'Copy the bundled skills into a <host>/skills/ directory.' },
      ],
      flags: [
        { name: '--host <name>', description: 'Which agent host to install for — claude (default), agents (Antigravity), codex, cursor, or opencode. Selects the .<name>/ directory.' },
        { name: '--global', description: "Install to ~/.<host>/skills/ instead of ./.<host>/skills/ (the current directory's project-level skills)." },
        { name: '--force', description: 'Overwrite an already-installed skill of the same name.' },
      ],
    });
    return;
  }
  const [subcommand, ...rest] = rawArgs;
  if (subcommand === 'install') return runInstall(rest);
  console.error('Usage: aperas skill install [--host claude|agents|codex|cursor|opencode] [--global] [--force]');
  process.exit(1);
}

if (process.argv[1]?.endsWith('kgSkill.ts')) {
  main().catch((err) => {
    console.error('[aperas skill] Failed:', err.message || err);
    process.exit(1);
  });
}
