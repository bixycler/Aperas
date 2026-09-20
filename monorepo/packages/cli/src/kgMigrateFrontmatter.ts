/**
 * `kg:migrate-frontmatter` — one-time migration for the frontmatter-as-props redesign
 * (discussion/core.md's 2026-09-20 entry; issues/core.md's matching Open Issue). Re-runs
 * `ArtifactNode.ingestFromDisk` for every live artifact, bypassing the unchanged-content skip, so
 * each one's existing single opaque `frontmatter` prop splits into per-key props — `description`
 * among them, seeded from whatever `extractAbstract` last derived, now carrying real, bakeable
 * `Link`s of its own instead of a copy with nothing to bake against. No equivalent step exists (or
 * is needed) for `FolderNode`: `kg:ingest`'s folder-tree half already rebuilds unconditionally on
 * every run, so the very next ordinary `kg:ingest` migrates every folder for free.
 *
 * Meant to run exactly once, after the code change lands and before relying on `description`
 * anywhere — safe to re-run afterward too (idempotent: re-splitting already-split props is a no-op
 * `carryForwardProp` recognizes by unchanged value).
 */

import { ensureServiceRunning, request } from './apeironNgn/serviceClient';
import { wantsHelp, printHelp } from './kgHelp';
import type { IngestFailure } from '@aperas/core/apeironNgn/artifacts';

interface MigrateFrontmatterResult {
  migrated: string[];
  bodyHeldBack: string[];
  failed: IngestFailure[];
}

export async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (wantsHelp(rawArgs)) {
    printHelp({
      description: "One-time migration: split every ArtifactNode's opaque frontmatter prop into per-key props (description, lang, ...), re-deriving description's own links.",
      usage: 'aperas migrate-frontmatter [--flush] [--reload]',
    });
    return;
  }

  const flush = rawArgs.includes('--flush');
  const reload = rawArgs.includes('--reload');

  await ensureServiceRunning();
  const result = await request<MigrateFrontmatterResult>({ op: 'migrateFrontmatter', reload, flush });

  console.log(`[ApeironNgn migrate-frontmatter] Migrated ${result.migrated.length} artifact(s).`);
  if (result.bodyHeldBack.length > 0) {
    console.warn(`[ApeironNgn migrate-frontmatter] description landed on ${result.bodyHeldBack.length} more, but their body reconciliation is held back by a pre-existing, unrelated issue (see 'kg:ingest <path> --force' once confirmed safe):`);
    for (const p of result.bodyHeldBack) console.warn(`  • ${p}`);
  }
  if (result.failed.length > 0) {
    console.warn(`[ApeironNgn migrate-frontmatter] ${result.failed.length} failure(s):`);
    for (const f of result.failed) console.warn(`  • ${f.path}: ${f.error}`);
  }
}

if (process.argv[1]?.endsWith('kgMigrateFrontmatter.ts')) {
  main().catch((err) => {
    console.error('[ApeironNgn migrate-frontmatter] Failed:', err.message || err);
    process.exit(1);
  });
}
