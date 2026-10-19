// The round trip is exact (planning/core.md, Batch 9 step 4; design/core.md, "The round trip is exact"): a load followed by a dump returns the
// files byte for byte, so a flush with nothing changed leaves git clean. The fixture mirror, written into a scratch root, with the shell's three
// graphs (every kind, a tombstone, an embedded Link with a StringProp, a TreeView with unfolds, an empty container, a containment
// that crosses graphs). The seeded model is in `roundtrip.model.test.ts` and the corpus round trip, on a migrated copy
// of the real mirror, in `corpus/mirror.test.ts` (`demand`).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { documentsText } from '@aperas/core/shell/mirrorFiles';
import { fixtureDocs, roundTrip, testMapping, textsOf } from '../support/mirrorFixture.ts';

describe('the fixture mirror: a load followed by a dump returns the files byte for byte', () => {
  test('in the three graphs of the shell', () => {
    const mapping = testMapping();
    const docs = fixtureDocs();
    const texts = textsOf(mapping, docs);
    const kinds = new Set(Object.values(docs).flat().flatMap(function collect(d: unknown): string[] {
      const own = (d as { '@type'?: string })['@type'];
      const nested = Object.values(d as object).flatMap((v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'object' && x !== null).flatMap(collect) : []));
      return own === undefined ? nested : [own, ...nested];
    }));
    assert.deepEqual([...kinds].sort(), ['ArtifactNode', 'BlockNode', 'FolderNode', 'Link', 'Profile', 'StringProp', 'TreeView'], 'the fixture covers every kind');
    assert.deepEqual(mapping.map((m) => `${m.graph} ${m.kind}`), ['tree ArtifactNode', 'tree FolderNode', 'tree BlockNode', 'tree Profile', 'threads.tree ArtifactNode', 'threads.tree FolderNode', 'threads.tree BlockNode', 'treeviews TreeView'], 'in three graphs');

    const r = roundTrip(texts, mapping);
    for (const m of mapping) assert.equal(r.dumped[m.file], r.written[m.file], `${m.graph} ${m.kind}: ${m.file}`);
    assert.deepEqual(r.again, r.dumped, 'a dump of the dump is the same');
    assert.deepEqual(r.dangling, [], 'the folder of the threads graph that the root folder lists is defined, and so is every other reference');
  });

  test('with the file of the views empty', () => {
    const mapping = testMapping();
    const texts = { ...textsOf(mapping, fixtureDocs()), 'Apeiron/.state/TreeView.jsonld': documentsText([]) };
    assert.equal(texts['Apeiron/.state/TreeView.jsonld'], '[]\n');
    const r = roundTrip(texts, mapping);
    for (const m of mapping) assert.equal(r.dumped[m.file], r.written[m.file], `${m.graph} ${m.kind}: ${m.file}`);
  });
});
