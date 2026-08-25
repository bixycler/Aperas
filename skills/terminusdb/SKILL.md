---
name: terminusdb
description: Complete reference for TerminusDB, a Git-like open-source graph and document database — JSON-LD documents, WOQL queries, schema modeling, and branch/commit/merge version control on graph data. Use whenever the user mentions TerminusDB or TerminusCMS, WOQL (Web Object Query Language), a "graph database with version control" or "git for data", the `terminusdb` npm package or `terminusdb-client` pip package, the `terminusdb` CLI, or wants to design a JSON-LD schema, write a WOQL query, branch/diff/merge a database, or stand up a TerminusDB server via Docker — even if they don't say "TerminusDB" by name.
---

# TerminusDB Skill

TerminusDB is an open-source document and graph database with Git-like revision control: data lives as JSON-LD documents, is queried with WOQL (or GraphQL), and every write is a commit that can be branched, diffed, and merged like a Git repo.

Current stable line as of this writing: **v12** (server, JS client, Python client all track the same major version).

## Quick Workflow Checklist

1. **Server**: run TerminusDB locally via Docker/Docker Compose — [references/server_setup.md](references/server_setup.md).
2. **Connect**: JS/TypeScript (`npm install terminusdb`) — [references/js_client.md](references/js_client.md), or Python (`pip install terminusdb-client`) — [references/python_client.md](references/python_client.md). Or drive it directly from a shell via the `terminusdb` CLI — [references/cli.md](references/cli.md).
3. **Schema**: model classes/properties as JSON-LD — [references/schema_design.md](references/schema_design.md).
4. **Query & CRUD**: high-level document API for simple CRUD, WOQL for graph traversals/joins/aggregation — [references/woql_queries.md](references/woql_queries.md).
5. **Version control**: branch, commit, diff, merge (`apply`), reset — [references/version_control.md](references/version_control.md).

## Picking a client

- **JS/TypeScript** (`terminusdb` on npm) is the actively-maintained, TypeScript-first package and the one current docs lead with. You may still see older code using `@terminusdb/terminusdb-client` — it still works but is behind; prefer `terminusdb` for anything new.
- **Python** (`terminusdb-client` on PyPI) is the choice for scripts, notebooks, and data pipelines. Add the `[dataframe]` extra (`pip install terminusdb-client[dataframe]`) when working with pandas.
- **CLI** (`terminusdb` binary, ships with the server / installable separately) is good for one-off admin tasks, scripting, and CI — no client library needed.

## A note on WOQL syntax

WOQL supports more than one equivalent calling style — don't be surprised to see both in the wild:
- **Nested**: `WOQL.and(WOQL.triple(...), WOQL.triple(...))`
- **Chained with `Vars()`**: `let v = Vars("x","y"); limit(5).select(v.x, v.y).and(triple(...), triple(...))`

Both compile to the same query. See [references/woql_queries.md](references/woql_queries.md) for worked examples of each.

## Detailed References

- [references/server_setup.md](references/server_setup.md) — Docker / Docker Compose install, env vars, default security posture.
- [references/js_client.md](references/js_client.md) — install, connect, database ops, document CRUD.
- [references/python_client.md](references/python_client.md) — install, connect, database ops, document CRUD.
- [references/cli.md](references/cli.md) — `terminusdb` command-line tool: db/doc/branch/log/query/store commands.
- [references/schema_design.md](references/schema_design.md) — classes, `@key` strategies, subdocuments, enums, `Optional`/`Set`/`List`/`Array` property types.
- [references/woql_queries.md](references/woql_queries.md) — triples, `select`/`and`/`or`, comparisons, aggregation, both calling styles.
- [references/version_control.md](references/version_control.md) — branch, commit log, diff, merge (`apply`), reset.
