/**
 * ApeironNgn rehydration: AperasKG/Apeiron/'s JSON-LD mirror -> an in-memory Oxigraph Store.
 * See Aperas-apeironngn-design.md §3-4 and the `oxigraph` skill's persistence.md (in-memory-only
 * Node/WASM build, rehydrated at process start — no separate on-disk step of its own here).
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Store, quad } from 'oxigraph';
import {
  NODE_BASE,
  nodeIri,
  predIri,
  encodeLiteral,
  isNodeRef,
  ORDERED_CONTAINMENT_FIELD,
  PARENT_PRED,
  SIBLING_INDEX_PRED,
} from './vocab';
import { resolveEffectiveApeironRoot } from '../graphConfig';

// The top-level-addressable content kinds (Aperas-apeironngn-design.md §4 rollout step 3's
// hierarchy refactor), plus `Profile` (Aperas-treeview-design.md §8/§11 — stable identity, tracked
// alongside content now, not per-viewer ephemeral state): `Link`/`StringProp` are subdocuments,
// nested inline inside whichever `BlockNode`/`ArtifactNode`/`FolderNode`/`Profile` document owns
// them (`encodeDoc`'s embedded-object branch below handles both `links`/`props`/`preferences`
// uniformly) — no standalone `Link.jsonld` to read anymore. `Assertion` is gone entirely, not
// merely unread: previously listed here (its fields landed as raw quads, since `encodeDoc` doesn't
// consult any class registry) while `dehydrate.ts` never wrote it back out — a real latent bug (any
// live `Assertion` doc would silently vanish on the next dehydrate), closed by removing the read
// path rather than adding the write path back. The real `Assertion.jsonld` had zero documents when
// this was checked, so nothing was lost.
const INSTANCE_FILES = ['BlockNode', 'ArtifactNode', 'FolderNode', 'Profile'] as const;

// `TreeView` (Aperas-treeview-design.md §8) — genuinely ephemeral per-viewer UI state, read from
// the gitignored `.state/` subfolder `dehydrateStateToJsonLd` writes into, not alongside
// `INSTANCE_FILES` above.
const STATE_FILES = ['TreeView'] as const;

/** Defaults to `resolveEffectiveApeironRoot()` — see `artifacts.ts#getArtifactsDir`'s own doc
 *  comment for the full reasoning (this is its Apeiron-root counterpart, `APERAS_APEIRON_ROOT`
 *  instead of `APERAS_ARTIFACTS_ROOT`). */
export function getApeironExportDir(dir: string = resolveEffectiveApeironRoot()): string {
  return dir;
}

export interface RehydrateResult {
  store: Store;
  quadCount: number;
  nodeCount: number;
  /** Ids referenced (as a `parent`/`root`/`children` entry) that never appear as a document's own
   *  `@id` anywhere in the mirror — a genuine data problem now that every reference-shaped field
   *  points at one of the 3 `INSTANCE_FILES` kinds. Surfaced rather than silently dropped. */
  danglingRefs: string[];
  /** Two or more distinct JSON-LD documents (top-level or embedded) sharing one `@id` — quads from
   *  every occurrence land on the same subject, so encoding silently merges them and a later
   *  dehydrate can only ever emit one JSON document back out per id, dropping whichever source
   *  document doesn't win. Confirmed live: a hand-edit collapsed two distinct `Profile` entries
   *  (`Aperas-apeironngn-design.md`'s Profile identity — see `issues/core.md`) onto one `@id`, and
   *  the "claude" profile silently vanished on every subsequent flush/reload/clobber, with nothing
   *  ever reporting *why* — this array exists so that never again requires a human noticing a
   *  missing profile by hand before anyone finds out. Surfaced, never auto-resolved: picking a
   *  winner here would just be a second, quieter way to lose the same data. */
  duplicateIds: string[];
}

/** Encodes one JSON-LD document's own fields as quads, recursing into `@subdocument` arrays
 *  (`props`: `Prop`/`StringProp`) whose entries carry their own `@id` and fields. `duplicateIds`
 *  collects (doesn't throw on) an `@id` already seen earlier in this same rehydrate — see
 *  `RehydrateResult.duplicateIds`'s own doc comment for why surfacing beats guessing a winner. */
function encodeDoc(store: Store, doc: Record<string, any>, seenIds: Set<string>, duplicateIds: string[]): void {
  const id: string = doc['@id'];
  if (!id) return;
  if (seenIds.has(id)) duplicateIds.push(id);
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
        encodeDoc(store, item, seenIds, duplicateIds);
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
 *  callers always want the actual `AperasKG/Apeiron/` mirror. Also reads `TreeView` from `stateDir`
 *  (default: `dir`'s own `.state/` subfolder, `dehydrateStateToJsonLd`'s output) into the same
 *  `Store` — one in-memory graph either way, just dehydrated to two locations
 *  (Aperas-treeview-design.md §8). Each `STATE_FILES` entry is read only if it exists: on a fresh
 *  checkout, or before any view has ever been unfolded, `.state/` may not exist yet at all — that's
 *  not a data problem the way a missing `INSTANCE_FILES` entry would be. */
export function rehydrateStore(dir: string = getApeironExportDir(), stateDir: string = join(dir, '.state')): RehydrateResult {
  const store = new Store();
  const seenIds = new Set<string>();
  const referencedIds = new Set<string>();
  const duplicateIds: string[] = [];

  for (const file of INSTANCE_FILES) {
    const docs: any[] = JSON.parse(readFileSync(join(dir, `${file}.jsonld`), 'utf-8'));
    for (const doc of docs) {
      if (doc['@type'] === '@context') continue;
      encodeDoc(store, doc, seenIds, duplicateIds);
    }
  }
  for (const file of STATE_FILES) {
    const path = join(stateDir, `${file}.jsonld`);
    if (!existsSync(path)) continue;
    const docs: any[] = JSON.parse(readFileSync(path, 'utf-8'));
    for (const doc of docs) {
      if (doc['@type'] === '@context') continue;
      encodeDoc(store, doc, seenIds, duplicateIds);
    }
  }

  // Second pass for dangling-reference detection: any object-position node reference that never
  // showed up as a document's own `@id` above.
  for (const q of store.match(null, null, null, null)) {
    if (q.object.termType === 'NamedNode') {
      const raw = q.object.value;
      if (raw.startsWith(NODE_BASE)) referencedIds.add(raw.slice(NODE_BASE.length));
    }
  }
  const danglingRefs = [...referencedIds].filter((id) => !seenIds.has(id)).sort();

  return { store, quadCount: store.size, nodeCount: seenIds.size, danglingRefs, duplicateIds: [...new Set(duplicateIds)].sort() };
}
