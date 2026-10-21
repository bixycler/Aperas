// The anchor chain of the linking slice (steps 13, 15, 16, 17 and 18 of the extended legacy suite), on one
// artifact (`linking-a.md`) in a tiny store: anchor emission and its idempotency across a real write-back and
// re-ingest, three link forms that dedupe onto one target, the anchor-matching gate, the aperas-tree cleanup
// pass, and the collision refusal and list adoption that `kg:insert` and `kg:update` apply to the same blocks.
// The cases share one store, the artifact file and the blocks found along the way, and run in order, so the
// file is the unit: a single case cannot run alone. (Step 14, the collision refusal at ingestion, is
// independent and lives in `collisions.test.ts`.)
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HEADING_TREE_ANCHOR_PROP } from '@aperas/core/astParser';
import { getProp, getProps } from '@aperas/core/props';
import { trackArtifact, ingestArtifact } from '@aperas/core/shell/artifacts';
import { findByExactPath } from '@aperas/core/shell/tree';
import { wrap, type ArtifactNode, type BlockNode, type Link } from '@aperas/core/shell/node';
import { runBacklinks } from '../../kgBacklinks';
import { runInsert } from '../../kgInsert';
import { runUpdate } from '../../kgUpdate';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';
import { findByText, findHeadingByTitle } from '../support/tree.ts';

