/**
 * Aperas Phase 0: GraphQL Query Execution
 *
 * TerminusDB auto-generates a GraphQL endpoint per database (schema-derived) at
 * `api/graphql/<organization>/<database>`. The JS client has no built-in GraphQL
 * helper, so requests are dispatched through `client.sendCustomRequest`, which reuses
 * the client's existing auth/session context instead of hand-rolling a fetch call.
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
 * Fetches all BlockNodes belonging to a DocumentNode via GraphQL, as an alternative
 * read path to the Document API / WOQL for projection agents that prefer GraphQL joins.
 */
export async function getDocumentBlocksViaGraphQL(client: any, docId: string): Promise<any[]> {
  const query = `
    query BlocksForDocument($docId: String!) {
      BlockNode(filter: { docId: { eq: $docId } }) {
        blockId
        docId
        nodeType
        content
        startOffset
        endOffset
      }
    }
  `;

  const result = await executeGraphQLQuery(client, query, { docId });
  return result.data?.BlockNode ?? [];
}
