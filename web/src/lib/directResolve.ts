/**
 * The identity-only half of node addressing (Aperas-basic-assertion-skill-design.md §2): a full
 * node id passes through unchanged (never existence-checked — direct addressing trusts the
 * caller); a bare snowflake code (Crockford Base32, 13 chars — the exact shape
 * generateNodeId()/snowflake.ts always produces) is tried as BlockNode, then ArtifactNode, then
 * FolderNode, since all three share one generation scheme/namespace and a bare code alone
 * doesn't say which class it belongs to.
 *
 * Deliberately a leaf module with no dependency on artifacts.ts/folders.ts. Both need this —
 * artifacts.ts to resolve `[[code]]` inline link targets at ingestion time (Aperas-markdown-
 * fractal-mapping-design.md §4 — the canonical example there, `[[00C5H15NT0000]]`, is exactly a
 * bare snowflake code, never a human-typed path), and nodeRef.ts to extend this with a
 * bare-path fallback for CLI addressing — so this stays a leaf to avoid a cycle either way
 * would otherwise create importing back into artifacts.ts/folders.ts.
 */

const FULL_NODE_ID_RE = /^(BlockNode|ArtifactNode|FolderNode)\//;
const BARE_SNOWFLAKE_RE = /^[0-9A-HJKMNP-TV-Z]{13}$/;

export async function resolveDirectOrSnowflake(client: any, ref: string): Promise<string | null> {
  if (FULL_NODE_ID_RE.test(ref)) return ref;
  if (!BARE_SNOWFLAKE_RE.test(ref)) return null;

  for (const kind of ['BlockNode', 'ArtifactNode', 'FolderNode']) {
    try {
      const doc = await client.getDocument({ id: `${kind}/${ref}` });
      if (doc && typeof doc !== 'string' && !doc.tombstonedAt) return `${kind}/${ref}`;
    } catch {
      // Not this kind — try the next.
    }
  }
  return null;
}
