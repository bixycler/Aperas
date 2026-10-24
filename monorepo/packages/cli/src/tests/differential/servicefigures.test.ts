// The script of the service-level figures (planning/core.md, Batch 13, piece 7) and the wrapper that puts the sampler on each service of a run of the script of commands. Its tests are the
// Python `unittest` module `scripts/differential/test_service_figures.py`, which starts no service; each case here runs one class of it as a process and fails with its output.
// The file is in the `differential` suite.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';

const DIR = resolve(import.meta.dirname, '../../../../../scripts/differential');

function unittest(target: string): Promise<{ status: number; output: string }> {
  return new Promise((done) => {
    execFile('python3', ['-W', 'error', '-m', 'unittest', '-v', `test_service_figures.${target}`], { cwd: DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000, env: { ...process.env, LD_LIBRARY_PATH: undefined } }, (error, stdout, stderr) => {
      const status = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as unknown as { code: number }).code : -1;
      done({ status, output: stdout + stderr });
    });
  });
}

describe('the figures script and the sampled run', { concurrency: true }, () => {
  for (const [name, target, count] of [
    ['counts, takes the median and the range, counts the non-zero statuses and tabulates a series', 'Figures', 3],
    ['refuses a directory that is not empty, and reads a lock that is missing or not JSON as no lock', 'Refusal', 2],
  ] as [string, string, number][]) {
    test(name, async () => {
      const r = await unittest(target);
      assert.equal(r.status, 0, r.output);
      assert.match(r.output, new RegExp(`Ran ${count} tests?\\b`), r.output);
      assert.match(r.output, /\nOK\n?$/, r.output);
    });
  }
});
