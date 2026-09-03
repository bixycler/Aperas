/**
 * Aperas Phase 0: Temporal Commit Management
 *
 * Wraps TerminusDB's Git-like version control primitives — every write already lands
 * as an immutable commit (see commit metadata threaded through crud.ts); this module
 * covers the remaining time-travel surface: branching, history, diffing, merging, and reset.
 */

export interface CommitLogEntry {
  identifier?: string;
  author?: string;
  message?: string;
  timestamp?: number;
  [key: string]: any;
}

/**
 * Creates a new branch from the client's current context (or an empty branch if isEmpty is true).
 * Used to let agents draft speculative graph updates on a proposal branch without
 * touching main until a human or coherence agent reviews and merges them.
 */
export async function createBranch(client: any, branchId: string, isEmpty: boolean = false): Promise<any> {
  console.log(`[Aperas VCS] Creating branch '${branchId}'${isEmpty ? ' (empty)' : ''}...`);
  return client.branch(branchId, isEmpty);
}

/**
 * Switches the client's context to the given branch; subsequent CRUD/WOQL calls operate against it.
 */
export function checkoutBranch(client: any, branchId: string): string {
  console.log(`[Aperas VCS] Checking out branch '${branchId}'...`);
  return client.checkout(branchId);
}

/**
 * Deletes a branch, e.g. after a proposal branch has been merged or rejected.
 */
export async function deleteBranch(client: any, branchId: string): Promise<any> {
  return client.deleteBranch(branchId);
}

/**
 * Deletes a branch if it exists — best-effort, so seed/demo scripts that create a
 * fixed-name branch each run stay re-runnable instead of failing on "already exists".
 */
export async function deleteBranchIfExists(client: any, branchId: string): Promise<void> {
  try {
    await client.deleteBranch(branchId);
  } catch (err) {
    // Not found is the expected outcome on a clean database — nothing to reset.
  }
}

/**
 * Retrieves the commit history for the current branch — the audit trail behind the
 * Provenance view (History – Audit deltas) described in the Aperas node epistemology.
 */
export async function getCommitHistory(client: any, start: number = 0, count: number = 20): Promise<CommitLogEntry[]> {
  const history = await client.getCommitsLog(start, count);
  return Array.isArray(history) ? history : [];
}

/**
 * Retrieves the full revision history of a single reified node/document.
 */
export async function getNodeHistory(client: any, nodeId: string, count: number = 10): Promise<CommitLogEntry[]> {
  const history = await client.getDocumentHistory(nodeId, { count });
  return Array.isArray(history) ? history : [];
}

/**
 * Diffs two arbitrary JSON documents (e.g. a proposed edit against the stored node).
 */
export async function diffDocuments(client: any, before: any, after: any): Promise<any> {
  return client.getJSONDiff(before, after);
}

/**
 * Diffs a single document's state between two commits/branches — the basis for advisory
 * invalidation: showing a human or coherence agent exactly what changed before accepting it.
 */
export async function diffNodeVersions(
  client: any,
  beforeVersion: string,
  afterVersion: string,
  nodeId: string
): Promise<any> {
  return client.getVersionDiff(beforeVersion, afterVersion, nodeId);
}

/**
 * Merges a source branch into the currently checked-out (target) branch by applying the
 * diff between the two. TerminusDB has no `mergeBranch` — `apply` is the merge primitive.
 */
export async function mergeBranch(
  client: any,
  sourceBranch: string,
  targetBranch: string,
  message: string
): Promise<any> {
  client.checkout(targetBranch);
  return client.apply(sourceBranch, targetBranch, message, false);
}

/**
 * Moves the current branch's HEAD back to a specific commit — used to roll back a
 * branch after an agent's write is found to violate boundary schema rules or intent.
 */
export async function resetToCommit(client: any, commitPath: string): Promise<any> {
  console.log(`[Aperas VCS] Resetting current branch to commit '${commitPath}'...`);
  return client.reset(commitPath);
}
