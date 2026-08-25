/**
 * Aperas Phase 0: Knowledge Graph CLI
 *
 * `npm run kg:track`  — register/refresh lightweight ArtifactNodes for every file under AperasKG/artifacts/.
 * `npm run kg:ingest` — AST-parse and commit DocumentNode/BlockNodes for artifacts changed since last ingestion.
 */

import { createTerminusClient, initializeAperasDatabase } from './client';
import { trackAllArtifacts, ingestAllArtifacts } from './artifacts';

async function main() {
  const command = process.argv[2];

  if (command !== 'track' && command !== 'ingest') {
    console.error('Usage: kg:track | kg:ingest');
    process.exit(1);
  }

  await initializeAperasDatabase();
  const client = createTerminusClient();

  if (command === 'track') {
    const tracked = await trackAllArtifacts(client);
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
