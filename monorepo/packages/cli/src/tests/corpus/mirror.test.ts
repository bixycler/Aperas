// Corpus check: the new load and dump on a migrated copy of the real mirror (planning/core.md, Batch 9 steps 4 and 6; Done when: "the round trip
// is exact ... on a copy of the mirror (in `demand`, when the user asks) against the migrated mirror of step 6").
// The real `Apeiron/` (content mirror and `.state/`) is copied once into a scratch root, the six rules of `scripts/migrate-mirror.py` are run on
// the copy (the reference engine cannot read the migrated mirror, and the new load cannot read an unmigrated one), a second run is shown to change
// nothing, and the copy is loaded into a new engine and dumped into a second scratch root: every file must come back byte for byte, the two
// `FolderNode` files too (the Format lists `path` before `children`, as the mirror does). The real mirror is only read. The mapping is the
// shell's own, made from the default table of settings with relative directories: the tracked kinds in `Apeiron/`, the thread kinds and the
// views in `Apeiron/.state/`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dumpMirror } from '@aperas/core/shell/mirrorDump';
import { loadMirror, type LoadResult } from '@aperas/core/shell/mirrorLoad';
import { REAL_GRAPH, assertNotRealMirror } from '../support/fixture.ts';
import { newEngine, testMapping } from '../support/mirrorFixture.ts';

const MIGRATE = resolve(import.meta.dirname, '../../../../../scripts/migrate-mirror.py');

/** The shell's mapping: the eight files the real mirror has. */
const mapping = testMapping();

describe('corpus: the new load and dump on a migrated copy of the real mirror', () => {
  let root: string;
  let out: string | undefined;
  before(() => {
    const source = join(REAL_GRAPH, 'Apeiron');
    assert.ok(existsSync(source), `no real mirror to copy: ${source}`);
    root = mkdtempSync(join(tmpdir(), 'aperas-mirror-corpus-'));
    assertNotRealMirror(root);
    cpSync(source, join(root, 'Apeiron'), { recursive: true, dereference: true });
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
    if (out) rmSync(out, { recursive: true, force: true });
  });

  test('the copy is migrated by the six rules, and a second run changes nothing', () => {
    const run = (): string => {
      const r = spawnSync('python3', [MIGRATE, root], { encoding: 'utf8' });
      assert.equal(r.status, 0, `migrate-mirror.py exited ${r.status}: ${r.stdout}${r.stderr}`);
      return r.stdout;
    };
    run();
    assert.match(run(), /files that differ after the rules: 0/);
  });

  describe('with the three graphs of the shell', () => {
    let load: LoadResult;
    let dumpDir: string;

    before(() => {
      const engine = newEngine();
      const started = Date.now();
      load = loadMirror(engine, root, mapping);
      console.log(`load: ${Date.now() - started} ms, ${load.documents} documents and ${load.embedded} embedded entries`);
      dumpDir = mkdtempSync(join(tmpdir(), 'aperas-mirror-corpus-out-'));
      out = dumpDir;
      const t = Date.now();
      dumpMirror(engine, dumpDir, mapping);
      console.log(`dump: ${Date.now() - t} ms`);
    });
    after(() => rmSync(dumpDir, { recursive: true, force: true }));

    test('the load reports nothing: no error, no warning, no rejected id, nothing dangling', () => {
      assert.deepEqual({ errors: load.errors.slice(0, 3), warnings: load.warnings.slice(0, 3), rejected: load.rejected, dangling: load.dangling.slice(0, 3) }, { errors: [], warnings: [], rejected: [], dangling: [] });
      assert.ok(load.documents > 10000, `${load.documents} documents`);
    });

    for (const m of mapping) {
      test(`${m.graph} ${m.kind}: ${m.file} comes back byte for byte`, () => {
        assert.equal(readFileSync(join(dumpDir, m.file), 'utf8'), readFileSync(join(root, m.file), 'utf8'));
      });
    }
  });
});
