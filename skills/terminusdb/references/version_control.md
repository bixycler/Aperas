# TerminusDB Version Control Reference (JS client)

TerminusDB tracks every write as a commit, and databases can be branched/diffed/merged like a Git repo. These method names are taken directly from the current `terminusdb-client-js` source — some differ from what you might expect (or from stale tutorials) as noted inline.

## Branching

```typescript
// Create a branch from the client's current context (branch/ref)
await client.branch("feature/add-department-schema")

// Optionally start it empty rather than copying current data
await client.branch("feature/empty-branch", /* isEmpty */ true)

// Delete a branch
await client.deleteBranch("feature/add-department-schema")
```

There is **no `createBranch`/`getBranches` method** despite what some older examples show — branch creation is `client.branch(newBranchId, isEmpty)`, and there's no dedicated "list branches" call on the client; branches show up as refs under the database.

## Switching context

```typescript
client.checkout("feature/add-department-schema")
```

`checkout` gets or sets which branch subsequent calls (`addDocument`, `query`, etc.) operate against.

## Committing

Every write (`addDocument`, `updateDocument`, `deleteDocument`, or a WOQL insert/delete) *is* a commit — pass commit metadata through the call's options rather than committing as a separate step:

```typescript
await client.addDocument(
  { "@type": "Department", "@id": "Department/engineering", name: "Engineering" },
  { commit_info: { author: "dev@example.com", message: "Add engineering department" } },
)
```

## Commit history

```typescript
const history = await client.getCommitsLog(0, 20) // start=0, count=20 (count defaults to 1 if omitted)
```

## Diffing

```typescript
// Diff two arbitrary JSON documents
const patch = await client.getJSONDiff(beforeDoc, afterDoc)

// Diff two versions/branches/commits of the same document by id
const diff = await client.getVersionDiff(beforeVersion, afterVersion, documentId)

// Full history of one document
const history = await client.getDocumentHistory(documentId, { count: 10 })
```

## Merging — `apply`, not `mergeBranch`

There is no `mergeBranch` method. Merging is done by checking out the target branch and *applying* the diff between two versions onto it:

```typescript
client.checkout("main")

await client.apply(
  "feature/add-department-schema", // beforeVersion / source
  "main",                          // afterVersion / target — check current docs for exact arg semantics on your version
  "Merge feature/add-department-schema into main",
  /* matchFinalState */ false,
)
```

The exact positional meaning of `beforeVersion`/`afterVersion` in `apply` is easy to get backwards — treat this as "check the installed client's type signature or run a throwaway test merge on a scratch database" before relying on it for anything with real history behind it, rather than trusting any single online example (including this one) blindly.

## Reset

```typescript
// Move the current branch's HEAD to a specific commit
await client.reset(commitPath)
```

## Optimize / squash (maintenance)

```typescript
await client.squashBranch("feature/add-department-schema", "Squash before merge")
await client.optimizeBranch("main")
```
