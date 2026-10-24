// `runIngest` and the lookups of the path map (planning/core.md, Batch 11, piece 8): the folder ingest and the artifact sweeps find a node by its path through
// the one map of `store.maps`, which the write layer tells after each accepted write, so a node tracked, renamed, tombstoned or created in the same run is found
// the way the map has it and by nothing else. Cases: an artifact tracked and the folder over it ingested in one run, a file renamed on disk, a path reused after
// a removal (a new artifact with a new id), a ghost folder and a node with no title that no sweep lists, a thread artifact that lands in the threads graph, and
// a `Link` whose `position` props the store reads in another order than the text's (the ids of the props stay), and an ingest of a file that does not exist
// (it fails the way the reference's does, and leaves no record of any kind in the store). The cases share one store and one scratch
// folder and run in order. The store is reached through `fx.store`, `wrap`, the maps and the `runX` functions only.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { THREADS_GRAPH, MAIN_GRAPH } from '@aperas/core/graphConfig';
import { getProps } from '@aperas/core/props';
import { allIdsOfKind, graphOfId, liveDocumentIdsOfKind } from '@aperas/core/shell/db';
import { getFolderRecord, ingestFolderTree } from '@aperas/core/shell/folders';
import { trackAllArtifacts, trackArtifact } from '@aperas/core/shell/artifacts';
import { createNode, wrap, type ArtifactNode, type BlockNode, type FolderNode, type Link } from '@aperas/core/shell/node';
import { generateNodeId } from '@aperas/core/snowflake';
import { runIngest } from '../../kgIngest';
import { runShow } from '../../kgShow';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';
import { writeArtifact } from '../support/commandsCorpus.ts';

