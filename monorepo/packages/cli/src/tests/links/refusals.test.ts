// The link-refusal chain (steps 5g and 13 of the legacy suite): refusals on write, set-aside on ingest,
// the stored bad-target report of `check-links`, then the single-anchor rendering of the preview. The
// cases share one store and run in order (13 needs the target that 5g writes), so the file is the unit.
// The check functions are kept in `verifyLinkRefusals.ts`, which is also runnable on its own.
import { describe, test, before, after } from 'node:test';
import { checkLinkRefusals, checkSingleAnchorRendering } from '../../verifyLinkRefusals.ts';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';

describe('link refusals', () => {
  let fx: FixtureStore;
  let citedId = '';
  before(() => { fx = makeFixtureStore('link_demo'); });
  after(() => fx.cleanup());

  test('5g: refusals, set-aside on ingest, check-links bad targets', () => {
    citedId = checkLinkRefusals(fx.store, fx.demoDir);
  });

  test('13: the preview renders an anchored link with its single anchor', () => {
    checkSingleAnchorRendering(fx.store, fx.demoDir, citedId);
  });
});
