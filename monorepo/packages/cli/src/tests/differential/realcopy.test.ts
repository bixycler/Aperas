// What piece 5 of Batch 13 added for the run on a copy of the real mirror (planning/core.md, Batch 13): `scripts/differential/overlay.py` lays the `cmd_demo` corpus over a copy of the
// real graph root, `cases.py` finds the corpus's own thread whatever the artifact is called, the comparer gives a side's label only to a token the side's dump defines (and maps a token
// written in lower case in a slug), and the harness waits for a service to answer a ping after a start or a restart. Its tests are the Python `unittest` module
// `scripts/differential/test_realcopy.py`; each case here runs one class of it as a process and fails with its output. They start no service. The file is in the `differential` suite.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';

const DIR = resolve(import.meta.dirname, '../../../../../scripts/differential');

function unittest(target: string): Promise<{ status: number; output: string }> {
  return new Promise((done) => {
    execFile('python3', ['-W', 'error', '-m', 'unittest', '-v', `test_realcopy.${target}`], { cwd: DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000, env: { ...process.env, LD_LIBRARY_PATH: undefined } }, (error, stdout, stderr) => {
      const status = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as unknown as { code: number }).code : -1;
      done({ status, output: stdout + stderr });
    });
  });
}

describe('the differential run on a copy of the real mirror', { concurrency: true }, () => {
  for (const [name, target, count] of [
    ['lays the corpus over a copy of a real graph root and reads the real directory only', 'Overlay', 6],
    ['finds the corpus\'s own thread on the small snapshot and on the overlaid one', 'Thread', 2],
    ['labels only the tokens a side defines and maps a token written in lower case in a slug', 'Labels', 3],
    ['waits for a service to answer a ping after a start or a restart and after nothing else', 'Settle', 4],
  ] as [string, string, number][]) {
    test(name, async () => {
      const r = await unittest(target);
      assert.equal(r.status, 0, r.output);
      assert.match(r.output, new RegExp(`Ran ${count} tests?\\b`), r.output);
      assert.match(r.output, /\nOK\n?$/, r.output);
    });
  }
});
