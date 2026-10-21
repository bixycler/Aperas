// `kg:backlinks` (step 12 of the legacy suite), the reverse of unfold's forward view, on a store with two
// hand-built blocks: a target and a paragraph that references it. Independent of every other case.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createNode, type BlockNode, type ApeironNode } from '@aperas/core/shell/node';
import { generateNodeId } from '@aperas/core/snowflake';
import { runBacklinks } from '../../kgBacklinks';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';

describe('backlinks', () => {
  let fx: FixtureStore;
  before(() => { fx = makeFixtureStore('backlinks_demo'); });
  after(() => fx.cleanup());

  test('12: a block that references a target is reported as its one backlink, with text on request', () => {
    // A block is made in the graph of the node it is built under: an artifact is made first (its graph is the rule of its path), and the two blocks under it.
    const hostId = `ArtifactNode:${generateNodeId()}`;
    createNode(fx.store, hostId, { path: 'backlinks_demo/host.md' });
    const targetId = `BlockNode:${generateNodeId()}`;
    const target = createNode(fx.store, targetId, { under: hostId }) as unknown as BlockNode;
    target.type = 'heading'; target.title = 'Backlink Target'; target.children = [];
    const referrerId = `BlockNode:${generateNodeId()}`;
    const referrer = createNode(fx.store, referrerId, { under: hostId }) as unknown as BlockNode;
    referrer.type = 'paragraph'; referrer.title = 'Referrer Para'; referrer.text = 'See the target above.'; referrer.children = [];
    referrer.links = [referrer.mintWikilink(targetId, [0])] as unknown as ApeironNode[];

    const results = runBacklinks(fx.store, targetId, false);
    assert.equal(results.length, 1, `exactly 1 backlink to ${targetId}`);
    const [bl] = results;
    assert.ok(bl.linkId.startsWith(`${referrerId}:links:Link:`), `the linkId is prefixed by its owner ${referrerId}, got '${bl.linkId}'`);
    assert.equal(bl.label, 'paragraph');
    assert.equal(bl.title, 'Referrer Para');
    assert.equal(bl.text, undefined, "no 'text' field without --text");
    const withText = runBacklinks(fx.store, targetId, true);
    assert.equal(withText[0].text, 'See the target above.', "--text includes the referrer's own abstract");
  });
});
