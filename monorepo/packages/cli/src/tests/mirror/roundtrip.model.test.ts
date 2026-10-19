// The seeded model of the round trip (planning/core.md, Batch 9 step 4; design/core.md, "The round trip is exact"): 20 random mirrors in the
// canonical form, written into a scratch root; a load then a dump returns the files byte for byte, and a dump loaded and dumped again is the same.
// The fixture round trip is in `roundtrip.test.ts`.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { compareIds } from '@aperas/core/apeironNgn/order';
import { rng } from '../support/prng.ts';
import { THREADS, TREE, VIEWS, inFormat, roundTrip, testMapping, textsOf } from '../support/mirrorFixture.ts';

const ALPHABET = [...'0123456789ABCDEFGHJKMNPQRSTVWXYZ'];
const TEXTS = ['', 'plain', 'café', 'quote " and \\ backslash', 'line\nbreak', '😀 emoji', 'tab\t', '  separator', '<b>&amp;</b>', 'a'.repeat(300)];
const KINDS_WITH_LINKS = ['BlockNode', 'ArtifactNode', 'FolderNode'] as const;

/** A random mirror in the canonical form: the text of each file of `testMapping()`. */
function randomMirror(seed: number): Record<string, string> {
  const g = rng(seed);
  const taken = new Set<string>();
  const flake = (): string => { for (;;) { const f = Array.from({ length: 13 }, () => g.pick(ALPHABET)).join(''); if (!taken.has(f)) { taken.add(f); return f; } } };
  const mk = (kind: string): string => `${kind}:${flake()}`;
  type Node = { id: string; kind: (typeof KINDS_WITH_LINKS)[number]; graph: string; tomb: boolean };
  const nodes: Node[] = [];
  const add = (kind: Node['kind'], tomb = false): Node => { const n: Node = { id: mk(kind), kind, graph: g.chance(0.3) ? THREADS : TREE, tomb }; nodes.push(n); return n; };
  for (let i = 0; i < 1 + g.int(3); i++) add('FolderNode');
  for (let i = 0; i < 2 + g.int(4); i++) add('ArtifactNode');
  for (let i = 0; i < 15 + g.int(20); i++) add('BlockNode', g.chance(0.12));
  // The container of each node: an earlier live node, or none.
  const parentOf = new Map<string, string>();
  const listed = new Map<string, string[]>();
  nodes.forEach((n, i) => {
    if (n.tomb || i === 0 || g.chance(0.1)) return;
    const containers = nodes.slice(0, i).filter((c) => !c.tomb);
    if (containers.length === 0) return;
    const parent = g.pick(containers).id;
    parentOf.set(n.id, parent);
    listed.set(parent, [...(listed.get(parent) ?? []), n.id]);
  });
  const anyId = (): string => (g.chance(0.85) ? g.pick(nodes).id : mk('BlockNode'));
  const embedded = (owner: string, field: string, kind: string, fields: (id: string) => Record<string, unknown>): Record<string, unknown>[] => {
    const out = Array.from({ length: g.int(3) }, () => { const id = `${owner}:${field}:${kind}:${flake()}`; return { id, doc: { '@id': id, '@type': kind, ...fields(id) } }; });
    return out.sort((a, b) => compareIds(a.id, b.id)).map((e) => e.doc);
  };
  const propsOf = (owner: string, field: string): Record<string, unknown>[] => embedded(owner, field, 'StringProp', () => ({ key: g.pick(['k', 'description', 'position', 'z']), value: g.pick(TEXTS) }));
  const common = (n: Node): Record<string, unknown> => {
    const f: Record<string, unknown> = {};
    const links = g.chance(0.4) ? embedded(n.id, 'links', 'Link', (id) => { const props = g.chance(0.5) ? propsOf(id, 'props') : []; return { target: anyId(), ...(props.length > 0 ? { props } : {}) }; }) : [];
    if (links.length > 0 && !n.tomb) f.links = links;
    const props = g.chance(0.3) && !n.tomb ? propsOf(n.id, 'props') : [];
    if (props.length > 0) f.props = props;
    if (n.tomb) f.tombstonedAt = `2026-10-${10 + g.int(9)}T00:00:00.000Z`;
    if (n.kind === 'FolderNode' && g.chance(0.3)) f.holder = true;
    f.title = g.pick(TEXTS);
    if (g.chance(0.7)) f.text = g.pick(TEXTS);
    if (parentOf.has(n.id)) f.parent = parentOf.get(n.id);
    f.children = g.shuffle(listed.get(n.id) ?? []);
    return f;
  };
  const docs = new Map<string, Record<string, unknown>[]>();
  const put = (graph: string, kind: string, doc: Record<string, unknown>): void => { const key = `${graph} ${kind}`; docs.set(key, [...(docs.get(key) ?? []), doc]); };
  for (const n of nodes) {
    const f = common(n);
    if (n.kind === 'BlockNode') f.type = g.pick(['paragraph', 'heading', 'code']);
    else {
      f.path = `p/${g.int(1000)}.md`;
      if (n.kind === 'ArtifactNode') { for (const k of ['fileHash', 'lastTrackedAt', 'ingestedHash', 'lastIngestedAt', 'projectedHash']) if (g.chance(0.5)) f[k] = g.pick(TEXTS); }
      else if (g.chance(0.5)) f.projectedHash = g.pick(TEXTS);
    }
    put(n.graph, n.kind, inFormat(n.kind, n.id, f));
  }
  const profiles = Array.from({ length: 1 + g.int(3) }, () => mk('Profile'));
  for (const id of profiles) {
    const prefs = g.chance(0.4) ? propsOf(id, 'preferences') : [];
    put(TREE, 'Profile', inFormat('Profile', id, { handle: g.pick(TEXTS), ...(g.chance(0.6) ? { name: g.pick(TEXTS) } : {}), ...(g.chance(0.5) ? { kind: g.pick(['human', 'agent']) } : {}), ...(prefs.length > 0 ? { preferences: prefs } : {}) }));
  }
  for (let i = 0; i < g.int(5); i++) {
    const unfolds = [...new Set(Array.from({ length: g.int(5) }, anyId))].sort(compareIds);
    put(VIEWS, 'TreeView', inFormat('TreeView', mk('TreeView'), { profile: g.pick(profiles), name: g.pick(TEXTS), ...(unfolds.length > 0 ? { unfolds } : {}), ...(g.chance(0.5) ? { root: anyId() } : {}) }));
  }
  const mapping = testMapping();
  return textsOf(mapping, Object.fromEntries(mapping.map((m) => [m.file, (docs.get(`${m.graph} ${m.kind}`) ?? []).sort((a, b) => compareIds(a['@id'] as string, b['@id'] as string))])));
}

describe('the seeded model: random mirrors in the canonical form', () => {
  for (const seed of Array.from({ length: 20 }, (_, i) => 3001 + i)) {
    test(`seed ${seed}: load then dump is equal, and dump then load then dump is idempotent`, () => {
      const mapping = testMapping();
      const texts = randomMirror(seed);
      const docs = Object.values(texts).reduce((n, t) => n + (JSON.parse(t) as unknown[]).length, 0);
      assert.ok(docs > 15, `a mirror with something in it: ${docs} documents`);
      const r = roundTrip(texts, mapping);
      for (const m of mapping) assert.equal(r.dumped[m.file], r.written[m.file], `${m.graph} ${m.kind}`);
      assert.deepEqual(r.again, r.dumped);
    });
  }
});
