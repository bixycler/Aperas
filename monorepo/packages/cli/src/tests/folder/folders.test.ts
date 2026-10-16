// FolderNode ingestion and README projection (steps 6 and 6b of the legacy suite) on a scratch artifacts
// folder holding one artifact: the folder tree is built, then a README is projected, written back and
// re-ingested to show the projection is a fixed point. The cases share the store and the folder, so they
// run in order.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getArtifactsDir } from '@aperas/core/artifacts';
import { trackArtifact } from '@aperas/core/shell/artifacts';
import { ingestFolderTree, getFolderRecord } from '@aperas/core/shell/folders';
import { wrap, type FolderNode } from '@aperas/core/shell/node';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';

const DEMO_README = `---
draft: true
---
# Demo Folder

Intro sentence for the demo folder.

- item one
- item two`;

describe('folder ingestion', () => {
  let fx: FixtureStore;
  let readmeFile = '';
  let folderId = '';
  before(() => {
    fx = makeFixtureStore('folder_demo');
    readmeFile = join(getArtifactsDir(), fx.demoDir, 'README.md');
  });
  after(() => fx.cleanup());

  test('6: ingesting the folder tree finds the demo folder', () => {
    writeFileSync(join(getArtifactsDir(), fx.demoDir, 'note.md'), '# Note\n\nA note in the demo folder.\n', 'utf-8');
    trackArtifact(fx.store, `${fx.demoDir}/note.md`);
    const { folderCount } = ingestFolderTree(fx.store);
    // new: the old step only printed the count of folders in the tree
    assert.ok(folderCount >= 1, `folders in tree: ${folderCount}`);
    assert.ok(getFolderRecord(fx.store, fx.demoDir), `a FolderNode for '${fx.demoDir}'`);
  });

  test('6b: README projection, copy of the first abstract, write-by-default is a fixed point', () => {
    writeFileSync(readmeFile, DEMO_README, 'utf-8');
    ingestFolderTree(fx.store);
    const record = getFolderRecord(fx.store, fx.demoDir);
    assert.ok(record, `a FolderNode for '${fx.demoDir}' after ingestion`);
    folderId = record.folderId;
    const folderNode = wrap(fx.store, `FolderNode:${folderId}`) as unknown as FolderNode;
    // Copy, not consume: the README is headed, and the folder text still picks up the heading's own sentence.
    assert.equal(folderNode.text, 'Intro sentence for the demo folder.');
    const projected = folderNode.toReadme();
    assert.ok(projected.includes('draft: true'), `projected README keeps the frontmatter: ${projected}`);
    assert.ok(projected.includes('Intro sentence for the demo folder.'), `projected README has the intro sentence: ${projected}`);
    assert.ok(projected.includes('item one'), `projected README has the list items: ${projected}`);
    // Write the regenerated content, re-ingest it and project again: the same output, not drift.
    writeFileSync(readmeFile, projected, 'utf-8');
    ingestFolderTree(fx.store);
    const reprojected = (wrap(fx.store, `FolderNode:${folderId}`) as unknown as FolderNode).toReadme();
    assert.equal(reprojected, projected);
  });
});
