// The reproduction of "a move of a node after an anchor inside its own subtree is not refused by the working engine, and it loops the service"
// (issues/core.md): the move is run in a child process on a scratch store (`support/moveIntoOwnSubtreeChild.ts`), which this test kills after a few
// seconds, so a loop ends the test instead of the run. The test is written to expect a refusal that names the cause, and a child that ends by itself.
// On the working engine it fails: the move returns, the first walk of the moved heading's parent chain loops, and the child is killed.
// The file ends in `.repro.ts`, not `.test.ts`, so the runner finds it in no group and no suite and `commit` stays green. Run it alone with
// `node --import tsx --test packages/cli/src/tests/commands/moveIntoOwnSubtree.repro.ts` from `monorepo/`. Piece 6 (planning/core.md, Batch 11) renames it
// to `moveIntoOwnSubtree.test.ts` and names it in `commit.suite.mjs` once the write layer refuses the move.
// The child makes its scratch roots under this test's own scratch directory (`TMPDIR`), so a killed child leaves nothing outside it.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';

const CHILD = join(import.meta.dirname, '..', 'support', 'moveIntoOwnSubtreeChild.ts');
const KILL_AFTER_MS = 6000;

describe('a move into its own subtree', () => {
  let fx: FixtureStore;
  before(() => { fx = makeFixtureStore('mv_parent'); });
  after(() => fx.cleanup());

  test('is refused with a message that names the cause, and the child ends by itself', () => {
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: fx.root };
    delete env.NODE_TEST_CONTEXT;
    delete env.APERAS_APEIRON_ROOT;
    delete env.APERAS_ARTIFACTS_ROOT;
    const started = Date.now();
    const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), CHILD], { encoding: 'utf8', env, timeout: KILL_AFTER_MS, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const lines = r.stdout.split('\n');
    const outline = lines.find((l) => l.startsWith('RESULT '));
    const steps = lines.filter((l) => l.startsWith('AFTER ')).map((l) => l.slice('AFTER '.length));
    const killed = r.error !== undefined || r.signal !== null;
    assert.ok(!killed, `the child was killed after ${seconds} s (${r.signal ?? r.error?.message}) instead of ending: ${outline ?? 'the move did not return'}; steps that returned: ${steps.join(', ') || 'none'}`);
    assert.ok(outline, `the child ended with status ${r.status} and no RESULT line:\n${r.stdout}\n${r.stderr.slice(-600)}`);
    const result = JSON.parse(outline.slice('RESULT '.length)) as { outcome: string; message?: string };
    assert.equal(result.outcome, 'refused', `the move was carried out: ${outline}`);
    assert.ok(/own subtree|its own descendant|inside itself|cannot be moved (in)?to itself/i.test(result.message ?? ''), `the message does not name the cause: ${result.message}`);
    assert.equal(steps.length, 0, 'a refused move goes on to nothing');
  });
});
