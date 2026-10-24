# Aperas

Aperas is a local-first knowledge graph for documentation that has to stay true: every claim is a
node in a graph, linked to the evidence it rests on, and the Markdown files you read are projections
that the graph regenerates, never the place a change is made. It is worked through a command-line tool,
`aperas`, a long-lived service that holds the graph in memory, and a small webapp; a set of skills
teaches an AI agent the same discipline. The graph is stored as JSON-LD files (the mirror) that are
meant to live in git.

Aperas is early and evolving. The release notes are in [`CHANGELOG.md`](CHANGELOG.md).

## Two ways to use it

- **Use the released package.** `npm install -g aperas`, then `aperas init` in an empty directory.
  See [`monorepo/packages/cli/README.md`](monorepo/packages/cli/README.md), the README that the package
  ships.
- **Work on Aperas from a checkout** (below): run the TypeScript source directly, run the tests, build
  the bundle.

## Upgrading from 0.2.x

The mirror's format changed in 0.3.0 and a graph written by 0.2.x or earlier must be migrated once,
with the scripts in `monorepo/scripts/`; the steps are in [`CHANGELOG.md`](CHANGELOG.md).

## Prerequisites

- **Node.js** 22 or later, with npm. The package declares `"engines": { "node": ">=22" }`, and 22 is
  the only version the project is run on.
- **git**.
- **Python 3**, only for the scripts in `monorepo/scripts/` and for the suites that run them.

Tested with Node 22.22.1, npm 9.2.0 and Python 3.14.4 on Linux.

## Set up a checkout

```sh
git clone git@github.com:bixycler/Aperas.git      # or https://github.com/bixycler/Aperas.git
cd Aperas/monorepo
npm install
npm run aperas -- --help
npm run aperas -- --version      # aperas 0.3.0
```

`npm run aperas -- <verb> <args>` runs `packages/cli/src/aperas.ts` through `tsx`, so every edit to
`packages/core` or `packages/cli` is live on the next command. A service that is already running holds
the code it started with: pick up a change with `aperas service restart`.

### A graph for the checkout

The checkout looks for its graph in a directory called `AperasKG` beside it: the repository's own
`AperasKG` entry is a symlink to `../AperasKG`, which a fresh clone does not have. Make a graph there
with `aperas init`, run from inside the new directory (from `Aperas/monorepo`):

```sh
CHECKOUT="$(pwd)"
mkdir ../../AperasKG && cd ../../AperasKG
"$CHECKOUT/node_modules/.bin/tsx" "$CHECKOUT/packages/cli/src/aperas.ts" init
cd "$CHECKOUT"
```

`aperas init` writes `aperas.config.json`, an empty `Apeiron/` and an `artifacts/` tree. Without a
graph, `aperas service start`, `restart` and `serve` create nothing: they refuse, give the path they
resolved and how they found it, and say to run `aperas init`.

### The shim

So that a bare `aperas` runs the checkout's source from any directory, save these lines as
`~/.local/bin/aperas` (with the path of your own checkout), make the file executable and make sure
`~/.local/bin` is on your `PATH`:

```sh
#!/bin/sh
cd /path/to/Aperas/monorepo && exec env -u LD_LIBRARY_PATH node_modules/.bin/tsx packages/cli/src/aperas.ts "$@"
```

```sh
mkdir -p ~/.local/bin
chmod +x ~/.local/bin/aperas
```

The `cd` makes the shim always bind the service to the checkout's graph, whichever directory it is
called from, so use the unshimmed command of the previous step for `aperas init`. `env -u
LD_LIBRARY_PATH` only matters on a host that exports a `LD_LIBRARY_PATH` of its own libraries, which
makes node fail at start with an OpenSSL error.

### A first command

```sh
aperas service start
aperas service status       # ready, the pid, the port, the roots and the code the service runs
printf '# Hello\n\nFirst paragraph.\n' > ../AperasKG/artifacts/hello.md
aperas track hello.md
aperas ingest
aperas tree hello.md
aperas serve
```

`track` registers the file, `ingest` parses it into blocks, `tree` prints them, and `serve` prints the
address of the webapp (`http://127.0.0.1:2736` by default). In a checkout the service serves the webapp
from `monorepo/packages/web/dist`, which `npm run build:web` (from `monorepo/`) builds; until then the
address answers 404.

## Where the graph is found

