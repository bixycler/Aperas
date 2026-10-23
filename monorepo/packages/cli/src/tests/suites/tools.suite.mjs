// Run when the runner (`run.mjs`), `support/suite.mjs`, `support/reporter.mjs`, a suite file or `scripts/` changes: the runner's own test,
// whose cases start the runner as a process, and the rehearsal of the cutover (`scripts/cutover-rehearsal.py`). The tests of the differential
// run (`scripts/differential/`) are in the `differential` suite. It has a budget of 30 s wall at concurrency 2, declared below.
import { defineSuite } from '../support/suite.mjs';

export default defineSuite(import.meta.url, [
  '../runner/runner.test.ts',
  '../rehearsal/cutoverRehearsal.test.ts',
], 30);
