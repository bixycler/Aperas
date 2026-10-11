// The few-seconds suite to run after every change. It has a budget of 5 s wall at concurrency 2, declared below, and holds the
// cheapest and most central file of each group, each on a tiny store or none. The other files of each group are in `commit`.
import { defineSuite } from '../support/suite.mjs';

export default defineSuite(import.meta.url, [
  '../parse/ast.test.ts',
  '../ingest/chain.test.ts',
  '../folder/folders.test.ts',
  '../store/fixture.test.ts',
  '../store/roundtrip.test.ts',
  '../gc/collection.test.ts',
  '../links/refusals.test.ts',
  '../linking/anchors.test.ts',
], 5);
