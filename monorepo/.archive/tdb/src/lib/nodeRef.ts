/**
 * Aperas node addressing — pure/engine-agnostic pieces (Aperas-basic-assertion-skill-design.md
 * §2, Aperas-deep-path-resolution-design.md §2). `apeironNgn/node.ts`/`resolveCreate.ts`/
 * `resolve.ts` import `slugify`/`tokenize`/`pathToNameTokens`/`Token` directly. The TerminusDB
 * `client`-based resolver (`resolveNodeRefDetail`/`resolveNodeRefOrNull`/`resolveIdToPath`, and
 * everything they call) moved to `nodeRefTdb.ts` (Aperas-apeironngn-design.md §4 rollout,
 * archiving step), headed to `.archive/` with `kgCli.ts`.
 */

/**
 * One rule, deliberately not collapsing runs or trimming edges: every individual non-
 * alphanumeric character becomes its own `-`, preserving exact length/position rather than
 * folding different inputs toward the same output — maximal distinction over cosmetic
 * prettiness. No special-casing for a heading's leading `#`/`##` marker either; under this
 * blanket rule it's just another character that becomes a `-` like any other, no AST-awareness
 * needed. Applied to both the candidate `BlockNode.title` and a query segment before comparing
 * (Aperas-deep-path-resolution-design.md §5), so either side matches on equal footing.
 */
export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '-');
}

// ---------------------------------------------------------------------------------------------
// Deep path resolution (Aperas-deep-path-resolution-design.md §1-7) tokenizer: shared by both
// the TerminusDB resolver (nodeRefTdb.ts) and ApeironNgn's own (resolveCreate.ts/resolve.ts).
// ---------------------------------------------------------------------------------------------

export type Token = { kind: 'self' } | { kind: 'up' } | { kind: 'name'; text: string };

/** §2's grammar: `.`/`..` are reserved at every segment position, everything else is a name. */
export function tokenize(path: string): Token[] {
  return path
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => (s === '.' ? { kind: 'self' } : s === '..' ? { kind: 'up' } : { kind: 'name', text: s }));
}

export function pathToNameTokens(path: string): Token[] {
  return path === '.' ? [] : path.split('/').map((text) => ({ kind: 'name', text }));
}
