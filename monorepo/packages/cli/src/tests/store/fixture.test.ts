// The fixture helper itself: scratch roots, removal afterwards, and the refusal to touch the real mirror.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getArtifactsDir } from '@aperas/core/artifacts';
import { assertNotRealMirror, makeFixtureStore } from '../support/fixture.ts';

describe('fixture helper', () => {
  test('makeFixtureStore sets scratch roots for this process and cleanup removes them', () => {
    const fx = makeFixtureStore('fx_demo');
    try {
      assert.equal(process.env.APERAS_APEIRON_ROOT, fx.apeironRoot);
      assert.equal(process.env.APERAS_ARTIFACTS_ROOT, fx.artifactsRoot);
      assert.equal(getArtifactsDir(), fx.artifactsRoot);
      assert.ok(existsSync(join(fx.artifactsRoot, 'fx_demo')));
      assert.ok(existsSync(fx.apeironRoot));
    } finally {
      fx.cleanup();
    }
    assert.equal(existsSync(fx.root), false);
    assert.equal(process.env.APERAS_APEIRON_ROOT, undefined);
    assert.equal(process.env.APERAS_ARTIFACTS_ROOT, undefined);
    fx.cleanup(); // a second call is harmless
  });

  test('assertNotRealMirror refuses the real graph and anything inside it', () => {
    const real = join(import.meta.dirname, '../../../../../..', 'AperasKG');
    assert.throws(() => assertNotRealMirror(real), /real mirror/);
    assert.throws(() => assertNotRealMirror(join(real, 'Apeiron')), /real mirror/);
    assert.throws(() => assertNotRealMirror(join(real, 'artifacts', 'nope')), /real mirror/);
    assert.doesNotThrow(() => assertNotRealMirror('/tmp/somewhere-else'));
  });
});
