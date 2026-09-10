/**
 * `kg:project` — serializes a tracked ArtifactNode/FolderNode's tree back to Markdown, via the
 * shared ApeironNgn service (Aperas-apeironngn-design.md §4 rollout step 5). The service returns
 * the rendered markdown and target file path; the actual file write stays client-side so the
 * service's own disk-write footprint stays limited to the 3 mirror files it owns. Pass `--dry-run`
 * to print instead of writing.
 *
 * Also the **(o)** promotion channel (Aperas-crud-design.md §4/§6): projecting a holder
 * Folder/Artifact for the first time is exactly how it becomes real. Gated on purity (no holder
 * descendant anywhere in the subtree — `hasHolderDescendant`), and — only when actually writing,
 * never for `--dry-run` — refreshes the bookkeeping a real disk-based ingest would otherwise own:
 * `.holder` cleared, `.text` derived from the live graph (`deriveAbstractFromLiveChildren`), and for
 * an `ArtifactNode` specifically, `fileHash`/`ingestedHash`/`lastIngestedAt` set from the markdown
 * about to be written — safe to compute *before* the client's own `writeFileSync` runs, since once
 * that write lands unchanged, the real file's hash is exactly `computeFileHash(markdown)` by
 * construction. Skipping this for `--dry-run` matters: nothing is actually written then, so marking
 * the node "promoted"/"file-synced" would be a lie the store would carry forward regardless.
 *
 * `force` (Aperas-crud-design.md §16) — §14's issue, reciprocal direction: a real write here would
 * silently clobber anything that changed the file on disk since the graph's last known-good state
 * (a hand-edit, an external tool, an older `git checkout`), with no way to tell "this is fine" from
 * "this destroys something." Held back the same way §14 holds back a destructive reconciliation:
 * read the file that's about to be overwritten (if it exists) and compare its hash against the
 * field that already means "the graph's last known disk content" for that kind — `fileHash` for
 * `ArtifactNode` (kept in lockstep by *both* directions: a real `kg:track`/`kg:ingest` read sets it,
 * and this very write path sets it too, so it's already exactly "what disk should currently read as,
 * as far as the graph knows" regardless of which direction last touched it), `projectedHash` for
 * `FolderNode` (no `fileHash`-equivalent baseline exists for a folder's README otherwise). A mismatch
 * — or an `ArtifactNode` that's never been read from disk at all (`fileHash` unset) with a file
 * already sitting at its target path — holds back instead of writing, unless `force`.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Store } from 'oxigraph';
import { findByExactPath } from '@aperas/core/apeironNgn/tree';
import { nodeKindFromId } from '@aperas/core/apeironNgn/vocab';
import { wrap, hasHolderDescendant, deriveAbstractFromLiveChildren, type ArtifactNode, type FolderNode, type TreeNode } from '@aperas/core/apeironNgn/node';
import { getArtifactsDir, computeFileHash } from '@aperas/core/artifacts';
import { createLineReader } from '@aperas/core/lineReader';
import { ensureServiceRunning, request } from './apeironNgn/serviceClient';
import { wantsHelp, printHelp } from './kgHelp';

export function runProject(store: Store, path: string, dryRun: boolean, force: boolean = false) {
  const id = findByExactPath(store, path);
  const kind = id ? nodeKindFromId(id) : null;
  if (kind !== 'ArtifactNode' && kind !== 'FolderNode') {
    throw new Error(`No ingested ArtifactNode or FolderNode found for '${path}'.`);
  }

  if (hasHolderDescendant(wrap(store, id!) as unknown as TreeNode)) {
    throw new Error(
      `'${path}' still has a placeholder (holder) node somewhere in its subtree — projecting it ` +
      `would silently bake placeholder content into a real file. Promote or remove it first.`
    );
  }

  // Artifact addressing writes back to the same path it was found at; folder addressing reads
  // the FolderNode's own `path` field (its README's directory, `.` for the artifacts root) rather
  // than reusing the lookup path verbatim.
  let markdown: string | null;
  let targetFile: string;
  if (kind === 'ArtifactNode') {
    const artifact = wrap(store, id!) as unknown as ArtifactNode;
    markdown = artifact.toMarkdown();
    targetFile = join(getArtifactsDir(), path);
  } else {
    const folder = wrap(store, id!) as unknown as FolderNode;
    markdown = folder.toReadme();
    const folderPath = folder.path as unknown as string;
    targetFile = join(getArtifactsDir(), folderPath === '.' ? '' : folderPath, 'README.md');
  }

  if (markdown === null) {
    throw new Error(`Projection produced no content for '${path}'.`);
  }

  if (!dryRun) {
    const onDiskHash = existsSync(targetFile) ? computeFileHash(readFileSync(targetFile, 'utf-8')) : null;
    // `ArtifactNode.fileHash` is refreshed by *both* directions (a real `kg:track`/`kg:ingest` read,
    // and this very write path), so `undefined` there genuinely means "graph has never read this
    // path" — a pre-existing file the graph knows nothing about is exactly as much a conflict as a
    // hand-edit would be. `FolderNode.projectedHash` has no such dual-direction history (a folder's
    // README is never hash-tracked by ordinary ingestion) — `undefined` there just means "never
    // projected yet," the ordinary first-projection-of-an-already-ingested-folder case, not a
    // conflict; only a *set* `projectedHash` that no longer matches disk counts as one.
    const conflict = kind === 'ArtifactNode'
      ? onDiskHash !== null && onDiskHash !== (wrap(store, id!) as unknown as ArtifactNode).fileHash
      : (() => {
          const knownHash = (wrap(store, id!) as unknown as FolderNode).projectedHash;
          return onDiskHash !== null && knownHash !== undefined && onDiskHash !== knownHash;
        })();
    if (conflict && !force) {
      return { conflict: true as const, path, targetFile };
    }

    if (kind === 'ArtifactNode') {
      const artifact = wrap(store, id!) as unknown as ArtifactNode;
      artifact.holder = undefined;
      artifact.text = deriveAbstractFromLiveChildren(artifact as unknown as TreeNode) || undefined;
      const hash = computeFileHash(markdown);
      artifact.fileHash = hash;
      artifact.ingestedHash = hash;
      artifact.lastIngestedAt = new Date().toISOString();
      // Aperas-crud-design.md §15: the "reverse track" baseline — what `kg:track --reverse` compares
      // a fresh render against to detect drift. Set on every real write, not just first promotion.
      artifact.projectedHash = hash;
    } else {
      const folder = wrap(store, id!) as unknown as FolderNode;
      folder.holder = undefined;
      folder.text = deriveAbstractFromLiveChildren(folder as unknown as TreeNode) || undefined;
      folder.projectedHash = computeFileHash(markdown);
    }
  }

  return { markdown, targetFile };
}

export async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (wantsHelp(rawArgs)) {
    printHelp({
      description: "Serialize a tracked ArtifactNode/FolderNode's tree back to Markdown.",
      usage: 'aperas project <path> [--dry-run] [--force] [--reload]',
      args: [
        { name: '<path>', description: 'Tracked artifact or folder path to serialize. An artifact writes back to the same path; a folder writes to its README.' },
      ],
      flags: [
        { name: '--dry-run', description: 'Print the rendered Markdown instead of writing it to disk — also skips the promotion bookkeeping a real write triggers (Aperas-crud-design.md §6).' },
        { name: '--force', description: "Overwrite even if the file on disk has changed since this artifact/folder's last known content, without asking. Use for non-interactive/scripted runs." },
        { name: '--flush', description: 'Force an immediate sync to disk after this call, instead of waiting for the normal flush timer. Ignored with --dry-run (nothing is mutated).' },
        { name: '--reload', description: 'Reload the store from disk first, in case something else (e.g. a git pull) changed it since the service started.' },
      ],
    });
    return;
  }
  const dryRun = rawArgs.includes('--dry-run');
  const flush = rawArgs.includes('--flush');
  const reload = rawArgs.includes('--reload');
  const force = rawArgs.includes('--force');
  const [path] = rawArgs.filter((p) => p !== '--dry-run' && p !== '--flush' && p !== '--reload' && p !== '--force');
  if (!path) {
    console.error('Usage: aperas project <path> [--dry-run] [--force] [--flush] [--reload]');
    process.exit(1);
  }

  await ensureServiceRunning();
  let result = await request<ReturnType<typeof runProject>>({ op: 'project', path, dryRun, force, flush, reload });

  if ('conflict' in result) {
    console.log(`\n[ApeironNgn kg:project] '${path}' has changed on disk since this artifact/folder's last known content (a hand-edit, an external tool, or it was never read from disk at all) — projecting now would overwrite it.`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const lines = createLineReader(rl);
    process.stdout.write('Overwrite anyway? [yes/NO]: ');
    const raw = await lines.next();
    rl.close();
    const answer = (raw ?? '').trim().toLowerCase();
    if (answer === 'yes' || answer === 'y') {
      result = await request<ReturnType<typeof runProject>>({ op: 'project', path, dryRun, force: true, flush, reload: false });
    } else {
      console.log('[ApeironNgn kg:project] Skipped — nothing was written. Re-run with --force, or answer yes, to overwrite.');
      return;
    }
  }

  if ('conflict' in result) {
    // Unreachable in practice (the retry above always sends force: true), but keeps the type
    // narrowing below honest without a cast.
    throw new Error(`Unexpected: '${path}' still conflicted after a forced retry.`);
  }

  const { markdown, targetFile } = result;
  if (dryRun) {
    console.log(markdown);
  } else {
    // Confirmed live: a promoted Folder/Artifact's own directory may never have existed on disk
    // (it was a holder, minted purely in-graph) — writeFileSync doesn't create parent directories,
    // and the server has already committed the (o) promotion bookkeeping (`.holder` cleared,
    // fileHash/ingestedHash set from this exact markdown) by the time this runs, on the assumption
    // that the write about to happen here will succeed. Create the directory first so that
    // assumption actually holds, rather than leaving the node believing it's file-backed when the
    // write silently failed.
    mkdirSync(dirname(targetFile), { recursive: true });
    writeFileSync(targetFile, markdown, 'utf-8');
    console.log(`[ApeironNgn kg:project] Projected '${path}' to '${targetFile}'.`);
  }
}

if (process.argv[1]?.endsWith('kgProject.ts')) {
  main().catch((err) => {
    console.error('[ApeironNgn kg:project] Failed:', err.message || err);
    process.exit(1);
  });
}
