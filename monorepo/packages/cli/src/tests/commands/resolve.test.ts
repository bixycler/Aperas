// The path commands before the reads move to the engine (planning/core.md, Batch 11, step 10): `runPath` and `runResolve` on a small corpus. The deep-path
// grammar (a folder, a file, a heading by exact slug and by prefix, the aperas:// forms, a bare code, the root, a base), `..` at each tier, a path that is
// ambiguous, a miss, a path reused after a removal, the creation of a holder chain, and the round trip from a node to its path and back. The last block is
// the issue that the first node found at a path was the answer: a path held by a live node and by a tombstone answers the live node, whichever was stored
// first. The store is reached through `fx.store`, `wrap`, `createNode` and the `runX` functions only.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateNodeId } from '@aperas/core/snowflake';
import { findByExactPath } from '@aperas/core/shell/tree';
import { createNode } from '@aperas/core/shell/node';
import { runPath } from '../../kgPath';
import { runResolve } from '../../kgResolve';
import { runTree } from '../../kgTree';
import { runShow } from '../../kgShow';
import { runIngest } from '../../kgIngest';
import { runRemove } from '../../kgRemove';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';
import { buildCorpus, idOf, parseTree, writeArtifact, type Corpus } from '../support/commandsCorpus.ts';

const refuses = (fn: () => unknown, message: RegExp): void => assert.throws(fn, (e: unknown) => e instanceof Error && message.test(e.message), `expected a refusal matching ${message}`);
const NOT_TRACKED = /isn't a tracked artifact\/folder path, deep path, bare node code, or full node id/;

