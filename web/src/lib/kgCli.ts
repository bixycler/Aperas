/**
 * Aperas Phase 0: Knowledge Graph CLI
 *
 * `npm run kg:track`               — register/refresh lightweight ArtifactNodes for every file under AperasKG/artifacts/.
 * `npm run kg:track -- <path...>`  — register/refresh ArtifactNodes for only the given file(s) (relative to artifacts/).
 * `npm run kg:ingest`              — AST-parse and commit DocumentNode/BlockNodes for artifacts changed since last ingestion.
 */

import { createTerminusClient, initializeAperasDatabase } from './client';
import { trackArtifact, trackAllArtifacts, ingestAllArtifacts } from './artifacts';

async function main() {
  const [command, ...paths] = process.argv.slice(2);

  if (command !== 'track' && command !== 'ingest') {
    console.error('Usage: kg:track [path...] | kg:ingest');
    process.exit(1);
  }

  await initializeAperasDatabase();
  const client = createTerminusClient();

  if (command === 'track') {
    const tracked = paths.length > 0
      ? await Promise.all(paths.map((p) => trackArtifact(client, p)))
      : await trackAllArtifacts(client);
    console.log(`[Aperas KG CLI] Tracked ${tracked.length} artifact(s).`);
  } else {
    const ingested = await ingestAllArtifacts(client);
    if (ingested.length === 0) {
      console.log('[Aperas KG CLI] No artifacts required ingestion.');
    } else {
      for (const r of ingested) {
        console.log(`[Aperas KG CLI] Ingested '${r.path}' -> '${r.docId}' (${r.blockCount} blocks).`);
      }
    }
  }
}

main().catch((err) => {
  console.error('[Aperas KG CLI] Failed:', err.message || err);
  process.exit(1);
});
