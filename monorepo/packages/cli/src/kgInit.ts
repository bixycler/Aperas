/**
 * `aperas init` — bootstraps a brand-new graph in the current directory: `aperas.config.json`, an
 * empty `Apeiron/` store, and an `artifacts/` tree. The files are the main graph's, from the mirror's
 * mapping (`mirrorFiles.ts`): a fresh directory with none would load as an empty graph all the same,
 * but a directory that holds them says it was initialized.
 *
 * Non-destructive by design: refuses outright if `aperas.config.json` already exists here (this
 * directory is already a graph root), and never overwrites an existing `Apeiron/*.jsonld` file.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { EMPTY_FILE_TEXT, fileNameOfKind, KINDS_OF_GRAPH, MAIN_GRAPH } from '@aperas/core/shell/mirrorFiles';
import { wantsHelp, printHelp } from './kgHelp';

export async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (wantsHelp(rawArgs)) {
    printHelp({
      description: 'Bootstrap a brand-new graph in the current directory: aperas.config.json, an empty Apeiron/ store, and an artifacts/ tree.',
      usage: 'aperas init [--name <name>]',
      flags: [
        { name: '--name <name>', description: "Display name for this graph (aperas.config.json's \"name\" field). Defaults to the current directory's name." },
      ],
    });
    return;
  }

  const cwd = process.cwd();
  const nameFlagIdx = rawArgs.indexOf('--name');
  const name = nameFlagIdx >= 0 ? rawArgs[nameFlagIdx + 1] : basename(cwd);
  if (nameFlagIdx >= 0 && !name) throw new Error('--name requires a value.');

  const configPath = join(cwd, 'aperas.config.json');
  if (existsSync(configPath)) {
    throw new Error(`${configPath} already exists — this directory is already a graph root.`);
  }

  const apeironDir = join(cwd, 'Apeiron');
  const artifactsDir = join(cwd, 'artifacts');
  mkdirSync(apeironDir, { recursive: true });
  mkdirSync(artifactsDir, { recursive: true });

  for (const kind of KINDS_OF_GRAPH[MAIN_GRAPH]!) {
    const path = join(apeironDir, fileNameOfKind(kind));
    if (existsSync(path)) continue; // never clobber real data
    writeFileSync(path, EMPTY_FILE_TEXT, 'utf-8');
  }

  writeFileSync(
    configPath,
    JSON.stringify({ graph: { apeiron: './Apeiron', artifacts: './artifacts' }, name }, null, 2) + '\n',
    'utf-8',
  );

  console.log(`[aperas init] Created ${configPath}`);
  console.log(`[aperas init] Graph "${name}" ready — run 'aperas serve' to open it, or 'aperas track'/'aperas ingest' to bring in existing Markdown.`);
}

if (process.argv[1]?.endsWith('kgInit.ts')) {
  main().catch((err) => {
    console.error('[aperas init] Failed:', err.message || err);
    process.exit(1);
  });
}
