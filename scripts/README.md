# Aperas Core Infrastructure Scripts

This directory contains universal infrastructure and database management scripts maintained by the Aperas Core Dev Team. These scripts apply to the core TerminusDB engine and are agnostic of any specific domain Knowledge Graph (KG).

## Available Scripts

- **`restore.sh`**: Backup, restore & verification suite for the TerminusDB Docker volume.
- **`tdb-log.sh`**: Helper to view the commit log with local-time formatting.
- **`tdb-doc.sh`**: Helper to inspect document contents with unescaped text.

## Core Database Backup Strategy

The live graph's actual state lives in TerminusDB, not in git. The binary volume data mutates on every commit and is not diffable.

We use **whole-volume tarball archives (`./restore.sh backup-full`)** as the primary adopted mechanism for cross-machine backup and host transfer (e.g., between office and home). These snapshots should be saved outside of Git (e.g., `~/.aperas/backups/`).

*Note: Same-store `.bundle` archives (`./restore.sh backup`) are kept only for fast same-instance local rollbacks, as they suffer from cross-store layer reference incompatibility (issue #2509).*
