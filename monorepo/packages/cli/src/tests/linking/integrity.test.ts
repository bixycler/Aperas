// `checkLinkIntegrity`, `checkArtifactLinkIntegrity` and `repairLinkIntegrity` (step 19 of the extended legacy
// suite) on a tiny store: drop one stored link, see exactly that discrepancy, see the scoped check agree while
// inspecting fewer blocks, repair, and see an unrelated citation come out of the repair untouched (the regression
// where a repair reprocessed every link-bearing block of the artifact). The scan of the whole mirror is
// `corpus/link-integrity.test.ts`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackArtifact, ingestArtifact } from '@aperas/core/apeironNgn/artifacts';
import { ingestFolderTree } from '@aperas/core/apeironNgn/folders';
import { findByExactPath } from '@aperas/core/apeironNgn/tree';
import { wrap, type ArtifactNode, type BlockNode } from '@aperas/core/apeironNgn/node';
import { checkLinkIntegrity, checkArtifactLinkIntegrity, owningArtifactId, repairLinkIntegrity } from '@aperas/core/apeironNgn/linkIntegrity';
import { predIri, nodeIri } from '@aperas/core/apeironNgn/vocab';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';
import { findByText, findHeadingByTitle } from '../support/tree.ts';

type LinkView = { id: string; target?: { id: string } };

describe('linking: link integrity', () => {
  let fx: FixtureStore;
  before(() => { fx = makeFixtureStore('integrity_demo'); });
  after(() => fx.cleanup());

  test('19: a dropped link is detected precisely and repaired, and an unrelated link is left alone', () => {
    // A second artifact, so the corpus sweep covers more blocks than the one-artifact scope (as it does on the mirror).
    const otherPath = `${fx.demoDir}/linking-check-bystander.md`;
    writeFileSync(join(fx.artifactsRoot, otherPath), '# Bystander\n\nAn artifact the scoped check does not look at.\n\nAnother paragraph of it.\n', 'utf-8');
    trackArtifact(fx.store, otherPath);
    ingestFolderTree(fx.store);
    ingestArtifact(fx.store, otherPath);
    const initialReport = checkLinkIntegrity(fx.store);

    const path = `${fx.demoDir}/linking-check-integrity.md`;
    writeFileSync(join(fx.artifactsRoot, path), `# Check Link Integrity

## Target <a name='check-link-integrity/target' class='aperas-anchor aperas-tree'></a>

Content for the link-integrity sweep test to cite.

## Citation

A [self-reference](#check-link-integrity/target) back to the target above.

## Other Target <a name='check-link-integrity/other-target' class='aperas-anchor aperas-tree'></a>

Unrelated content that a separate citation below points to.

## Other Citation

An [unrelated reference](#check-link-integrity/other-target) that must survive a repair of the
*other* citation above untouched — same \`Link\` id, same target — since \`repairLinkIntegrity\`
must never reprocess a block the discrepancy report didn't name.
`, 'utf-8');
    trackArtifact(fx.store, path);
    ingestFolderTree(fx.store);
    ingestArtifact(fx.store, path);
    const artifactId = findByExactPath(fx.store, path)!;
    assert.ok(artifactId, `'${path}' is tracked after ingestion`);
    const artifact = wrap(fx.store, artifactId) as unknown as ArtifactNode;
    const target = findHeadingByTitle(artifact, 'Target');
    assert.ok(target, "the 'Target' heading exists");
    // Search for the link's own label only: `.text` stores the raw markdown syntax around it.
    const citing = findByText(artifact, 'self-reference');
    assert.ok(citing, 'the citing paragraph exists');
    const citingLinks = ((wrap(fx.store, citing.id) as unknown as BlockNode).links as unknown as LinkView[]) ?? [];
    const targetLink = citingLinks.find((l) => l.target?.id === target.id);
    assert.ok(targetLink, `the citing paragraph carries a resolved Link targeting ${target.id}: ${JSON.stringify(citingLinks)}`);

    // The unrelated pair, captured before anything is dropped: the repair must never touch this block.
    const otherTarget = findHeadingByTitle(artifact, 'Other Target');
    assert.ok(otherTarget, "the 'Other Target' heading exists");
    const otherCiting = findByText(artifact, 'unrelated reference');
    assert.ok(otherCiting, 'the unrelated citing paragraph exists');
    const otherBefore = (((wrap(fx.store, otherCiting.id) as unknown as BlockNode).links as unknown as LinkView[]) ?? []).find((l) => l.target?.id === otherTarget.id);
    assert.ok(otherBefore, `the unrelated citing paragraph carries a resolved Link targeting ${otherTarget.id}`);
    for (const q of fx.store.match(nodeIri(citing.id), predIri('links'), nodeIri(targetLink!.id), null)) fx.store.delete(q);

    const withDropped = checkLinkIntegrity(fx.store);
    assert.equal(withDropped.discrepancies.length - initialReport.discrepancies.length, 1, 'exactly one new discrepancy after dropping the citing block\'s link');
    const dropped = withDropped.discrepancies.find((d) => d.blockId === citing.id);
    assert.ok(dropped && dropped.missingCodes.length === 1, `the citing block's own discrepancy names exactly one missing code: ${JSON.stringify(dropped)}`);

    const scopedId = owningArtifactId(fx.store, citing.id);
    assert.equal(scopedId, artifactId, 'owningArtifactId walks the block back to its artifact');
    const scoped = checkArtifactLinkIntegrity(fx.store, scopedId!);
    const scopedDisc = scoped.discrepancies.find((d) => d.blockId === citing.id);
    assert.ok(scopedDisc && scopedDisc.missingCodes.length === 1, `the scoped artifact check reports the same dropped code: ${JSON.stringify(scoped.discrepancies)}`);
    assert.ok(scoped.totalLiveBlocks < withDropped.totalLiveBlocks, `the scoped check inspects fewer blocks than the corpus sweep (${scoped.totalLiveBlocks} vs ${withDropped.totalLiveBlocks}): it is actually scoped`);

    const repair = repairLinkIntegrity(fx.store, withDropped);
    assert.equal(repair.reportAfter.discrepancies.length, initialReport.discrepancies.length, 'repairLinkIntegrity restores the discrepancy count to baseline');
    const restored = (((wrap(fx.store, citing.id) as unknown as BlockNode).links as unknown as Array<{ target?: { id: string } }>) ?? []);
    assert.ok(restored.some((l) => l.target?.id === target.id), "repairLinkIntegrity re-resolves the citing block's link back onto the target");

    // The regression check: the unrelated block the report never named comes out untouched.
    const otherAfter = (((wrap(fx.store, otherCiting.id) as unknown as BlockNode).links as unknown as LinkView[]) ?? []).find((l) => l.target?.id === otherTarget.id);
    assert.ok(otherAfter, "the repair leaves the unrelated citing paragraph's Link in place");
    assert.equal(otherAfter!.id, otherBefore!.id, 'the unrelated Link keeps its id (not reminted)');
    // new: the sweep after the repair names no discrepancy of the unrelated block
    assert.ok(!repair.reportAfter.discrepancies.some((d) => d.blockId === otherCiting.id), 'the unrelated block has no discrepancy after the repair');
  });
});
