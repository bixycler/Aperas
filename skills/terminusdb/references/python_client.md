# TerminusDB Python Client Reference

## Installation

```bash
pip install terminusdb-client
```

For pandas DataFrame support:

```bash
pip install terminusdb-client[dataframe]
```

Works with TerminusDB and TerminusCMS. Requires Python >= 3.7. Recommended to install into its own virtualenv.

## Import & Connect

```python
import os
from terminusdb_client import Client

client = Client(os.environ.get("TERMINUSDB_URL", "http://localhost:6363"))
client.connect(
    team=os.environ.get("TERMINUSDB_USER", "admin"),
    key=os.environ.get("TERMINUSDB_KEY", "root"),  # matches TERMINUSDB_ADMIN_PASS on the server
)
```

## Database Operations

```python
client.create_database(
    "my_db",
    label="my_db",
    description="created from the python client",
    include_schema=False,  # True to enable schema validation from the start
)
```

## Document CRUD

```python
# Add one document
document = {"@type": "Player", "name": "George", "position": "Center Back"}
result = client.insert_document(document)

# Add many
results = client.insert_document(documents)

# Add schema documents
result = client.insert_document(schema, graph_type="schema")

# Read
doc = client.get_document("Player/george")
docs = client.get_all_documents(document_type="Player")

# Update (replace)
client.replace_document(document)

# Delete
client.delete_document("Player/george")
```

Insert without a predefined schema by passing `raw_json=True` — useful for quick, schema-less prototyping.

## WOQL from the Python client

```python
from terminusdb_client import WOQLQuery

query = WOQLQuery().woql_and(
    WOQLQuery().triple("v:Person", "rdf:type", "@schema:Person"),
    WOQLQuery().triple("v:Person", "@schema:name", "v:Name"),
)
result = client.query(query)

for binding in result["bindings"]:
    print(binding["Name"])
```

Note the Python builder uses `WOQLQuery().woql_and(...)` / `.triple(...)` method chaining off a `WOQLQuery()` instance — the naming differs slightly from the JS client's `WOQL.and(...)` (see [woql_queries.md](woql_queries.md) for the JS-side equivalents), but the underlying query semantics are the same.
