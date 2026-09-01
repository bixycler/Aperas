---
name: oxigraph
description: Reference for Oxigraph, an embeddable Rust RDF/SPARQL graph database, used here via its Node.js/WASM package (`oxigraph` on npm) as ApeironNgn's storage engine. Use whenever the user mentions Oxigraph, an embedded/in-process RDF or triple store, SPARQL in Node.js, `@rdfjs/data-model`, or ApeironNgn's substrate specifically — even if they don't say "Oxigraph" by name.
---

# Oxigraph Skill

Oxigraph is an open-source graph database written in Rust implementing SPARQL 1.1. It ships three
ways: a native Rust crate (with a RocksDB-backed persistent storage option), a standalone CLI/server
binary, and a WASM-compiled npm package for Node.js/browsers. **This project uses only the third
one** — there is no server process, no Docker container; `Store` lives in-process inside the same
Node.js process that uses it.

## Quick Workflow Checklist

1. **Install**: `npm install oxigraph` — [references/js_api.md](references/js_api.md).
2. **Create a store, add data**: `new Store()`, then `store.add(quad)` or `store.load(rdfText, {
   format })` for bulk Turtle/N-Quads/JSON-LD ingestion — [references/js_api.md](references/js_api.md).
3. **Query**: `store.match(s?, p?, o?, g?)` for a plain triple-pattern lookup (this project's
   primary access path — see `Aperas-apeironngn-design.md`'s reified-triple design), or
   `store.query(sparqlString)` for SPARQL SELECT/CONSTRUCT/DESCRIBE/ASK —
   [references/js_api.md](references/js_api.md).
4. **Before assuming persistence works the way TerminusDB's did**: read
   [references/persistence.md](references/persistence.md) first. This is the one constraint that
   actually changes ApeironNgn's design, not just an implementation detail.

## The one fact worth internalizing before writing any code

**Every `Store` method is synchronous** — `add`, `delete`, `has`, `match`, `query`, `update`,
`load` all return immediately, no `Promise`, no `await`. Confirmed from the package's own
`js/README.md` (`oxigraph/oxigraph` on GitHub). This is what makes the lazy/deferred-then-forced
`a.b.c` property-access model (`Aperas-apeironngn-design.md` §3) actually implementable in JS via
`valueOf`/`Symbol.toPrimitive` — those hooks are required by the language to return synchronously,
which a `Promise`-returning store API would have made impossible without an explicit `await` at
every access.

## Detailed References

- [references/js_api.md](references/js_api.md) — `Store` class: constructor, `add`/`delete`/`has`/
  `match`, `query`/`update`, `load` (supported RDF formats), the RDF/JS `DataFactory` interface
  (`namedNode`/`literal`/`quad`) via `@rdfjs/data-model`.
- [references/persistence.md](references/persistence.md) — **in-memory only in the WASM/Node
  build** — no RocksDB, no `path` option, unlike the native Rust crate/CLI. What this means for
  ApeironNgn's persistence story.
