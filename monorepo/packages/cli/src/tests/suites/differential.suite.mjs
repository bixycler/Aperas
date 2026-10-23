// Run when `scripts/differential/` or the tests of the differential run change: the harness (`harness.py`), the comparer (`compare.py`) and the script of commands on the small corpus (`corpus.py`,
// `cases.py`, `explain.py`, `cmdrun.py`), whose cases run Python and, for the harness, the steps and the corpus, start services of their own in scratch directories. It has a budget of 40 s wall
// at concurrency 2, declared below.
import { defineSuite } from '../support/suite.mjs';

export default defineSuite(import.meta.url, [
  '../differential/harness.test.ts',
  '../differential/compare.test.ts',
  '../differential/commands.test.ts',
], 40);
