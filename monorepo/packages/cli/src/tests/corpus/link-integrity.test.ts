// Corpus check: the link-integrity scan of the whole mirror (`checkLinkIntegrity`, what `aperas check-links`
// runs, and the scan at the start of step 19 of the extended legacy suite) at the real mirror's size.
// It runs on a COPY of `AperasKG/Apeiron/` (`makeCorpusCopy()`), the mirror as it is on disk, which lags the
// service's memory by up to its flush interval. The real mirror is only read. The tiny-store version of the
// drop-and-repair part is `linking/integrity.test.ts`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { checkLinkIntegrity } from '@aperas/core/shell/linkIntegrity';
import { allIdsOfKind } from '@aperas/core/shell/dehydrate';
import { makeCorpusCopy, type CorpusCopy } from '../support/corpus.ts';

describe('corpus: link integrity of the whole mirror', () => {
  let copy: CorpusCopy;
  before(() => { copy = makeCorpusCopy(); });
  after(() => copy?.cleanup());

  test('19: the scan of the mirror finds no discrepancy between block text and stored links', () => {
    const report = checkLinkIntegrity(copy.store);
    const shown = report.discrepancies.slice(0, 5).map((d) => `${d.artifactPath}: ${d.blockId} misses ${d.missingCodes.join(', ')}`).join('; ');
    assert.deepEqual(report.discrepancies, [], `${report.discrepancies.length} discrepancies; first: ${shown}`);
    // new: a scan that inspected nothing would pass the check above
    assert.ok(report.totalLiveBlocks > 1000, `the scan covered the mirror's live blocks (${report.totalLiveBlocks})`);
    assert.ok(report.blocksWithLinkText > 0, `some blocks carry internal link text (${report.blocksWithLinkText})`);
    assert.ok(report.totalLiveBlocks <= allIdsOfKind(copy.store, 'BlockNode').length, 'the scan covers no more than the BlockNodes of the store');
  });
});
