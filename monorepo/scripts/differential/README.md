# The differential tools

Python 3 tools (standard library only) that run one list of `aperas` commands on a service of two
engines and compare what each answers and what each leaves in its graph: the engine of 0.2.x
(Oxigraph, the `oxigraph` branch of this repository) and the engine of 0.3.0. They were built to prove
the cutover from one to the other, and they are kept for the next time two versions have to be compared.

| file | what it is |
|---|---|
| `harness.py` | starts a service of each side, apart, in scratch directories on two claimed ports, runs a list of commands on each in turn, records every answer, copies both graphs, stops its own services. Compares nothing. |
| `compare.py`, `explain.py` | the comparer: normalises the two sides' dumps, answers and logs, and explains each difference by one rule (`explain.py` holds the rules' texts, `compare.py` the matchers). A difference no rule claims is `UNEXPLAINED`. |
| `corpus.py`, `cases.py`, `cmdrun.py` | the script of 311 commands on a small corpus (`cmd_demo`, a few documents, a thread, two views): `corpus.py` builds the snapshot with the old engine's own service, `cases.py` holds the commands, `cmdrun.py` runs them in three parts (`main`, `lifecycle`, `broken`) through the harness and the comparer and prints the report. |
| `overlay.py`, `sampled_run.py`, `service_figures.py` | the same script laid over a copy of a real mirror; the same run with a memory and CPU sampler on each service; start, write and reload times and memory of each service. |
| `demo-commands.json` | a three-command list (`track`, `ingest`, `tree`) for the harness on the demo snapshot. |
| `test_*.py` | the tests of the tools; the `differential` suite runs them. |

## The deliberate differences

The 31 entries of Layer 4 of the plan of the cutover are the differences between the 0.2.x engine and
0.3.0 that were found when the two were run side by side and accepted at the migration. Each is a
behaviour that the new engine does on purpose and the old one did not: for example, a removed node
leaves the list of its container; an `insert` whose anchor is not a child of the parent is refused
before anything is written; listings are sorted by id; the load of the mirror is whole or the service
does not start; `aperas migrate-frontmatter` is gone. The entries are grouped as flips, order,
ingest, sweeps, a follow-up, a move and a refusal. The list lives in the project's graph; here each
one is a matcher in `compare.py` (with its title) and a rule in `explain.py`, so that a run explains a
difference by the entry that accounts for it and reports every other one.

## When to use them

- **The `differential` suite**, when anything in `scripts/differential/` changes:
  `npm run verify -- --suite differential` from `monorepo/` (a budget of 40 s, about 30 s). It tests the
  tools themselves, with this checkout as both sides (no old engine is needed); it needs the
  project's graph in the `AperasKG` directory beside the checkout.
- **A real comparison between two engines**, only to compare 0.3.0 with a later change against the
  frozen 0.2.x behaviour, or with another version. A run is minutes, not seconds (below). It is not a
  regression test of 0.3.0: for that, use the suites of `npm run verify`.

## The recipe: compare against the old engine

1. **A checkout of the old engine, with its own `node_modules`.** From this checkout (the paths here
   put it beside it; any path will do):

   ```sh
   git worktree add ../Aperas.oxigraph oxigraph
   cd ../Aperas.oxigraph/monorepo && npm install        # about 6 s with a warm npm cache; longer with a cold one
   ```

   The branch is a checkout like any other and stays in git; `git worktree remove ../Aperas.oxigraph`
   takes the working copy away. The harness never writes in it (it records the checkout's git state
   before and after a run, and a change fails the run).

2. **A snapshot of an unmigrated graph.** The old engine reads the old form of the mirror and cannot
   read a migrated one; the new side's copy is migrated by the harness with
   `scripts/migrate-mirror.py --rules 123456` (all six rules, always: the two that name this project's own
   documents change nothing in a graph that does not hold them).
   - For the demo, `harness.py --demo-snapshot <dir>` writes a small one (seven files).
   - For the script of commands, `cmdrun.py` builds its own with the old engine's service.
   - For a real graph, take a copy of the mirror from before its migration (a `cp -a` of the graph
     root, or a clone at a commit before it). Never name the live graph: the harness refuses it
     unless `--allow-real-root` is given, and then only reads it.

3. **Two ports.** `--ports <ref>,<new>`: two different free ports of 2800 to 2899, the old engine's
   first. The harness refuses 2736 and any port a working service holds.

