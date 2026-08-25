# TerminusDB CLI Reference

The `terminusdb` command-line tool talks to a running server (or a local store) directly — useful for admin tasks, scripting, and CI without pulling in a client library.

## Storage

```bash
terminusdb store init                      # initialize a local storage directory
```

## Databases

```bash
terminusdb db create admin/MyDatabase --label="My Database"
terminusdb db delete admin/MyDatabase
terminusdb db list                         # list databases (and branches, with the right flags)
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
terminusdb log admin/MyDatabase                 # commit history
terminusdb reset admin/MyDatabase <commit-id>
terminusdb push admin/MyDatabase <remote>
terminusdb pull admin/MyDatabase <remote>
terminusdb diff --before <ref> --after <ref>    # or diff two JSON docs directly
```

## Querying

```bash
terminusdb query admin/MyDatabase --woql='<woql-json-ast>'
```

## Access control

```bash
terminusdb user create <name> --password=<pw>
terminusdb user delete <name>
terminusdb role create <name>
terminusdb organization create <name>
```

## Server

```bash
terminusdb serve                            # run the server process directly (vs. Docker)
```

## Portable database bundles

```bash
terminusdb bundle admin/MyDatabase > mydb.bundle
terminusdb unbundle admin/NewDatabase < mydb.bundle
```

For exact flags on any subcommand, `terminusdb <command> --help` is authoritative — CLI flag names shift between releases more often than the client library method names do, so don't hard-code flags from any single example (including this one) without checking `--help` first if the command fails.
