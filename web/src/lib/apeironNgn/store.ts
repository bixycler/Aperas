/**
 * ApeironNgn rehydration: AperasKG/Apeiron/'s JSON-LD mirror -> an in-memory Oxigraph Store.
 * See Aperas-apeironngn-design.md §3-4 and the `oxigraph` skill's persistence.md (in-memory-only
 * Node/WASM build, rehydrated at process start — no separate on-disk step of its own here).
 */

import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, quad } from 'oxigraph';
import {
  nodeIri,
  predIri,
  encodeLiteral,
  isNodeRef,
  ORDERED_CONTAINMENT_FIELD,
  PARENT_PRED,
  SIBLING_INDEX_PRED,
} from './vocab';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Same 5 files export.ts writes/reads (`Link` included since export.ts's INSTANCE_CLASSES fix —
// Aperas-apeironngn-design.md §4's dangling-reference finding is now closed on the TerminusDB
// side; `danglingRefs` below stays as a general-purpose check, not a Link-specific one).
const INSTANCE_FILES = ['BlockNode', 'Link', 'ArtifactNode', 'FolderNode', 'Assertion'] as const;

export function getApeironExportDir(): string {
  // web/src/lib/apeironNgn -> web/src/lib -> web/src -> web -> repo root -> AperasKG/Apeiron
  return resolve(__dirname, '..', '..', '..', '..', 'AperasKG', 'Apeiron');
}

export interface RehydrateResult {
  store: Store;
  quadCount: number;
  nodeCount: number;
  /** Ids referenced (as a `links`/`target`/etc. value) that never appear as a document's own
   *  `@id` anywhere in the mirror — currently always `Link/...` ids, since Link isn't among
   *  INSTANCE_FILES. Surfaced rather than silently dropped. */
  danglingRefs: string[];
}

/** Encodes one JSON-LD document's own fields as quads, recursing into `@subdocument` arrays
 *  (`props`: `Prop`/`StringProp`) whose entries carry their own `@id` and fields. */
function encodeDoc(store: Store, doc: Record<string, any>, seenIds: Set<string>): void {
  const id: string = doc['@id'];
  if (!id) return;
  seenIds.add(id);
  const subject = nodeIri(id);

  for (const [field, value] of Object.entries(doc)) {
    if (field === '@id' || field === '@type') continue;

    if (field === ORDERED_CONTAINMENT_FIELD && Array.isArray(value)) {
      // Reified containment (Aperas-apeironngn-design.md §3): no forward `children` quad at all —
      // each member gets its own `parent` back-reference plus a `siblingIndex`, both cheap to
      // query in either direction on Oxigraph's ordinary indexes, order recovered by sorting an
      // already-fetched set rather than walking a `Cons` chain.
      value.forEach((childId: string, index: number) => {
        if (typeof childId !== 'string') return; // no inline-literal children observed in practice
        store.add(quad(nodeIri(childId), PARENT_PRED, subject));
        store.add(quad(nodeIri(childId), SIBLING_INDEX_PRED, encodeLiteral(index)));
      });
      continue;
    }

    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (item === null || item === undefined) continue;
      if (typeof item === 'object' && item['@id']) {
        // Embedded subdocument (props: StringProp) — its own subject, recurse, plus a forward
        // link from the owner so `owner.props` can find it.
        store.add(quad(subject, predIri(field), nodeIri(item['@id'])));
        encodeDoc(store, item, seenIds);
        continue;
      }
      if (isNodeRef(item)) {
        store.add(quad(subject, predIri(field), nodeIri(item)));
        continue;
      }
      if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
        store.add(quad(subject, predIri(field), encodeLiteral(item)));
      }
    }
  }
}

/** Rehydrates a fresh in-memory Store from the JSON-LD mirror. Pass `dir` only in tests — real
 *  callers always want the actual `AperasKG/Apeiron/` mirror. */
export function rehydrateStore(dir: string = getApeironExportDir()): RehydrateResult {
  const store = new Store();
  const seenIds = new Set<string>();
  const referencedIds = new Set<string>();

  for (const file of INSTANCE_FILES) {
    const docs: any[] = JSON.parse(readFileSync(join(dir, `${file}.jsonld`), 'utf-8'));
    for (const doc of docs) {
      if (doc['@type'] === '@context') continue;
      encodeDoc(store, doc, seenIds);
    }
  }

  // Second pass for dangling-reference detection: any object-position node reference that never
  // showed up as a document's own `@id` above.
  for (const q of store.match(null, null, null, null)) {
    if (q.object.termType === 'NamedNode') {
      const raw = q.object.value;
      if (raw.startsWith('urn:aperas:node:')) referencedIds.add(raw.slice('urn:aperas:node:'.length));
    }
  }
  const danglingRefs = [...referencedIds].filter((id) => !seenIds.has(id)).sort();

  return { store, quadCount: store.size, nodeCount: seenIds.size, danglingRefs };
}
