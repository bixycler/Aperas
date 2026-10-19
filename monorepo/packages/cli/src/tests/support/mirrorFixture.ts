// The fixture mirror of the `mirror` tests (planning/core.md, Batch 9): documents as literals in the canonical form of the Format, covering
// every kind, the three graphs, a tombstone, an embedded `Link` with a `StringProp`, a `TreeView` with `unfolds`, an empty container, an empty file,
// a containment that crosses graphs (the root folder lists the `.threads` folder of the threads graph) and strings that need escaping. It is
// written into a scratch root by the test; no test here reads the real mirror.
//
// The mapping is the shell's own, made from the default table of settings with relative directories (`Apeiron/` and `Apeiron/.state/`), so
// the files stand under the scratch root the test gives.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MAIN_GRAPH, THREADS_GRAPH, VIEWS_GRAPH } from '@aperas/core/graphConfig';
import { createEngine } from '@aperas/core/apeironNgn/engine';
import type { Engine } from '@aperas/core/apeironNgn/interface';
import { APERAS_SCHEMA } from '@aperas/core/shell/aperasSchema';
import { dumpMirror } from '@aperas/core/shell/mirrorDump';
import { documentsText, mirrorMapping, type MirrorMapping } from '@aperas/core/shell/mirrorFiles';
import { loadMirror } from '@aperas/core/shell/mirrorLoad';

export const TREE = MAIN_GRAPH;
export const THREADS = THREADS_GRAPH;
export const VIEWS = VIEWS_GRAPH;

export const newEngine = (): Engine => createEngine(APERAS_SCHEMA);

/** The shell's mapping under the default table, relative to a root: the main graph under `Apeiron/`, the threads graph and the views under `Apeiron/.state/`. */
export function testMapping(): MirrorMapping {
  return mirrorMapping([
    { graph: TREE, directory: 'Apeiron', flushIntervalMs: 10_000 },
    { graph: THREADS, directory: 'Apeiron/.state', flushIntervalMs: 3_000 },
    { graph: VIEWS, directory: 'Apeiron/.state', flushIntervalMs: 3_000 },
  ]);
}

/** A scratch directory, removed by `cleanup`. */
export function scratchRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'aperas-mirror-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Writes text files under a root, making their directories. */
export function writeTexts(root: string, files: Readonly<Record<string, string>>): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
}

/** The text of each file of a mapping, from the documents of each file (a file with none holds an empty array). */
export function textsOf(mapping: MirrorMapping, docs: Readonly<Record<string, readonly unknown[]>>): Record<string, string> {
  return Object.fromEntries(mapping.map((m) => [m.file, documentsText(docs[m.file] ?? [])]));
}

const flake = (n: number): string => `00T5MX${String(n).padStart(7, '0')}`;
/** An id of a kind. */
export const idOf = (kind: string, n: number): string => `${kind}:${flake(n)}`;
const link = (owner: string, n: number, target: string, props: [number, string, string][] = []): Record<string, unknown> => {
  const id = `${owner}:links:Link:${flake(n)}`;
  return { '@id': id, '@type': 'Link', target, ...(props.length ? { props: props.map(([m, key, value]) => ({ '@id': `${id}:props:StringProp:${flake(m)}`, '@type': 'StringProp', key, value })) } : {}) };
};
const prop = (owner: string, n: number, key: string, value: string, field = 'props'): Record<string, unknown> => ({ '@id': `${owner}:${field}:StringProp:${flake(n)}`, '@type': 'StringProp', key, value });

export const F_ROOT = idOf('FolderNode', 1);
export const F_DOCS = idOf('FolderNode', 2);
export const F_THREADS = idOf('FolderNode', 3);
export const A_DESIGN = idOf('ArtifactNode', 10);
export const A_EMPTY = idOf('ArtifactNode', 11);
export const B_ONE = idOf('BlockNode', 20);
export const B_TWO = idOf('BlockNode', 21);
export const B_EMPTY = idOf('BlockNode', 22);
export const B_CHILD = idOf('BlockNode', 23);
export const B_TOMB = idOf('BlockNode', 24);
export const B_ORPHAN = idOf('BlockNode', 25);
export const P_HUMAN = idOf('Profile', 30);
export const P_BARE = idOf('Profile', 31);
export const V_MAIN = idOf('TreeView', 40);
export const V_BARE = idOf('TreeView', 41);
export const V_THREAD = idOf('TreeView', 42);
export const A_THREAD = idOf('ArtifactNode', 50);
export const B_THREAD = idOf('BlockNode', 51);

