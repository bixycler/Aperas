// Full-slug-path collision refusal at ingestion (step 14 of the extended legacy suite, Linking Slice 2 Task 2),
// on a tiny store: (a) two new same-titled siblings in one document, (b) a heading added later that collides
// with an existing unchanged sibling, with (d) no false positive on a genuinely unique title, and (c) an
// ordinary heading whose natural path equals another file's hand-written anchor name. Independent of the
// anchors chain; the cases run in order only because (c) names the file it needs.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { slugify } from '@aperas/core/nodeRef';
import { trackArtifact, ingestArtifact } from '@aperas/core/apeironNgn/artifacts';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';

describe('linking: collisions at ingestion', () => {
  let fx: FixtureStore;
  const write = (path: string, text: string): void => writeFileSync(join(fx.artifactsRoot, path), text, 'utf-8');
  const errorOf = (fn: () => unknown): Error | undefined => {
    try { fn(); } catch (e) { return e as Error; }
    return undefined;
  };
  before(() => { fx = makeFixtureStore('collision_demo'); });
  after(() => fx.cleanup());

  test('14: two siblings with one full slug path are refused at ingestion', () => {
    // (a) Two brand-new blocks, same document, same tree position, identical title: rejected on the very first ingestion.
    const dupPath = `${fx.demoDir}/linking-dup.md`;
    write(dupPath, `# Dup Test

## Same Name

First one.

## Same Name

Second one, colliding with the first from the very first ingestion.
`);
    trackArtifact(fx.store, dupPath);
    const dup = errorOf(() => ingestArtifact(fx.store, dupPath));
    assert.ok(dup, '(a) two new blocks in the same document, same tree position, same title: rejected');
    assert.match(dup!.message, /collision/i, '(a) the error names the collision');

    // (b) A block added later, in a re-ingestion, colliding with an existing sibling that is not itself changing.
    const renamePath = `${fx.demoDir}/linking-rename.md`;
    write(renamePath, `# Stable Sibling

First heading, ingested cleanly.
`);
    trackArtifact(fx.store, renamePath);
    assert.doesNotThrow(() => ingestArtifact(fx.store, renamePath), '(d) a genuinely unique title is not a false positive');
    write(renamePath, `# Stable Sibling

First heading, ingested cleanly.

# Stable Sibling

A second heading colliding with the first.
`);
    trackArtifact(fx.store, renamePath);
    const rename = errorOf(() => ingestArtifact(fx.store, renamePath));
    assert.ok(rename, "(b) a newly-added heading colliding with an existing, unchanged sibling's path: rejected");
    assert.match(rename!.message, /collision/i, '(b) the error names the collision');

    // (c) Cross-artifact collision via an embedded anchor name: file A hand-writes a tree-anchor equal to what file B's
    // own, ordinary heading computes as its toPath(). `slugify()` runs on the raw title including its `#` markers, so the
    // name is computed with the real function rather than hand-derived.
    const targetPath = `${fx.demoDir}/linking-anchor-target.md`;
    const newPath = `${fx.demoDir}/linking-anchor-new.md`;
    const collidingAnchorName = `${newPath}/${slugify('# New Doc')}/${slugify('## Shared Title')}`;
    write(targetPath, `# Anchor Owner <a name='${collidingAnchorName}' class='aperas-anchor aperas-tree'></a>

Holds a hand-written anchor that happens to name another file's future, perfectly ordinary path.
`);
    trackArtifact(fx.store, targetPath);
    ingestArtifact(fx.store, targetPath);
    write(newPath, `# New Doc

## Shared Title

Ordinary content with no anchor of its own.
`);
    trackArtifact(fx.store, newPath);
    const anchorCollision = errorOf(() => ingestArtifact(fx.store, newPath));
    assert.ok(anchorCollision, "(c) an ordinary heading's own natural path colliding with a different file's hand-written anchor name: rejected");
    assert.match(anchorCollision!.message, /collision/i, '(c) the error names the collision');
  });
});