describe('ingest and the map by path', () => {
  let fx: FixtureStore;
  const artifactAt = (path: string): string | undefined => fx.store.maps.liveAtPath(path, { kind: 'ArtifactNode' });
  const folderAt = (path: string): string | undefined => fx.store.maps.liveAtPath(path, { kind: 'FolderNode' });
  const childrenOf = (folderId: string): string[] => (wrap(fx.store, folderId) as unknown as FolderNode).treeChildren.map((c) => c.id);
  const stored = (id: string) => runShow(fx.store, id) as { path?: string; tombstonedAt?: string };
  before(() => {
    fx = makeFixtureStore('ing_demo');
  });
  after(() => fx.cleanup());

  describe('a tracked artifact and its folder, in one run', () => {
    test('the artifact and the folder made by one ingest are found by the map, and the folder lists the artifact', () => {
      writeArtifact(fx, 'ing_demo/a.md', '# A\n\nA text.\n');
      writeArtifact(fx, 'ing_demo/b.md', '# B\n\nB text.\n');
      const result = runIngest(fx.store, ['ing_demo/a.md', 'ing_demo/b.md'], true, false);
      assert.deepEqual(result.failed, []);
      const a = artifactAt('ing_demo/a.md');
      const folder = folderAt('ing_demo');
      assert.ok(a, 'the artifact is in the map');
      assert.ok(folder, 'the folder is in the map');
      assert.ok(folderAt('.'), 'the root folder is in the map');
      assert.deepEqual(childrenOf(folder).filter((id) => id.startsWith('ArtifactNode:')), [a, artifactAt('ing_demo/b.md')!].sort(), 'the folder lists both artifacts, tracked in the same run');
      assert.equal(childrenOf(folderAt('.')!).includes(folder), true, 'and the root lists the folder');
    });

    test('a path is a file or a directory, never both: each kind finds only its own', () => {
      assert.equal(artifactAt('ing_demo'), undefined);
      assert.equal(folderAt('ing_demo/a.md'), undefined);
      assert.equal(fx.store.maps.liveAtPath('ing_demo/a.md', { graph: THREADS_GRAPH }), undefined, 'and only in the graph it is in');
      assert.equal(fx.store.maps.liveAtPath('ing_demo/a.md', { graph: MAIN_GRAPH }), artifactAt('ing_demo/a.md'));
    });

    test('a second ingest keeps the id of the folder and of each artifact, and the folder still lists them', () => {
      const [a, b, folder] = [artifactAt('ing_demo/a.md')!, artifactAt('ing_demo/b.md')!, folderAt('ing_demo')!];
      const before = childrenOf(folder);
      runIngest(fx.store, [], false, false);
      assert.equal(artifactAt('ing_demo/a.md'), a);
      assert.equal(artifactAt('ing_demo/b.md'), b);
      assert.equal(folderAt('ing_demo'), folder);
      assert.deepEqual(childrenOf(folder), before);
    });
  });

  describe('a file renamed on disk', () => {
    test('the map follows the rename: the new path finds the node with its id and the old path finds nothing', () => {
      const b = artifactAt('ing_demo/b.md')!;
      renameSync(join(fx.artifactsRoot, 'ing_demo/b.md'), join(fx.artifactsRoot, 'ing_demo/b2.md'));
      const result = runIngest(fx.store, [], true, false);
      assert.equal(result.trackResult?.renamed, 1);
      assert.equal(artifactAt('ing_demo/b2.md'), b);
      assert.equal(artifactAt('ing_demo/b.md'), undefined);
      assert.equal(stored(b).path, 'ing_demo/b2.md');
      assert.equal(childrenOf(folderAt('ing_demo')!).filter((id) => id === b).length, 1, 'the folder lists the node once');
    });
  });

  describe('a path reused after a removal', () => {
    test('a new artifact with a new id takes the path, and the removed one stays a tombstone the map does not answer', () => {
      const old = artifactAt('ing_demo/a.md')!;
      rmSync(join(fx.artifactsRoot, 'ing_demo/a.md'));
      const held = trackAllArtifacts(fx.store);
      assert.deepEqual(held.pendingRemovals, ['ing_demo/a.md']);
      assert.equal(artifactAt('ing_demo/a.md'), old, 'held back, so still live');
      trackAllArtifacts(fx.store, true);
      assert.equal(artifactAt('ing_demo/a.md'), undefined, 'tombstoned, so not in the map');
      assert.equal(typeof stored(old).tombstonedAt, 'string');
      assert.equal(stored(old).path, 'ing_demo/a.md', 'a tombstone keeps its stored path');

      writeArtifact(fx, 'ing_demo/a.md', '# A again\n\nA new text for the reused path.\n');
      const result = runIngest(fx.store, ['ing_demo/a.md'], true, false);
      assert.deepEqual(result.failed, []);
      const fresh = artifactAt('ing_demo/a.md');
      assert.ok(fresh, 'the path is in the map again');
      assert.notEqual(fresh, old, 'a new artifact, not the removed one');
      assert.equal(stored(old).tombstonedAt !== undefined, true, 'the removed one stays removed');
      assert.equal(childrenOf(folderAt('ing_demo')!).includes(fresh), true, 'the folder lists the new one');
      assert.equal(childrenOf(folderAt('ing_demo')!).includes(old), false, 'and no longer the removed one');
    });
  });

  describe('what no sweep lists', () => {
    test('a ghost, named by the children of the root and with no document, is not an artifact or a folder', () => {
      const root = folderAt('.')!;
      (wrap(fx.store, root) as unknown as FolderNode).appendChild('FolderNode:GHOST000000');
      (wrap(fx.store, root) as unknown as FolderNode).appendChild('ArtifactNode:GHOST000001');
      assert.equal(liveDocumentIdsOfKind(fx.store, 'FolderNode').includes('FolderNode:GHOST000000'), false);
      assert.equal(liveDocumentIdsOfKind(fx.store, 'ArtifactNode').includes('ArtifactNode:GHOST000001'), false);
      assert.deepEqual(ingestFolderTree(fx.store).pendingRemovals, []);
      assert.deepEqual(trackAllArtifacts(fx.store).pendingRemovals, []);
    });

    test('a node with a record and a path but no title is not listed either, and no sweep holds it back for removal', () => {
      const id = `ArtifactNode:${generateNodeId()}`;
      const half = createNode(fx.store, id, { path: 'ing_demo/half.md' }) as unknown as ArtifactNode;
      half.path = 'ing_demo/half.md';
      assert.equal(liveDocumentIdsOfKind(fx.store, 'ArtifactNode').includes(id), false, 'a record without a title is not a document yet');
      assert.deepEqual(trackAllArtifacts(fx.store).pendingRemovals, []);
      half.title = 'half.md';
      assert.equal(liveDocumentIdsOfKind(fx.store, 'ArtifactNode').includes(id), true, 'with a title it is');
      assert.deepEqual(trackAllArtifacts(fx.store).pendingRemovals, ['ing_demo/half.md'], 'and with its file missing it is held back');
    });
  });

  describe('a removed node with the abstract of a live one', () => {
    test('a folder that vanished with a README like a live folder\'s is a removal, not a rename into the live folder', () => {
      writeArtifact(fx, 'ing_demo/twinA/README.md', '# Twin\n\nThe same abstract in two folders.\n');
      writeArtifact(fx, 'ing_demo/twinB/README.md', '# Twin\n\nThe same abstract in two folders.\n');
      ingestFolderTree(fx.store);
      const [a, b] = [folderAt('ing_demo/twinA')!, folderAt('ing_demo/twinB')!];
      assert.ok(a && b && a !== b, 'two folders');
      rmSync(join(fx.artifactsRoot, 'ing_demo/twinB'), { recursive: true });
      const result = ingestFolderTree(fx.store);
      assert.equal(result.sweep.renamed, 0);
      assert.deepEqual(result.pendingRemovals, ['ing_demo/twinB']);
      assert.equal(folderAt('ing_demo/twinA'), a, 'the live folder keeps its id');
      assert.equal(getFolderRecord(fx.store, 'ing_demo/a.md'), null, 'a file path names no folder');
    });

    test('an artifact that vanished with the text of a live one is a removal, not a rename into the live one', () => {
      writeArtifact(fx, 'ing_demo/twinA.md', '# Twin\n\nThe same text in two files.\n');
      writeArtifact(fx, 'ing_demo/twinB.md', '# Twin\n\nThe same text in two files.\n');
      runIngest(fx.store, ['ing_demo/twinA.md', 'ing_demo/twinB.md'], true, false);
      const [a, b] = [artifactAt('ing_demo/twinA.md')!, artifactAt('ing_demo/twinB.md')!];
      assert.ok(a && b && a !== b, 'two artifacts');
      rmSync(join(fx.artifactsRoot, 'ing_demo/twinB.md'));
      const result = trackAllArtifacts(fx.store);
      assert.equal(result.sweep.renamed, 0);
      assert.equal(result.pendingRemovals.includes('ing_demo/twinB.md'), true);
      assert.equal(artifactAt('ing_demo/twinA.md'), a);
      assert.equal(stored(a).path, 'ing_demo/twinA.md');
    });
  });

  describe('a thread artifact', () => {
    test('is created in the threads graph and found there by its path, and is not in the main graph', () => {
      writeArtifact(fx, '.threads/t.md', '# T\n\nA thread.\n');
      const result = runIngest(fx.store, ['.threads/t.md'], true, false);
      assert.deepEqual(result.failed, []);
      const t = artifactAt('.threads/t.md');
      assert.ok(t, 'the thread artifact is in the map');
      assert.equal(graphOfId(fx.store, t), THREADS_GRAPH);
      assert.equal(fx.store.maps.liveAtPath('.threads/t.md', { graph: THREADS_GRAPH }), t);
      assert.equal(fx.store.maps.liveAtPath('.threads/t.md', { graph: MAIN_GRAPH }), undefined);
      assert.equal(graphOfId(fx.store, artifactAt('ing_demo/a.md')!), MAIN_GRAPH, 'an ordinary artifact is in the main graph');
    });
  });

  describe('the position props of a Link', () => {
    test('read in another order than the text keep their ids on a later ingest of the same text', () => {
      writeArtifact(fx, 'ing_demo/target.md', '# Target\n\nThe target.\n');
      writeArtifact(fx, 'ing_demo/pos.md', '# Pos\n\nTwice: a [first]([[ing_demo/target.md]]) and a [second]([[ing_demo/target.md]]).\n');
      runIngest(fx.store, ['ing_demo/target.md', 'ing_demo/pos.md'], true, false);
      const art = wrap(fx.store, artifactAt('ing_demo/pos.md')!) as unknown as ArtifactNode;
      const paragraph = (function find(nodes: BlockNode[]): BlockNode | undefined {
        for (const n of nodes) {
          if (typeof n.text === 'string' && n.text.startsWith('Twice:')) return n;
          const found = find((n.children ?? []) as BlockNode[]);
          if (found) return found;
        }
        return undefined;
      })((art.children ?? []) as BlockNode[]);
      assert.ok(paragraph, 'the paragraph with the two mentions');
      const links = paragraph.links as unknown as Link[];
      assert.equal(links.length, 1, 'one Link for the target');
      const linkId = links[0]!.id;
      const ascending = getProps(links[0] as never, 'position').map(Number);
      assert.equal(ascending.length, 2);

      // Store the two positions in descending order, as another read order of the same set would give them.
      const link = wrap(fx.store, linkId) as unknown as Link;
      link.props = [...ascending].reverse().map((p) => ({ '@type': 'StringProp', key: 'position', value: String(p) })) as never;
      const stateBefore = (wrap(fx.store, linkId) as unknown as Link).props as unknown as Array<{ id: string; key: string; value: string }>;
      const orderBefore = stateBefore.filter((p) => p.key === 'position').map((p) => Number(p.value));
      assert.deepEqual(orderBefore, [...ascending].reverse(), 'the store reads the positions in the order they were written');
      const idsBefore = stateBefore.map((p) => p.id);

      // The text is unchanged but the file is not (a second paragraph), so the artifact is ingested again and its links are resolved again.
      writeArtifact(fx, 'ing_demo/pos.md', '# Pos\n\nTwice: a [first]([[ing_demo/target.md]]) and a [second]([[ing_demo/target.md]]).\n\nUnrelated.\n');
      runIngest(fx.store, ['ing_demo/pos.md'], true, false);
      const after = (wrap(fx.store, linkId) as unknown as Link).props as unknown as Array<{ id: string; key: string; value: string }>;
      assert.deepEqual(after.map((p) => p.id), idsBefore, 'the props are the same nodes: the same positions are not a change');
    });
  });

  describe('a file that does not exist', () => {
    const everyArtifactId = () => allIdsOfKind(fx.store, 'ArtifactNode');
    test('ingest of it fails with the read error and leaves no record: no new ArtifactNode, nothing at its path', () => {
      const before = everyArtifactId();
      assert.throws(() => runIngest(fx.store, ['ing_demo/missing.md'], false, false), /ENOENT/);
      assert.deepEqual(everyArtifactId(), before, 'the store holds the same ArtifactNode records as before');
      assert.equal(artifactAt('ing_demo/missing.md'), undefined);
    });

    test('ingest of it with --track, and track of it, leave no record either', () => {
      const before = everyArtifactId();
      assert.throws(() => runIngest(fx.store, ['ing_demo/missing.md'], true, false), /ENOENT/);
      assert.throws(() => trackArtifact(fx.store, 'ing_demo/missing.md'), /ENOENT/);
      assert.deepEqual(everyArtifactId(), before);
      assert.equal(artifactAt('ing_demo/missing.md'), undefined);
    });

    test('a missing file after a good one in the same run keeps the good one tracked and adds nothing for the missing one', () => {
      writeArtifact(fx, 'ing_demo/present.md', '# Present\n\nHere.\n');
      const before = everyArtifactId();
      assert.throws(() => runIngest(fx.store, ['ing_demo/present.md', 'ing_demo/missing.md'], false, false), /ENOENT/);
      const added = everyArtifactId().filter((id) => !before.includes(id));
      assert.deepEqual(added, [artifactAt('ing_demo/present.md')], 'only the file that exists has a record');
    });
  });
});