/** The documents of the fixture for each file of `testMapping()`, each in the canonical form: fields in the schema's order, documents and embedded entries by id. */
export function fixtureDocs(): Record<string, unknown[]> {
  const treeViews = [
    { '@id': V_MAIN, '@type': 'TreeView', profile: P_HUMAN, name: 'main', unfolds: [A_DESIGN, B_ONE, B_TWO, F_ROOT], root: A_DESIGN },
    { '@id': V_BARE, '@type': 'TreeView', profile: P_BARE, name: 'bare' },
    { '@id': V_THREAD, '@type': 'TreeView', profile: P_HUMAN, name: 'thread view', unfolds: [A_THREAD, B_ONE], root: A_THREAD },
  ];
  return {
    'Apeiron/FolderNode.jsonld': [
      { '@id': F_ROOT, '@type': 'FolderNode', props: [prop(F_ROOT, 1, 'description', 'the root')], title: 'root', path: '.', children: [F_DOCS, F_THREADS] },
      { '@id': F_DOCS, '@type': 'FolderNode', title: 'docs', parent: F_ROOT, path: 'docs', children: [A_DESIGN, A_EMPTY], projectedHash: 'h1' },
    ],
    'Apeiron/ArtifactNode.jsonld': [
      {
        '@id': A_DESIGN, '@type': 'ArtifactNode',
        links: [link(A_DESIGN, 2, B_ONE, [[3, 'position', '10']])],
        props: [prop(A_DESIGN, 4, 'description', 'How a thing resolves'), prop(A_DESIGN, 5, 'zeta', '')],
        title: 'Design', text: 'a "quoted" text\nwith a newline, a tab\t, a backslash \\ and a slash /', parent: F_DOCS,
        children: [B_TWO, B_ONE, B_EMPTY], path: 'docs/design.md', fileHash: 'f1', lastTrackedAt: '2026-10-17T00:00:00.000Z', ingestedHash: 'i1', lastIngestedAt: '2026-10-17T00:00:01.000Z', projectedHash: 'p1',
      },
      { '@id': A_EMPTY, '@type': 'ArtifactNode', title: 'Empty', parent: F_DOCS, children: [], path: 'docs/empty.md' },
    ],
    'Apeiron/BlockNode.jsonld': [
      {
        '@id': B_ONE, '@type': 'BlockNode',
        links: [link(B_ONE, 6, B_TWO, [[7, 'position', '3'], [8, 'anchor', 'a']]), link(B_ONE, 9, A_THREAD)],
        title: 'One', text: 'café — 😀   and a control \u0001', parent: A_DESIGN, type: 'paragraph', children: [B_CHILD],
      },
      { '@id': B_TWO, '@type': 'BlockNode', props: [prop(B_TWO, 12, 'k', 'v')], title: 'Two', text: '', parent: A_DESIGN, type: 'heading', children: [] },
      { '@id': B_EMPTY, '@type': 'BlockNode', title: 'Empty container', parent: A_DESIGN, type: 'paragraph', children: [] },
      { '@id': B_CHILD, '@type': 'BlockNode', title: 'Child', parent: B_ONE, type: 'paragraph', children: [] },
      { '@id': B_TOMB, '@type': 'BlockNode', tombstonedAt: '2026-10-16T00:00:00.000Z', title: 'Gone', text: 'what is left of it', type: 'paragraph', children: [] },
      { '@id': B_ORPHAN, '@type': 'BlockNode', title: 'No parent', type: 'paragraph', children: [] },
    ],
    'Apeiron/Profile.jsonld': [
      { '@id': P_HUMAN, '@type': 'Profile', handle: 'will', name: 'Will', kind: 'human', preferences: [prop(P_HUMAN, 13, 'theme', 'dark', 'preferences')] },
      { '@id': P_BARE, '@type': 'Profile', handle: 'default' },
    ],
    'Apeiron/.state/FolderNode.jsonld': [
      { '@id': F_THREADS, '@type': 'FolderNode', holder: true, title: '.threads', parent: F_ROOT, path: '.threads', children: [A_THREAD] },
    ],
    'Apeiron/.state/ArtifactNode.jsonld': [
      { '@id': A_THREAD, '@type': 'ArtifactNode', title: 'coder', parent: F_THREADS, children: [B_THREAD], path: '.threads/coder.md' },
    ],
    'Apeiron/.state/BlockNode.jsonld': [
      { '@id': B_THREAD, '@type': 'BlockNode', title: 'a turn', parent: A_THREAD, type: 'heading', children: [] },
    ],
    'Apeiron/.state/TreeView.jsonld': treeViews,
  };
}

