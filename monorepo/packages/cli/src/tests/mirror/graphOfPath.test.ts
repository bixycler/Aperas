// The graph a new node takes (planning/core.md, Batch 9 step 2; design/core.md, "Written by graph and kind"): a profile is in the main graph, a
// view in the graph of the views, an artifact or a folder in the threads graph when its path is `.threads` or lies under `.threads/` and in the
// main graph otherwise, and a block, a link or a property in the graph of the node it is built under. The rule reads the engine's `graphOf`.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { graphOfNewNode, isThreadsPath } from '@aperas/core/shell/graphOfPath';
import { THREADS, TREE, VIEWS, idOf, newEngine } from '../support/mirrorFixture.ts';
import { createMirrorGraphs } from '@aperas/core/shell/mirrorFiles';

describe('the scope of the threads graph is a path', () => {
  test('is `.threads` or a path under `.threads/`, from the root of the tree', () => {
    for (const path of ['.threads', '.threads/', '.threads/coder.md', '.threads/deep/er/x.md', './.threads/coder.md', '.threads\\coder.md']) assert.equal(isThreadsPath(path), true, path);
  });

  test('is not a path with `.threads` inside a name, or deeper in the tree', () => {
    for (const path of ['a.threads', '.threadsx', '.threadsx/coder.md', 'threads', 'threads/coder.md', 'docs/.threads', 'docs/.threads/x.md', 'a.threads/x.md', '', '.', 'design/core.md', '.thread/x.md']) assert.equal(isThreadsPath(path), false, path);
  });
});

describe('the graph of a new node', () => {
  const engine = newEngine();
  createMirrorGraphs(engine);
  const block = idOf('BlockNode', 1);
  const threadBlock = idOf('BlockNode', 2);
  const view = idOf('TreeView', 3);
  engine.build(TREE, { id: block, kind: 'BlockNode', fields: { title: 'x', type: 'p' } });
  engine.build(THREADS, { id: threadBlock, kind: 'BlockNode', fields: { title: 'y', type: 'p' } });
  engine.build(VIEWS, { id: view, kind: 'TreeView', fields: { profile: idOf('Profile', 4), name: 'v' } });

  test('a profile is in the main graph and a view in the graph of the views, whatever else is given', () => {
    assert.equal(graphOfNewNode(engine, { kind: 'Profile' }), TREE);
    assert.equal(graphOfNewNode(engine, { kind: 'Profile', path: '.threads/x', under: threadBlock }), TREE);
    assert.equal(graphOfNewNode(engine, { kind: 'TreeView' }), VIEWS);
    assert.equal(graphOfNewNode(engine, { kind: 'TreeView', path: '.threads/x', under: threadBlock }), VIEWS);
  });

  test('an artifact or a folder is in the threads graph by its path and in the main graph otherwise', () => {
    for (const kind of ['ArtifactNode', 'FolderNode']) {
      assert.equal(graphOfNewNode(engine, { kind, path: '.threads' }), THREADS, `${kind} .threads`);
      assert.equal(graphOfNewNode(engine, { kind, path: '.threads/coder.md' }), THREADS, `${kind} under`);
      assert.equal(graphOfNewNode(engine, { kind, path: 'design/core.md' }), TREE, `${kind} elsewhere`);
      assert.equal(graphOfNewNode(engine, { kind, path: 'a.threads' }), TREE, `${kind} a.threads`);
      assert.equal(graphOfNewNode(engine, { kind, path: '.threadsx' }), TREE, `${kind} .threadsx`);
      assert.equal(graphOfNewNode(engine, { kind, path: '.threadsx/y.md' }), TREE, `${kind} .threadsx/`);
      assert.equal(graphOfNewNode(engine, { kind, path: 'x/.threads/y.md' }), TREE, `${kind} deeper`);
    }
  });

  test('the stored path of a node is not read: a block under a container takes the container\'s graph, not a path', () => {
    assert.equal(graphOfNewNode(engine, { kind: 'BlockNode', under: block }), TREE);
    assert.equal(graphOfNewNode(engine, { kind: 'BlockNode', under: threadBlock }), THREADS);
    assert.equal(graphOfNewNode(engine, { kind: 'BlockNode', path: '.threads/x', under: block }), TREE, 'a path given to a block does not matter');
    assert.equal(graphOfNewNode(engine, { kind: 'Link', under: threadBlock }), THREADS, 'nor does a link\'s: it takes its owner\'s graph');
    assert.equal(graphOfNewNode(engine, { kind: 'StringProp', under: view }), VIEWS);
  });

  test('is an error for what the rule cannot place: an artifact or a folder with no path, a block with no container, a container in no graph', () => {
    assert.throws(() => graphOfNewNode(engine, { kind: 'ArtifactNode' }), /needs its path/);
    assert.throws(() => graphOfNewNode(engine, { kind: 'FolderNode', under: block }), /needs its path/);
    assert.throws(() => graphOfNewNode(engine, { kind: 'BlockNode' }), /needs the node it is built under/);
    assert.throws(() => graphOfNewNode(engine, { kind: 'BlockNode', under: idOf('BlockNode', 99) }), /in no graph/);
  });
});
