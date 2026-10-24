// A link written as a relative path with no `#id/` (`[x](./beta.md)`, `[x](../beta.md)`) in a body that `insert` or `update` writes: the link is stored in `.links`
// of the new block, `show` lists it, and `check-links` is a clean pass without `--repair`. A path link is resolved against the artifact the block sits in, so the
// block must be attached to its parent before the links are resolved (the regression: the links were resolved before the attachment, found no enclosing artifact,
// and the link was left out of `.links`). A link that cannot point anywhere is still refused, and the refusal leaves nothing behind.
import { describe, test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { runInsert } from '../../kgInsert';
import { runUpdate } from '../../kgUpdate';
import { runShow } from '../../kgShow';
import { checkLinkIntegrity } from '@aperas/core/shell/linkIntegrity';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';
import { buildCorpus, idOf, linkIdsOf, linkTargetOf, writeArtifact, type Corpus } from '../support/commandsCorpus.ts';
import { mark, assertNothingLeft } from '../support/leftovers.ts';
import { runIngest } from '../../kgIngest';

const createdIdOf = (line: string): string => line.split('  ')[0].replace('aperas://id/', '');

describe('path links in a body written by insert and update', () => {
  let fx: FixtureStore;
  let c: Corpus;
  before(() => {
    fx = makeFixtureStore('cmd_demo');
    c = buildCorpus(fx);
    writeArtifact(fx, 'cmd_demo/sub/deep.md', '# Deep\n\nDeep intro.\n\n## Deep Sec\n\nDeep text.\n');
    runIngest(fx.store, ['cmd_demo/sub/deep.md'], true, false);
  });
  after(() => fx.cleanup());

  const targets = (blockId: string): string[] => linkIdsOf(fx, blockId).map((l) => linkTargetOf(fx, blockId, l)).sort();
  const discrepancies = (): number => checkLinkIntegrity(fx.store).discrepancies.length;

  test('a path link in a body inserted at the end of a parent is stored, and check-links is clean', () => {
    const r = runInsert(fx.store, { path: 'cmd_demo/dup.md/Dup', markdown: '## Cites\n\nSee [beta](./beta.md) and [alpha](./alpha.md).\n' });
    const id = createdIdOf(r.lines[0]);
    assert.deepEqual(r.linkResolution, { resolved: 2, dangling: 0, changed: 1 });
    assert.deepEqual(targets(id), [c.alphaArt, c.betaArt].sort());
    assert.equal(discrepancies(), 0);
  });

  test('a path link that climbs a directory, in a body inserted from a nested artifact, is stored', () => {
    const id = createdIdOf(runInsert(fx.store, { path: 'cmd_demo/sub/deep.md/Deep', markdown: 'Up to [beta](../beta.md).\n' }).lines[0]);
    assert.deepEqual(targets(id), [c.betaArt]);
    assert.equal(discrepancies(), 0);
  });

  test('a path link in a body inserted --after and --before an anchor is stored', () => {
    for (const side of ['after', 'before'] as const) {
      const id = createdIdOf(runInsert(fx.store, { path: 'cmd_demo/dup.md/Dup', markdown: `## ${side} anchor\n\nTo [beta](./beta.md).\n`, [side]: c.itemOne }).lines[0]);
      assert.deepEqual(targets(id), [c.betaArt], side);
    }
    assert.equal(discrepancies(), 0);
  });

  test('a path link in a nested body is stored on the block that holds it, not on the top of the body', () => {
    const top = createdIdOf(runInsert(fx.store, { path: 'cmd_demo/dup.md/Dup', markdown: '## Nest\n\n### Inner\n\nTo [beta](./beta.md).\n' }).lines[0]);
    const inner = (runShow(fx.store, top).children as string[])[0];
    assert.deepEqual(targets(inner), [c.betaArt]);
    assert.equal(discrepancies(), 0);
  });

  test('several blocks in one body each keep their path link', () => {
    const lines = runInsert(fx.store, { path: 'cmd_demo/dup.md/Dup', markdown: '## One P\n\nTo [beta](./beta.md).\n\n## Two P\n\nTo [alpha](./alpha.md).\n', after: c.itemTwo }).lines;
    assert.deepEqual(lines.map((l) => targets(createdIdOf(l))), [[c.betaArt], [c.alphaArt]]);
    assert.equal(discrepancies(), 0);
  });

  test('a path link under an artifact itself (a top-level block) is stored', () => {
    const id = createdIdOf(runInsert(fx.store, { path: 'cmd_demo/dup.md', markdown: '# Second\n\nTo [beta](./beta.md).\n' }).lines[0]);
    assert.deepEqual(targets(id), [c.betaArt]);
    assert.equal(discrepancies(), 0);
  });

  test('update keeps the path link it resolves, and a second identical update keeps its id', () => {
    writeArtifact(fx, 'cmd_demo/upd.md', '# Upd\n\n## One\n\nOne text.\n');
    runIngest(fx.store, ['cmd_demo/upd.md'], true, false);
    const one = idOf(fx, 'cmd_demo/upd.md/Upd/One');
    const text = 'Now [beta](./beta.md).\n';
    const r1 = runUpdate(fx.store, { path: one, markdown: text, textOnly: false });
    assert.deepEqual(r1.linkResolution, { resolved: 1, dangling: 0, changed: 1 });
    const ids = linkIdsOf(fx, one);
    assert.equal(ids.length, 1);
    assert.equal(discrepancies(), 0);
    assert.deepEqual(runUpdate(fx.store, { path: one, markdown: text, textOnly: false }).linkResolution, { resolved: 1, dangling: 0, changed: 0 });
    assert.deepEqual(linkIdsOf(fx, one), ids);
  });

  test('update --text-only with an overflow keeps the path link of the new blocks', () => {
    const one = idOf(fx, 'cmd_demo/upd.md/Upd/One');
    runUpdate(fx.store, { path: one, markdown: 'One text.\n\n- first [beta](./beta.md)\n- second\n', textOnly: true });
    const firstItem = (runShow(fx.store, one).children as string[])[0];
    assert.deepEqual(targets(firstItem), [c.betaArt]);
    assert.equal(discrepancies(), 0);
  });

  test('refused: a path link to an artifact that is not tracked leaves nothing behind (it is dangling, not refused), and a link to an id that names no node is refused and leaves nothing', () => {
    const before = mark(fx.store);
    assert.throws(
      () => runInsert(fx.store, { path: 'cmd_demo/dup.md/Dup', markdown: '## Bad\n\nTo [ok](./beta.md) and [bad]([[BlockNode:0000000000000]]).\n' }),
      /Refusing to store 1 link\(s\) that cannot point anywhere/,
    );
    assertNothingLeft(fx.store, before, 'insert refused for a link to an id that names no node');
    assert.equal(discrepancies(), 0);
  });

  test('ingest of a file with path links stores them, the nested file with a link that climbs a directory included', () => {
    writeArtifact(fx, 'cmd_demo/sub/ing.md', '# Ing\n\nUp to [beta](../beta.md).\n\n## Inner\n\nSide to [deep](./deep.md).\n');
    runIngest(fx.store, ['cmd_demo/sub/ing.md'], true, false);
    const top = idOf(fx, 'cmd_demo/sub/ing.md/Ing');
    assert.deepEqual(targets(top), [c.betaArt]);
    assert.equal(targets(idOf(fx, 'cmd_demo/sub/ing.md/Ing/Inner')).length, 1);
    assert.equal(discrepancies(), 0);
  });

  test('a refusal while the links are resolved, after the blocks are placed, takes the placed blocks with it', () => {
    const before = mark(fx.store);
    const addPair = fx.store.engine.addPair.bind(fx.store.engine);
    const faulty = mock.method(fx.store.engine, 'addPair', (...args: Parameters<typeof addPair>) => {
      if (args[2] === 'links') throw new Error('injected: the link is refused');
      return addPair(...args);
    });
    try {
      assert.throws(() => runInsert(fx.store, { path: 'cmd_demo/dup.md/Dup', markdown: '## Fault\n\nTo [beta](./beta.md).\n', after: c.itemOne }), /injected/);
    } finally { faulty.mock.restore(); }
    assertNothingLeft(fx.store, before, 'insert refused while its links are resolved');
  });
});
