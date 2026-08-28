/**
 * Aperas Phase 1: GraphQL Query Execution
 *
 * TerminusDB auto-generates a GraphQL endpoint per database (schema-derived) at
 * `api/graphql/<organization>/<database>`. The JS client has no built-in GraphQL
 * helper, so requests are dispatched through `client.sendCustomRequest`, which reuses
 * the client's existing auth/session context instead of hand-rolling a fetch call.
 *
 * Why GraphQL and not the plain Document API for tree reads: the Document API *can*
 * return a full nested `BlockNode` tree in one call too, via a `"@unfoldable": []`
 * class-level schema annotation (not `@subdocument` — a common mix-up; see
 * AperasKG/artifacts/Aperas-architecture.md §2's "Read-path note" for the full
 * investigation). We
 * benchmarked it on the real 149-block `Aperas-core-ontology-design.md` tree and it
 * was ~3.5x slower than this GraphQL path (~48ms vs ~13.5ms steady-state). Marking
 * `BlockNode` `@unfoldable` would also apply globally to every reference to it, not
 * just artifact-tree reads, which is a wider blast radius than an explicit,
 * bounded-depth query. We also hit a real upstream bug in the sibling mechanism
 * (property-level `@unfold: true` on `List` fields silently does nothing — filed as
 * terminusdb/terminusdb#2512), which doesn't affect this decision directly (class-level
 * `@unfoldable` works correctly) but is a data point that the unfold subsystem overall
 * is new and still maturing.
 *
 * One real gap this surfaced: a single bounded-depth query silently truncates a tree
 * deeper than `maxDepth`, with no error and no signal in the response, confirmed live
 * (see `resolveTruncatedSubtrees` below). Not just theoretical — content genuinely
 * without a natural depth bound (e.g. an uncut Logseq-style outline) can exceed any
 * fixed cutoff easily. `getArtifactTreeViaGraphQL` detects and re-fetches past
 * `maxDepth` automatically, so it always returns the whole tree regardless of depth.
 */

export interface GraphQLResponse<T = any> {
  data?: T;
  errors?: Array<{ message: string; [key: string]: any }>;
}

/**
 * Builds the URL of the auto-generated GraphQL endpoint for the client's current database.
 */
export function buildGraphQLEndpoint(client: any, dbId?: string, organization?: string): string {
  const org = organization || client.organization();
  const db = dbId || client.db();
  return `${client.connectionConfig.apiURL()}graphql/${org}/${db}`;
}

/**
 * Executes a GraphQL query (or mutation) against the Aperas Apeiron substrate's
 * auto-generated GraphQL endpoint.
 */
export async function executeGraphQLQuery<T = any>(
  client: any,
  query: string,
  variables: Record<string, any> = {},
  opts: { dbId?: string; organization?: string } = {}
): Promise<GraphQLResponse<T>> {
  const endpoint = buildGraphQLEndpoint(client, opts.dbId, opts.organization);

  console.log(`[Aperas GraphQL] Executing query against ${endpoint}...`);
  const response: GraphQLResponse<T> = await client.sendCustomRequest('POST', endpoint, {
    query,
    variables
  });

  if (response?.errors?.length) {
    console.error(`[Aperas GraphQL] Query returned ${response.errors.length} error(s):`, response.errors);
  }

  return response;
}

/**
 * Recursively builds a bounded-depth BlockNode field selection. GraphQL has no
 * built-in recursion, so a fractal tree of unbounded depth has to be queried to some
 * explicit cutoff. At the cutoff, `children` simply isn't selected at all — a node
 * genuinely without children still comes back with `children: []` (we asked, there
 * were none), but a node truncated by `maxDepth` comes back with the `children` key
 * *absent entirely* (we never asked). That distinction is what
 * `resolveTruncatedSubtrees` below uses to detect and re-fetch past the cutoff, so a
 * tree deeper than `maxDepth` (e.g. an uncut Logseq-style outline with no natural
 * depth bound) is never silently returned incomplete.
 */
function blockFieldSelection(depth: number): string {
  const ownFields = 'blockId type title text unfolded';
  if (depth <= 0) return ownFields;
  return `${ownFields} children { ${blockFieldSelection(depth - 1)} }`;
}

async function fetchBlockSubtree(client: any, blockId: string, maxDepth: number): Promise<any | null> {
  const query = `
    query BlockSubtree($blockId: String!) {
      BlockNode(filter: { blockId: { eq: $blockId } }) {
        ${blockFieldSelection(maxDepth)}
      }
    }
  `;
  const result = await executeGraphQLQuery(client, query, { blockId });
  const matches: any[] = result.data?.BlockNode ?? [];
  return matches[0] ?? null;
}

/** Nodes where the `children` key is absent (truncated by the depth cutoff), not just empty. */
function findTruncationPoints(node: any, out: any[] = []): any[] {
  if (!node) return out;
  if (!('children' in node)) {
    out.push(node);
    return out;
  }
  for (const child of node.children) {
    findTruncationPoints(child, out);
  }
  return out;
}

/**
 * Re-fetches from every node the initial query didn't reach the bottom of, splicing
 * each subtree back in place, repeating until the whole tree is resolved regardless
 * of its actual depth. A no-op (zero extra queries) whenever the tree is shallower
 * than maxDepth, which is the common case for ordinary Markdown artifacts.
 */
async function resolveTruncatedSubtrees(client: any, node: any, maxDepth: number): Promise<void> {
  const truncated = findTruncationPoints(node);
  if (truncated.length === 0) return;

  for (const leaf of truncated) {
    const subtree = await fetchBlockSubtree(client, leaf.blockId, maxDepth);
    leaf.children = subtree?.children ?? [];
  }
  await Promise.all(truncated.map((leaf) => resolveTruncatedSubtrees(client, leaf, maxDepth)));
}

/**
 * Fetches an ArtifactNode and its fractal BlockNode tree via GraphQL, as an
 * alternative read path to the Document API for projection agents that prefer
 * GraphQL joins. Always returns the tree in full, however deep it actually goes —
 * `maxDepth` only controls how many levels each individual query fetches at once
 * (bigger is more efficient for typical docs, smaller is cheaper if truncation and
 * re-fetching is expected to be common), not how deep the result can be.
 */
export async function getArtifactTreeViaGraphQL(client: any, path: string, maxDepth: number = 10): Promise<any | null> {
  const query = `
    query ArtifactTree($path: String!) {
      ArtifactNode(filter: { path: { eq: $path } }) {
        path
        fileHash
        ingestedHash
        root {
          ${blockFieldSelection(maxDepth)}
        }
      }
    }
  `;

  const result = await executeGraphQLQuery(client, query, { path });
  const matches: any[] = result.data?.ArtifactNode ?? [];
  const artifact = matches[0] ?? null;
  if (!artifact?.root) return artifact;

  await resolveTruncatedSubtrees(client, artifact.root, maxDepth);
  return artifact;
}