describe('linking: anchors chain', () => {
  let fx: FixtureStore;
  let aPath = '';
  let bPath = '';
  let untrackedPath = '';
  let aId = '';
  // State carried from case to case.
  let h1Block: any;
  let h2Block: any;
  let termItem: any;
  let unanchoredHeading: any;
  const artifactA = (): ArtifactNode => wrap(fx.store, aId) as unknown as ArtifactNode;
  const write = (path: string, text: string): void => writeFileSync(join(fx.artifactsRoot, path), text, 'utf-8');
  const collisionOf = (fn: () => unknown): Error | undefined => {
    try { fn(); } catch (e) { return e as Error; }
    return undefined;
  };

  before(() => {
    fx = makeFixtureStore('linking_demo');
    aPath = `${fx.demoDir}/linking-a.md`;
    bPath = `${fx.demoDir}/linking-b.md`;
    untrackedPath = `${fx.demoDir}/linking-untracked-referrer.md`;
  });
  after(() => fx.cleanup());

  test('13: anchor emission end to end', () => {
    write(aPath, `# H1 Heading <a name='h1-heading' class='aperas-anchor aperas-tree'></a>

Genuine leading prose for H1 that must stay as text, unaffected by the trailing anchor.

## H2 With Anchor <a name='h1-heading/h2-with-anchor' class='aperas-anchor aperas-tree'></a>

Leading prose for H2, also must stay unaffected.

- Term: a list item lead-in with no anchor yet.

## Unanchored Heading

No anchor tag on this one at all.
`);
    trackArtifact(fx.store, aPath);
    ingestArtifact(fx.store, aPath);
    aId = findByExactPath(fx.store, aPath)!;
    assert.ok(aId, `'${aPath}' is tracked after ingestion`);

    h1Block = findHeadingByTitle(artifactA(), 'H1 Heading');
    assert.ok(h1Block, "heading 'H1 Heading' exists");
    // `title` keeps the heading's own `#` marker(s) (the raw line, anchor-stripped); only the trailing anchor tag is cleaned out.
    assert.equal(h1Block.title, '# H1 Heading', "H1's title is clean of its anchor (marker included)");
    assert.equal(h1Block.text, 'Genuine leading prose for H1 that must stay as text, unaffected by the trailing anchor.', "H1's leading prose survives as its own text");
    assert.equal(getProp(h1Block, HEADING_TREE_ANCHOR_PROP), `<a name='h1-heading' class='aperas-anchor aperas-tree'></a>`, "H1's tree-anchor survives in its 'treeAnchor' prop");
    const h1FirstLine = (h1Block as BlockNode).toMarkdown()!.split('\n')[0];
    assert.equal(h1FirstLine, `# H1 Heading <a name='h1-heading' class='aperas-anchor aperas-tree'></a><a name='id/${h1Block.id}' class='aperas-anchor aperas-id'></a>`, "H1's projected line re-emits its tree-anchor then a fresh id-anchor");

    h2Block = findHeadingByTitle(artifactA(), 'H2 With Anchor');
    assert.ok(h2Block, "heading 'H2 With Anchor' exists");
    assert.equal(h2Block.text, 'Leading prose for H2, also must stay unaffected.', "H2's leading prose survives untouched");
    assert.equal(getProp(h2Block, HEADING_TREE_ANCHOR_PROP), `<a name='h1-heading/h2-with-anchor' class='aperas-anchor aperas-tree'></a>`, "H2's tree-anchor survives");

    termItem = findByText(artifactA(), 'a list item lead-in with no anchor yet.');
    assert.ok(termItem, "the 'Term' list item exists");
    const idAnchorMarker = `name='id/${termItem.id}'`;
    assert.ok(!(termItem.text as string).includes(idAnchorMarker), "the list item's stored text has no id-anchor before projection");
    // A bare listItem has no `serializeBlock` case of its own: the splice is only visible by projecting the parent H2.
    const h2ProjectedOnce = (h2Block as BlockNode).toMarkdown()!;
    assert.equal(h2ProjectedOnce.split(idAnchorMarker).length - 1, 1, 'exactly one id-anchor is spliced into the list item');
    assert.ok(h2ProjectedOnce.includes(`- Term: <a name='id/${termItem.id}'`), `the id-anchor is spliced in right after the lead-in colon: ${h2ProjectedOnce}`);

    // Idempotency across a real re-ingestion cycle: project the whole artifact back to disk, re-track and re-ingest.
    write(aPath, artifactA().toMarkdown()!);
    trackArtifact(fx.store, aPath);
    ingestArtifact(fx.store, aPath);
    const termAfter = findByText(artifactA(), 'a list item lead-in with no anchor yet.');
    assert.ok(termAfter, "the 'Term' list item still exists after re-ingesting the projected artifact");
    assert.equal(termAfter.id, termItem.id, 'the list item reconcile-matches (same id) across the projected round trip');
    const h2After = findHeadingByTitle(artifactA(), 'H2 With Anchor')!;
    assert.equal((h2After as BlockNode).toMarkdown()!.split(idAnchorMarker).length - 1, 1, 're-projecting an already-anchored list item does not duplicate its id-anchor');

    unanchoredHeading = findHeadingByTitle(artifactA(), 'Unanchored Heading');
    assert.ok(unanchoredHeading, "'Unanchored Heading' exists");

    const h2Id = h2Block.id as string;
    write(bPath, `# Cross-File Referrer

Three forms, one target: [bracket](<[[${h2Id}]]>), [aperas](aperas://id/${h2Id}), and [rel](linking-a.md#id/${h2Id}).

# Anchor Gate Referrer

Should not resolve: [nope](linking-a.md#h1-heading/unanchored-heading).
`);
    trackArtifact(fx.store, bPath);
    const bResult = ingestArtifact(fx.store, bPath);
    assert.ok(bResult, `'${bPath}' actually ingests`);
    assert.equal(bResult!.linkResolution.resolved, 3, 'all 3 link forms ([[Kind:snowflake]], aperas://id/<ID>, ../file#id/<ID>) resolve');
    const bId = findByExactPath(fx.store, bPath)!;
    const bArtifact = wrap(fx.store, bId) as unknown as ArtifactNode;
    const referrer = findHeadingByTitle(bArtifact, 'Cross-File Referrer');
    const referrerLinks = (referrer.links as unknown as Link[] | undefined) ?? [];
    assert.equal(referrerLinks.length, 1, 'the 3 equivalent link forms dedupe onto exactly 1 target (same block)');
    assert.equal((referrerLinks[0].target as unknown as { id: string } | undefined)?.id, h2Id, "the deduped link's target is H2");
    assert.equal(getProps(referrerLinks[0] as unknown as { props?: any[] }, 'position').length, 3, 'one occurrence position per link form is folded onto the one deduped Link');

    const gateReferrer = findHeadingByTitle(bArtifact, 'Anchor Gate Referrer');
    const gateLinks = (gateReferrer.links as unknown as Link[] | undefined) ?? [];
    assert.ok(!gateLinks.some((l) => (l.target as unknown as { id: string } | undefined)?.id === unanchoredHeading.id),
      "a #fragment link matching an unanchored heading's title-derived slug is rejected by the anchor-matching gate");
  });

  test('15: the aperas-tree cleanup pass, and the blindness of backlinks to an untracked file', () => {
    const cleanupPath = `${fx.demoDir}/linking-cleanup.md`;
    write(cleanupPath, `# Cleanup Target <a name='cleanup-target' class='aperas-anchor aperas-tree'></a>

Some content that should survive untouched.
`);
    trackArtifact(fx.store, cleanupPath);
    ingestArtifact(fx.store, cleanupPath);
    const cleanupId = findByExactPath(fx.store, cleanupPath)!;
    assert.ok(cleanupId, `'${cleanupPath}' is tracked after ingestion`);
    const before = findHeadingByTitle(wrap(fx.store, cleanupId), 'Cleanup Target');
    assert.ok(before && getProp(before, HEADING_TREE_ANCHOR_PROP) !== undefined, "'Cleanup Target' carries a treeAnchor prop before cleanup");

    // The cleanup pass: delete the aperas-tree anchor tag straight out of the source text.
    write(cleanupPath, `# Cleanup Target

Some content that should survive untouched.
`);
    trackArtifact(fx.store, cleanupPath);
    ingestArtifact(fx.store, cleanupPath);
    const after = findHeadingByTitle(wrap(fx.store, cleanupId), 'Cleanup Target');
    assert.ok(after, "'Cleanup Target' still exists after its anchor was stripped");
    assert.equal(after.id, before.id, 'the same block identity (matched, not re-minted) after stripping its anchor');
    assert.equal(getProp(after, HEADING_TREE_ANCHOR_PROP), undefined, 'the treeAnchor prop is gone after the anchor was removed from the source text');
    assert.equal(after.text, 'Some content that should survive untouched.', "the block's own text is unaffected by the anchor's removal");

    // kg:backlinks only queries the graph, so an on-disk reference that was never tracked is invisible to it.
    write(untrackedPath, `# Untracked Referrer

Old-style reference, never ingested: [old](linking-a.md#h1-heading).
`);
    assert.equal(runBacklinks(fx.store, h1Block.id as string, false).length, 0, 'kg:backlinks reports zero referrers for H1 (the untracked file was never ingested)');
    // (the old step read the file back from disk to show a full-text search would find the reference)
    assert.ok(readBack(fx, untrackedPath).includes('#h1-heading'), "the untracked file's own content still holds the old-style reference");
  });

  test('16: kg:insert rejects a heading colliding with an existing sibling', () => {
    const err = collisionOf(() => runInsert(fx.store, { path: `aperas://id/${h1Block.id}`, markdown: '## H2 With Anchor\n\nA new heading colliding with an existing sibling.\n' }));
    assert.ok(err, 'kg:insert rejects a newly-created heading colliding with an existing sibling');
    assert.match(err!.message, /collision/i, 'the error names the collision');
    const ok = runInsert(fx.store, { path: `aperas://id/${h1Block.id}`, markdown: '## A Genuinely New Heading\n\nNo collision here.\n' });
    assert.equal(ok.lines.length, 1, `a genuinely unique new heading is inserted, not a false positive: ${JSON.stringify(ok.lines)}`);
  });

  test("17: kg:update rejects renaming a heading to collide with an existing sibling", () => {
    const err = collisionOf(() => runUpdate(fx.store, { path: `aperas://id/${unanchoredHeading.id}`, markdown: '## H2 With Anchor\n\nRenamed to collide with an existing sibling.\n', textOnly: false }));
    assert.ok(err, 'kg:update rejects renaming a heading to collide with an existing sibling');
    assert.match(err!.message, /collision/i, 'the error names the collision');
  });

  test('18: kg:update keeps a list adopted onto its own leading paragraph', () => {
    // A real bug: adoption is not gated to heading/listItem containers, but the plain-paragraph branch only read firstChild.text.
    const result = runUpdate(fx.store, {
      path: `aperas://id/${termItem.id}`,
      markdown: 'Some replacement paragraph text.\n\n- Sub item one\n- Sub item two\n',
      textOnly: false,
    });
    assert.equal(result.added, 2, "the adopted list's 2 items survive as overflow children");
    const children = (wrap(fx.store, termItem.id) as unknown as BlockNode).children as unknown as BlockNode[] | undefined;
    assert.equal((children ?? []).length, 2, 'the target ends up with 2 real children');
  });
});

function readBack(fx: FixtureStore, path: string): string {
  return readFileSync(join(fx.artifactsRoot, path), 'utf-8');
}
