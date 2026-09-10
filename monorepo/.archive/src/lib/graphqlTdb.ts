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

import { WIKILINK_PREDICATE } from './astParser';

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
// `props: Set<Prop>` (Prop abstract, StringProp its one concrete leaf — see props.ts) can't be
// queried with an inline fragment (`... on StringProp { value }`): TerminusDB's auto-generated
// GraphQL schema materializes `Prop` as its own concrete OBJECT type (confirmed live via
// introspection — `possibleTypes: null`), not an interface/union StringProp implements, so
// `value` (StringProp-only) is simply absent from the `Prop` object type altogether — asking
// for it errors ("objects of type Prop can never be of type StringProp"). `_json` is the escape
// hatch every generated type carries (a JSON-encoded dump of the full subdocument, `value`
// included) — `normalizeProps` below parses it back into the ordinary `{key, value}` shape
// every other reader/writer (astParser.ts, project.ts) already uses.
function blockFieldSelection(depth: number): string {
  const ownFields = 'blockId type title text unfolded props { key _json } links { _id predicate }';
  if (depth <= 0) return ownFields;
  return `${ownFields} children { ${blockFieldSelection(depth - 1)} }`;
}

/** Strips GraphQL's full-IRI `_id` (`terminusdb:///data/Link/xxx`) down to the short ref-id
 *  string (`Link/xxx`) every other reader/writer in this codebase uses for a document reference
 *  (e.g. `BlockNode.children`/`ArtifactNode.root` on a plain Document API read) — same shape
 *  `carryForwardFields` (reconcile.ts) expects so a carried-forward `links` array can be written
 *  straight back via `updateDocument` unchanged. */
const DATA_IRI_PREFIX = 'terminusdb:///data/';
function shortRefId(fullIri: string): string {
  return fullIri.startsWith(DATA_IRI_PREFIX) ? fullIri.slice(DATA_IRI_PREFIX.length) : fullIri;
}

/**
 * Normalizes every node's `links { _id predicate }` (raw GraphQL shape) into a plain ref-id-
 * string array, recursing through `children` — the `links` counterpart to `normalizeProps` below.
 * Drops every `WIKILINK_PREDICATE` entry rather than carrying it forward: `resolveBlockLinks`
 * (artifacts.ts) always regenerates a block's *complete* current set of wikilink-derived `Link`s
 * from its text on every ingest, so carrying old ones forward here would just make them duplicate
 * against that fresh batch instead of being cleanly replaced by it (confirmed live as a real
 * regression before this fix — see artifacts.ts's `resolveBlockLinks` doc comment). Only
 * `kg:link`-authored entries (`"references"`, or any future non-reserved predicate) survive the
 * carry-forward, which is exactly what should persist untouched across re-ingestion.
 */
function normalizeLinks(node: any): void {
  if (!node) return;
  if (Array.isArray(node.links)) {
    node.links = node.links
      .filter((l: any) => l.predicate !== WIKILINK_PREDICATE)
      .map((l: any) => shortRefId(l._id));
  }
  for (const child of node.children ?? []) {
    normalizeLinks(child);
  }
}

/** Parses each prop's `_json` dump back into a plain `{key, value}` StringProp, recursively. */
function normalizeProps(node: any): void {
  if (!node) return;
  if (Array.isArray(node.props)) {
    node.props = node.props.map((p: any) => {
      if (typeof p._json !== 'string') return p;
      try {
        const parsed = JSON.parse(p._json);
        return { "@type": "StringProp", key: p.key, value: parsed.value };
      } catch {
        return { "@type": "StringProp", key: p.key, value: undefined };
      }
    });
  }
  for (const child of node.children ?? []) {
    normalizeProps(child);
  }
}

/** Exported for `getFolderTreeViaGraphQL`, which reuses this to fetch each `BlockNode` child's
 *  own concrete subtree — homogeneous below the one polymorphic `FolderNode.children` hop, so
 *  the normal bounded-depth/truncation machinery applies unchanged from there. */
export async function fetchBlockSubtree(client: any, blockId: string, maxDepth: number): Promise<any | null> {
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
        props { key _json }
        root {
          ${blockFieldSelection(maxDepth)}
        }
      }
    }
  `;

  const result = await executeGraphQLQuery(client, query, { path });
  const matches: any[] = result.data?.ArtifactNode ?? [];
  const artifact = matches[0] ?? null;
  if (!artifact) return artifact;

  normalizeProps(artifact);
  if (artifact.root) {
    await resolveTruncatedSubtrees(client, artifact.root, maxDepth);
    normalizeProps(artifact.root);
    normalizeLinks(artifact.root);
  }
  return artifact;
}

/**
 * Fetches a FolderNode and its full content via GraphQL, using the hybrid polymorphism pattern
 * (Aperas-markdown-fractal-mapping-design.md §7): `FolderNode.children: List<BaseNode>` is
 * genuinely polymorphic (a real mix of `BlockNode` content and `ArtifactNode`/`FolderNode`
 * references), so that one hop is queried with `_type`/`_json` instead of typed field
 * selections — GraphQL rejects nesting a concrete-only field selection under an abstract type
 * outright (confirmed live: "Unknown field \"children\" on type \"BaseNode\""), so there is no
 * way to ask for more than one level through this field in a single query. Once a child's
 * concrete `_type` is known, though, a `BlockNode` child is homogeneous underneath — its own
 * `children: List<BlockNode>` — so `fetchBlockSubtree`'s ordinary bounded-depth/truncation
 * machinery fetches its full concrete subtree in the normal, fast way. `ArtifactNode`/
 * `FolderNode` children are left as bare references (id + path) — never inlined, since neither
 * one's own content is part of *this* folder's README.
 */
export async function getFolderTreeViaGraphQL(client: any, path: string, maxDepth: number = 10): Promise<any | null> {
  const query = `
    query FolderTree($path: String!) {
      FolderNode(filter: { path: { eq: $path } }) {
        folderId path title text
        props { key _json }
        children { _id _type _json }
      }
    }
  `;

  const result = await executeGraphQLQuery(client, query, { path });
  const matches: any[] = result.data?.FolderNode ?? [];
  const folder = matches[0] ?? null;
  if (!folder) return folder;

  normalizeProps(folder);

  const children: any[] = [];
  for (const child of folder.children ?? []) {
    let parsed: any;
    try {
      parsed = JSON.parse(child._json);
    } catch {
      continue;
    }
    if (child._type === 'BlockNode') {
      const subtree = await fetchBlockSubtree(client, parsed.blockId, maxDepth);
      if (subtree) {
        await resolveTruncatedSubtrees(client, subtree, maxDepth);
        normalizeProps(subtree);
        normalizeLinks(subtree);
        children.push(subtree);
      }
    } else {
      // ArtifactNode/FolderNode reference — not inlined, just identified.
      children.push({ _type: child._type, ...parsed });
    }
  }
  folder.children = children;
  return folder;
}