For `aperas service start`, `restart` and `serve`, in this order:

1. `APERAS_APEIRON_ROOT` and `APERAS_ARTIFACTS_ROOT`, if set: the mirror directory and the Markdown
   directory.
2. The nearest `aperas.config.json`, walking up from the current directory (the shim always starts in
   `monorepo/`, so it never finds one). Its `graph` is either a
   path (with `Apeiron/` and `artifacts/` directly under it) or an `{ "apeiron": ..., "artifacts": ... }`
   pair. Its optional `name` is the webapp's title and `threadSizeCap` the size past which a thread
   reports a warning.
3. In a checkout, the `AperasKG` directory beside the repository.

The service binds to the graph it was started in for its whole life. To change graph, run
`aperas service restart` from the other graph's directory. The service exits by itself after 30 idle
minutes, flushing what it holds. When none of the three finds a graph, `service start`, `restart` and
`serve` refuse and say to run `aperas init`.

```sh
aperas service start      # a no-op if one is running
aperas service stop
aperas service restart
aperas service status     # look only: starts, stops and clears nothing
```

`aperas service status` prints a state word and its details; the exit status says which: `ready` 0,
`starting` 1 (a process lives and its lock says it is starting), `busy` 1 (a process lives and does not
answer), `stopped` 3. `--json` prints the same as one line. It also shows the fingerprint of the code
the service runs, and says when the code on disk is newer. `aperas --version` (or `-v`) prints the
version and does not touch the service.

## An isolated instance, for experiments

One service runs for each runtime directory (`$XDG_RUNTIME_DIR/aperas`: its lock, socket and token)
and each HTTP port (default 2736). To try something without touching your real service, give an
instance of its own a runtime directory, a free port and a scratch graph, and set all four variables
in every shell that talks to it:

```sh
export XDG_RUNTIME_DIR="$(mktemp -d)"
export APERAS_HTTP_PORT=38417
export APERAS_APEIRON_ROOT=/path/to/scratch-graph/Apeiron
export APERAS_ARTIFACTS_ROOT=/path/to/scratch-graph/artifacts
aperas service start
```

A command run in a shell where any of them is missing reaches the service of the default runtime
directory instead: check the four before you write.

## Tests

From `monorepo/`:

```sh
npm run verify                        # the commit suite: run before a commit
npm run verify -- --suite essential   # a few seconds: run after every change
npm run verify -- --group links       # one group of test files
npm run verify -- --help              # the suites, their budgets and the groups
```

| suite | budget | for |
|---|---|---|
| `essential` | 5 s | after every change |
| `commit` | 60 s | before a commit (the default) |
| `models` | 30 s | when the engine, lookups, mirror or write layer change |
| `tools` | 30 s | when the test runner changes |
| `cutover` | 40 s | when the cutover scripts, a service start or the migration scripts change |
| `differential` | 40 s | when `scripts/differential/` changes (needs the graph in `AperasKG` beside the checkout; see [its README](monorepo/scripts/differential/README.md)) |
| `demand` | none | everything above plus the corpus checks on a copy of the real mirror; on request only |

A test is a standalone `<name>.test.ts` file in a group directory under
`monorepo/packages/cli/src/tests/`, named in a suite under `suites/`.

## Build the package

```sh
npm run build:aperas
```

writes `monorepo/packages/cli/dist/`: one bundled `aperas.js`, the built webapp in `web/`, the skills,
`README.md`, `LICENSE`, `CHANGELOG.md` and a `package.json` for the package `aperas` (with its
`engines` and an explicit `files` list). That directory is what is published; `npm pack --dry-run` in
it lists what the package holds.

## Layout

```
monorepo/                    npm workspace (private; the published package is built from it)
  packages/core/             the engine (in memory) and the shell (the mirror, the load and the flush)
  packages/cli/              the aperas command, the service and the tests (src/tests/); build.mjs
  packages/web/              the webapp (SolidJS, Vite)
  scripts/                   one-time migration of the mirror, the cutover rehearsal and smoke
                             script (Python 3 and shell); differential/ compares two engines
                             (its README says how)
skills/                      the agent skills; aperas, its three roles and kg-doc-ingest are bundled
AperasKG                     symlink to ../AperasKG, the graph of this project (a separate repository)
CHANGELOG.md  LICENSE
```

## License

[The Unlicense](LICENSE): public domain.
