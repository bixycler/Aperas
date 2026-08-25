# TerminusDB CLI Reference

The `terminusdb` command-line tool talks to a running server (or a local store) directly — useful for admin tasks, scripting, and CI without pulling in a client library.

Every command below was actually run against a live `terminusdb/terminusdb-server:v12` instance to confirm it works as shown.

**Invocation**: if you're running the official Docker image, the `terminusdb` binary lives inside the container but is **not** on `$PATH` — invoke it via:

```bash
docker exec <container-name> /app/terminusdb/terminusdb <command>
```

If you installed the binary directly on the host (or via `store init` / `serve` yourself), drop the `docker exec` prefix and just run `terminusdb <command>`.

## Storage

```bash
terminusdb store init                      # initialize a local storage directory
```

## Databases

```bash
terminusdb db create admin/MyDatabase --label="My Database"
terminusdb db delete admin/MyDatabase
terminusdb db list                         # list databases (and branches, with the right flags)
terminusdb db list --branches              # DB_SPEC is optional — omit it to list every database
```

## Documents

```bash
terminusdb doc insert admin/MyDatabase --data='{"@type":"Person","name":"Jane"}'
terminusdb doc get admin/MyDatabase --type="Person" --as-list=true
terminusdb doc replace admin/MyDatabase --data='{"@id":"Person/jane","name":"Jane Smith"}'
terminusdb doc delete admin/MyDatabase --id="Person/jane"
```

## Version control

```bash
terminusdb branch create admin/MyDatabase/local/branch/feature
terminusdb log admin/MyDatabase                                    # commit history
terminusdb reset admin/MyDatabase/local/branch/main <commit-id>     # BRANCH_SPEC, not bare DB_SPEC
terminusdb push admin/MyDatabase --remote=origin                    # remote is a flag, not a positional arg
terminusdb pull admin/MyDatabase --remote=origin
terminusdb diff --before '{"a":1}' --after '{"a":2}'                                            # diff two JSON docs directly
terminusdb diff admin/MyDatabase --before-commit <ref> --after-commit <ref> --docid <doc-id>    # diff two commits (needs DB_SPEC + --docid; there is no bare `--before <ref> --after <ref>` form for commits)
```

`reset`'s first argument is a full branch spec (`.../local/branch/main`), the same shape `branch create` takes — a bare `admin/MyDatabase` is rejected.

## Querying

```bash
terminusdb query admin/MyDatabase "t(X, 'name', Y)" --json
```

There is no `--woql` flag — `QUERY` is a **positional** argument, and it's TerminusDB's native Prolog-like WOQL text syntax, not the JSON AST the JS/Python client builders produce. Two things that trip people up in that text syntax:
- Variables are bare capitalized atoms (`X`, `Y`), not `v("X")` or `v:X`.
- The triple predicate is `t(Subject, Predicate, Object)` — `triple(...)` (the JSON builder's method name) is not a valid predicate name here and fails with `NoViableMode`.

If you already have a WOQL JSON AST (e.g. from `WOQL.triple(...).json()` in the JS client), it's more reliable to POST it straight to the REST WOQL endpoint instead of translating it into this text syntax:

```bash
curl -u admin:<pass> -X POST "http://<host>:6363/api/woql/admin/MyDatabase" \
  -H "Content-Type: application/json" \
  -d '{"query": <woql-json-ast>}'
```

## Access control

```bash
terminusdb user create <name> --password=<pw>
terminusdb user delete <name>
terminusdb role create <role-name> instance_read_access instance_write_access   # ACTION_1..ACTION_N are required, not optional
terminusdb organization create <name>
```

## Server

```bash
terminusdb serve                            # run the server process directly (vs. Docker)
```

## Portable database bundles

```bash
terminusdb bundle admin/MyDatabase -o mydb.bundle       # writes to a file — NOT stdout, so `> mydb.bundle` silently captures only status text
terminusdb unbundle admin/NewDatabase mydb.bundle       # FILE is a positional arg — NOT read from stdin, so `< mydb.bundle` does not work
```

For exact flags on any subcommand, `terminusdb <command> --help` is authoritative — CLI flag names shift between releases more often than the client library method names do, so don't hard-code flags from any single example (including this one) without checking `--help` first if the command fails.
