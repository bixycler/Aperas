// The ghost folder: a root folder whose `children` names a FolderNode id that has no document (the shape a copy
// of the mirror without `.state/` loads as) must not make `ingestFolderTree` list anything for removal. A real
// folder that vanished from the disk is still listed, and a holder-flagged folder with a document is still kept.
// The cases share the store and the scratch folder, so they run in order.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getArtifactsDir } from '@aperas/core/artifacts';
import { ingestFolderTree, getFolderRecord } from '@aperas/core/apeironNgn/folders';
import { trackAllArtifacts } from '@aperas/core/apeironNgn/artifacts';
import { wrap, type FolderNode } from '@aperas/core/apeironNgn/node';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';

describe('ghost folder', () => {
  let fx: FixtureStore;
  let rootId = '';
  before(() => {
    fx = makeFixtureStore('ghost_demo');
    writeFileSync(join(getArtifactsDir(), fx.demoDir, 'note.md'), '# Note\n\nA note in the demo folder.\n', 'utf-8');
    ingestFolderTree(fx.store);
    // The root is the one folder whose path is the empty string or the artifacts root: find it as the parent of the demo folder.
    const demo = getFolderRecord(fx.store, fx.demoDir);
    assert.ok(demo, 'a FolderNode for the demo folder');
    const parentId = (wrap(fx.store, `FolderNode:${demo.folderId}`) as unknown as { parent?: { id: string } }).parent?.id;
    assert.ok(parentId, 'the demo folder has a parent folder (the root)');
    rootId = parentId;
  });
  after(() => fx.cleanup());

  test('a children entry naming a FolderNode with no document lists nothing for removal', () => {
    // Attach a bare id to the root: the id gets containment triples (parent, sibling index) and no document fields.
    const ghostId = 'FolderNode:GHOST000000';
    (wrap(fx.store, rootId) as unknown as FolderNode).appendChild(ghostId);
    assert.equal((wrap(fx.store, ghostId) as unknown as FolderNode).path, undefined, 'the ghost has no path');

    const result = ingestFolderTree(fx.store);
    assert.deepEqual(result.pendingRemovals, [], `pendingRemovals: ${JSON.stringify(result.pendingRemovals)}`);
    assert.equal(result.sweep.removed, 0);
    assert.ok(getFolderRecord(fx.store, fx.demoDir), 'the real folder is still there');
  });

  test('a holder-flagged folder with a document, not on the disk, is kept', () => {
    const holderId = 'FolderNode:HOLDER00000';
    const holder = wrap(fx.store, holderId) as unknown as FolderNode;
    holder.path = 'imagined/place';
    holder.title = 'place';
    holder.holder = true;
    (wrap(fx.store, rootId) as unknown as FolderNode).appendChild(holderId);

    const result = ingestFolderTree(fx.store);
    assert.deepEqual(result.pendingRemovals, []);
    assert.ok(getFolderRecord(fx.store, 'imagined/place'), 'the holder folder is still live');
  });

  test('a folder that really vanished from the disk is still listed', () => {
    mkdirSync(join(getArtifactsDir(), fx.demoDir, 'sub'), { recursive: true });
    writeFileSync(join(getArtifactsDir(), fx.demoDir, 'sub', 'inner.md'), '# Inner\n\nSomething only the sub folder holds.\n', 'utf-8');
    ingestFolderTree(fx.store);
    const subPath = `${fx.demoDir}/sub`;
    assert.ok(getFolderRecord(fx.store, subPath), 'the sub folder was ingested');

    rmSync(join(getArtifactsDir(), fx.demoDir, 'sub'), { recursive: true, force: true });
    const result = ingestFolderTree(fx.store);
    assert.deepEqual(result.pendingRemovals, [subPath]);
    assert.ok(getFolderRecord(fx.store, subPath), 'held back, not tombstoned');
  });

  test('a children entry naming an ArtifactNode with no document lists nothing for removal in a full track', () => {
    const ghostId = 'ArtifactNode:GHOST000001';
    (wrap(fx.store, rootId) as unknown as FolderNode).appendChild(ghostId);
    assert.equal((wrap(fx.store, ghostId) as unknown as FolderNode).path, undefined, 'the ghost has no path');

    const result = trackAllArtifacts(fx.store);
    assert.deepEqual(result.pendingRemovals, [], `pendingRemovals: ${JSON.stringify(result.pendingRemovals)}`);
    assert.equal(result.sweep.removed, 0);
  });
});
