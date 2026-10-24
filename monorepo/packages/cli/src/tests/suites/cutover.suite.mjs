// Run when `scripts/cutover-rehearsal.py`, `scripts/cutover-smoke.sh`, a service start or the migration scripts change: the rehearsal of the cutover on a scratch copy (`scripts/cutover-rehearsal.py`)
// and the smoke list of the cutover (`scripts/cutover-smoke.sh`), whose cases run those scripts and start services of their own in scratch directories, so none runs in `commit`.
// It has a budget of 40 s wall at concurrency 2, declared below.
import { defineSuite } from '../support/suite.mjs';

export default defineSuite(import.meta.url, [
  '../rehearsal/cutoverRehearsal.test.ts',
  '../smoke/cutoverSmoke.test.ts',
], 40);
