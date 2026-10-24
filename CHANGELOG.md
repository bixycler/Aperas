# Changelog

What changed in each release of Aperas, for someone who knows the project. The version numbers are
those of the npm package `aperas` and of the workspace in this repository, which move together.

## 0.3.0 - 2026-10-24

Aperas now runs on a new in-memory engine, written for its own data model, in place of the Oxigraph
triple store. The commands, the graph and the Markdown projections are the same. The service starts
sooner, holds less memory and answers commands faster, and the mirror on disk (the `Apeiron/` JSON-LD
files) has a new format that an existing graph must be migrated to once.

### Upgrading from 0.2.x: migrate the mirror once

The migration is one way. 0.2.x cannot read a migrated mirror, and 0.3.0 refuses an unmigrated one
(the service will not start; the refusal names at most 20 of the ids it refused and their count, and
`service.log` holds the full list). The previous engine stays on the `oxigraph` branch of this
repository, for reading and for a rollback to a backup of the mirror.

Two Python 3 scripts in `monorepo/scripts/` do it, with no dependency beyond the standard library and
`git`:

```sh
aperas service stop
git -C <graph-root> status                      # clean: the committed mirror is the baseline
python3 monorepo/scripts/migrate-mirror.py <graph-root> --dry   # counts only, writes nothing
python3 monorepo/scripts/migrate-mirror.py <graph-root>         # migrates in place
python3 monorepo/scripts/verify-migration.py <graph-root>       # ends "UNEXPECTED differences: 0"
aperas service start
```

Run the verifier before the service is started on the migrated mirror: it compares the working tree
with `HEAD`, and the first start prunes tombstones that the migration leaves, which the verifier would
then report. Both scripts read and write only `Apeiron/*.jsonld` and `Apeiron/.state/*.jsonld`, and
the graph root is a required first argument: a first argument that starts with `-` (`--help` among
them) or is not a directory that holds `Apeiron/` is a usage error,
with exit status 2 and nothing read or written. The migration stops without writing when it meets
something its rules cannot decide.

The migration makes six changes: a link loses its stored `predicate`; a removed (tombstoned) node
loses its content and leaves the list of its container; the `unfolds` entries of a view that name
nothing are dropped; an artifact loses its `type`; and two changes that name documents of this
project's own graph (the six `README.md` artifacts and one profile). The scripts' default is the
four general changes (`--rules 1256`), which is what any other graph needs. `--rules 123456` runs all
six and is for this project's own graph; give the migration and the verifier the same `--rules`.

### New

- **`aperas --version`** (and `-v`) prints `aperas <version>`, read from the package's `package.json`,
  and exits 0 without starting or reaching the service.
- **`aperas service status`** says whether the service is running, and starts, stops and clears
  nothing. It prints one state word, then the pid, the uptime, the HTTP port, the two roots, the run
  directory, the version and the fingerprint of the code the service runs. The states and exit codes:
  `ready` (the process lives and answers a ping) 0; `starting` (the lock says so and its process
  lives) 1; `busy` (the process lives and does not answer) 1; `stopped` (no lock, or the lock of a
  process that is gone, which is reported and left in place) 3. `--json` prints the same as one line
  of JSON. When the running service holds older code than the source now on disk, the line for the
  code fingerprint says so and gives `aperas service restart`; every command already prints that
  note when it meets such a service.
- **Tools for a comparison with the previous engine.** `monorepo/scripts/differential/` holds a
  harness that runs one list of commands on a service of each engine, a comparer that explains every
  difference between their answers and their graphs, and a script of 311 commands on a small corpus;
  its README gives the recipe for using it against the `oxigraph` branch. The test runner has six
  suites, `essential`, `commit`, `models`, `tools`, `cutover` and `differential`, and `demand` on
  request; `npm run verify -- --help` lists them.

### Changed

- **The engine.** The graph is held in memory as records with typed fields and ports, validated by one
  schema, and written to the mirror by a dump at each flush. Oxigraph is no longer a dependency: the
  published package has no runtime dependency at all.
- **Speed and memory**, measured against the previous engine on copies of this project's own mirror
  (about 13,000 blocks): the service answers its first ping about 5.8 s after `aperas service start`,
  where the previous one answered about 20 s after its start; it holds 297 MB at the first ping against
  637 MB; and a run of 285 commands takes about a third of the time (282 s against 918 s). Loading the
  mirror takes 0.4 to 0.5 s against 10 to 11 s, and neither engine's memory grows without levelling
  off over repeated reloads.
- **A removed node is gone from its container.** `tree` and `unfold` show nothing in place of a removed
  child, even with `--tombstoned`; the removed node itself is still reached by its id (`tree <id>
  --tombstoned`) until the next start, reload or stop prunes it. A path that is tracked again after its
  artifact was removed gets a new artifact with new ids.
- **A refused command leaves nothing behind.** An `insert` whose anchor is not a child of the parent used
  to fail after its body was written, leaving one parentless block for each top-level block of the body;
  it is now refused before anything is written, and so is a move of a node into its own subtree.
