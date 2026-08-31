/**
 * Aperas Phase 0: Knowledge Graph CLI
 *
 * `npm run kg:track`               — register/refresh lightweight ArtifactNodes for every file under AperasKG/artifacts/.
 * `npm run kg:track -- <path...>`  — register/refresh ArtifactNodes for only the given file(s) (relative to artifacts/).
 * `npm run kg:ingest`              — AST-parse and commit a fractal BlockNode tree for artifacts changed since last ingestion, then rebuild the FolderNode structural tree.
 * `npm run kg:export`              — dump the current schema and every instance document as JSON-LD files into AperasKG/Apeiron/.
 * `npm run kg:import`              — read AperasKG/Apeiron/ back into TerminusDB (schema full_replace, then per-class document upserts).
 * `npm run kg:project -- <path>`   — serialize an ingested ArtifactNode/FolderNode's tree back into Markdown and WRITE it to the artifact's file / the folder's README.md (Artifact Projection; the DB is the source of truth post-ingestion — Aperas-core-ontology-design.md §1.B). Pass `--dry-run` to print instead of writing.
 * `npm run kg:assert -- <source> <predicate> <target>`   — commit a real extrinsic Assertion (see Aperas-basic-assertion-skill-design.md). source/target accept a full node id (BlockNode/…, ArtifactNode/…, FolderNode/…) or a bare artifact path.
 * `npm run kg:assertions -- <node>`                       — list every Assertion touching a node (both directions).
 * `npm run kg:unassert -- <source> <predicate> <target>`  — delete exactly the matching Assertion(s).
 * `npm run kg:tree -- [path] [--depth N]`                 — deep, title-only structural map (Aperas-agentic-query-tools-design.md §3).
 * `npm run kg:unfold -- <path>`                            — one breadth-first step: this node's title plus each immediate child's full text; persists BlockNode.unfolded = true (§4).
 * `npm run kg:fold -- <path>`                               — inverse of kg:unfold; persists BlockNode.unfolded = false.
 * `npm run kg:search -- <pattern>`                          — regex/keyword search over every node's title/text (§5).
 * `npm run kg:title -- <path> [--recursive]`                 — interactively prompt for a real title on every still-unlabeled BlockNode in scope (Aperas-interactive-summarization-design.md §3). No `--recursive`: just <path> itself, if it's a BlockNode. `--recursive`: <path>'s full uniform tree.
 * `npm run kg:link -- <path> [--recursive] [--all]`          — interactively prompt for cross-links on BlockNodes in scope (§7). `--all` re-prompts blocks that already have links, not just unlinked ones.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { createTerminusClient, initializeAperasDatabase } from './client';
import { trackArtifact, trackAllArtifacts, ingestAllArtifacts, getArtifactRecord, getArtifactsDir, isReadmeFilename } from './artifacts';
import { ingestFolderTree, getFolderRecord } from './folders';
import { exportJsonLd, importJsonLd } from './export';
import { projectArtifactToMarkdown, projectFolderToReadme } from './project';
import { insertAssertion, deleteAssertion, updateBlockNode } from './crud';
import { queryNodeAssertions, searchNodes } from './woql';
import { resolveNodeRefOrNull } from './nodeRef';

const FULL_NODE_ID_RE = /^(BlockNode|ArtifactNode|FolderNode)\//;

function nodeKindFromId(id: string): string {
  const m = id.match(FULL_NODE_ID_RE);
  return m ? m[1] : 'Unknown';
}

/** Fetches one node by its full id via the plain Document API (reference ids, not a nested tree — same caveat as graphql.ts's own read-path note). Returns null if missing. */
async function getNode(client: any, id: string): Promise<any | null> {
  try {
    const doc = await client.getDocument({ id });
    return doc && typeof doc !== 'string' ? doc : null;
  } catch {
    return null;
  }
}

/** ArtifactNode's one child is its `root`; FolderNode/BlockNode's children are their `children` list. Both come back as plain reference id strings on a non-nested read. */
function childRefs(doc: any, kind: string): string[] {
  if (kind === 'ArtifactNode') return doc.root ? [doc.root] : [];
  return (doc.children ?? []).filter((c: any) => typeof c === 'string');
}

/** kg:tree's uniform render rule (§3): `title`, exclusively — a BlockNode's own mdast `type` stands in for `[kind]` since "BlockNode" alone says nothing about what kind of block it is. */
function displayLabel(id: string, doc: any): string {
  const kind = nodeKindFromId(id);
  return kind === 'BlockNode' ? doc.type : kind;
}

