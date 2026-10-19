// Corpus check: the maps of a literal value on a migrated copy of the real mirror (planning/core.md, Batch 10 Done when: "in `demand` the maps built from
// the migrated copy of the real mirror agree with a scan"). The real `Apeiron/` is copied once into a scratch root, the six rules of
// `scripts/migrate-mirror.py` are run on the copy, and the copy is loaded into a new engine. The maps are rebuilt and compared with a scan of the
// records of the four kinds, written apart from the maps, and the size of each map is the size of the scan; there are no keys held by two live nodes, and
// the tombstones that hold a path (the mirror has at least one) are found by no path. The real mirror is only read.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MIRROR_GRAPHS } from '@aperas/core/graphConfig';
import type { Engine } from '@aperas/core/apeironNgn/interface';
import { createLookups, type Lookups } from '@aperas/core/shell/lookups';
import { loadMirror } from '@aperas/core/shell/mirrorLoad';
import { REAL_GRAPH, assertNotRealMirror } from '../support/fixture.ts';
import { THREADS, TREE, newEngine, testMapping } from '../support/mirrorFixture.ts';

const MIGRATE = resolve(import.meta.dirname, '../../../../../scripts/migrate-mirror.py');

describe('corpus: the maps of a literal value on a migrated copy of the real mirror', () => {
  let root: string;
  let engine: Engine;
  let maps: Lookups;
  before(() => {
    const source = join(REAL_GRAPH, 'Apeiron');
    assert.ok(existsSync(source), `no real mirror to copy: ${source}`);
    root = mkdtempSync(join(tmpdir(), 'aperas-lookups-corpus-'));
    assertNotRealMirror(root);
    cpSync(source, join(root, 'Apeiron'), { recursive: true, dereference: true });
    const r = spawnSync('python3', [MIGRATE, root], { encoding: 'utf8' });
    assert.equal(r.status, 0, `migrate-mirror.py exited ${r.status}: ${r.stdout}${r.stderr}`);
    engine = newEngine();
    const load = loadMirror(engine, root, testMapping());
    assert.deepEqual({ errors: load.errors.slice(0, 3), warnings: load.warnings.slice(0, 3), rejected: load.rejected }, { errors: [], warnings: [], rejected: [] });
    maps = createLookups(engine, MIRROR_GRAPHS);
    const t = Date.now();
    assert.deepEqual(maps.rebuild(), [], 'no key is held by two live nodes');
    console.log(`maps: ${Date.now() - t} ms, ${JSON.stringify(maps.size())}`);
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  const scanOf = (kinds: readonly string[], field: string, graphs: readonly string[]): Map<string, string> => {
    const out = new Map<string, string>();
    for (const graph of graphs) for (const kind of kinds) for (const id of engine.idsOfKind(graph, kind)) {
      const record = engine.record(graph, id)!;
      if (record.fields.some((f) => f.name === 'tombstonedAt')) continue;
      const key = record.fields.find((f) => f.name === field)!.values[0] as string;
      assert.equal(out.has(key), false, `${field} ${key} is held twice`);
      out.set(key, id);
    }
    return out;
  };

  test('the handles, the view names and the paths agree with a scan of the records', () => {
    const handles = scanOf(['Profile'], 'handle', [TREE]);
    const names = scanOf(['TreeView'], 'name', MIRROR_GRAPHS);
    const paths = scanOf(['ArtifactNode', 'FolderNode'], 'path', [TREE, THREADS]);
    for (const [key, id] of handles) assert.equal(maps.profileByHandle(key), id, `handle ${key}`);
    for (const [key, id] of names) assert.equal(maps.viewByName(key), id, `view ${key}`);
    for (const [key, id] of paths) assert.equal(maps.liveAtPath(key), id, `path ${key}`);
    assert.deepEqual(maps.size(), { profiles: handles.size, views: names.size, paths: paths.size });
    assert.ok(handles.size >= 1 && names.size >= 1 && paths.size > 50, `${handles.size} handles, ${names.size} view names, ${paths.size} paths`);
  });

  test('a view and a profile that share a string are told apart: the view `default` and the profile whose handle is `default`', () => {
    const view = maps.viewByName('default');
    const profile = maps.profileByHandle('default');
    assert.ok(view !== undefined && profile !== undefined && view !== profile, `${view} ${profile}`);
    assert.equal(engine.record(MIRROR_GRAPHS[2]!, view)?.kind, 'TreeView');
    assert.equal(engine.record(TREE, profile)?.kind, 'Profile');
  });

  test('a tombstone that holds a path is found by nobody, and its path is not live', () => {
    const tombstones = [TREE, THREADS].flatMap((graph) => ['ArtifactNode', 'FolderNode'].flatMap((kind) => engine.idsOfKind(graph, kind).filter((id) => engine.first(graph, id, 'tombstonedAt') !== undefined).map((id) => ({ graph, id }))));
    for (const { graph, id } of tombstones) {
      const path = engine.first(graph, id, 'path') as string;
      assert.notEqual(maps.liveAtPath(path), id, `${path}`);
    }
    console.log(`tombstones holding a path: ${tombstones.length}`);
  });
});