- **Order.** Listings (profiles, views, `backlinks`, `check-links`, `track --reverse`) are sorted by id,
  and the links of a block are listed by their position in its text.
- `aperas show` prints a block's links in id order, as the mirror stores them.
- **A link in an inserted body is stored.** A path-based wikilink (a relative link with no `#id/`,
  such as `[x](../design/y.md)`) in the body that `aperas insert` writes is now resolved and stored as
  a link, as `ingest` and `update` always did; before, the inserted block kept the text and no stored
  link, and `check-links` reported the difference. A link to a title that has no node
  (`[[NotYetThere]]`) now creates a placeholder node in `insert` too, so that the three commands agree;
  `insert` used to leave it dangling.

### The service

- The lock reads `starting` until the service answers a ping, and `ready` only then. A start that
  fails says why at once, from `service.log`, where it used to report "did not become ready in time"
  after five seconds.
- `aperas service start` waits up to 180 s for a service that is starting (`APERAS_READY_TIMEOUT_MS`
  overrides it), and a second `service start` joins the start under way instead of beginning another.
  A lock whose process is alive is a running service, however busy; only a dead process's lock is
  cleared.
- **No graph, no service.** `aperas service start`, `restart` and `serve` refuse, before they create
  or stop anything, when the graph root they resolve is not a directory (no `aperas.config.json`
  above the current directory and no root variable, or a configuration that names a missing
  directory). The message gives the path, how it was found, and says to run `aperas init`. An
  installed package used to bind a service to a path four directories above its own install.
- The HTTP port is bound before the service marks itself ready. A port in use ends the start, with the
  reason in `service.log` and in the text of the command, and exit status 1.
- **The load rule.** The service starts only if it read the whole mirror. An id carried by more than
  one document, or a document the engine refused, stops the start (or a `reload`). The message of the
  command names at most 20 of the ids and their count; `service.log` names all the files and the ids.
  `--start-anyway` on `service start`, `service restart` and `reload` accepts the
  load: the service works on the unaffected parts, and copies each document it skipped to
  `<file>.rejected-<UTC stamp>.json` next to its file before anything can be flushed over it.
- A character split between two chunks of a message on the service's socket was decoded as U+FFFD, in
  the client's reading of a response and in the service's reading of a request, and could be stored in
  the graph. Both sides now decode the stream whole.
- Each of the three graphs of the shell (the content, the thread-scoped nodes and the views) is flushed
  on its own interval, and a write to a thread node alone now reaches `Apeiron/.state/`.

### Packaging

- The package declares `engines` (`node` >=22, the only version it is run on) and lists its `files`
  (`aperas.js`, `web`, `skills`, `README.md`, `LICENSE`, `CHANGELOG.md`), so it ships this changelog
  and no compiled Python from the skills. It also carries `repository`, `homepage` and `bugs`. The
  build fails if a name of `files` is missing.
- The dependencies of the webapp were updated for security advisories: `dompurify`, `mermaid`,
  `lodash-es`, `solid-js` and `vite` (and `seroval` and `source-map-js` with them). `npm audit` now
  reports three low advisories, on `katex` and `remark-math` (with `micromark-extension-math`), which
  wait for upstream: the fix is a major step or a downgrade.

### Removed

- The verbs `aperas link` and `aperas unlink` (manual links; links are the wikilinks of the text) and
  `aperas migrate-frontmatter`.

### Known limits and open issues

- `aperas insert <block> --after <artifact>` (a move with no body) takes the block out of its document
  into the artifact's folder without a refusal. It is allowed by the schema and kept open for a
  decision.
- The link-integrity check is slow on a large graph: about 4 s of a 4.4 s load, dump and check cycle,
  and about 3.6 s of the start (the service is busy but not yet ready during that time).
- The folder scan skips every name that starts with a dot, so `ingest` builds no folder for
  `.threads/` and a thread artifact ingested into a new graph is reached by its id and not by its path.
- A relative-path link in the `description` of a folder is not stored: `./x.md` resolves as a sibling
  of the folder, and what such a link should mean is undecided.
- The webapp's build holds two copies of `katex` (two chunks of about 259 kB each): the app's own,
  0.16, which carries the three low advisories, and the one that `mermaid` brings, 0.18. Moving the
  app to 0.18 is a major step and was not made.
- The cost of a write on a working service (one `insert` keeps the service busy for a moment around
  it) is an open issue.
- A long run of the new engine on a real graph over days has not been measured; the figures above are
  from scripted runs and from the start of the service.
- `npm run verify` runs the `commit` suite (1,121 tests in 73 files, about 45 s of its 60 s budget).
  The other suites are `essential`, `models`, `tools`, `cutover`, `differential` and `demand`
  (`npm run verify -- --help` lists them with their budgets). The `differential` suite needs a graph in
  the `AperasKG` directory beside the checkout, and `demand` a copy of this project's own mirror.
