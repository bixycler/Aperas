# TerminusDB Schema Design Reference

TerminusDB schemas are JSON-LD documents that define classes, properties, and relationships. A schema document is just a regular document written to the `schema` graph (`graph_type: "schema"` / `graph_type="schema"` — see [js_client.md](js_client.md) / [python_client.md](python_client.md)).

## Basic Class

```json
{
  "@type": "Class",
  "@id": "Person",
  "name": "xsd:string"
}
```

`@type: "Class"` and a unique `@id` are required. Every other key is a property name mapping to either an XSD datatype (`xsd:string`, `xsd:integer`, `xsd:decimal`, `xsd:dateTime`, ...) or another class `@id`.

## `@key` strategies

Keys determine how a document's `@id`/URI is generated — there is no auto-increment integer id.

- **Lexical** — URI built from named fields, in order:
  ```json
  { "@type": "Lexical", "@fields": ["first_name", "last_name"] }
  ```
- **Hash** — like Lexical, but SHA-256-hashes the field values first. Use this instead of Lexical when the raw field values would make an unwieldy URI (long text, many fields):
  ```json
  { "@type": "Hash", "@fields": ["email"] }
  ```
- **ValueHash** — hashes the *entire* document object rather than named fields. The object must be a DAG (no cycles):
  ```json
  { "@type": "ValueHash" }
  ```
- **Random** — a random UUID, for documents with no natural key:
  ```json
  { "@type": "Random" }
  ```

There is no key type simply called `"Value"` — that's a common misremembering of `ValueHash`.

## Subdocuments

A subdocument is owned entirely by its parent — it has no independent revision history and can't be fetched/updated on its own.

```json
{
  "@type": "Class",
  "@id": "Address",
  "@key": { "@type": "Random" },
  "@subdocument": [],
  "country": "xsd:string",
  "postal_code": "xsd:string"
}
```

A subdocument class still needs a `@key`; it's marked with `"@subdocument": []`.

## Enums

```json
{
  "@type": "Enum",
  "@id": "PrimaryColour",
  "@value": ["red", "blue", "yellow"]
}
```

Each enum member becomes its own URI (e.g. `.../PrimaryColour/blue`) — an enum is not a plain string type, it's a class of singleton individuals.

## Property type wrappers

Plain `"propertyName": "xsd:string"` means required-and-single-valued. For anything else, wrap the type:

- **Optional** — property may be absent:
  ```json
  { "@type": "Optional", "@class": "xsd:string" }
  ```
- **Set** — unordered collection, no duplicates, supports `@min_cardinality` / `@max_cardinality`:
  ```json
  { "@type": "Set", "@class": "Person" }
  ```
- **List** — ordered collection, duplicates allowed:
  ```json
  { "@type": "List", "@class": "Task" }
  ```
- **Array** — random-access, optionally multi-dimensional:
  ```json
  { "@type": "Array", "@dimensions": 2, "@class": "xsd:decimal" }
  ```

## Full example

```json
[
  {
    "@type": "Class",
    "@id": "Company",
    "@key": { "@type": "Lexical", "@fields": ["name"] },
    "name": "xsd:string",
    "industry": { "@type": "Optional", "@class": "xsd:string" },
    "employees": { "@type": "Set", "@class": "Person" }
  },
  {
    "@type": "Class",
    "@id": "Person",
    "@key": { "@type": "Hash", "@fields": ["email"] },
    "name": "xsd:string",
    "email": "xsd:string",
    "worksFor": "Company"
  }
]
```

Upload it as a schema-graph document write (see [js_client.md](js_client.md#document-crud) / [python_client.md](python_client.md#document-crud)).
