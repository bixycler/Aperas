// The dump (planning/core.md, Batch 9 step 1; design/core.md, "Format", "Orders in the mirror", "A flush is a dump"): documents sorted by @id by
// code point, indented by two spaces, ending with a newline, fields in the order of the Format, an unset field or an empty set left out except
// `children`, embedded entries and the values of a reference set sorted by id, strings as read and integers in their canonical text. The dump
// reads the records out of the engine and rebuilds nothing from pairs. The shuffle cases build the same records in many orders.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine } from '@aperas/core/apeironNgn/engine';
import type { BuildRecord, Engine } from '@aperas/core/apeironNgn/interface';
import { dumpDocuments, dumpText } from '@aperas/core/shell/mirrorDump';
import { dehydrateToJsonLd } from '@aperas/core/shell/dehydrate';
import { rehydrateStore } from '@aperas/core/shell/store';
import { freeWasm } from '@aperas/core/shell/vocab';
import { rng } from '../support/prng.ts';
import { FORMAT_ORDER, THREADS, TREE, idOf, newEngine } from '../support/mirrorFixture.ts';

const ALPHABET = [...'0123456789ABCDEFGHJKMNPQRSTVWXYZ'];
const codePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const engineWith = (records: BuildRecord[], graph = TREE): Engine => {
  const engine = newEngine();
  engine.createGraph(graph);
  for (const r of records) engine.build(graph, r);
  return engine;
};

describe('the text of a file', () => {
  test('is a JSON array indented by two spaces, with the fields in the Format\'s order, and ends with one newline', () => {
    const a = idOf('ArtifactNode', 1); const b = idOf('BlockNode', 2); const link = `${b}:links:Link:00T5MX0000009`;
    const engine = engineWith([
      { id: b, kind: 'BlockNode', fields: { children: [], type: 'paragraph', text: 'say "hi"\n', title: 'T', links: [link] } },
      { id: link, kind: 'Link', fields: { target: a } },
      { id: a, kind: 'ArtifactNode', fields: { path: 'a.md', children: [b], title: 'A' } },
    ]);
    assert.equal(dumpText(engine, TREE, 'BlockNode'), [
      '[',
      '  {',
      `    "@id": "${b}",`,
      '    "@type": "BlockNode",',
      '    "links": [',
      '      {',
      `        "@id": "${link}",`,
      '        "@type": "Link",',
      `        "target": "${a}"`,
      '      }',
      '    ],',
      '    "title": "T",',
      '    "text": "say \\"hi\\"\\n",',
      `    "parent": "${a}",`,
      '    "type": "paragraph",',
      '    "children": []',
      '  }',
      ']',
      '',
    ].join('\n'));
    assert.equal(dumpText(engine, TREE, 'ArtifactNode'), [
      '[',
      '  {',
      `    "@id": "${a}",`,
      '    "@type": "ArtifactNode",',
      '    "title": "A",',
      '    "children": [',
      `      "${b}"`,
      '    ],',
      '    "path": "a.md"',
      '  }',
      ']',
      '',
    ].join('\n'));
  });

  test('is [] and a newline for a kind with no record, and for a graph with none', () => {
    const engine = newEngine();
    engine.createGraph(TREE);
    assert.equal(dumpText(engine, TREE, 'BlockNode'), '[]\n');
    assert.equal(dumpText(engine, TREE, 'Profile'), '[]\n');
  });
});

