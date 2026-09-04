/**
 * ApeironNgn dehydrate: the in-process `Store` -> AperasKG/Apeiron/'s JSON-LD mirror — rehydration's
 * inverse (Aperas-apeironngn-design.md §3 "Field shape"/§4 rollout). Rewrites a whole class's file
 * at a time, same as `export.ts` does today against TerminusDB — no git commit here either; that
 * stays a separate, existing step (`AperasKG/Apeiron/` already lives inside a real git repo, per
 * §3's "Versioning" bullet).
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from 'oxigraph';
import {
  nodeIri,
  predIri,
  idFromNodeIri,
  decodeLiteral,
  isLiteralTerm,
  isNamedNodeTerm,
  nodeKindFromId,
  PARENT_PRED,
  SIBLING_INDEX_PRED,
} from './vocab';
import { SHAPE_BY_KIND, type FieldSpec } from './shape';
import { getApeironExportDir } from './store';

// Which SHAPE_BY_KIND entries get their own top-level file — the 3 top-level-addressable kinds
// (Aperas-apeironngn-design.md §4 rollout step 3). `Link`/`StringProp` are both subdocuments
// (`storageKind: 'embed'`) — `decodeField`/`serializeDoc` below already recurse into either one
// generically wherever a `links`/`props` field references it, so neither gets its own file.
// `Assertion` never appears here at all (removed from the model entirely, not merely unwritten).
export const DEHYDRATE_CLASSES = ['BlockNode', 'ArtifactNode', 'FolderNode'] as const;

// `Profile`/`TreeView` (Aperas-treeview-design.md §8) — per-viewer UI state, not authored content,
// dehydrated separately via `dehydrateStateToJsonLd` into a gitignored `.state/` subfolder rather
// than alongside `DEHYDRATE_CLASSES` above.
export const STATE_CLASSES = ['Profile', 'TreeView'] as const;

export function allIdsOfKind(store: Store, kind: string): string[] {
  const ids = new Set<string>();
  for (const q of store.match(null, null, null, null)) {
    if (q.subject.termType !== 'NamedNode') continue;
    const raw = q.subject.value;
    if (!raw.startsWith('urn:aperas:node:')) continue;
    const id = idFromNodeIri(raw);
    if (nodeKindFromId(id) === kind) ids.add(id);
  }
  return [...ids];
}

/** Reified containment's inverse (`node.ts`'s `childrenOf`, but returning bare ids — dehydrate
 *  writes the plain reference-id array shape, not wrapped nodes). */
function orderedChildIds(store: Store, id: string): string[] {
  const parentMatches = store.match(null, PARENT_PRED, nodeIri(id), null);
  const withIndex = parentMatches.map((m) => {
    const childId = idFromNodeIri(String(m.subject.value));
    const idxMatches = store.match(nodeIri(childId), SIBLING_INDEX_PRED, null, null);
    const idx = idxMatches.length > 0 && isLiteralTerm(idxMatches[0].object) ? Number(idxMatches[0].object.value) : 0;
    return { childId, idx };
  });
  withIndex.sort((a, b) => a.idx - b.idx);
  return withIndex.map(({ childId }) => childId);
}

function decodeField(store: Store, id: string, field: string, spec: FieldSpec): unknown {
  const matches = store.match(nodeIri(id), predIri(field), null, null);
  const decodeOne = (m: (typeof matches)[number]) => {
    const obj = m.object;
    if (isLiteralTerm(obj)) return decodeLiteral(obj);
    if (isNamedNodeTerm(obj)) {
      const refId = idFromNodeIri(obj.value);
      return spec.storageKind === 'embed' ? serializeDoc(store, refId) : refId;
    }
    return undefined;
  };
  if (spec.cardinality === 'set') {
    // `store.match()`'s order for a Set-typed field isn't stable across a rehydrate/dehydrate
    // cycle -- sorted here so re-serializing unchanged content doesn't reshuffle `links`/`props`
    // into git-diff noise, same principle `dehydrateToJsonLd` already applies to top-level
    // documents (sorted by @id, via `stableId` below).
    return matches.map(decodeOne).sort((a, b) => stableId(a).localeCompare(stableId(b)));
  }
  if (matches.length === 0) return undefined;
  return decodeOne(matches[0]);
}

function serializeDoc(store: Store, id: string): Record<string, unknown> {
  const kind = nodeKindFromId(id);
  const shape = SHAPE_BY_KIND[kind];
  if (!shape) throw new Error(`ApeironNgn dehydrate: no shape declared for kind '${kind}' (id '${id}')`);
  const doc: Record<string, unknown> = { '@id': id, '@type': kind };
  for (const [field, spec] of Object.entries(shape)) {
    if (spec.cardinality === 'orderedContainment') {
      doc[field] = orderedChildIds(store, id); // always present, even `[]` — matches List's real serialization
      continue;
    }
    const value = decodeField(store, id, field, spec);
    if (value === undefined) continue; // Optional/one, unset — omit
    if (spec.cardinality === 'set' && Array.isArray(value) && value.length === 0) continue; // Set, empty — omit
    doc[field] = value;
  }
  return doc;
}

/** Sort key for anything `dehydrateToJsonLd` needs a stable order for: a top-level document or a
 *  `set`-cardinality field's decoded entry (an embed object with its own `@id`, a bare reference-id
 *  string, or a plain literal). */
function stableId(value: unknown): string {
  if (value && typeof value === 'object' && '@id' in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>)['@id'] ?? '');
  }
  return String(value ?? '');
}

/** Rewrites a whole class's JSON-LD file from the `Store`'s current content, for each of
 *  `DEHYDRATE_CLASSES` — full replace, matching `export.ts`'s own behavior against TerminusDB. */
export function dehydrateToJsonLd(store: Store, dir: string = getApeironExportDir()): { dir: string; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  for (const kind of DEHYDRATE_CLASSES) {
    const docs = allIdsOfKind(store, kind)
      .map((id) => serializeDoc(store, id))
      .sort((a, b) => stableId(a).localeCompare(stableId(b)));
    writeFileSync(join(dir, `${kind}.jsonld`), JSON.stringify(docs, null, 2) + '\n');
    counts[kind] = docs.length;
  }
  return { dir, counts };
}

/** `Profile`/`TreeView`'s own dehydrate pass (Aperas-treeview-design.md §8) — same
 *  `serializeDoc`/`allIdsOfKind`/`stableId` machinery as `dehydrateToJsonLd`, writing
 *  `STATE_CLASSES` into a separate, gitignored directory instead (default: `.state/` under the
 *  main mirror dir) so per-viewer UI state never lands in the git-tracked content mirror.
 *  `mkdirSync(..., { recursive: true })` since `.state/` won't exist on a fresh checkout. */
export function dehydrateStateToJsonLd(store: Store, dir: string = join(getApeironExportDir(), '.state')): { dir: string; counts: Record<string, number> } {
  mkdirSync(dir, { recursive: true });
  const counts: Record<string, number> = {};
  for (const kind of STATE_CLASSES) {
    const docs = allIdsOfKind(store, kind)
      .map((id) => serializeDoc(store, id))
      .sort((a, b) => stableId(a).localeCompare(stableId(b)));
    writeFileSync(join(dir, `${kind}.jsonld`), JSON.stringify(docs, null, 2) + '\n');
    counts[kind] = docs.length;
  }
  return { dir, counts };
}