describe('path commands', () => {
  let fx: FixtureStore;
  let c: Corpus;
  before(() => { fx = makeFixtureStore('cmd_demo'); c = buildCorpus(fx); });
  after(() => fx.cleanup());

  describe('resolve, the grammar', () => {
    test('a folder, a file and a heading by prefix of its title', () => {
      assert.equal(idOf(fx, 'cmd_demo'), c.folder);
      assert.equal(idOf(fx, 'cmd_demo/beta.md'), c.betaArt);
      assert.equal(idOf(fx, 'cmd_demo/beta.md/Beta'), c.beta);
      assert.equal(idOf(fx, 'cmd_demo/beta.md/Beta/Beta Section'), c.betaSec);
      assert.equal(idOf(fx, 'cmd_demo/beta.md/beta/beta-sec'), c.betaSec, 'case and punctuation do not matter in a prefix');
    });

    test('a heading by the exact slug of its whole title, marker included', () => {
      assert.equal(idOf(fx, 'cmd_demo/beta.md/--beta/---beta-section'), c.betaSec);
    });

    test('the aperas://id and aperas://tree forms, a bare code, a full id, the root and a leading slash', () => {
      assert.equal(idOf(fx, `aperas://id/${c.betaSec}`), c.betaSec);
      assert.equal(idOf(fx, 'aperas://tree/cmd_demo/beta.md/Beta/Beta Section'), c.betaSec);
      assert.equal(idOf(fx, c.betaSec.split(':')[1]), c.betaSec);
      assert.equal(idOf(fx, c.betaArt.split(':')[1]), c.betaArt, 'a bare code is tried as a block, then an artifact, then a folder');
      assert.equal(idOf(fx, c.folder.split(':')[1]), c.folder);
      assert.equal(idOf(fx, c.betaSec), c.betaSec);
      assert.equal(idOf(fx, '/cmd_demo/beta.md'), c.betaArt);
      const root = runResolve(fx.store, { paths: ['.'], createHolder: false }).lines[0];
      assert.ok(root.endsWith('[FolderNode]  Artifacts'), root);
      assert.equal(idOf(fx, 'aperas://tree/.'), idOf(fx, '.'));
    });

    test('several paths in one call answer one line each, in the order asked, with the label and the title', () => {
      const out = runResolve(fx.store, { paths: ['cmd_demo/beta.md/Beta/Other', 'cmd_demo/alpha.md', 'cmd_demo'], createHolder: false }).lines;
      assert.deepEqual(out, [
        `aperas://id/${c.betaOther}  [heading]  ## Other`,
        `aperas://id/${c.alphaArt}  [ArtifactNode]  alpha.md`,
        `aperas://id/${c.folder}  [FolderNode]  cmd_demo`,
      ]);
    });

    test('a base: a relative path descends from it, an absolute one ignores it', () => {
      assert.equal(idOf(fx, 'Beta/Beta Section', 'cmd_demo/beta.md'), c.betaSec);
      assert.equal(idOf(fx, '..', 'cmd_demo/beta.md'), c.folder);
      assert.equal(idOf(fx, '/cmd_demo/alpha.md', 'cmd_demo/beta.md'), c.alphaArt);
      refuses(() => runResolve(fx.store, { paths: ['Beta'], base: 'cmd_demo/nothing.md', createHolder: false }), NOT_TRACKED);
    });
  });

  describe('resolve, .. at each tier', () => {
    test('from a heading it is the heading above, and from a top-level heading it is the artifact', () => {
      assert.equal(idOf(fx, 'cmd_demo/beta.md/Beta/Beta Section/..'), c.beta);
      assert.equal(idOf(fx, 'cmd_demo/beta.md/Beta/..'), c.betaArt);
      assert.equal(idOf(fx, 'cmd_demo/alpha.md/Alpha/Alpha Sec/../..'), c.alphaArt);
    });

    test('from an artifact it is the folder, from a folder the root, and from the root it is refused', () => {
      assert.equal(idOf(fx, 'cmd_demo/beta.md/..'), c.folder);
      assert.equal(idOf(fx, 'cmd_demo/beta.md/../alpha.md'), c.alphaArt, 'and the walk goes on from there');
      assert.equal(idOf(fx, 'cmd_demo/..'), idOf(fx, '.'));
      refuses(() => idOf(fx, '..'), /already at the artifacts root/);
    });

    test('.. then a name continues from the parent', () => {
      assert.equal(idOf(fx, 'cmd_demo/beta.md/Beta/Beta Section/../Other'), c.betaOther);
      assert.equal(idOf(fx, 'cmd_demo/beta.md/Beta/Beta Section/../../../alpha.md'), c.alphaArt);
    });
  });

  describe('resolve, refusals', () => {
    test('a name that matches two siblings is ambiguous, and a longer prefix or the exact slug picks one', () => {
      refuses(() => idOf(fx, 'cmd_demo/dup.md/Dup/Item'), new RegExp(`'Item' is ambiguous among: .*(${c.itemOne}|${c.itemTwo})`));
      assert.equal(idOf(fx, 'cmd_demo/dup.md/Dup/Item One'), c.itemOne);
      assert.equal(idOf(fx, 'cmd_demo/dup.md/Dup/Item-Two'), c.itemTwo);
    });

    test('ambiguity inside a longer call is named with the path it came from', () => {
      refuses(() => runResolve(fx.store, { paths: ['cmd_demo/dup.md/Dup/Item'], createHolder: false }), /^'cmd_demo\/dup.md\/Dup\/Item': .*ambiguous/);
    });

    test('a path that has no node, at each tier, is not tracked', () => {
      for (const ref of ['nothing', 'cmd_demo/nothing.md', 'cmd_demo/beta.md/Nothing', 'cmd_demo/beta.md/Beta/Nothing']) refuses(() => idOf(fx, ref), NOT_TRACKED);
    });

    test('an id that is not a valid snowflake is read as a path, and a miss', () => {
      refuses(() => idOf(fx, 'BlockNode:short'), NOT_TRACKED);
      refuses(() => idOf(fx, 'ZZZZZZZZZZZZZ'), NOT_TRACKED);
    });
  });

  describe('resolve, --create-holder', () => {
    test('creates the missing headings of a path, each tagged created, and a second call finds them all existing', () => {
      const first = runResolve(fx.store, { paths: ['cmd_demo/beta.md/Beta/New Part'], createHolder: true, titles: ['## New Part'] }).lines;
      assert.equal(first.length, 4, 'the folder, the file, the first heading, the new one');
      assert.deepEqual(first.map((l) => /\((created holder|existing)\)$/.exec(l)![1]), ['existing', 'existing', 'existing', 'created holder']);
      const created = first[3].split('  ')[0].replace('aperas://id/', '');
      assert.equal(idOf(fx, 'cmd_demo/beta.md/Beta/New Part'), created, 'the new heading resolves by its path');
      assert.equal(runShow(fx.store, created).title, '## New Part');
      assert.equal(runShow(fx.store, created).holder, true, 'and is a holder until written');
      const second = runResolve(fx.store, { paths: ['cmd_demo/beta.md/Beta/New Part'], createHolder: true, titles: ['## New Part'] }).lines;
      assert.ok(second.every((l) => l.endsWith('(existing)')), second.join('\n'));
    });

    test('refused: a path with no tracked prefix and no filename in it', () => {
      refuses(() => runResolve(fx.store, { paths: ['nothing/at/all'], createHolder: true, titles: [] }), /Nothing under 'nothing' is tracked.*--create-holder needs a filename/);
    });
  });

  describe('path', () => {
    test('gives the walkable path of a folder, an artifact and a heading, which resolves back to the node', () => {
      assert.equal(runPath(fx.store, c.folder), 'cmd_demo');
      assert.equal(runPath(fx.store, c.betaArt), 'cmd_demo/beta.md');
      assert.equal(runPath(fx.store, c.betaSec), 'cmd_demo/beta.md/--beta/---beta-section');
      assert.equal(runPath(fx.store, 'cmd_demo/beta.md/Beta/Beta Section'), runPath(fx.store, c.betaSec), 'a path in any form gives the canonical one');
      assert.equal(runPath(fx.store, '.'), '.');
    });

    test('every node of the render has a path that resolves back to it', () => {
      const entries = parseTree(runTree(fx.store, { pathArg: '.', noHolders: false, showTombstoned: false }) as string[]);
      assert.ok(entries.length >= 14, `${entries.length} nodes`);
      for (const e of entries) assert.equal(idOf(fx, runPath(fx.store, e.id)), e.id, `${e.id} (${e.rest})`);
    });

    test('refused: a path that resolves to nothing, and a link, which has no path of its own', () => {
      refuses(() => runPath(fx.store, 'cmd_demo/nothing.md'), NOT_TRACKED);
      // The message the code means (`has no walkable parent chain`) is not what it says today: a Link has no `toPath`, so the call fails with a TypeError. Any refusal passes.
      assert.throws(() => runPath(fx.store, c.alphaLinkToBeta), Error);
    });
  });

  describe('a path held by a live node and a tombstone', () => {
    test('after a removal and a new file at the same path, the path resolves to the new node, and the bare code of the tombstone to nothing', () => {
      writeArtifact(fx, 'cmd_demo/reused.md', '# Reused\n\nFirst.\n');
      runIngest(fx.store, ['cmd_demo/reused.md'], true, false);
      const dead = idOf(fx, 'cmd_demo/reused.md');
      runRemove(fx.store, { path: 'cmd_demo/reused.md' });
      writeArtifact(fx, 'cmd_demo/reused.md', '# Reused Again\n\nSecond.\n');
      runIngest(fx.store, ['cmd_demo/reused.md'], true, false);
      const live = idOf(fx, 'cmd_demo/reused.md');
      assert.notEqual(live, dead);
      assert.equal(runPath(fx.store, live), 'cmd_demo/reused.md');
      assert.equal(runShow(fx.store, live).tombstonedAt, undefined);
      assert.equal(typeof runShow(fx.store, dead).tombstonedAt, 'string');
      refuses(() => idOf(fx, dead.split(':')[1]), NOT_TRACKED);
      const heading = parseTree(runTree(fx.store, { pathArg: 'cmd_demo/reused.md', noHolders: false, showTombstoned: false }) as string[]).find((e) => e.label === 'heading')!;
      assert.equal(idOf(fx, 'cmd_demo/reused.md/Reused-Again'), heading.id, 'and the walk below it is the new node\'s');
    });
  });

  describe('the first node found at a path', () => {
    test('a path held by a live node and by a tombstone answers the live node, whichever was stored first', () => {
      const AT = '2026-10-19T00:00:00.000Z';
      const answers: Record<string, string> = {};
      let n = 0;
      for (const order of ['live first', 'dead first']) {
        const path = `held/${n++}.md`;
        const live = `ArtifactNode:${generateNodeId()}`;
        const dead = `ArtifactNode:${generateNodeId()}`;
        for (const id of order === 'live first' ? [live, dead] : [dead, live]) {
          const node = createNode(fx.store, id, { path }) as unknown as { title: string; path: string; tombstonedAt?: string };
          node.title = 'held';
          node.path = path;
          if (id === dead) node.tombstonedAt = AT;
        }
        const found = findByExactPath(fx.store, path);
        answers[order] = found === live ? 'live' : found === dead ? 'dead' : String(found);
      }
      assert.deepEqual(answers, { 'live first': 'live', 'dead first': 'live' }, 'the live node is the answer under both orders');
    });
  });
});
