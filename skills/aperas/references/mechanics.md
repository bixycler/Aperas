# Aperas CLI Mechanics Reference

Status: **v4.7** — On-demand reference manual for advanced graph mutations, AST parsing rules, CLI syntax subtleties, and troubleshooting. Consulted by subagents when executing non-trivial graph operations.

---

## Table of Contents

- [Wikilink & Link Syntax](#wikilink--link-syntax)
- [Anchor Placement — The Bold-Colon Rule](#anchor-placement--the-bold-colon-rule)
- [Sketching a Structure](#sketching-a-structure)
- [Markdown Subtree AST Parsing & Multi-Node Piping](#markdown-subtree-ast-parsing--multi-node-piping)
- [Moving a Node (`insert` with No Body)](#moving-a-node-insert-with-no-body)
- [Inserting into Lists](#inserting-into-lists)
- [Updating an Existing List Item (`aperas update <item-id>`)](#updating-an-existing-list-item-aperas-update-item-id)
- [Updating a Heading (`--text-only`)](#updating-a-heading---text-only)
- [Changing Block Types (`aperas retype`)](#changing-block-types-aperas-retype)
- [Renaming Artifacts](#renaming-artifacts)
- [Shell Quoting Gotcha](#shell-quoting-gotcha)
- [Service State & Recovery](#service-state--recovery)
- [Raw Node State Inspection](#raw-node-state-inspection)
- [`aperas unfold` — Bare vs. `--view`](#aperas-unfold--bare-vs---view)
- [Tombstoned Nodes](#tombstoned-nodes)
- [Full-Text Search via Raw Store](#full-text-search-via-raw-store)
- [Comparing Distant Docs (View as a Lens)](#comparing-distant-docs-view-as-a-lens)
- [Breadcrumbs in `aperas tree`](#breadcrumbs-in-aperas-tree)
- [Link Integrity Sweeps](#link-integrity-sweeps)

---

## Wikilink & Link Syntax
The link resolver recognizes:
- **Bare relative paths** (`./file.md` or `../folder/file.md`): Resolve directly to the whole target `ArtifactNode` or `FolderNode`. No fragment needed when citing an entire document or folder.
- **Fragment links** (`path#id/BlockNode:<ID>` or `path#anchor`): Required when linking to a specific block or heading *within* an artifact.
  - Direct node ID: `[Title](../folder/file.md#id/BlockNode:<ID>)` (unambiguous, preferred).
  - Anchor match: `[Title](../folder/file.md#heading-title)` (matches `name='...' class='aperas-anchor'`).
- **Scheme prefixes**: `[[code]]`, `aperas://tree/<path>`, or `aperas://id/<ID>`.

*Note*: An internal block link without `#id/...` or `#anchor` resolves to the whole document, not the specific block. Always verify block-level links with `aperas backlinks BlockNode:<ID> --text` on the target block.

---

## Anchor Placement — The Bold-Colon Rule
In list items, the lead-in colon must sit **outside** the bold span:
- `**Term**: text` (CORRECT)
- `**Term:** text` (INCORRECT — rejected by lead-in detector; anchor gets spliced into random text).

---

## Sketching a Structure
Build new headings or subtrees directly in the graph with zero disk-first authoring:
1. Create placeholder node:
   ```bash
   aperas resolve --create-holder <path> --titles "<Heading Title>"
   ```
2. Populate content using `aperas update` and `aperas insert`.

---

## Markdown Subtree AST Parsing & Multi-Node Piping
Markdown piped into `aperas insert <parent-id> [--after <anchor-id>]` parses into an AST and inserts the entire subtree:
- **Multi-node piping**: You can pipe multiple top-level list items or paragraphs in a single command (e.g. piping `- **Work**: ...` and `- **Report**: ...` together). All piped root items are inserted as direct children under `<parent-id>`.
- **Hierarchical nesting**: Nested sub-bullets beneath piped items parse into child BlockNodes cleanly attached to their parent items.
- **Anchor positioning**: The `--after <anchor-id>` flag positions the inserted batch directly after the specified anchor child (e.g. inserting Work and Report after the turn's `**Ask**` node).
- **Anchor constraint**: The anchor node must be a **direct child** of `<parent-id>`, not a descendant. Check tree structure first via `aperas tree` or `aperas show <parent-id>`. If an anchor is invalid, the insert fails after hydrating nodes into memory, leaving live orphans. Recover by running `aperas reload -- --discard`.

---

## Moving a Node (`insert` with No Body)
`aperas insert <node-id> --after <anchor-id>` (or `--before <anchor-id>`) with no body moves the existing node next to the anchor, keeping its ID, backlinks and history; the anchor's parent becomes the node's new parent:
```bash
aperas insert <node-id> --after <anchor-id> --flush < /dev/null
```
- **Close standard input**: A move reads standard input to its end before acting, and a harness can leave standard input open, so a move without `< /dev/null` can wait on it indefinitely.

---

## Inserting into Lists

- **Unordered Lists**:
  - Pipe bare text **with its bullet marker**:
    ```bash
    echo "- new item" | aperas insert <parent-id> --after <sibling-id> --flush
    ```
  - **Never pipe plain text without a bullet**: it parses as a paragraph, breaking the list run.

- **Ordered Lists**:
  - Appending at the end is safe when the numbering continues (`n. new item`).
  - Inserting in the middle requires renumbering everything after it. Target the **parent heading** (`aperas update <heading-id>`) and pipe the heading line plus the *complete* list verbatim with the new item included.

---

## Updating an Existing List Item (`aperas update <item-id>`)

- **Preserving Children with `--text-only`**:
  ```bash
  echo "updated text" | aperas update <item-id> --text-only --flush
  ```
  `--text-only` updates the item's `.text` (and `.title` if a lead-in exists) while leaving all existing child blocks completely untouched.
- **Ordinary text change without `--text-only`**:
  Pipe bare text with **no bullet marker**:
  ```bash
  echo "updated text" | aperas update <item-id> --flush
  ```
  *Note*: Without `--text-only`, this replaces the item's text **and reconciles its children** (tombstoning any unstated child blocks).
- **Checkboxes**:
  - Marker `- [x]` or `- [ ]` sets checkbox state.
  - Bare `- ` with text (marker-less bullet) **removes an existing checkbox entirely**.
- **Ordered List Items**:
  - Use `n.` marker when updating an ordered item (e.g. `echo "1. updated text" | aperas update <item-id> --flush`).
  - Updating an item never changes its position in the list (ordered or unordered, its sequence position is preserved). To reorder or renumber, update the parent heading with the complete list.
- **Deliberately blank text**: A bare `- ` (bullet with nothing after it) clears the item's text while allowing children to be attached.
- **Title Tracking**: The title updates if text has a bold lead-in (`**Term**: ...`). Without one, title falls back to the item's ID.
- **Symmetry Rule**: Whichever piece you do not restate without `--text-only` is wiped. If you pipe only text with no children and no `--text-only`, existing children are tombstoned. Restate whichever side you are not modifying, or use `--text-only`.

---

## Updating a Heading (`--text-only`)
- Calling `aperas update <heading-id>` without `--text-only` reconciles children against piped input. Piping just `## Title` tombstones all existing child blocks!
- **Always use `--text-only`** when retitling headings:
  ```bash
  echo "## Corrected Heading" | aperas update <heading-id> --text-only --flush
  ```
  `--text-only` updates `.title` and `.text` while leaving child blocks completely untouched.

---

## Changing Block Types (`aperas retype`)
Convert a block's type in place while preserving ID, links, parent, and position:
```bash
aperas retype <ref> --to <type>   # h1..h6, paragraph, listItem, code, blockquote, table
```
- Heading → non-heading folds title into text as `**Title**: <body>`.
- Non-heading → heading cuts lead-in term back into the heading line.

---

## Renaming Artifacts
- **Single Artifact**:
  ```bash
  git mv old.md new.md
  aperas ingest <new-path> --track --flush
  ```
  Rename detection matches by abstract-text equality against tracked nodes whose old path vanished.
- **Cross-Referencing Docs**: Complete all internal content/heading/path updates first while files remain at old names; verify with `check-links`, then execute `git mv`.

---

## Shell Quoting Gotcha
A piped `echo "..."` silently drops nested double quotes in bash (`"foo "bar" baz"` becomes `foo bar baz`).
- For content with quotes, write to a temporary file first and pipe via `cat`:
  ```bash
  cat /tmp/content.md | aperas update <id> --flush
  ```

---

## Service State & Recovery
- Flush and restart daemon from disk mirror:
  ```bash
  aperas service restart
  ```
- Discard uncommitted in-memory mutations and reload disk state:
  ```bash
  aperas reload -- --discard
  ```

---

## Raw Node State Inspection
Preview commands (`tree`, `unfold`, `backlinks`) display truncated abstracts. To inspect exact stored state:
```bash
aperas show <ref>          # Full record: props, tombstonedAt, parent, children, links, text
aperas show <ref> --text   # Exact stored text only, undecorated
```
To edit safely: dump `aperas show <ref> --text > edit.txt`, modify what is needed, and `cat edit.txt | aperas update <ref> --flush`.

---

## `aperas unfold` — Bare vs. `--view`
- Bare `aperas unfold <ref>`: Read-only peek; does not mutate any view.
- `aperas unfold <ref> --view <name> --flush`: Adds `<ref>` to `<name>`'s `unfolds` set for persistent rendering in `aperas tree --view <name>`.

---

## Tombstoned Nodes
Tombstoned nodes and their subtrees are hidden everywhere by default:
- `aperas tree` and `aperas unfold` omit them unless `--tombstoned` is passed.
- `aperas unfold <tombstoned-id>` errors out without `--tombstoned`.

---

## Full-Text Search via Raw Store
Grep the JSON-LD mirror directly for fast, untruncated content search:
```bash
grep -n -C3 '<pattern>' AperasKG/Apeiron/BlockNode.jsonld
```
Matches are candidate IDs. Always inspect live status via `aperas show <id>`.

> [!WARNING]
> `git grep` and `grep -r` skip symlinked directories like `AperasKG -> ../AperasKG`. Always use `grep -R` to follow symlinks, or specify the path directly (e.g. `grep -n -C3 '<pattern>' AperasKG/Apeiron/BlockNode.jsonld` from repo root, or `../AperasKG/Apeiron/BlockNode.jsonld` from `monorepo/`).

---

## Comparing Distant Docs (View as a Lens)
Use `--view` to bring distant parts of the tree together side by side:
```bash
for doc in issues/a.md discussion/b.md design/c.md; do
  aperas unfold "$doc" --view comparison-lens --flush
done
aperas tree --view comparison-lens
```

---

## Breadcrumbs in `aperas tree`
The first line of an `aperas tree` render is a breadcrumb: `aperas://tree/<path>`.
- Represents the walkable path of the starting apex, directly reusable as a `<ref>`.
- Appears once at the top; child lines are implicitly relative to it.
- When an unfolded link escapes into an external viewcone, an indented breadcrumb marks the jump.

---

## Link Integrity Sweeps
```bash
aperas check-links           # Sweep corpus for unresolved internal wikilinks
aperas check-links --repair  # Re-resolve and persist repairs to store
```
