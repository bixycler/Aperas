// The differential harness skeleton (planning/core.md, Batch 13, piece 2): `scripts/differential/harness.py` makes two copies of one snapshot (the reference
// unmigrated, the new engine migrated), starts two services apart, runs a list of commands on each and stops its own services by the pid of its own lock.
// Its tests are the Python `unittest` module `scripts/differential/test_harness.py`; each case here runs one class or method of it as a process and fails with
// its output. They cover the assertions that refuse a start (the working service's runtime directory, port and roots, the real graph, anything outside the output
// directory, a side already running), the command line's refusals (nothing written, nothing started), and the run itself on the demo snapshot with two services
// of the new code (no process left, the working service and the snapshot untouched, an unexpected status or a timeout fails the run), and the wait for a service the
// code's own start call gave up on. Only scratch roots are used. The file is in the `differential` suite: it runs Python and starts services.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';

const DIR = resolve(import.meta.dirname, '../../../../../scripts/differential');

function unittest(target: string): Promise<{ status: number; output: string }> {
  return new Promise((done) => {
    execFile('python3', ['-W', 'error', '-m', 'unittest', '-v', `test_harness.${target}`], { cwd: DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 180000, env: { ...process.env, LD_LIBRARY_PATH: undefined } }, (error, stdout, stderr) => {
      const status = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as unknown as { code: number }).code : -1;
      done({ status, output: stdout + stderr });
    });
  });
}

describe('the differential harness', { concurrency: true }, () => {
  for (const [name, target, count] of [
    ['refuses a start whose variables are the working service\'s or the live roots\' (and signals only its own service)', 'Assertions', 12],
    ['refuses a bad command line and writes nothing', 'Cli', 7],
    ['waits out a start call that gave up early until the service is ready, and still fails a service that ends or never gets ready', 'Start', 3],
    ['claims the ports of the live cases, so that no two test processes choose the same one', 'Ports', 2],
    ['runs the demo list on both sides and leaves no process', 'Live.test_the_demo_list_runs_on_both_sides_and_leaves_nothing', 1],
    ['fails the run on an unexpected status and still stops its services', 'Live.test_an_unexpected_status_fails_the_run_and_the_services_are_still_stopped', 1],
    ['kills a command that outlives its timeout and reports it', 'Live.test_a_command_that_outlives_its_timeout_is_killed_and_reported', 1],
  ] as [string, string, number][]) {
    test(name, async () => {
      const r = await unittest(target);
      assert.equal(r.status, 0, r.output);
      assert.match(r.output, new RegExp(`Ran ${count} tests?\\b`), r.output);
      assert.match(r.output, /\nOK\n?$/, r.output);
    });
  }
});