/** The Format's field order of each kind (design/core.md, "Format"), stated here once more, apart from the schema the dump follows. */
export const FORMAT_ORDER: Readonly<Record<string, readonly string[]>> = {
  BlockNode: ['links', 'props', 'tombstonedAt', 'holder', 'title', 'text', 'parent', 'type', 'children'],
  ArtifactNode: ['links', 'props', 'tombstonedAt', 'holder', 'title', 'text', 'parent', 'children', 'path', 'fileHash', 'lastTrackedAt', 'ingestedHash', 'lastIngestedAt', 'projectedHash'],
  FolderNode: ['links', 'props', 'tombstonedAt', 'holder', 'title', 'text', 'parent', 'path', 'children', 'projectedHash'],
  Profile: ['handle', 'name', 'kind', 'preferences'],
  TreeView: ['profile', 'name', 'unfolds', 'root'],
};

/** A document with its keys in the Format's order: `@id`, `@type`, then the fields of the kind that the record holds. */
export function inFormat(kind: string, id: string, fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = { '@id': id, '@type': kind };
  for (const name of FORMAT_ORDER[kind]!) if (name in fields && fields[name] !== undefined) out[name] = fields[name];
  const stray = Object.keys(fields).filter((k) => !FORMAT_ORDER[kind]!.includes(k));
  if (stray.length > 0) throw new Error(`${kind} has no field ${stray.join(', ')}`);
  return out;
}

const readAll = (root: string, mapping: MirrorMapping): Record<string, string> => Object.fromEntries(mapping.map((m) => [m.file, readFileSync(join(root, m.file), 'utf8')]));

/** Writes `texts`, loads them, dumps to a second root and gives what was written back, after checking that the load found nothing to report. */
export function roundTrip(texts: Record<string, string>, mapping: MirrorMapping): { written: Record<string, string>; dumped: Record<string, string>; again: Record<string, string>; dangling: readonly string[] } {
  const a = scratchRoot(); const b = scratchRoot(); const c = scratchRoot();
  try {
    writeTexts(a.root, texts);
    const first = loadMirror(newEngine(), a.root, mapping);
    assert.deepEqual({ errors: first.errors, warnings: first.warnings, rejected: first.rejected }, { errors: [], warnings: [], rejected: [] }, 'the load of a canonical mirror reports nothing');
    const engine = newEngine();
    loadMirror(engine, a.root, mapping);
    dumpMirror(engine, b.root, mapping);
    const dumped = readAll(b.root, mapping);
    // The dump loaded again and dumped again.
    const second = newEngine();
    const result = loadMirror(second, b.root, mapping);
    assert.deepEqual({ errors: result.errors, warnings: result.warnings, rejected: result.rejected }, { errors: [], warnings: [], rejected: [] }, 'and so does the load of the dump');
    dumpMirror(second, c.root, mapping);
    return { written: texts, dumped, again: readAll(c.root, mapping), dangling: first.dangling };
  } finally {
    a.cleanup(); b.cleanup(); c.cleanup();
  }
}

