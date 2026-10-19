// Run on demand: everything in `commit`, then the corpus checks. The corpus checks run on a copy of the real
// mirror (`makeCorpusCopy()`), each at real size in its own process, and take from seconds to minutes; they are
// not part of `commit`. The helper's own test comes first, so a broken copy fails before the long files start.
// It declares no budget, so the reporter never warns, and its per-file timeout default is 900 s.
import { defineSuite } from '../support/suite.mjs';

export default defineSuite(import.meta.url, [
  './commit.suite.mjs',
  '../corpus/copy.test.ts',
  '../corpus/dangling-unfolds.test.ts',
  '../corpus/link-integrity.test.ts',
  '../corpus/roundtrip.test.ts',
  '../corpus/mirror.test.ts',
  '../corpus/lookups.test.ts',
]);