describe('the fields of a document', () => {
  const all: Record<string, Record<string, unknown>> = {
    BlockNode: { type: 'p', children: [], text: 't', title: 'T', holder: true, tombstonedAt: '2026-10-17T00:00:00Z', props: ['PROP'], links: ['LINK'] },
    ArtifactNode: { projectedHash: 'a', lastIngestedAt: 'b', ingestedHash: 'c', lastTrackedAt: 'd', fileHash: 'e', path: 'f', children: [], text: 't', title: 'T', holder: true, tombstonedAt: 'x', props: ['PROP'], links: ['LINK'] },
    FolderNode: { projectedHash: 'a', path: 'f', children: [], text: 't', title: 'T', holder: true, tombstonedAt: 'x', props: ['PROP'], links: ['LINK'] },
    Profile: { preferences: ['PREF'], kind: 'human', name: 'N', handle: 'h' },
    TreeView: { root: idOf('BlockNode', 5), unfolds: [idOf('BlockNode', 6)], name: 'n', profile: idOf('Profile', 7) },
  };

  for (const kind of Object.keys(all)) {
    test(`${kind} lists @id and @type and then its fields in the Format's order, however the build named them`, () => {
      const id = idOf(kind, 1);
      const container = idOf('BlockNode', 99);
      const fields = Object.fromEntries(Object.entries(all[kind]!).map(([k, v]) => [k, JSON.stringify(v).includes('LINK') ? [`${id}:links:Link:00T5MX0000010`] : JSON.stringify(v).includes('PROP') ? [`${id}:props:StringProp:00T5MX0000011`] : JSON.stringify(v).includes('PREF') ? [`${id}:preferences:StringProp:00T5MX0000012`] : v]));
      const records: BuildRecord[] = [{ id, kind, fields: fields as BuildRecord['fields'] }];
      if ('links' in fields) records.push({ id: `${id}:links:Link:00T5MX0000010`, kind: 'Link', fields: { target: idOf('BlockNode', 5) } });
      if ('props' in fields) records.push({ id: `${id}:props:StringProp:00T5MX0000011`, kind: 'StringProp', fields: { key: 'k', value: 'v' } });
      if ('preferences' in fields) records.push({ id: `${id}:preferences:StringProp:00T5MX0000012`, kind: 'StringProp', fields: { key: 'k', value: 'v' } });
      if (kind !== 'Profile' && kind !== 'TreeView') records.push({ id: container, kind: 'BlockNode', fields: { title: 'c', type: 'p', children: [id] } });
      const engine = engineWith(records);
      const [doc] = dumpDocuments(engine, TREE, kind);
      const expected = ['@id', '@type', ...FORMAT_ORDER[kind]!.filter((f) => f === 'parent' ? kind !== 'Profile' && kind !== 'TreeView' : true)];
      assert.deepEqual(Object.keys(doc!), expected);
    });
  }

  test('a field that is unset or an empty set is left out, and children is written as an empty array', () => {
    const b = idOf('BlockNode', 1); const f = idOf('FolderNode', 2); const a = idOf('ArtifactNode', 3); const p = idOf('Profile', 4); const v = idOf('TreeView', 5);
    const engine = engineWith([
      { id: b, kind: 'BlockNode', fields: { title: 'T', type: 'p', links: [], props: [], children: [] } },
      { id: f, kind: 'FolderNode', fields: { title: 'F', path: '.', props: [] } },
      { id: a, kind: 'ArtifactNode', fields: { title: 'A', path: 'a.md', links: [] } },
      { id: p, kind: 'Profile', fields: { handle: 'h', preferences: [] } },
      { id: v, kind: 'TreeView', fields: { profile: p, name: 'n', unfolds: [] } },
    ]);
    assert.deepEqual(Object.keys(dumpDocuments(engine, TREE, 'BlockNode')[0]!), ['@id', '@type', 'title', 'type', 'children']);
    assert.deepEqual(dumpDocuments(engine, TREE, 'FolderNode')[0], { '@id': f, '@type': 'FolderNode', title: 'F', path: '.', children: [] }, 'children written although the build gave none');
    assert.deepEqual(dumpDocuments(engine, TREE, 'ArtifactNode')[0], { '@id': a, '@type': 'ArtifactNode', title: 'A', children: [], path: 'a.md' });
    assert.deepEqual(dumpDocuments(engine, TREE, 'Profile')[0], { '@id': p, '@type': 'Profile', handle: 'h' });
    assert.deepEqual(dumpDocuments(engine, TREE, 'TreeView')[0], { '@id': v, '@type': 'TreeView', profile: p, name: 'n' });
  });

  test('a string is written as read and an integer in its canonical text', () => {
    const odd = ['', ' padded ', 'café 😀', 'a b', '\u0001\u001f', '"\\/', 'line\r\nbreak', '00123', '1e3', 'true'];
    const engine = engineWith(odd.map((text, i) => ({ id: idOf('BlockNode', i + 1), kind: 'BlockNode', fields: { title: text, text, type: 'p' } })));
    const docs = dumpDocuments(engine, TREE, 'BlockNode');
    assert.deepEqual(docs.map((d) => d.text), odd);
    const parsed = JSON.parse(dumpText(engine, TREE, 'BlockNode')) as { text: string }[];
    assert.deepEqual(parsed.map((d) => d.text), odd, 'and the text reads back to the same strings');

    const numeric = createEngine({ kinds: [{ name: 'Num', fields: [{ name: 'n', storage: 'literal', cardinality: 'optional' }, { name: 'flag', storage: 'literal', cardinality: 'optional' }] }] });
    numeric.createGraph(TREE);
    const values: [number, string][] = [[0, '0'], [7, '7'], [-3, '-3'], [12345678901, '12345678901'], [1.5, '1.5'], [-0, '0'], [1e21, '1e+21']];
    values.forEach(([n], i) => numeric.build(TREE, { id: `Num:00T5MX00000${String(i).padStart(2, '0')}`, kind: 'Num', fields: { n, flag: i % 2 === 0 } }));
    const text = dumpText(numeric, TREE, 'Num');
    const lines = text.split('\n').filter((l) => l.includes('"n"')).map((l) => l.trim().replace(/,$/, ''));
    assert.deepEqual(lines, values.map(([, canonical]) => `"n": ${canonical}`));
    assert.ok(text.includes('"flag": true') && text.includes('"flag": false'), 'a boolean stays a boolean');
  });
});