async function printTree(client: any, id: string, depth: number, maxDepth: number | undefined, lines: string[]): Promise<void> {
  const indent = '  '.repeat(depth);
  const doc = await getNode(client, id);
  if (!doc) {
    lines.push(`${indent}${id}  [?]  <not found>`);
    return;
  }
  lines.push(`${indent}${id}  [${displayLabel(id, doc)}]  ${doc.title}`);
  const refs = childRefs(doc, nodeKindFromId(id));
  if (maxDepth !== undefined && depth >= maxDepth) {
    if (refs.length > 0) lines.push(`${'  '.repeat(depth + 1)}…`);
    return;
  }
  for (const childId of refs) {
    await printTree(client, childId, depth + 1, maxDepth, lines);
  }
}

/**
 * Collects every BlockNode `{id, doc}` reachable from `id` (Aperas-interactive-summarization-
 * design.md §3/§7's shared scoping rule: no artifact/folder/block boundary, just an opt-in walk
 * of the same uniform tree `kg:tree` traverses — kgCli.ts:47-51,59). Without `recursive`, only
 * `id` itself is visited, and only collected if it's a BlockNode — an ArtifactNode/FolderNode
 * target with `recursive` unset yields nothing, by design (nothing to prompt for at that node
 * itself). With `recursive`, every kind is walked as a starting point but only BlockNode
 * descendants are collected into the result.
 */
async function collectBlockNodes(client: any, id: string, recursive: boolean): Promise<Array<{ id: string; doc: any }>> {
  const out: Array<{ id: string; doc: any }> = [];
  async function visit(nodeId: string, isRoot: boolean): Promise<void> {
    const doc = await getNode(client, nodeId);
    if (!doc) return;
    const kind = nodeKindFromId(nodeId);
    if (kind === 'BlockNode') {
      out.push({ id: nodeId, doc });
    }
    if (isRoot && !recursive) return;
    for (const childId of childRefs(doc, kind)) {
      await visit(childId, false);
    }
  }
  await visit(id, true);
  return out;
}

/**
 * Line-by-line stdin reader for kg:title/kg:link's interactive prompts. Deliberately not
 * `rl.question()`: that API races against readline's auto-close-on-stream-'end' whenever real
 * async work (e.g. resolveNodeRefOrNull's DB round-trip) happens between calls — confirmed live,
 * two different failure modes depending on timing (an immediate throw, or a silently-abandoned
 * pending call that lets the process exit with no output at all). A live interactive TTY never
 * sends 'end' mid-session, so neither failure mode is reachable there; both are real for a coding
 * agent piping pre-computed answers non-interactively, which this tool is explicitly meant to
 * support. Consuming the interface's own async iterator instead — the same mechanism `for
 * await...of readline.createInterface(...)` uses — reports end-of-input as an ordinary `{done:
 * true}`, not a race-prone exception, regardless of what else is `await`ed in between reads.
 */
function createLineReader(rl: any): { next: () => Promise<string | null> } {
  const iter = rl[Symbol.asyncIterator]();
  return {
    async next(): Promise<string | null> {
      const { value, done } = await iter.next();
      return done ? null : value;
    },
  };
}

/**
 * Sets BlockNode.unfolded, fetch-then-resubmit (children is a required List — see
 * Aperas-agentic-query-tools-design.md §4). `unfolded` only exists on BlockNode — kg:unfold/
 * kg:fold still work uniformly against an ArtifactNode/FolderNode target (display an id/kind/
 * title and its immediate children, same as any node), just with nothing to persist there, so
 * this is a no-op note rather than a hard failure for those kinds.
 */
async function setUnfolded(client: any, id: string, value: boolean): Promise<boolean> {
  if (nodeKindFromId(id) !== 'BlockNode') {
    return false;
  }
  const doc = await getNode(client, id);
  if (!doc) {
    console.error(`[Aperas KG CLI] Node '${id}' not found.`);
    process.exit(1);
  }
  await client.updateDocument(
    { ...doc, unfolded: value },
    {},
    client.db(),
    `${value ? 'Unfold' : 'Fold'} BlockNode ${id}`,
    undefined,
    undefined,
    undefined,
    true
  );
  return true;
}

/**
 * CLI-facing wrapper over the shared `resolveNodeRefOrNull` (direct id / artifact-or-folder
 * path / bare snowflake code — Aperas-basic-assertion-skill-design.md §2) that exits with a
 * usage error on a miss, since a CLI invocation with an unresolvable ref has nothing useful to
 * fall back to (unlike link extraction, which treats a miss as best-effort).
 */
