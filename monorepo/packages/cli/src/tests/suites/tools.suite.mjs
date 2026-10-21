// Run when the runner (`run.mjs`), `support/suite.mjs`, `support/reporter.mjs` or a suite file changes: the runner's own test,
// whose cases start the runner as a process. It has a budget of 30 s wall at concurrency 2, declared below.
import { defineSuite } from '../support/suite.mjs';

export default defineSuite(import.meta.url, [
  '../runner/runner.test.ts',
], 30);