describe('the orders of a file', () => {
  for (const seed of Array.from({ length: 10 }, (_, i) => 700 + i)) {
    test(`seed ${seed}: documents are sorted by @id by code point, whatever the order of the build`, () => {
      const g = rng(seed);
      const ids = new Set<string>();
      while (ids.size < 40) ids.add(`BlockNode:${Array.from({ length: 13 }, () => g.pick(ALPHABET)).join('')}`);
      const engine = engineWith(g.shuffle([...ids]).map((id) => ({ id, kind: 'BlockNode', fields: { title: id, type: 'p' } })));
      const dumped = dumpDocuments(engine, TREE, 'BlockNode').map((d) => d['@id'] as string);
      assert.deepEqual(dumped, [...ids].sort(codePoint));
      assert.equal(dumpText(engine, TREE, 'BlockNode'), dumpText(engineWith(g.shuffle([...ids]).map((id) => ({ id, kind: 'BlockNode', fields: { title: id, type: 'p' } }))), TREE, 'BlockNode'), 'the same text from another order');
    });
  }

  test('the embedded entries of a set field and the values of a reference set are sorted by id, however they were built', () => {
    for (const seed of [11, 12, 13, 14, 15]) {
      const g = rng(seed);
      const owner = idOf('BlockNode', 1);
      const links = g.shuffle(Array.from({ length: 6 }, () => `${owner}:links:Link:${Array.from({ length: 13 }, () => g.pick(ALPHABET)).join('')}`));
      const props = g.shuffle(Array.from({ length: 6 }, () => `${links[0]}:props:StringProp:${Array.from({ length: 13 }, () => g.pick(ALPHABET)).join('')}`));
      const unfolds = g.shuffle(Array.from({ length: 8 }, () => `${g.pick(['BlockNode', 'FolderNode', 'ArtifactNode'])}:${Array.from({ length: 13 }, () => g.pick(ALPHABET)).join('')}`));
      const view = idOf('TreeView', 2);
      const engine = engineWith([
        { id: owner, kind: 'BlockNode', fields: { title: 'x', type: 'p', links } },
        ...links.map((id, i) => ({ id, kind: 'Link', fields: { target: owner, ...(i === 0 ? { props } : {}) } })),
        ...props.map((id, i) => ({ id, kind: 'StringProp', fields: { key: `k${i}`, value: 'v' } })),
        { id: view, kind: 'TreeView', fields: { profile: idOf('Profile', 3), name: 'v', unfolds } },
      ]);
      const [doc] = dumpDocuments(engine, TREE, 'BlockNode');
      const linkDocs = doc!.links as { '@id': string; props?: { '@id': string }[] }[];
      assert.deepEqual(linkDocs.map((l) => l['@id']), [...links].sort(codePoint));
      assert.deepEqual(linkDocs.find((l) => l['@id'] === links[0])!.props!.map((p) => p['@id']), [...props].sort(codePoint));
      assert.deepEqual(dumpDocuments(engine, TREE, 'TreeView')[0]!.unfolds, [...unfolds].sort(codePoint));
    }
  });

  test('the children of a container are in the order of its list, not sorted', () => {
    const box = idOf('BlockNode', 1);
    const kids = [idOf('BlockNode', 9), idOf('BlockNode', 3), idOf('BlockNode', 7), idOf('BlockNode', 5)];
    const engine = engineWith([{ id: box, kind: 'BlockNode', fields: { title: 'x', type: 'p', children: kids } }, ...kids.map((id) => ({ id, kind: 'BlockNode', fields: { title: 'k', type: 'p' } }))]);
    assert.deepEqual(dumpDocuments(engine, TREE, 'BlockNode').find((d) => d['@id'] === box)!.children, kids);
  });

  test('the sort is by code point and never by the locale: a hostile localeCompare changes nothing', () => {
    // Under a collation where ":" sorts before a digit, "Item:..." comes before "Item2:...", which is not the code-point order. The kinds are the
    // schema's, so the case needs a schema with two kinds whose names differ at that place; the dump is generic.
    const schema = { kinds: [{ name: 'Item', fields: [{ name: 'refs', storage: 'reference' as const, cardinality: 'set' as const }] }, { name: 'Item2', fields: [] }] };
    const engine = createEngine(schema);
    engine.createGraph(TREE);
    const colon = 'Item:00T5MX0000001'; const digit = 'Item2:00T5MX0000001'; const owner = 'Item:00T5MX0000009';
    engine.build(TREE, { id: owner, kind: 'Item', fields: { refs: [colon, digit] } });
    engine.build(TREE, { id: colon, kind: 'Item', fields: {} });
    const hostile = String.prototype.localeCompare;
    String.prototype.localeCompare = function (this: string, that: string): number { return hostile.call(this.replace(':', '\u0000'), that.replace(':', '\u0000')); };
    try {
      assert.ok(colon.localeCompare(digit) < 0 && colon > digit, 'the premise: this collation puts the id with the colon first, code points the other');
      assert.deepEqual(dumpDocuments(engine, TREE, 'Item').find((d) => d['@id'] === owner)!.refs, [digit, colon], 'the dump keeps the code-point order');
    } finally {
      String.prototype.localeCompare = hostile;
    }
  });
});

