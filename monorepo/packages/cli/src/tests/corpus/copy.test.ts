// `makeCorpusCopy()`: the copy is a copy, the real files are not modified, and the scratch roots go away.
// Reads the real mirror (the files of `AperasKG/Apeiron/`, content mirror and `.state/`) and nothing else.
// If the service flushes to the real mirror while this runs, the checksum comparison can fail for a reason
// that is not the helper's; rerun.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { makeCorpusCopy } from '../support/corpus.ts';
import { assertNotRealMirror } from '../support/fixture.ts';

/** Relative path -> sha256 of every file under `dir`. */
function checksums(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

describe('makeCorpusCopy', () => {
  test('the copy is a copy, the real files are not modified, and the scratch roots are removed afterwards', () => {
    const copy = makeCorpusCopy();
    let cleaned = false;
    try {
      const realBefore = checksums(copy.sourceApeironRoot);
      assert.ok(Object.keys(realBefore).length >= 5, `the real mirror has its files: ${Object.keys(realBefore).join(', ')}`);
      // The copy is outside the real mirror, and its files equal the real ones.
      assert.throws(() => assertNotRealMirror(copy.sourceApeironRoot), /real mirror/, 'the real mirror is what the guard refuses');
      assert.doesNotThrow(() => assertNotRealMirror(copy.apeironRoot), 'the copy is not the real mirror');
      assert.notEqual(copy.apeironRoot, copy.sourceApeironRoot);
      assert.deepEqual(checksums(copy.apeironRoot), realBefore, 'the copy has the same files with the same contents as the real mirror');
      assert.ok(Object.keys(realBefore).some((f) => f.startsWith('.state')), 'the state mirror is copied too');
      // The process resolves its roots to the copy, and the store holds the copy's data.
      assert.equal(process.env.APERAS_APEIRON_ROOT, copy.apeironRoot);
      assert.equal(process.env.APERAS_ARTIFACTS_ROOT, copy.artifactsRoot);
      assert.ok(copy.quadCount > 0 && copy.nodeCount > 0 && copy.store.size === copy.quadCount, `the copy was rehydrated: ${copy.quadCount} quads, ${copy.nodeCount} nodes`);
      // Writing to the copy changes the copy and not the real file.
      const victim = join(copy.apeironRoot, 'ArtifactNode.jsonld');
      writeFileSync(victim, readFileSync(victim, 'utf-8') + '\n', 'utf-8');
      assert.notEqual(checksums(copy.apeironRoot)['ArtifactNode.jsonld'], realBefore['ArtifactNode.jsonld'], 'the write reached the copy');
      assert.deepEqual(checksums(copy.sourceApeironRoot), realBefore, 'the real files are unchanged by the copy, by rehydrating it and by writing to it');
      const root = copy.root;
      copy.cleanup();
      cleaned = true;
      assert.equal(existsSync(root), false, 'the scratch roots are removed');
      assert.equal(existsSync(copy.apeironRoot) || existsSync(copy.artifactsRoot), false);
      assert.equal(process.env.APERAS_APEIRON_ROOT, undefined);
      assert.equal(process.env.APERAS_ARTIFACTS_ROOT, undefined);
      assert.deepEqual(checksums(copy.sourceApeironRoot), realBefore, 'the real files are unchanged after the cleanup');
      assert.doesNotThrow(() => copy.cleanup(), 'cleanup twice is safe');
    } finally {
      if (!cleaned) copy.cleanup();
    }
  });
});