4. **Isolation.** The harness gives each side its own `XDG_RUNTIME_DIR` (`<out>/<side>/run`),
   `XDG_CONFIG_HOME`, port, graph roots (`APERAS_APEIRON_ROOT`, `APERAS_ARTIFACTS_ROOT`), graph name
   and machine number, and asserts all of it again before each start; it stops only the services it
   started, by the pid of each one's own lock after checking that the process is that service. You
   set none of these yourself. If you run it while the `differential` suite runs, the suite's tests
   take an `flock` on `$TMPDIR/aperas-dh-ports/<port>` for each port they use: take another pair, or
   the same locks.

5. **Run.** The demo, with the harness (about 7 s):

   ```sh
   python3 monorepo/scripts/differential/harness.py --demo-snapshot /tmp/demo-snap
   python3 monorepo/scripts/differential/harness.py --snapshot /tmp/demo-snap --out /tmp/demo-run \
       --commands monorepo/scripts/differential/demo-commands.json --ports 2891,2892 \
       --reference-code ../Aperas.oxigraph/monorepo
   ```

   It ends with a table (the command, each side's status and time) and `DIFFERENTIAL RUN: COMPLETE`,
   exit 0. And the script of commands on the small corpus:

   ```sh
   python3 monorepo/scripts/differential/cmdrun.py --out /tmp/cmd-run --ports 2891,2892 \
       --reference-code ../Aperas.oxigraph/monorepo --new-code "$(pwd)/monorepo"
   ```

   The full run is about 6 to 7 minutes (`main` about 5.5 minutes, `lifecycle` 25 s, `broken` 12 s).
   `--reference-code` is the old engine's `monorepo`, `--new-code` the one under test (default: this
   checkout). Its default is `Aperas/monorepo` in the parent directory of the checkout, which is the checkout
   itself when it is called `Aperas`, and so not the old engine: always pass it. `--parts main,lifecycle,broken` runs a
   subset (`broken` is 4 commands, about 20 s; a subset ends with the entries it did not reach listed
   as neither seen nor named, and exit 1). `--out` must not exist.

6. **Read the output.** The table has a row for each of the 31 entries: `SEEN` with the part and the
   number of times, `NOT REACHED BY A COMMAND` with its reason (no verb can reach it), or `REACHED, NO
   DIFFERENCE ON THIS CORPUS`. Below it, the coverage of the 19 verbs and:

   ```
   UNEXPLAINED differences: 0
   entries neither seen nor named: none
   ```

   The first line reads 0 when every difference between the sides is accounted for by an entry; any
   other number lists, above it, the differences that no entry accounts for (`UNEXPLAINED`) and the
   problems of the run (`PROBLEM:`). A change made on purpose to either engine after the entries
   were written (a new line in a usage text, a new log line) shows up there until a rule for it is
   added to `explain.py` and `compare.py`. Exit status: 0 when both
   lines are clean; 1 otherwise; 2 for a usage error or a refusal (nothing is started). Everything
   behind the table is under `--out`: `<part>/commands/NNN-<name>.<side>.{stdout,stderr}`, the
   dumps of both graphs, `results.json`, the services' logs and `<part>.harness.txt`.

## Cautions

- **The old engine loops on a move into a node's own subtree** and does not answer; the harness runs
  every command under a timeout (`--command-timeout`, 120 s by default), kills that side's service by
  the pid of its lock when a command is expected to hang (`"hangs": ["ref"]` in the list), and gives
  that side no further command. `cmdrun.py` also ends a part that makes no progress for 5 minutes.
- **Leave both checkouts alone during a run.** The harness records the git state of the old engine's
  checkout and of the one under test before and after, and a change in either (an edit, a staged
  file) ends the run as `PROBLEM: the git state of the code ... changed` and `DIFFERENTIAL RUN:
  FAILED`.
- **Never point it at the live mirror.** The harness refuses a snapshot that is the real graph unless
  `--allow-real-root`, copies it into the scratch directory, and runs the services there.
- A copy of a real mirror needs far more time than the small corpus: pass `--command-timeout` and
  `--start-timeout` of minutes, and see `overlay.py` for how the script's ids are laid over it.
- Both engines need Node 22; on a host that exports `LD_LIBRARY_PATH` of its own libraries, unset it
  for the run (`env -u LD_LIBRARY_PATH python3 ...`), or node fails at start with an OpenSSL error.
