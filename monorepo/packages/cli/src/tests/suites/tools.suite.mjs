// Run when the runner (`run.mjs`), `support/suite.mjs`, `support/reporter.mjs` or a suite file changes: the runner's own test, whose cases start the runner as a process.
// The rehearsal and the smoke list of the cutover are in the `cutover` suite and the tests of the differential run (`scripts/differential/`) are in the `differential` suite.
// It has a budget of 30 s wall at concurrency 2, declared below.
import { defineSuite } from '../support/suite.mjs';

export default defineSuite(import.meta.url, [
  '../runner/runner.test.ts',
], 30);
