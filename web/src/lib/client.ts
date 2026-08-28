/**
 * Aperas Phase 0: TerminusDB Substrate Client Manager
 * 
 * Manages connections, database creation, and schema initialization for the Aperas Apeiron substrate.
 */

// @ts-ignore - terminusdb npm package exports WOQLClient
import TerminusDB from 'terminusdb';
import { createHash } from 'node:crypto';
import schemaObjects from './schema.json';

// Recursively sorts object keys so two structurally-identical schemas hash the same
// regardless of property insertion order (JSON.stringify key order is insertion order).
function stableStringify(value: any): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashSchema(docs: any[]): string {
  const sorted = [...docs].sort((a, b) => (a['@id'] ?? a['@type']).localeCompare(b['@id'] ?? b['@type']));
  return createHash('sha256').update(stableStringify(sorted)).digest('hex');
}

export interface TerminusConfig {
  serverUrl?: string;
  dbName?: string;
  user?: string;
  key?: string;
  organization?: string;
}

export const DEFAULT_TERMINUS_CONFIG: Required<TerminusConfig> = {
  serverUrl: process.env.TERMINUSDB_SERVER || 'http://localhost:6363/',
  dbName: process.env.TERMINUSDB_DB || 'aperas_apeiron',
  user: process.env.TERMINUSDB_USER || 'admin',
  key: process.env.TERMINUSDB_KEY || 'root',
  organization: process.env.TERMINUSDB_ORG || 'admin'
};

/**
 * Creates and configures a TerminusDB WOQLClient instance.
 */
export function createTerminusClient(config: TerminusConfig = {}) {
  const cfg = { ...DEFAULT_TERMINUS_CONFIG, ...config };
  
  const WOQLClient = TerminusDB.WOQLClient || TerminusDB;
  const client = new WOQLClient(cfg.serverUrl, {
    user: cfg.user,
    key: cfg.key,
    organization: cfg.organization
  });

  client.db(cfg.dbName);
  return client;
}

/**
 * Ensures the target database exists and applies the Aperas JSON-LD schema.
 */
export async function initializeAperasDatabase(config: TerminusConfig = {}): Promise<void> {
  const cfg = { ...DEFAULT_TERMINUS_CONFIG, ...config };
  const client = createTerminusClient(cfg);

  // Check if database exists (there is no getDatabase singular on WOQLClient — list and check membership)
  const existingDbs: any[] = await client.getDatabases();
  const dbExists = existingDbs.some((d: any) => d.name === cfg.dbName || d.id === cfg.dbName);

  if (dbExists) {
    console.log(`[Aperas Substrate] Connected to existing database: ${cfg.dbName}`);
  } else {
    console.log(`[Aperas Substrate] Database '${cfg.dbName}' not found. Creating new database...`);
    await client.createDatabase(cfg.dbName, {
      label: 'Aperas Apeiron Substrate',
      comment: 'Fluid semantic substrate for agentic knowledge graph rendering and lazy atomization.',
      schema: true
    });
    console.log(`[Aperas Substrate] Database '${cfg.dbName}' created successfully.`);
  }

  // Apply or update JSON-LD schema (real client method is `addDocument`, not `insertDocument`).
  // full_replace scopes to the schema graph only — it lets re-running this stay idempotent
  // instead of failing with "document already exists" on every schema class after the first run.
  // const schemaObjects = getAperasSchemaObjects(); (now imported directly)

  let existingSchema: any[] = [];
  try {
    existingSchema = await client.getDocument({ graph_type: 'schema', as_list: true });
  } catch {
    // No schema graph yet (brand-new database) — fall through to applying it.
  }

  if (existingSchema.length > 0 && hashSchema(existingSchema) === hashSchema(schemaObjects)) {
    console.log(`[Aperas Substrate] Schema unchanged (${schemaObjects.length} classes) — skipping apply.`);
    return;
  }

  console.log(`[Aperas Substrate] Applying JSON-LD schema (${schemaObjects.length} classes)...`);
  await client.addDocument(
    schemaObjects,
    { graph_type: 'schema', full_replace: true },
    cfg.dbName,
    'Initialize Aperas Apeiron schema'
  );
  console.log(`[Aperas Substrate] Schema applied successfully.`);
}
