/**
 * Aperas Artifact filesystem helpers — engine-agnostic (Aperas-apeironngn-design.md §4 rollout,
 * archiving step). This file used to also hold the TerminusDB-backed track/ingest functions;
 * those moved to `artifactsTdb.ts` (with `kgCli.ts`/`client.ts`/etc., all headed to `.archive/`)
 * since `apeironNgn/artifacts.ts`/`apeironNgn/node.ts`/`apeironNgn/folders.ts` depend directly on
 * what's left here (`getArtifactsDir`, `listArtifactFiles`, `computeFileHash`, `isReadmeFilename`,
 * `extractLinkCodes`) and can't move with them.
 */

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type { ParsedBlockNode, LinkOccurrence } from './astParser';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getArtifactsDir(): string {
  // web/src/lib -> web -> repo root -> AperasKG/artifacts
  return resolve(__dirname, '..', '..', '..', 'AperasKG', 'artifacts');
}

/** A directory's own `README.md` is absorbed directly into its `FolderNode` (`folders.ts`'s
 *  `buildFolderTree`) and must never also be tracked/ingested as an ordinary `ArtifactNode` —
 *  shared here (not duplicated in `folders.ts`) so both file-walkers agree on one definition. */
export function isReadmeFilename(filename: string): boolean {
  return filename.toLowerCase() === 'readme.md';
}

/**
 * Recursively lists every artifact file path, relative to the artifacts directory. Excludes
 * each directory's own `README.md` — that file is absorbed into its `FolderNode`, never
 * exposed as a separate `ArtifactNode` (previously a real bug: this list had no such exclusion,
 * so `ingestAllArtifacts` ingested every README as an ordinary artifact *in addition to*
 * `folders.ts`'s own absorption, leaving a redundant, orphaned `ArtifactNode` nothing
 * referenced — see `Aperas-dev-status.md`).
 */
export function listArtifactFiles(artifactsDir: string = getArtifactsDir()): string[] {
  const files: string[] = [];

  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (entry.endsWith('.md') && !entry.startsWith('.') && !isReadmeFilename(entry)) {
        // Only tracked markdown artifacts — excludes editor swap/lock files (.foo.md.swp),
        // dotfiles, and any other transient junk that can appear alongside real content.
        files.push(relative(artifactsDir, fullPath));
      }
    }
  }

  walk(artifactsDir);
  return files;
}

/** Expands each given path against `AperasKG/artifacts/`: a directory (e.g. `archive`, or `.` for
 *  everything) becomes every artifact file under it, recursively, via `listArtifactFiles` scoped
 *  to that subtree; a plain file path passes through unchanged (including one that doesn't exist —
 *  the caller's existing per-file error handling still applies). Lets `kg:track`/`kg:ingest` take
 *  a folder argument alongside individual file paths. */
export function expandArtifactPaths(paths: string[], artifactsDir: string = getArtifactsDir()): string[] {
  const expanded: string[] = [];
  for (const p of paths) {
    const full = join(artifactsDir, p);
    if (existsSync(full) && statSync(full).isDirectory()) {
      expanded.push(...listArtifactFiles(full).map((f) => join(p, f)));
    } else {
      expanded.push(p);
    }
  }
  return expanded;
}

export function computeFileHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

// A quick count function just for logging/reporting.
export function countBlocks(node: any): number {
  return 1 + (node.children || []).reduce((sum: number, child: any) => sum + countBlocks(child), 0);
}

export interface PendingLinkCodes {
  blockId: string;
  codes: LinkOccurrence[];
}

/**
 * Strips `linkCodes` off every node in the tree (it's parser-only bookkeeping — `schema.json`
 * has no such field, so leaving it in on the big write below fails schema check with
 * `unknown_property_for_type`, confirmed live), collecting `{blockId, codes}` pairs along the
 * way for a caller to resolve in its own separate pass afterward (`artifactsTdb.ts`'s
 * `resolveBlockLinks`, `apeironNgn/artifacts.ts`'s own version). Called *before* the write; link
 * resolution itself runs *after* it (see either resolveBlockLinks's own doc comment).
 */
export function extractLinkCodes(node: ParsedBlockNode, out: PendingLinkCodes[] = []): PendingLinkCodes[] {
  if (node.linkCodes && node.linkCodes.length > 0) {
    out.push({ blockId: node.blockId, codes: node.linkCodes });
  }
  delete node.linkCodes;
  for (const child of node.children ?? []) {
    extractLinkCodes(child, out);
  }
  return out;
}
