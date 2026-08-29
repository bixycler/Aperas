/**
 * Aperas Phase 0: Knowledge Graph CLI
 *
 * `npm run kg:track`               — register/refresh lightweight ArtifactNodes for every file under AperasKG/artifacts/.
 * `npm run kg:track -- <path...>`  — register/refresh ArtifactNodes for only the given file(s) (relative to artifacts/).
 * `npm run kg:ingest`              — AST-parse and commit a fractal BlockNode tree for artifacts changed since last ingestion, then rebuild the FolderNode structural tree.
 * `npm run kg:export`              — dump the current schema and every instance document as JSON-LD files into AperasKG/Apeiron/.
 * `npm run kg:import`              — read AperasKG/Apeiron/ back into TerminusDB (schema full_replace, then per-class document upserts).
 * `npm run kg:project -- <path>`   — serialize a tracked artifact's ingested BlockNode tree back into Markdown and print it (Artifact Projection, see Aperas-artifact-projection-design.md).
 */

import { createTerminusClient, initializeAperasDatabase } from './client';
import { trackArtifact, trackAllArtifacts, ingestAllArtifacts } from './artifacts';
import { ingestFolderTree } from './folders';
import { exportJsonLd, importJsonLd } from './export';
import { projectArtifactToMarkdown } from './project';

async function main() {
  const [command, ...paths] = process.argv.slice(2);

  if (command !== 'track' && command !== 'ingest' && command !== 'export' && command !== 'import' && command !== 'project') {
    console.error('Usage: kg:track [path...] | kg:ingest | kg:export | kg:import | kg:project <path>');
    process.exit(1);
  }

  await initializeAperasDatabase();
  const client = createTerminusClient();

  if (command === 'project') {
    const [path] = paths;
    if (!path) {
      console.error('Usage: kg:project -- <path>');
      process.exit(1);
    }
    const markdown = await projectArtifactToMarkdown(client, path);
    if (markdown === null) {
      console.error(`[Aperas KG CLI] No ingested ArtifactNode found for '${path}'.`);
      process.exit(1);
    }
    console.log(markdown);
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
      const results = await Promise.all(paths.map((p) => trackArtifact(client, p)));
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
