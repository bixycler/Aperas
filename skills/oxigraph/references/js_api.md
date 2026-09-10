# Oxigraph JavaScript/Node.js API Reference

## Installation

```bash
npm install oxigraph
```

Requires Node.js 18+ (WASM reference types + `WeakRef`) or a bundler (Vite/Webpack) for browser use.
Distributed as a compiled WASM module wrapped in a JS package — no native compilation step, no
per-platform binary.

## Store: the only class that matters

```typescript
import { Store } from "oxigraph"

const store = new Store()
// or seed it with quads up front:
const store2 = new Store([quad1, quad2])
```

**Every method below is synchronous** — returns a real value immediately, never a `Promise`.
Confirmed from `oxigraph/oxigraph`'s own `js/README.md`.

## Data management

```typescript
store.add(quad)        // insert one quad
store.delete(quad)      // remove one quad
store.has(quad)         // boolean — does this exact quad exist?
```

## Pattern matching — `match()`

This project's primary access path (`Aperas-apeironngn-design.md` §3's reified-triple design:
`(child, parent, P)` / `(child, siblingIndex, N)` as direct quads, not an `rdf:List` chain):

```typescript
// Any argument left null/undefined is a wildcard.
const childrenOfP = store.match(null, parentPredicate, pNode, null)   // reverse lookup: who has P as parent
const ownParent   = store.match(childNode, parentPredicate, null, null) // forward lookup: child's own parent
```

Returns a plain array of matching `Quad` objects — no pagination, no cursor, the whole match set
at once. This is the method to build the `a.b.c` prop-access interface's `.force()` step on
(`Aperas-apeironngn-design.md` §3/§4), since it's a single synchronous call regardless of how many
quads match.

## SPARQL — `query()` / `update()`

```typescript
const results = store.query("SELECT ?s ?o WHERE { ?s <predicate> ?o }")
// SELECT -> array of Map objects, one per solution row, keyed by variable name
// CONSTRUCT/DESCRIBE -> array of Quad objects
// ASK -> boolean

store.update("INSERT DATA { <s> <p> <o> }")
```

Reach for `query()`/`update()` only when a pattern is genuinely more than a triple match (e.g. a
join across several patterns, an aggregate) — `match()` alone covers the reified-triple traversal
this project actually needs day to day.

## Loading bulk RDF data — `load()`

```typescript
store.load(fileContents, { format: "text/turtle" })
// also accepts: "application/n-quads", "application/trig", "application/n-triples",
// "application/rdf+xml", "application/ld+json" (JSON-LD), "text/n3"
```

Useful options: `base_iri`, `to_named_graph` (load everything into one named graph), `unchecked`
(skip validation, faster for data already known-good — e.g. re-loading this project's own
previously-exported JSON-LD).

## RDF/JS DataFactory — building quads/terms

Oxigraph implements the [RDF/JS data model spec](https://rdf.js.org/data-model-spec/) but doesn't
bundle a `DataFactory` itself — pair it with `@rdfjs/data-model`:

```typescript
import dataModel from "@rdfjs/data-model"

const subject   = dataModel.namedNode("http://example/child1")
const predicate = dataModel.namedNode("http://example/parent")
const object    = dataModel.namedNode("http://example/P")
const quad      = dataModel.quad(subject, predicate, object)

store.add(quad)
```

`dataModel.literal(value, languageOrDatatype)` builds literal terms (e.g. a `title`/`siblingIndex`
value) the same way.
