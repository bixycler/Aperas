// What the differential harness does about the timing of a service (planning/core.md, Batch 13, piece 5): a command whose answer on a side is exactly the client's refusal to send
// (`No ApeironNgn service running` while the side's service is alive: the service was busy for a moment, and the command did not run) is made again, up to 3 times after a wait for a ping,
// and every retry is recorded in `results.json`; the edits of files that must follow a command by milliseconds (`then_fs`) are applied to a side right after its command; the new side's
// scratch `aperas.config.json` can hold a long flush interval for the content graph (`--content-flush-ms`), the reference keeping its timer. Its tests are the Python `unittest` module
// `scripts/differential/test_timing.py`, which starts no service (the live case is in `test_steps.py`); each case here runs one class of it as a process and fails with its output.
// The file is in the `differential` suite.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';

const DIR = resolve(import.meta.dirname, '../../../../../scripts/differential');

function unittest(target: string): Promise<{ status: number; output: string }> {
  return new Promise((done) => {
    execFile('python3', ['-W', 'error', '-m', 'unittest', '-v', `test_timing.${target}`], { cwd: DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000, env: { ...process.env, LD_LIBRARY_PATH: undefined } }, (error, stdout, stderr) => {
      const status = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as unknown as { code: number }).code : -1;
      done({ status, output: stdout + stderr });
    });
  });
}

describe('the harness and the timing of a service', { concurrency: true }, () => {
  for (const [name, target, count] of [
    ['makes a command again when the client refused to send it, within a bound, records the retry, and applies the edits of then_fs right after the last call', 'Retry', 6],
    ['writes the long flush interval into the new side\'s scratch config only, and refuses a bad then_fs and a bad interval', 'Config', 4],
  ] as [string, string, number][]) {
    test(name, async () => {
      const r = await unittest(target);
      assert.equal(r.status, 0, r.output);
      assert.match(r.output, new RegExp(`Ran ${count} tests?\\b`), r.output);
      assert.match(r.output, /\nOK\n?$/, r.output);
    });
  }
});
