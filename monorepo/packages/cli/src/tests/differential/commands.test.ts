// The script of commands on the small corpus (planning/core.md, Batch 13, piece 4): `scripts/differential/corpus.py` builds the snapshot with a service of its own, `cases.py` writes the
// three lists of commands from it, `explain.py` holds the rules that account for each deliberate difference in a command's output or a service's log, and `cmdrun.py` runs the lists
// on both sides, compares and prints the table of the 31 entries of Layer 4. Its tests are the Python `unittest` modules `scripts/differential/test_steps.py` (what piece 4 added to
// the harness: edits of files, waits, captures, the expected hang), `test_explain.py` (the rules, the logs, the differences of a dump a command makes, and 47 mutations of the rules and of the comparer's matcher for entry 31
// that each fail the module) and `test_cases.py` (the corpus and the lists: their shape, the ids they name, the 19 verbs, the entries each case aims at); each case here runs one
// class or one method of them as a process and fails with its output. The file is in the `differential` suite: it runs Python and starts services.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';

const DIR = resolve(import.meta.dirname, '../../../../../scripts/differential');

function unittest(target: string): Promise<{ status: number; output: string }> {
  return new Promise((done) => {
    execFile('python3', ['-W', 'error', '-m', 'unittest', '-v', target], { cwd: DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 180000, env: { ...process.env, LD_LIBRARY_PATH: undefined } }, (error, stdout, stderr) => {
      const status = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as unknown as { code: number }).code : -1;
      done({ status, output: stdout + stderr });
    });
  });
}

describe('the script of commands', { concurrency: true }, () => {
  for (const [name, target, count] of [
    ['edits the files of both sides, waits, and reads the object form of a list', 'test_steps.Steps', 6],
    ['runs a step of files, a wait, a capture, the expected statuses and a hang on both sides and leaves no process', 'test_steps.StepsLive.test_steps_of_files_and_waits_a_capture_expected_statuses_and_a_hang_leave_no_problem', 1],
    ['fails the run on a hang that was not expected and on a command that follows a hang', 'test_steps.StepsLive.test_a_hang_that_was_not_expected_and_a_command_that_follows_a_hang_are_problems', 1],
    ['explains each deliberate difference of an output with its own entry and leaves a plain difference alone', 'test_explain.Rules', 27],
    ['accounts for each line of a service\'s log by the entries it shows and finds the line no rule knows', 'test_explain.Logs', 2],
    ['explains the differences of a dump that a command makes and offers the commands and the logs to the comparer', 'test_explain.Dumps test_explain.Compare', 12],
    ['fails on a copy of the rules with any one of 47 mutations', 'test_explain.Mutations', 1],
    ['builds the corpus with a service and the three lists from it, and every entry of Layer 4 is aimed at or named unreachable', 'test_cases', 6],
  ] as [string, string, number][]) {
    test(name, async () => {
      const r = await unittest(target.split(' ')[0]).then(async (first) => {
        if (target.split(' ').length === 1) return first;
        const rest = await Promise.all(target.split(' ').slice(1).map(unittest));
        return { status: [first, ...rest].every((x) => x.status === 0) ? 0 : 1, output: [first, ...rest].map((x) => x.output).join('\n') };
      });
      assert.equal(r.status, 0, r.output);
      if (target.split(' ').length === 1) {
        assert.match(r.output, new RegExp(`Ran ${count} tests?\\b`), r.output);
        assert.match(r.output, /\nOK\n?$/, r.output);
      } else {
        const ran = [...r.output.matchAll(/Ran (\d+) tests?\b/g)].reduce((n, m) => n + Number(m[1]), 0);
        assert.equal(ran, count, r.output);
      }
    });
  }
});
