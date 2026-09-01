# Persistence — the WASM/Node build is in-memory only

**Confirmed via web search (this project, 2026-09-02) and the package's own `js/README.md`: the
Node.js/WASM build of Oxigraph has no persistent storage backend at all.** `new Store()` lives
entirely in the process's own memory; there is no `path` constructor option, no on-disk file, no
RocksDB — closing the process discards everything unless you've explicitly serialized it out
yourself.

## Why: this is a WASM constraint, not an Oxigraph limitation

The **native Rust crate** and the **standalone CLI/server binary** both support a RocksDB-backed
persistent store (open with a directory path, survives process restarts). RocksDB is a native
C++ library — it doesn't compile to WASM, so the WASM build silently falls back to in-memory-only.
This is a real, documented distinction between Oxigraph's three distribution forms, not a bug or
an oversight: a memory-only store is the standard trade every WASM-embedded-DB binding makes (the
same pattern as sql.js's WASM SQLite build) in exchange for zero native compilation and one
portable artifact across every OS/architecture.

## What this means for ApeironNgn specifically

This directly changes one premise in `Aperas-apeironngn-design.md`'s rollout plan: the "two-tier
caching" bullet described "JS-level caching, in addition to byte-level caching by RocksDB" — there
is no RocksDB tier in the Node/WASM build to sit on top of. Revisit that bullet before implementing
it; the design's other premises are unaffected:

- **The synchronous API is still confirmed** (see `SKILL.md`) — `valueOf`-triggered implicit
  forcing for the `a.b.c` prop-access interface is unaffected by this finding.
- **Persistence still exists in this project — it just isn't Oxigraph's job.** `AperasKG/Apeiron/`
  (the JSON-LD mirror under git, `Aperas-architecture.md` §5) is already the durable substrate,
  independent of whatever engine queries it — that's the entire point of the mirror, stated
  explicitly in `Aperas-design.md`'s Phase 0.1 motivation ("nothing about the substrate's actual
  content depends on TerminusDB being the engine underneath it"). An in-memory-only `Store`
  rehydrated from that JSON-LD on process start is consistent with, not a regression from, the
  existing "each Aperas instance owns its own local store" design
  (`Aperas-apeironngn-design.md` §3's concurrency section) — it just means "own its own store" now
  concretely means "rebuild an in-memory index from the git-committed JSON-LD at startup," not
  "open a persistent file that survives untouched between runs."
- **Decided**: stay in-memory, rehydrating from `AperasKG/Apeiron/`'s JSON-LD at process start, and
  defer the rebuild-cost/working-set-size question until the KG actually reaches GB scale — not
  speculatively ahead of it. `pyoxigraph` (native, RocksDB-backed) was considered and set aside for
  now specifically because it's a second language/process needing its own projection bridge to the
  Node UI (`Aperas-apeironngn-design.md` §5) — a real cost, not worth paying before size makes it
  necessary.
