// Tree view state against tombstones and deleted links (steps 8, 9 and 9b of the legacy suite): a tombstoned
// target is hidden from the rendered tree unless asked for, deleting an unfolded Link sweeps it out of the
// view's `unfolds`, and `unfold` refuses a ref that never existed while the engine drops an entry with its target
// when the sweep deletes a tombstone. The cases share the store, the view and the paragraph that carries the links, and run in order.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { wrap, createNode, ensureDefaultView, sweepTombstones, type ArtifactNode, type BlockNode, type Link, type TreeView, type ApeironNode } from '@aperas/core/shell/node';
import { generateNodeId } from '@aperas/core/snowflake';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';
import { ingestLinkedDemo, type LinkedDemo } from '../support/linkedDemo.ts';

type Ref = Array<{ id: string }>;

describe('tree view state', () => {
  let fx: FixtureStore;
  let demo: LinkedDemo;
  let view: TreeView;
  const unfoldIds = (): string[] => (((wrap(fx.store, view.id) as unknown as TreeView).unfolds as unknown as Ref | undefined) ?? []).map((n) => n.id);
  const dedupBlock = (): BlockNode => wrap(fx.store, demo.dedupBlockId) as unknown as BlockNode;
  const linkIdsOf = (block: BlockNode): string[] => ((block.links as unknown as Link[] | undefined) ?? []).map((l) => (l as unknown as { id: string }).id);

  before(() => {
    fx = makeFixtureStore('views_demo');
    demo = ingestLinkedDemo(fx);
  });
  after(() => fx.cleanup());

  test('8: a tombstoned link target is hidden from the tree by default and marked when shown', () => {
    // Tombstoning clears a dead node's own children, links and props but never other documents' references to
    // it, so the render has to hide it (and tag it once `showTombstoned` opts back in). Built directly against
    // the store: a standalone victim node plus a wikilink to it from an already-ingested block.
    const victimId = `BlockNode:${generateNodeId()}`;
    const victim = createNode(fx.store, victimId, { under: demo.demoId }) as unknown as BlockNode; // made in the graph of the demo artifact, attached to nothing
    victim.type = 'heading';
    victim.title = 'A Node That Will Be Tombstoned';
    victim.children = [];
    victim.tombstonedAt = new Date().toISOString();

    const block = dedupBlock();
    const victimLinkId = block.mintWikilink(victimId, [0]);
    block.links = [...linkIdsOf(block), victimLinkId] as unknown as ApeironNode[];

    view = ensureDefaultView(fx.store);
    view.unfold(demo.dedupBlockId); // makes this block's own .links visible in the view render
    const artifact = () => wrap(fx.store, demo.demoId) as unknown as ArtifactNode;
    const defaultLines = artifact().renderTree({ view });
    assert.equal(defaultLines.some((l) => l.includes(victimId)), false, `the tombstoned target ${victimId} is hidden by default`);
    const shownLines = artifact().renderTree({ view, showTombstoned: true });
    const tombstonedLine = shownLines.find((l) => l.includes(victimId));
    assert.ok(tombstonedLine, `a rendered line for the tombstoned target ${victimId} with showTombstoned`);
    assert.ok(tombstonedLine.includes('(tombstoned)'), `that line is tagged '(tombstoned)': ${JSON.stringify(tombstonedLine)}`);
    assert.ok(tombstonedLine.includes(`${victimLinkId}  [Link]  → ${victimId}`), `a Link line names its target and no predicate: ${JSON.stringify(tombstonedLine)}`);
  });

  test('9: deleting an unfolded Link sweeps it out of the view\'s unfolds', () => {
    // A Link has no tombstone of its own: deleting it is a hard delete, and `unfolds` is the only field that can
    // reference a Link directly, so the entry would dangle forever if the delete did not sweep it.
    const block = dedupBlock();
    const scratchLinkId = block.mintWikilink(demo.rootId, [0]);
    const existing = linkIdsOf(block);
    block.links = [...existing, scratchLinkId] as unknown as ApeironNode[];
    view.unfold(scratchLinkId);
    assert.ok(unfoldIds().includes(scratchLinkId), `'${scratchLinkId}' is in unfolds before the deletion`);
    // Reassigning `.links` without it makes the embed diff hard-delete the Link.
    block.links = existing.filter((id) => id !== scratchLinkId) as unknown as ApeironNode[];
    assert.equal(unfoldIds().includes(scratchLinkId), false, `'${scratchLinkId}' is swept out of unfolds once its Link was deleted: ${JSON.stringify(unfoldIds())}`);
  });

  test('9b: unfold refuses a ref that never existed; the sweep that deletes a tombstone drops its unfolds entry and keeps a live one', () => {
    // The removal in 9 fires at the moment a specific node is deleted. `unfold(ref)` itself refuses a ref that does not
    // exist, and an entry whose target is deleted later by the sweep leaves `unfolds` with it (the engine's role `dropWithTarget`).
    const neverExistedId = `BlockNode:${generateNodeId()}`;
    const before = unfoldIds().length;
    view.unfold(neverExistedId); // the write-time guard: a silent no-op, not an add
    const afterGuard = unfoldIds();
    assert.equal(afterGuard.includes(neverExistedId), false, `unfold() refuses a ref with no quads at all ('${neverExistedId}')`);
    assert.equal(afterGuard.length, before, 'the write-time guard is a no-op: the count does not change');
    // A tombstone nothing reaches, unfolded: a tombstoned target is a legitimate entry until the sweep deletes it.
    const doomedId = `BlockNode:${generateNodeId()}`;
    const doomed = createNode(fx.store, doomedId, { under: demo.demoId }) as unknown as BlockNode; // made in the graph of the demo artifact, attached to nothing
    doomed.type = 'heading';
    doomed.title = 'Doomed';
    doomed.children = [];
    doomed.tombstonedAt = new Date().toISOString();
    view.unfold(doomedId);
    assert.ok(unfoldIds().includes(doomedId), 'a tombstoned target can be unfolded');
    const { pruned } = sweepTombstones(fx.store);
    const afterSweep = unfoldIds();
    assert.ok(pruned >= 1, `the sweep deleted the tombstone (${pruned})`);
    assert.equal(afterSweep.includes(doomedId), false, 'the entry left with its target');
    assert.ok(afterSweep.includes(demo.dedupBlockId), `a genuinely live entry (${demo.dedupBlockId}) is left alone`);
  });
});
