// Tombstone garbage collection and unlinking (steps 10 and 11 of the legacy suite): mark and sweep collects a
// dead cluster whose members point only at each other and spares a tombstone that a live block still links to;
// removing that manual link with `kg:unlink` lets a later pass collect it. The cases share the store, the
// paragraph that carries the links and the spared tombstone, and run in order.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { wrap, pruneUnreachableTombstones, type BlockNode, type Link } from '@aperas/core/shell/node';
import { WIKILINK_PREDICATE } from '@aperas/core/astParser';
import { nodeExists } from '@aperas/core/shell/vocab';
import { generateNodeId } from '@aperas/core/snowflake';
import { runRemoveBlockLink } from '../../kgLink';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';
import { ingestLinkedDemo, type LinkedDemo } from '../support/linkedDemo.ts';

describe('tombstone garbage collection', () => {
  let fx: FixtureStore;
  let demo: LinkedDemo;
  let keptDeadId = '';
  let manualBeforeAdd = 0;
  const linksOf = (blockId: string): Link[] => ((wrap(fx.store, blockId) as unknown as BlockNode).links as unknown as Link[] | undefined) ?? [];
  const tombstoned = (title: string): string => {
    const id = `BlockNode:${generateNodeId()}`;
    const node = wrap(fx.store, id) as unknown as BlockNode;
    node.type = 'heading'; node.title = title; node.children = [];
    return id;
  };

  before(() => {
    fx = makeFixtureStore('gc_demo');
    demo = ingestLinkedDemo(fx); // the link paragraph carries two wikilinks and a manual link to the artifact
  });
  after(() => fx.cleanup());

  test('10: mark and sweep collects a cyclic dead cluster but spares a referenced tombstone', () => {
    // Dropping a tombstoned node once it has zero incoming references fails on a cycle, as refcounting does: two
    // tombstoned nodes pointing only at each other would each show a nonzero count forever. Mark and sweep from
    // the live roots does not. Built directly against the store, unattached to any tree.
    const deadAId = tombstoned('Dead A');
    const deadBId = tombstoned('Dead B');
    (wrap(fx.store, deadAId) as unknown as BlockNode).addLink('references', deadBId);
    (wrap(fx.store, deadBId) as unknown as BlockNode).addLink('references', deadAId);
    const now = new Date().toISOString();
    (wrap(fx.store, deadAId) as unknown as BlockNode).tombstonedAt = now;
    (wrap(fx.store, deadBId) as unknown as BlockNode).tombstonedAt = now;

    // A third tombstone kept by a manual link from a live block must survive the same pass, which shows the
    // pass is not deleting every tombstone unconditionally.
    keptDeadId = tombstoned('Kept Dead');
    (wrap(fx.store, keptDeadId) as unknown as BlockNode).tombstonedAt = now;
    manualBeforeAdd = linksOf(demo.linkBlockId).filter((l) => l.predicate === 'references').length;
    (wrap(fx.store, demo.linkBlockId) as unknown as BlockNode).addLink('references', keptDeadId);

    const { pruned } = pruneUnreachableTombstones(fx.store);
    assert.equal(nodeExists(fx.store, deadAId), false, `the dead cluster member ${deadAId} is pruned`);
    assert.equal(nodeExists(fx.store, deadBId), false, `the dead cluster member ${deadBId} is pruned`);
    assert.ok(nodeExists(fx.store, keptDeadId), `'${keptDeadId}' survives: a live block's manual link still references it`);
    assert.ok(pruned >= 2, `at least 2 nodes pruned (the dead cluster), got ${pruned}`);
  });

  test('11: kg:unlink removes only the targeted manual link and lets the next pass collect the tombstone', () => {
    // `runAddBlockLink` had no removal counterpart: a manual link could only be taken back by tombstoning its
    // whole block. Removing this one is also what lets a later pass collect `keptDead`.
    const result = runRemoveBlockLink(fx.store, demo.linkBlockId, keptDeadId);
    assert.ok(result.removed, `runRemoveBlockLink removes the manual link from ${demo.linkBlockId} to ${keptDeadId}`);
    const links = linksOf(demo.linkBlockId);
    assert.equal(
      links.some((l) => l.predicate === 'references' && (l.target as unknown as { id: string } | undefined)?.id === keptDeadId),
      false,
      `no manual link to ${keptDeadId} remains`,
    );
    assert.equal(links.filter((l) => l.predicate === 'references').length, manualBeforeAdd, "the block's other manual links are untouched");
    assert.equal(links.filter((l) => l.predicate === WIKILINK_PREDICATE).length, 2, "the block's wikilinks are untouched"); // new: the old step only printed this count
    pruneUnreachableTombstones(fx.store);
    assert.equal(nodeExists(fx.store, keptDeadId), false, `'${keptDeadId}' is collected now that its only reference is gone`);
  });
});
