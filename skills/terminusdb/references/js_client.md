# TerminusDB JavaScript / TypeScript Client Reference

## Installation

```bash
npm install terminusdb
```

`terminusdb` is the current, actively-published, TypeScript-first package (npm shows it ahead of `@terminusdb/terminusdb-client` as of early 2026). You may encounter older code/tutorials using:

```bash
npm install @terminusdb/terminusdb-client
```

That package still works (same API shape) but is not the one current official docs lead with — prefer `terminusdb` unless you're maintaining code already tied to the older package name.

## Import & Connect

```typescript
import TerminusClient from "terminusdb"
const { WOQL } = TerminusClient

const client = new TerminusClient.WOQLClient("http://localhost:6363", {
  user: "admin",
  organization: "admin",
  key: "root", // matches TERMINUSDB_ADMIN_PASS on the server, see server_setup.md
})

const info = await client.info() // throws/rejects if the server is unreachable or creds are wrong
```

CommonJS works the same way: `const TerminusClient = require("terminusdb")`.

## Database Operations

```typescript
// Create
await client.createDatabase("MyDatabase", {
  label: "My Database",
  comment: "created from the JS client",
  schema: true, // enable schema validation; omit/false for schema-less quickstart use
})

// Switch context to a database for subsequent calls
client.db("MyDatabase")

// Delete
await client.deleteDatabase("MyDatabase")
```

## Document CRUD

The Document API takes plain JSON-LD objects (or arrays of them) and an options object.

```typescript
// Add one document
const doc = { "@type": "Player", name: "George", position: "Center Back" }
const result = await client.addDocument(doc)

// Add many
const result = await client.addDocument(players)

// Add schema documents (note graph_type option)
const result = await client.addDocument(schema, { graph_type: "schema" })

// Read by id
const person = await client.getDocument({ id: "terminusdb:///data/jane", as_list: true })

// Read all of a type
const people = await client.getDocument({ type: "Person", as_list: true })

// Update — pass the full document plus any commit metadata
await client.updateDocument(
  { "@id": "terminusdb:///data/jane", name: "Jane Smith", email: "jane.smith@company.com" },
  { raw_json: true },
)

// Delete
await client.deleteDocument({ id: ["terminusdb:///data/jane"] })
```

`raw_json: true` tells the client to send the object as-is without extra JSON-LD framing — handy for quick schema-less inserts. For real commits you generally want to pass author/message via `commit_info: { author, message }` inside the options object so history is meaningful (see [version_control.md](version_control.md)).

## WOQL from the JS client

`WOQL` is exposed off the client module (`TerminusClient.WOQL`). See [woql_queries.md](woql_queries.md) for the full query syntax (both the nested `WOQL.and(...)` style and the `Vars()` + chained style) — both are executed the same way:

```typescript
const result = await client.query(query)
console.log(result.bindings)
```
