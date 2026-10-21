// Tombstone garbage collection (steps 10 and 11 of the legacy suite): mark and sweep collects a dead cluster whose
// members point only at each other and spares a tombstone that a live block still links to; dropping that link
// lets a later pass collect it. The cases share the store, the paragraph that carries the links and the spared
// tombstone, and run in order.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { wrap, createNode, pruneUnreachableTombstones, type BlockNode, type Link, type ApeironNode } from '@aperas/core/shell/node';
import { nodeExists } from '@aperas/core/shell/db';
import { generateNodeId } from '@aperas/core/snowflake';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';
import { ingestLinkedDemo, type LinkedDemo } from '../support/linkedDemo.ts';

describe('tombstone garbage collection', () => {
  let fx: FixtureStore;
  let demo: LinkedDemo;
  let keptDeadId = '';
  let keptDeadLinkId = '';
  const blockOf = (blockId: string): BlockNode => wrap(fx.store, blockId) as unknown as BlockNode;
  const linksOf = (blockId: string): Link[] => (blockOf(blockId).links as unknown as Link[] | undefined) ?? [];
  const linkIdsOf = (blockId: string): string[] => linksOf(blockId).map((l) => (l as unknown as { id: string }).id);
  /** Links `fromId` to `toId` with a wikilink `Link` appended to its existing ones; returns the new Link's id. */
  const linkTo = (fromId: string, toId: string): string => {
    const linkId = blockOf(fromId).mintWikilink(toId, [0]);
    blockOf(fromId).links = [...linkIdsOf(fromId), linkId] as unknown as ApeironNode[];
    return linkId;
  };
  const tombstoned = (title: string): string => {
    const id = `BlockNode:${generateNodeId()}`;
    const node = createNode(fx.store, id, { under: demo.linkBlockId }) as unknown as BlockNode; // made in the graph of the block, attached to nothing
    node.type = 'heading'; node.title = title; node.children = [];
    return id;
  };

  before(() => {
    fx = makeFixtureStore('gc_demo');
    demo = ingestLinkedDemo(fx); // the link paragraph carries two wikilinks
  });
  after(() => fx.cleanup());

  test('10: mark and sweep collects a cyclic dead cluster but spares a referenced tombstone', () => {
    // Dropping a tombstoned node once it has zero incoming references fails on a cycle, as refcounting does: two
    // tombstoned nodes pointing only at each other would each show a nonzero count forever. Mark and sweep from
    // the live roots does not. Built directly against the store, unattached to any tree.
    const deadAId = tombstoned('Dead A');
    const deadBId = tombstoned('Dead B');
    linkTo(deadAId, deadBId);
    linkTo(deadBId, deadAId);
    const now = new Date().toISOString();
    blockOf(deadAId).tombstonedAt = now;
    blockOf(deadBId).tombstonedAt = now;

    // A third tombstone kept by a link from a live block must survive the same pass, which shows the pass is not
    // deleting every tombstone unconditionally.
    keptDeadId = tombstoned('Kept Dead');
    blockOf(keptDeadId).tombstonedAt = now;
    keptDeadLinkId = linkTo(demo.linkBlockId, keptDeadId);

    const { pruned } = pruneUnreachableTombstones(fx.store);
    assert.equal(nodeExists(fx.store, deadAId), false, `the dead cluster member ${deadAId} is pruned`);
    assert.equal(nodeExists(fx.store, deadBId), false, `the dead cluster member ${deadBId} is pruned`);
    assert.ok(nodeExists(fx.store, keptDeadId), `'${keptDeadId}' survives: a live block's link still references it`);
    assert.ok(pruned >= 2, `at least 2 nodes pruned (the dead cluster), got ${pruned}`);
  });

  test('11: dropping the only link to a tombstone lets the next pass collect it', () => {
    // Reassigning `.links` without the Link makes the embed diff hard-delete it, which leaves `keptDead` with no
    // live reference.
    blockOf(demo.linkBlockId).links = linkIdsOf(demo.linkBlockId).filter((id) => id !== keptDeadLinkId) as unknown as ApeironNode[];
    const links = linksOf(demo.linkBlockId);
    assert.equal(
      links.some((l) => (l.target as unknown as { id: string } | undefined)?.id === keptDeadId),
      false,
      `no link to ${keptDeadId} remains`,
    );
    assert.equal(links.length, 2, "the block's wikilinks are untouched");
    pruneUnreachableTombstones(fx.store);
    assert.equal(nodeExists(fx.store, keptDeadId), false, `'${keptDeadId}' is collected now that its only reference is gone`);
  });
});
