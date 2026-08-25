# TerminusDB Server Setup Reference

## Docker Compose (preferred for local dev)

The official quickstart uses Docker Compose, not a bare `docker run`:

```bash
git clone https://github.com/terminusdb/terminusdb-quickstart.git
cd terminusdb-quickstart
docker compose up -d
```

This starts the server and console at `http://127.0.0.1:6363/`.

## Bare Docker command

If you don't want Docker Compose:

```bash
export TERMINUSDB_ADMIN_PASS=root
docker run --pull always -d \
  -p 127.0.0.1:6363:6363 \
  -e TERMINUSDB_ADMIN_PASS \
  -v terminusdb_storage:/app/terminusdb/storage \
  --name terminusdb \
  terminusdb/terminusdb-server:v12
```

Notes:
- The admin password env var is **`TERMINUSDB_ADMIN_PASS`** (older material floating around the internet uses `TERMINUSDB_SERVER_KEY` — that's stale, not the current server).
- By default the container binds to `127.0.0.1` only — it is **not** exposed beyond localhost unless you deliberately change the bind address. This is a deliberate security default, not an oversight; don't "fix" it by binding `0.0.0.0` without thinking about who else is on that network.
- Default org/user is `admin`; the key/password is whatever you set in `TERMINUSDB_ADMIN_PASS`.

## Docker Compose (manual, no quickstart repo)

```yaml
services:
  terminusdb:
    image: terminusdb/terminusdb-server:v12
    ports:
      - "127.0.0.1:6363:6363"
    environment:
      TERMINUSDB_ADMIN_PASS: "root"
    volumes:
      - terminus_data:/app/terminusdb/storage

volumes:
  terminus_data:
```

## Verifying the server is up

From any client (see [js_client.md](js_client.md) / [python_client.md](python_client.md)), call `client.info()` (JS) or the equivalent connect call — a successful response confirms the server is reachable and the credentials are valid. Or just hit it directly:

```bash
curl http://127.0.0.1:6363/api/info
```
