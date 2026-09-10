/**
 * Aperas internal-linking leading-part translator (AperasKG/artifacts/design/linking.md's
 * Topology section, `planning/linking.md`'s Slice 1 Task 2) — pure/engine-agnostic, like
 * `nodeRef.ts`. Converts between an artifact's canonical path (root-relative, `/`-joined, the same
 * form `ArtifactNode.path`/`FolderNode.path` already store) and an ordinary OS-style relative file
 * path (the "compatible/pre-ingestion" context's own leading part, before its `#fragment`).
 *
 * Deliberately its own module, not folded into `resolveCreate.ts`'s `descend()`: that function's
 * own `..` handling counts every path segment — folder, filename, heading — as one uniform hop (the
 * deep-path grammar's own address family, `aperas://tree/...`), which is a different counting rule
 * than an ordinary relative file path uses (a filename is never its own directory level). Resolving
 * a compatible-context fragment link at all (`apeironNgn/artifacts.ts`'s `resolveBlockLinks`)
 * already needs the relative→canonical half just to find a candidate; the canonical→relative half
 * is unused until the cleanup pass (Slice 2) needs to emit/rewrite a compatible link from an
 * already-resolved target — built together here rather than split across two slices, which would
 * mean designing the same path arithmetic twice, inconsistently.
 */

/**
 * Resolves `relativePath` (an ordinary OS-style relative file path, e.g. `"../design/linking.md"`,
 * or `""` for a same-document reference) against `currentArtifactPath` (the artifact containing the
 * link, e.g. `"issues/linking.md"`) into a concrete canonical artifact path. `.`/empty segments are
 * no-ops; `..` pops one real directory level (the containing artifact's own *filename* is never a
 * level to pop — `currentArtifactPath`'s own dirname is where navigation starts, exactly like
 * resolving an ordinary relative link on disk). Returns `null` only on an authoring error: a `..`
 * that walks back past the artifacts root.
 */
export function relativeToCanonicalArtifactPath(currentArtifactPath: string, relativePath: string): string | null {
  if (relativePath === '') return currentArtifactPath; // same-document reference — no navigation at all
  const stack = currentArtifactPath.split('/').slice(0, -1);
  for (const part of relativePath.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (stack.length === 0) return null;
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack.length ? stack.join('/') : null;
}

/**
 * The reverse half: the OS-style relative path from `currentArtifactPath`'s own directory to
 * `targetArtifactPath` — what the cleanup pass (Slice 2) uses to emit a compatible
 * `../folder/file#...` reference for an already-resolved target. Pops one `..` per directory level
 * of `currentArtifactPath` not shared with `targetArtifactPath`'s own containing path, then descends
 * the rest — the standard "shared-prefix" relative-path construction, kept beside its inverse so the
 * two directions agree on the same segment-counting rule.
 */
export function canonicalArtifactPathToRelative(currentArtifactPath: string, targetArtifactPath: string): string {
  const currentDir = currentArtifactPath.split('/').slice(0, -1);
  const targetSegments = targetArtifactPath.split('/');
  let commonLength = 0;
  while (
    commonLength < currentDir.length &&
    commonLength < targetSegments.length - 1 &&
    currentDir[commonLength] === targetSegments[commonLength]
  ) {
    commonLength++;
  }
  const ups = currentDir.length - commonLength;
  const downs = targetSegments.slice(commonLength);
  return [...Array(ups).fill('..'), ...downs].join('/');
}
