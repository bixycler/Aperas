// Run before a commit: `essential` and every other migrated test file that runs on a tiny store.
import { defineSuite } from '../support/suite.mjs';

export default defineSuite(import.meta.url, [
  './essential.suite.mjs',
  '../runner/runner.test.ts',
  '../store/dangling-unfolds.test.ts',
  '../store/storeAccess.test.ts',
  '../store/views.test.ts',
  '../links/backlinks.test.ts',
  '../linking/collisions.test.ts',
  '../linking/integrity.test.ts',
  '../linking/edits.test.ts',
], 60);
