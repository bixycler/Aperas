// The normaliser and the comparer of the differential run (planning/core.md, Batch 13, piece 3): `scripts/differential/compare.py` reads the two dumps the harness
// leaves, migrates the reference's with `migrate-mirror.py`, maps the ids minted by the run by order, masks the timestamps, compares the documents as parsed values
// (sets as sets, `children` as a list) and offers each difference to the table of 31 matchers, one per entry of Layer 4; a difference no entry claims is a finding.
// Its tests are the Python `unittest` module `scripts/differential/test_compare.py`; each case here runs one class of it as a process and fails with its output.
// They start no service: pairs of dumps with one injected difference of each class (a changed literal, a missing child, an id swapped, a timestamp), a minimal pair
// for each entry a dump can show (2, 3, 21, 23, 25) that only that entry claims, near misses that none claims, the table itself, the mapping of ids named only by a
// command's stdout, the migration of the reference's dump, and the command line's exit status. The file is in the `differential` suite: it runs Python.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';

const DIR = resolve(import.meta.dirname, '../../../../../scripts/differential');

function unittest(target: string): Promise<{ status: number; output: string }> {
  return new Promise((done) => {
    execFile('python3', ['-W', 'error', '-m', 'unittest', '-v', `test_compare.${target}`], { cwd: DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000, env: { ...process.env, LD_LIBRARY_PATH: undefined } }, (error, stdout, stderr) => {
      const status = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as unknown as { code: number }).code : -1;
      done({ status, output: stdout + stderr });
    });
  });
}

describe('the differential comparer', { concurrency: true }, () => {
  for (const [name, target, count] of [
    ['compares dumps as parsed values, maps minted ids by order and catches a changed literal, a missing child, an id swapped and a timestamp that is not one', 'Values', 18],
    ['holds one table of 31 entries, five with a matcher and the others saying why a dump cannot show them', 'Table', 3],
    ['lets only its own entry claim a deliberate difference, and none claim a plain one', 'Matchers', 16],
    ['reads the snapshot for the six README documents, the tombstones by artifact and by graph and the unfolds that name a tombstone', 'FactsOfTheSnapshot', 4],
    ['leaves out of the emptied containers the tombstones the snapshot already held', 'EmptiedIds', 2],
    ['maps the ids that only a command\'s stdout names, and masks the times in an output', 'Outputs', 5],
    ['migrates the reference\'s dump with migrate-mirror.py before the comparison', 'Migration', 3],
    ['exits 0, 1 or 2, prints the table and reads a run directory', 'Cli', 4],
  ] as [string, string, number][]) {
    test(name, async () => {
      const r = await unittest(target);
      assert.equal(r.status, 0, r.output);
      assert.match(r.output, new RegExp(`Ran ${count} tests?\\b`), r.output);
      assert.match(r.output, /\nOK\n?$/, r.output);
    });
  }
});
