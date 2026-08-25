# WOQL (Web Object Query Language) Reference

WOQL is TerminusDB's declarative datalog-style query language: you describe triple patterns and constraints, and the engine binds variables to every matching solution. It's evaluated against RDF-style triples (subject, predicate, object) even though the data model on top is JSON-LD documents.

WOQL's JS builder supports **two equivalent calling styles** — pick whichever reads clearer for a given query, both compile to the same query object.

## Style 1: Nested (`WOQL.foo(...)`)

```typescript
import TerminusClient from "terminusdb"
const { WOQL } = TerminusClient

const query = WOQL.and(
  WOQL.isa("v:docid", "Person"),
  WOQL.triple("v:docid", "age", "v:age"),
  WOQL.greater("v:age", 30),
  WOQL.triple("v:docid", "name", "v:name"),
)

const result = await client.query(query)
console.log(result.bindings)
```

## Style 2: `Vars()` + chained

```typescript
const v = WOQL.Vars("Person", "Name")

const query = WOQL.and(
  WOQL.triple(v.Person, "rdf:type", "@schema:Person"),
  WOQL.triple(v.Person, "name", v.Name),
)

const result = await client.query(query)
for (const binding of result.bindings) {
  console.log(binding.Name)
}
```

`Vars("a", "b")` gives you an object whose properties (`v.a`, `v.b`) are already-prefixed WOQL variables — equivalent to writing `"v:a"` / `"v:b"` by hand, just less error-prone.

Chaining also works directly off `limit`/`select` without re-wrapping in `WOQL.and`:

```typescript
const v = WOQL.Vars("person", "eyes", "name")

const query = WOQL.limit(5)
  .select(v.name, v.eyes)
  .and(
    WOQL.triple(v.person, "label", v.name),
    WOQL.triple(v.person, "eye_color", v.eyes),
  )
```

## Core building blocks

- **`triple(subject, predicate, object)`** — the fundamental pattern match. Any position can be a literal or a `v:`-prefixed variable; variables in all three positions match every triple in the graph, so constrain at least one.
- **`select(...vars)`** — restricts which variables are exposed in the result bindings; everything else is still used internally for joins but hidden from output.
- **`and(...queries)`** — conjunction; chaining `.triple(...).triple(...)` implies the same `and` semantics.
- **`or(...queries)`** — disjunction.
- **`eq(a, b)`**, **`greater(a, b)`**, **`less(a, b)`** — comparisons/filters over bound variables.
- **`isa(instance, class)`** — type-check/bind that an instance belongs to a class.
- **`limit(n)`**, **`order_by(...)`** — result-set control.
- **`read_document(id, doc_var)`** / **`delete_document(id)`** — document-level operations from within a WOQL query, as opposed to the high-level Document API.

## Aggregation / grouping

```typescript
const query = WOQL.select("v:Count").group_by(
  [],
  "v:Person",
  "v:Count",
  WOQL.triple("v:Person", "rdf:type", "@schema:Person"),
)

const result = await client.query(query)
```

## Insert / delete triples directly

For low-level graph edits outside the Document API:

```typescript
const insertQuery = WOQL.and(
  WOQL.add_triple("doc:Person/bob", "name", "Bob"),
  WOQL.add_triple("doc:Person/bob", "rdf:type", "@schema:Person"),
)
await client.query(insertQuery)

const deleteQuery = WOQL.delete_triple("doc:Person/bob", "name", "Bob")
await client.query(deleteQuery)
```

Prefer the Document API ([js_client.md](js_client.md) / [python_client.md](python_client.md)) for normal CRUD — reach for raw triple inserts/deletes only when you need graph-level edits the document layer doesn't expose.

## Python equivalent

The Python client uses a `WOQLQuery()` builder instance instead of a static `WOQL` namespace, with `woql_and`/`woql_or` instead of `and`/`or` (to avoid clashing with Python keywords):

```python
from terminusdb_client import WOQLQuery

query = WOQLQuery().woql_and(
    WOQLQuery().triple("v:Person", "rdf:type", "@schema:Person"),
    WOQLQuery().triple("v:Person", "@schema:name", "v:Name"),
)
result = client.query(query)
```
