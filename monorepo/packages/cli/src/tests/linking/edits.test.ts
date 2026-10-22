// Three scope regressions of edits on a block next to a resolved link (steps 20, 21 and 22 of the extended
// legacy suite), each on its own artifact in a tiny store: `kg:update --text-only` on a parent must not wipe an
// untouched child's wikilink (20), `aperas retype` keeps identity, links and children across the heading boundary
// and refuses its two bad inputs (21), and an ingest held back by a pending tombstone must not wipe an untouched
// sibling's wikilink (22). The cases are independent and each can run alone.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackArtifact, ingestArtifact } from '@aperas/core/shell/artifacts';
import { ingestFolderTree } from '@aperas/core/shell/folders';
import { wrap, type ArtifactNode, type BlockNode } from '@aperas/core/shell/node';
import { runUpdate } from '../../kgUpdate';
import { runRetype } from '../../kgRetype';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';
import { findByText, findHeadingByTitle } from '../support/tree.ts';

type LinkView = { id: string; target?: { id: string } };

describe('linking: edits next to a resolved link', () => {
  let fx: FixtureStore;
  const linksOf = (id: string): LinkView[] => ((wrap(fx.store, id) as unknown as BlockNode).links as unknown as LinkView[] | undefined) ?? [];
  const ingestNew = (path: string, markdown: string): ArtifactNode => {
    writeFileSync(join(fx.artifactsRoot, path), markdown, 'utf-8');
    trackArtifact(fx.store, path);
    ingestFolderTree(fx.store);
    ingestArtifact(fx.store, path);
    const id = fx.store.maps.liveAtPath(path);
    assert.ok(id, `'${path}' is tracked after ingestion`);
    return wrap(fx.store, id!) as unknown as ArtifactNode;
  };
  before(() => { fx = makeFixtureStore('edits_demo'); });
  after(() => fx.cleanup());

  test("20: kg:update --text-only does not wipe an untouched real child's wikilink", () => {
    const artifact = ingestNew(`${fx.demoDir}/linking-textonly-scope.md`, `# Update Text-Only Scope

## Parent Heading

Parent's own original leading text.

### Child Citation

A [child self-reference](#update-text-only-scope/target) to the target below.

## Target <a name='update-text-only-scope/target' class='aperas-anchor aperas-tree'></a>

Content the child citation points to.
`);
    const parent = findHeadingByTitle(artifact, 'Parent Heading');
    assert.ok(parent, "the 'Parent Heading' heading exists");
    const target = findHeadingByTitle(artifact, 'Target');
    assert.ok(target, "the 'Target' heading exists");
    const child = findByText(artifact, 'child self-reference');
    assert.ok(child, 'the child citing paragraph exists');
    const before = linksOf(child.id).find((l) => l.target?.id === target.id);
    assert.ok(before, `the child citing paragraph carries a resolved Link targeting ${target.id}`);

    // The write under test: `--text-only` on the parent, a bare heading line piped (the "holder promotion" shape that surfaced the bug).
    runUpdate(fx.store, { path: `aperas://id/${parent.id}`, markdown: '## Parent Heading\n', textOnly: true });
    const parentAfter = wrap(fx.store, parent.id) as unknown as BlockNode;
    assert.equal(parentAfter.text, undefined, "the update leaves 'Parent Heading' with no leading text (bare heading line piped)");
    const after = linksOf(child.id).find((l) => l.target?.id === target.id);
    assert.ok(after, "the untouched child's Link to the target stays in place");
    assert.equal(after!.id, before!.id, "the child's Link id survives untouched (not reminted)");
    assert.ok(parentAfter.treeChildren.some((c) => c.id === child.id), "'Child Citation' remains the parent's own child");
  });

  test('21: aperas retype keeps identity, links and children, and refuses its bad inputs', () => {
    const artifact = ingestNew(`${fx.demoDir}/linking-retype-scope.md`, `# Retype Scope

## Target Section <a name='retype-scope/target' class='aperas-anchor aperas-tree'></a>

Content for the retype fixture to cite.

## Convert Me

Body text of the heading about to be converted, citing [the target](#retype-scope/target).

### Nested Child

A child that must stay attached to its parent across the conversion.

## Depth Me

Body of the heading whose depth changes.

- Plain prose with no bold lead-in term at all, so there's nothing to cut back into a heading.
`);
    const retypeTarget = findHeadingByTitle(artifact, 'Target Section');
    const convertMe = findHeadingByTitle(artifact, 'Convert Me');
    const depthMe = findHeadingByTitle(artifact, 'Depth Me');
    const noLeadIn = findByText(artifact, 'Plain prose with no bold lead-in');
    assert.ok(retypeTarget && convertMe && depthMe && noLeadIn, 'all four fixture blocks exist');

    const convertBlock = wrap(fx.store, convertMe.id) as unknown as BlockNode;
    const linkBefore = linksOf(convertMe.id).find((l) => l.target?.id === retypeTarget.id);
    assert.ok(linkBefore, "'Convert Me' carries a resolved Link before the retype");
    const childIdsBefore = convertBlock.treeChildren.map((c) => c.id);
    const originalTitle = convertBlock.title as string;
    const originalText = convertBlock.text as string | undefined;
    assert.ok(childIdsBefore.length > 0, "'Convert Me' has a nested child before the retype");

    // (a) heading -> listItem: the heading's own words fold into `.text` as a lead-in; the new title is the parser's derivation from it.
    const conv = runRetype(fx.store, { path: `aperas://id/${convertMe.id}`, to: 'listItem' });
    const convertAfter = wrap(fx.store, convertMe.id) as unknown as BlockNode;
    const expectedFoldedText = `**Convert Me**: ${originalText}`;
    assert.equal(convertAfter.type, 'listItem', "'Convert Me' becomes a listItem");
    assert.equal(convertAfter.text, expectedFoldedText, "the heading's words are folded into '.text' as a lead-in");
    assert.equal(convertAfter.title, '**Convert Me**', "the title is the parser's own derivation from the folded text");
    assert.ok(!conv.untitled, 'the automatic fold succeeds (untitled is false)');
    assert.equal(conv.toText, expectedFoldedText, 'the result reports the new text');
    const linkAfter = linksOf(convertMe.id).find((l) => l.target?.id === retypeTarget.id);
    assert.ok(linkAfter, `the resolved Link survives the retype; '.links' is ${JSON.stringify(convertAfter.links)}`);
    assert.equal(linkAfter!.id, linkBefore!.id, 'the Link id survives untouched');
    assert.deepEqual(convertAfter.treeChildren.map((c) => c.id), childIdsBefore, 'children stay attached across the retype');

    // (b) listItem -> heading, the reverse: cutting the same canonical lead-in back out reproduces the original title and text.
    const back = runRetype(fx.store, { path: `aperas://id/${convertMe.id}`, to: 'h2' });
    const convertBack = wrap(fx.store, convertMe.id) as unknown as BlockNode;
    assert.equal(convertBack.type, 'heading', "the reverse retype lands back on 'heading'");
    assert.equal(convertBack.title, originalTitle, 'the round trip reproduces the original title');
    assert.equal(convertBack.text, originalText, 'the round trip reproduces the original text');
    assert.ok(!back.untitled, 'the reverse cut succeeds (untitled is false)');
    assert.equal(linksOf(convertMe.id).find((l) => l.target?.id === retypeTarget.id)?.id, linkBefore!.id, 'the Link survives the round trip with its original id');

    // (c) heading depth as an ordinary retype: h2 -> h3, words preserved, text untouched.
    const depth = runRetype(fx.store, { path: `aperas://id/${depthMe.id}`, to: 'h3' });
    const depthAfter = wrap(fx.store, depthMe.id) as unknown as BlockNode;
    assert.equal(depthAfter.type, 'heading', "'Depth Me' stays a heading");
    assert.equal(depthAfter.title, '### Depth Me', 'depth changes to h3 keeping its words');
    assert.equal(depth.toText, undefined, "a depth-only retype never touches '.text'");
    assert.ok(!depth.droppedProps.includes('treeAnchor'), 'a heading -> heading retype does not drop its own treeAnchor prop');

    // (d) non-heading -> heading with nothing to cut: degrades to the id-fallback title and does not touch '.text'.
    const textBefore = (wrap(fx.store, noLeadIn.id) as unknown as BlockNode).text;
    const noCut = runRetype(fx.store, { path: `aperas://id/${noLeadIn.id}`, to: 'h4' });
    const noLeadInAfter = wrap(fx.store, noLeadIn.id) as unknown as BlockNode;
    assert.ok(noCut.untitled, "a conversion with no lead-in to cut reports 'untitled'");
    assert.equal(noLeadInAfter.text, textBefore, "'.text' stays untouched when there is nothing to cut");
    assert.equal(noLeadInAfter.title, `#### ${noLeadInAfter.key}`, 'the id-fallback title');

    // (e) refusals: a no-op conversion, and a bare 'heading' with no depth.
    assert.throws(() => runRetype(fx.store, { path: `aperas://id/${depthMe.id}`, to: 'h3' }), 'retype refuses a no-op conversion');
    assert.throws(() => runRetype(fx.store, { path: `aperas://id/${depthMe.id}`, to: 'heading' }), "retype refuses a bare 'heading' target type without a depth");
  });

  test("22: a tombstone-held-back ingest does not wipe an untouched sibling's wikilink", () => {
    const path = `${fx.demoDir}/linking-ingest-holdback-scope.md`;
    const v1 = `# Ingest Holdback Scope

## Target <a name='ingest-holdback-scope/target' class='aperas-anchor aperas-tree'></a>

Content the citation points to.

## Citing Paragraph

A [citation](#ingest-holdback-scope/target) to the target above, which must survive an ingest that gets held back by an unrelated pending removal.
`;
    const artifact = ingestNew(path, `${v1}
## Removable Section

This section is deleted between v1 and v2, purely to trip reconcile's tombstone-confirmation gate.
`);
    const target = findHeadingByTitle(artifact, 'Target');
    assert.ok(target, "the 'Target' heading exists");
    const citing = findHeadingByTitle(artifact, 'Citing Paragraph');
    assert.ok(citing, "the 'Citing Paragraph' heading exists");
    const before = linksOf(citing.id).find((l) => l.target?.id === target.id);
    assert.ok(before, `'Citing Paragraph' carries a resolved Link to ${target.id}`);

    // v2 removes 'Removable Section': reconcile finds a genuine tombstone candidate, and re-ingesting without `--force` holds
    // the whole body update back pending confirmation, the branch that used to wipe the citing block's untouched Link.
    writeFileSync(join(fx.artifactsRoot, path), v1, 'utf-8');
    trackArtifact(fx.store, path);
    const result = ingestArtifact(fx.store, path);
    assert.ok(result?.pendingConfirmation && result.pendingConfirmation.length > 0, `the second ingest is held back pending confirmation (a genuine tombstone candidate): ${JSON.stringify(result)}`);
    const after = linksOf(citing.id).find((l) => l.target?.id === target.id);
    assert.ok(after, `the held-back ingest leaves the Link in place; '.links' is ${JSON.stringify(wrap(fx.store, citing.id).links)}`);
    assert.equal(after!.id, before!.id, 'the Link id survives the held-back ingest untouched');
  });
});