describe('the derived entry', () => {
  test('parent stands at its place in the Format and is read from the engine, not from a pair', () => {
    const box = idOf('BlockNode', 1); const kid = idOf('BlockNode', 2);
    const engine = engineWith([{ id: box, kind: 'BlockNode', fields: { title: 'b', type: 'p', children: [kid] } }, { id: kid, kind: 'BlockNode', fields: { title: 'k', type: 'p' } }]);
    assert.deepEqual(Object.keys(dumpDocuments(engine, TREE, 'BlockNode').find((d) => d['@id'] === kid)!), ['@id', '@type', 'title', 'parent', 'type', 'children']);
    assert.equal(dumpDocuments(engine, TREE, 'BlockNode').find((d) => d['@id'] === kid)!.parent, box);
  });

  test('is written for a node whose container is in another graph, and left out for a node that has none', () => {
    const root = idOf('FolderNode', 1); const threads = idOf('FolderNode', 2); const lone = idOf('FolderNode', 3);
    const engine = newEngine();
    engine.createGraph(TREE); engine.createGraph(THREADS);
    engine.build(TREE, { id: root, kind: 'FolderNode', fields: { title: '.', path: '.', children: [threads] } });
    engine.build(THREADS, { id: threads, kind: 'FolderNode', fields: { title: '.threads', path: '.threads' } });
    engine.build(THREADS, { id: lone, kind: 'FolderNode', fields: { title: 'lone', path: 'lone' } });
    assert.equal(engine.record(THREADS, threads)!.fields.some((f) => f.name === 'parent'), false, 'the record of the node holds none: a read is filtered to the graph');
    const [withContainer, without] = dumpDocuments(engine, THREADS, 'FolderNode', [TREE, THREADS]);
    assert.equal(withContainer!.parent, root);
    assert.equal('parent' in without!, false);
    assert.equal('parent' in dumpDocuments(engine, THREADS, 'FolderNode', [THREADS])[0]!, false, 'the bridge reads the graphs the caller names and no others');
  });
});

describe('the same on the reference copy (goes with it, Batch 12)', () => {
  test('dehydrate sorts with localeCompare: under a collation that reads digit runs as numbers its file is out of code-point order; the dump is not', () => {
    // The issue's Symptom is "none observed": every collation of the mirror's ASCII ids agrees with the code points. A collation that is
    // numeric (a runtime whose default locale carries it) is one that does not, so this simulates one for the length of the case.
    const ids = ['BlockNode:00T5MX0000010', 'BlockNode:00T5MX000009Z', 'BlockNode:00T5MX0000011'];
    const inCodePoint = [...ids].sort(codePoint);
    const dir = mkdtempSync(join(tmpdir(), 'aperas-format-'));
    const original = String.prototype.localeCompare;
    try {
      mkdirSync(join(dir, 'in'));
      for (const kind of ['ArtifactNode', 'FolderNode', 'Profile']) writeFileSync(join(dir, 'in', `${kind}.jsonld`), '[]\n');
      writeFileSync(join(dir, 'in', 'BlockNode.jsonld'), JSON.stringify(ids.map((id) => ({ '@id': id, '@type': 'BlockNode', title: id, type: 'p', children: [] }))));
      const reference = rehydrateStore(join(dir, 'in'));
      mkdirSync(join(dir, 'out'));
      String.prototype.localeCompare = function (this: string, that: string): number { return original.call(this, that, 'en', { numeric: true }); };
      dehydrateToJsonLd(reference.store, join(dir, 'out'));
      const referenceOrder = (JSON.parse(readFileSync(join(dir, 'out', 'BlockNode.jsonld'), 'utf8')) as { '@id': string }[]).map((d) => d['@id']);
      assert.notDeepEqual(referenceOrder, inCodePoint, 'the reference copy\'s file follows the collation');
      freeWasm(reference.store);

      const engine = engineWith(ids.map((id) => ({ id, kind: 'BlockNode', fields: { title: id, type: 'p' } })));
      assert.deepEqual(dumpDocuments(engine, TREE, 'BlockNode').map((d) => d['@id']), inCodePoint, 'and the dump does not');
    } finally {
      String.prototype.localeCompare = original;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