async function resolveNodeRef(client: any, ref: string): Promise<string> {
  const resolved = await resolveNodeRefOrNull(client, ref);
  if (resolved) return resolved;
  console.error(`[Aperas KG CLI] '${ref}' isn't a tracked artifact or folder path, a bare node code, or a full node id (BlockNode/…, ArtifactNode/…, FolderNode/…).`);
  process.exit(1);
}

async function main() {
  const [command, ...paths] = process.argv.slice(2);

  const COMMANDS = ['track', 'ingest', 'export', 'import', 'project', 'assert', 'assertions', 'unassert', 'tree', 'unfold', 'fold', 'search', 'title', 'link'];
  if (!COMMANDS.includes(command)) {
    console.error(`Usage: kg:${COMMANDS.join(' | kg:')}`);
    process.exit(1);
  }

  await initializeAperasDatabase();
  const client = createTerminusClient();

  if (command === 'assert') {
    const [source, predicate, target] = paths;
    if (!source || !predicate || !target) {
      console.error('Usage: kg:assert -- <source> <predicate> <target>');
      process.exit(1);
    }
    const assertion = {
      source: await resolveNodeRef(client, source),
      predicate,
      target: await resolveNodeRef(client, target),
    };
    await insertAssertion(client, assertion);
    console.log(`[Aperas KG CLI] Asserted (${assertion.source}) --[${assertion.predicate}]--> (${assertion.target}).`);
  } else if (command === 'assertions') {
    const [node] = paths;
    if (!node) {
      console.error('Usage: kg:assertions -- <node>');
      process.exit(1);
    }
    const nodeId = await resolveNodeRef(client, node);
    const assertions = await queryNodeAssertions(client, nodeId);
    if (assertions.length === 0) {
      console.log(`[Aperas KG CLI] No assertions found for ${nodeId}.`);
    } else {
      for (const a of assertions) {
        console.log(`  ${a.direction}  ${a.predicate}  ${a.otherNodeId}`);
      }
    }
  } else if (command === 'unassert') {
    const [source, predicate, target] = paths;
    if (!source || !predicate || !target) {
      console.error('Usage: kg:unassert -- <source> <predicate> <target>');
      process.exit(1);
    }
    const assertion = {
      source: await resolveNodeRef(client, source),
      predicate,
      target: await resolveNodeRef(client, target),
    };
    const deleted = await deleteAssertion(client, assertion);
    console.log(`[Aperas KG CLI] Deleted ${deleted} assertion(s) matching (${assertion.source}) --[${assertion.predicate}]--> (${assertion.target}).`);
  } else if (command === 'project') {
    const dryRun = paths.includes('--dry-run');
    const [path] = paths.filter((p) => p !== '--dry-run');
    if (!path) {
      console.error('Usage: kg:project -- <path> [--dry-run]');
      process.exit(1);
    }

    // Try artifact addressing first (existing ArtifactNode/root path), then folder addressing
    // (new FolderNode/README.md path) — same "try both, they never collide" pattern resolveNodeRef
    // already uses elsewhere.
    const artifact = await getArtifactRecord(client, path);
    let markdown: string | null;
    let targetFile: string;
    if (artifact) {
      markdown = await projectArtifactToMarkdown(client, path);
      targetFile = join(getArtifactsDir(), path);
    } else {
      const folder = await getFolderRecord(client, path);
      if (!folder) {
        console.error(`[Aperas KG CLI] No ingested ArtifactNode or FolderNode found for '${path}'.`);
        process.exit(1);
      }
      markdown = await projectFolderToReadme(client, path);
      targetFile = join(getArtifactsDir(), folder.path === '.' ? '' : folder.path, 'README.md');
    }

    if (markdown === null) {
      console.error(`[Aperas KG CLI] Projection produced no content for '${path}'.`);
      process.exit(1);
    }

    if (dryRun) {
      console.log(markdown);
    } else {
      writeFileSync(targetFile, markdown, 'utf-8');
      console.log(`[Aperas KG CLI] Projected '${path}' to '${targetFile}'.`);
    }
  } else if (command === 'tree') {
    const depthFlagIdx = paths.indexOf('--depth');
    let maxDepth: number | undefined;
    let pathArg = '.';
    if (depthFlagIdx !== -1) {
      maxDepth = Number(paths[depthFlagIdx + 1]);
      const rest = paths.filter((_, i) => i !== depthFlagIdx && i !== depthFlagIdx + 1);
      if (rest[0]) pathArg = rest[0];
    } else if (paths[0]) {
      pathArg = paths[0];
    }
    const id = await resolveNodeRef(client, pathArg);
    const lines: string[] = [];
    await printTree(client, id, 0, maxDepth, lines);
    console.log(lines.join('\n'));
  } else if (command === 'unfold' || command === 'fold') {
    const [pathArg] = paths;
    if (!pathArg) {
      console.error(`Usage: kg:${command} -- <path>`);
      process.exit(1);
    }
    const id = await resolveNodeRef(client, pathArg);
    if (command === 'fold') {
      const persisted = await setUnfolded(client, id, false);
      console.log(persisted ? `[Aperas KG CLI] Folded ${id}.` : `[Aperas KG CLI] '${id}' has no 'unfolded' state to fold (only BlockNode does) — nothing to do.`);
    } else {
      const doc = await getNode(client, id);
      if (!doc) {
        console.error(`[Aperas KG CLI] Node '${id}' not found.`);
        process.exit(1);
      }
      console.log(`${id}  [${displayLabel(id, doc)}]  ${doc.title}`);
      for (const childId of childRefs(doc, nodeKindFromId(id))) {
        const child = await getNode(client, childId);
        if (!child) {
          console.log(`  ${childId}  [?]  <not found>`);
          continue;
        }
        const childKind = nodeKindFromId(childId);
        const label = displayLabel(childId, child);
        const text = childKind === 'BlockNode' && child.type === 'list'
          ? `(no text of its own — see kg:unfold ${childId})`
          : (child.text ?? '');
        console.log(`  ${childId}  [${label}]  ${text}`);
      }
      await setUnfolded(client, id, true);
    }
  } else if (command === 'search') {
    const [pattern] = paths;
    if (!pattern) {
      console.error('Usage: kg:search -- <pattern>');
      process.exit(1);
    }
    const matches = await searchNodes(client, pattern);
    if (matches.length === 0) {
      console.log(`[Aperas KG CLI] No matches for /${pattern}/.`);
    } else {
      for (const m of matches) {
        let label = nodeKindFromId(m.id);
        if (label === 'BlockNode') {
          const doc = await getNode(client, m.id);
          if (doc?.type) label = doc.type;
        }
        console.log(`${m.id}  [${label}]  ${m.field}  ${m.value}`);
      }
    }
  } else if (command === 'title') {
    const recursive = paths.includes('--recursive');
    const [pathArg] = paths.filter((p) => p !== '--recursive');
    if (!pathArg) {
      console.error('Usage: kg:title -- <path> [--recursive]');
      process.exit(1);
    }
    const id = await resolveNodeRef(client, pathArg);
    const blocks = await collectBlockNodes(client, id, recursive);
    const candidates = blocks.filter(({ doc }) => !doc.title || doc.title === doc.blockId);
    if (candidates.length === 0) {
      console.log('[Aperas KG CLI] No blocks need a title in scope.');
    } else {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const lines = createLineReader(rl);
      let set = 0;
      let asked = 0;
      for (const { id: blockId, doc } of candidates) {
        console.log(`\n${blockId}  [${doc.type}]`);
        console.log(doc.text || '(no text)');
        process.stdout.write('Title (blank to skip): ');
        const raw = await lines.next();
        if (raw === null) break; // stdin closed early — stop cleanly, don't crash
        asked++;
        const answer = raw.trim();
        if (answer) {
          await updateBlockNode(client, blockId, { title: answer });
          set++;
        }
      }
      rl.close();
      console.log(`[Aperas KG CLI] Set ${set} title(s), skipped ${asked - set}${asked < candidates.length ? ` (${candidates.length - asked} unreached — input ended early)` : ''}.`);
    }
  } else if (command === 'link') {
    const recursive = paths.includes('--recursive');
    const all = paths.includes('--all');
    const [pathArg] = paths.filter((p) => p !== '--recursive' && p !== '--all');
    if (!pathArg) {
      console.error('Usage: kg:link -- <path> [--recursive] [--all]');
      process.exit(1);
    }
    const id = await resolveNodeRef(client, pathArg);
    const blocks = await collectBlockNodes(client, id, recursive);
    const candidates = all ? blocks : blocks.filter(({ doc }) => !doc.links || doc.links.length === 0);
    if (candidates.length === 0) {
      console.log('[Aperas KG CLI] No blocks to prompt for links in scope.');
    } else {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const lines = createLineReader(rl);
      let linkedBlocks = 0;
      let addedLinks = 0;
      let stdinClosed = false;
      for (const { id: blockId, doc } of candidates) {
        if (stdinClosed) break;
        console.log(`\n${blockId}  [${doc.type}]`);
        console.log(doc.text || '(no text)');
        const existing: any[] = doc.links ?? [];
        const newLinks: any[] = [];
        for (;;) {
          const prompt = newLinks.length === 0 ? 'Link target (blank to skip block): ' : 'Another link target (blank to move on): ';
          process.stdout.write(prompt);
          const raw = await lines.next();
          if (raw === null) { stdinClosed = true; break; } // stdin closed early — stop after saving what's gathered so far
          const answer = raw.trim();
          if (!answer) break;
          const target = await resolveNodeRefOrNull(client, answer);
          if (!target) {
            console.log(`  '${answer}' didn't resolve to any node — try again or leave blank.`);
            continue;
          }
          newLinks.push({ '@type': 'Link', target, predicate: 'references' });
        }
        if (newLinks.length > 0) {
          await updateBlockNode(client, blockId, { links: [...existing, ...newLinks] });
          linkedBlocks++;
          addedLinks += newLinks.length;
        }
      }
      rl.close();
      console.log(`[Aperas KG CLI] Added ${addedLinks} link(s) across ${linkedBlocks} block(s).`);
    }
  } else if (command === 'export') {
    const { dir, counts } = await exportJsonLd(client);
    const summary = Object.entries(counts).map(([type, n]) => `${n} ${type}`).join(', ');
    console.log(`[Aperas KG CLI] Exported JSON-LD to ${dir} (${summary}).`);
  } else if (command === 'import') {
    const { dir, counts, skipped } = await importJsonLd(client);
    const summary = Object.entries(counts).map(([type, n]) => `${n} ${type}`).join(', ');
    const skippedSummary = skipped.length > 0 ? `; skipped unchanged: ${skipped.join(', ')}` : '';
    console.log(`[Aperas KG CLI] Imported JSON-LD from ${dir} (${summary}${skippedSummary}).`);
  } else if (command === 'track') {
    if (paths.length > 0) {
      // A README is absorbed into its FolderNode (folders.ts), never an ordinary ArtifactNode —
      // trackAllArtifacts's sweep already excludes it via listArtifactFiles; this explicit
      // single-file path bypasses that list entirely, so it needs the same guard directly.
      const readmeArgs = paths.filter((p) => isReadmeFilename(p.split('/').pop() ?? p));
      for (const p of readmeArgs) {
        console.warn(`[Aperas KG CLI] '${p}' is a README — it's absorbed into its FolderNode, not tracked as an ordinary artifact. Skipping.`);
      }
      const trackablePaths = paths.filter((p) => !readmeArgs.includes(p));
      const results = await Promise.all(trackablePaths.map((p) => trackArtifact(client, p)));
      const trackedCount = results.filter((r) => r.tracked).length;
      const skippedCount = results.length - trackedCount;
      console.log(`[Aperas KG CLI] Tracked ${trackedCount} artifact(s), skipped ${skippedCount} unchanged.`);
    } else {
      const { results, sweep } = await trackAllArtifacts(client);
      const trackedCount = results.filter((r) => r.tracked).length;
      const skippedCount = results.length - trackedCount;
      console.log(`[Aperas KG CLI] Tracked ${trackedCount} artifact(s), skipped ${skippedCount} unchanged, ${sweep.renamed} renamed, ${sweep.removed} removed.`);
    }
  } else {
    const ingested = await ingestAllArtifacts(client);
    if (ingested.length === 0) {
      console.log('[Aperas KG CLI] No artifacts required ingestion.');
    } else {
      for (const r of ingested) {
        const recon = r.reconciliation;
        const reconSummary = recon ? ` (reconciled: ${recon.unchanged} unchanged, ${recon.moved} moved, ${recon.added} added, ${recon.removed} removed)` : '';
        console.log(`[Aperas KG CLI] Ingested '${r.path}' fractal tree (${r.blockCount} blocks)${reconSummary}.`);
      }
    }

    const { folderCount, sweep } = await ingestFolderTree(client);
    console.log(`[Aperas KG CLI] Rebuilt FolderNode structural tree (${folderCount} folder(s), ${sweep.renamed} renamed, ${sweep.removed} removed).`);
  }
}

main().catch((err) => {
  console.error('[Aperas KG CLI] Failed:', err.message || err);
  process.exit(1);
});
