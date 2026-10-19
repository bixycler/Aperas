// The Aperas schema (planning/core.md, Batch 3 step 2): an engine is constructed with it, and the schema read back
// holds exactly what design/core.md lists: the field order of each kind equals the lists of "Format", the storage
// kind and the cardinality of each field, the optional ones named in the plan, the five roles, and `parent` as the
// reverse name of `children`. The engine's directory names no kind or field of it.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from '@aperas/core/apeironNgn/engine';
import { APERAS_SCHEMA } from '@aperas/core/shell/aperasSchema';

const schema = createEngine(APERAS_SCHEMA).schema;
const kind = (name: string) => schema.kinds.find((k) => k.name === name)!;
const field = (k: string, name: string) => kind(k).fields.find((f) => f.name === name)!;
const order = (k: string): string[] => kind(k).fields.map((f) => f.name);
/** `[storage, cardinality]` of a field. */
const shape = (k: string, name: string): [string, string] => [field(k, name).storage, field(k, name).cardinality];

describe('the Aperas schema', () => {
  test('an engine is constructed with it', () => {
    assert.deepEqual(schema.kinds.map((k) => k.name), ['BaseNode', 'TreeNode', 'BlockNode', 'ArtifactNode', 'FolderNode', 'Link', 'StringProp', 'Profile', 'TreeView']);
  });

  test('the field order of each kind is the order of the Format lists', () => {
    assert.deepEqual(order('BaseNode'), ['links', 'props', 'tombstonedAt', 'holder']);
    // `path` stays in the schema for now, so it stands after `children` in the two kinds that hold it; the Format lists neither.
    assert.deepEqual(order('TreeNode'), ['links', 'props', 'tombstonedAt', 'holder', 'title', 'text', 'parent', 'children']);
    assert.deepEqual(order('BlockNode'), ['links', 'props', 'tombstonedAt', 'holder', 'title', 'text', 'parent', 'type', 'children']);
    assert.deepEqual(order('ArtifactNode'), ['links', 'props', 'tombstonedAt', 'holder', 'title', 'text', 'parent', 'children', 'path', 'fileHash', 'lastTrackedAt', 'ingestedHash', 'lastIngestedAt', 'projectedHash']);
    assert.deepEqual(order('FolderNode'), ['links', 'props', 'tombstonedAt', 'holder', 'title', 'text', 'parent', 'path', 'children', 'projectedHash']);
    assert.deepEqual(order('Link'), ['target', 'props']);
    assert.deepEqual(order('StringProp'), ['key', 'value']);
    assert.deepEqual(order('Profile'), ['handle', 'name', 'kind', 'preferences']);
    assert.deepEqual(order('TreeView'), ['profile', 'name', 'unfolds', 'root']);
  });

  test('the hierarchy: a block, an artifact and a folder are siblings under TreeNode', () => {
    assert.deepEqual(schema.kinds.map((k) => [k.name, k.parent]), [['BaseNode', undefined], ['TreeNode', 'BaseNode'], ['BlockNode', 'TreeNode'], ['ArtifactNode', 'TreeNode'], ['FolderNode', 'TreeNode'], ['Link', undefined], ['StringProp', undefined], ['Profile', undefined], ['TreeView', undefined]]);
  });

  test('TreeNode holds title, text, children and parent; BlockNode adds only type; an artifact has no type', () => {
    assert.deepEqual(kind('TreeNode').fields.filter((f) => f.origin === 'TreeNode').map((f) => f.name), ['title', 'text', 'parent', 'children']);
    assert.deepEqual(kind('BlockNode').fields.filter((f) => f.origin === 'BlockNode').map((f) => f.name), ['type']);
    assert.deepEqual(kind('ArtifactNode').fields.filter((f) => f.origin === 'ArtifactNode').map((f) => f.name), ['path', 'fileHash', 'lastTrackedAt', 'ingestedHash', 'lastIngestedAt', 'projectedHash']);
    assert.deepEqual(kind('FolderNode').fields.filter((f) => f.origin === 'FolderNode').map((f) => f.name), ['path', 'projectedHash']);
    assert.equal(field('ArtifactNode', 'type'), undefined);
    assert.equal(field('FolderNode', 'type'), undefined);
    assert.equal(schema.kinds.flatMap((k) => k.fields).filter((f) => f.name === 'type').every((f) => f.origin === 'BlockNode'), true);
    assert.equal(field('ArtifactNode', 'children').origin, 'TreeNode');
    assert.equal(field('FolderNode', 'children').origin, 'TreeNode');
  });

  test('the storage kind and the cardinality of each field', () => {
    for (const k of ['BaseNode', 'TreeNode', 'BlockNode', 'ArtifactNode', 'FolderNode']) {
      assert.deepEqual(shape(k, 'links'), ['embed', 'set']);
      assert.equal(field(k, 'links').embeds, 'Link');
      assert.deepEqual(shape(k, 'props'), ['embed', 'set']);
      assert.equal(field(k, 'props').embeds, 'StringProp');
      assert.deepEqual(shape(k, 'tombstonedAt'), ['literal', 'optional']);
      assert.deepEqual(shape(k, 'holder'), ['literal', 'optional']);
    }
    for (const k of ['TreeNode', 'BlockNode', 'ArtifactNode', 'FolderNode']) {
      assert.deepEqual(shape(k, 'title'), ['literal', 'one']);
      assert.deepEqual(shape(k, 'text'), ['literal', 'optional']);
    }
    assert.deepEqual(shape('BlockNode', 'type'), ['literal', 'one']);
    for (const k of ['TreeNode', 'BlockNode', 'ArtifactNode', 'FolderNode']) assert.deepEqual(shape(k, 'children'), ['reference', 'ordered']);
    assert.deepEqual(shape('ArtifactNode', 'path'), ['literal', 'one']);
    assert.deepEqual(shape('FolderNode', 'path'), ['literal', 'one']);
    assert.deepEqual(shape('Link', 'target'), ['reference', 'one']);
    assert.deepEqual(shape('Link', 'props'), ['embed', 'set']);
    assert.equal(field('Link', 'props').embeds, 'StringProp');
    assert.deepEqual(shape('StringProp', 'key'), ['literal', 'one']);
    assert.deepEqual(shape('StringProp', 'value'), ['literal', 'one']);
    assert.deepEqual(shape('Profile', 'handle'), ['literal', 'one']);
    assert.deepEqual(shape('Profile', 'preferences'), ['embed', 'set']);
    assert.equal(field('Profile', 'preferences').embeds, 'StringProp');
    assert.deepEqual(shape('TreeView', 'profile'), ['reference', 'one']);
    assert.deepEqual(shape('TreeView', 'name'), ['literal', 'one']);
    assert.deepEqual(shape('TreeView', 'unfolds'), ['reference', 'set']);
    assert.deepEqual(shape('TreeView', 'root'), ['reference', 'optional']);
  });

  test('the optional fields named in the plan are optional, and the cardinalities are the four of the meta-model', () => {
    for (const name of ['fileHash', 'lastTrackedAt', 'ingestedHash', 'lastIngestedAt', 'projectedHash']) assert.deepEqual(shape('ArtifactNode', name), ['literal', 'optional'], `ArtifactNode.${name}`);
    assert.deepEqual(shape('FolderNode', 'projectedHash'), ['literal', 'optional']);
    for (const name of ['name', 'kind']) assert.deepEqual(shape('Profile', name), ['literal', 'optional'], `Profile.${name}`);
    assert.deepEqual([...new Set(schema.kinds.flatMap((k) => k.fields).map((f) => f.cardinality))].sort(), ['one', 'optional', 'ordered', 'set']);
  });

  test('has no predicate on a Link and no stored parent', () => {
    assert.equal(field('Link', 'predicate'), undefined);
    for (const k of ['TreeNode', 'BlockNode', 'ArtifactNode', 'FolderNode']) {
      assert.equal(field(k, 'parent').derived, true, `${k}.parent is a derived entry`);
      assert.deepEqual(shape(k, 'parent'), ['reference', 'optional']);
    }
    assert.equal(schema.kinds.flatMap((k) => k.fields).filter((f) => f.derived).every((f) => f.name === 'parent'), true);
  });

  test('children is ordered and partitioning, and its reverse name is parent', () => {
    for (const k of ['TreeNode', 'BlockNode', 'ArtifactNode', 'FolderNode']) {
      assert.equal(field(k, 'children').partitioning, true);
      assert.equal(field(k, 'children').reverse, 'parent');
    }
    assert.equal(schema.kinds.flatMap((k) => k.fields).filter((f) => f.partitioning).every((f) => f.name === 'children'), true);
  });

  test('the five roles', () => {
    assert.deepEqual(schema.roles, {
      containment: 'children',
      tombstone: 'tombstonedAt',
      dropWithTarget: ['unfolds'],
      sweep: { roots: ['ArtifactNode', 'FolderNode'], follow: ['children', 'links', 'target'] },
    });
  });
});

describe('the engine names nothing of the Aperas schema', () => {
  test('no file of its directory names one of its kinds or distinctive fields', () => {
    const dir = fileURLToPath(new URL('../../../../core/src/apeironNgn/', import.meta.url));
    const sources = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? sources(join(d, n)) : n.endsWith('.ts') ? [`${n}\n${readFileSync(join(d, n), 'utf8')}`] : []));
    const names = [...schema.kinds.map((k) => k.name), 'children', 'tombstonedAt', 'fileHash', 'lastTrackedAt', 'ingestedHash', 'lastIngestedAt', 'projectedHash', 'unfolds', 'preferences', 'holder'];
    const hits = sources(dir).flatMap((text) => names.filter((n) => new RegExp(`\\b${n}\\b`).test(text)).map((n) => `${text.split('\n')[0]}: ${n}`));
    assert.deepEqual(hits, []);
  });
});
