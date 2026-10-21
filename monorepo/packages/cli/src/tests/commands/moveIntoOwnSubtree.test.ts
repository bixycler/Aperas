// A move of a node after an anchor inside its own subtree is refused (issues/core.md): the engine refuses an item whose host is the item or lies under it (it would close a
// cycle in the lists), the shell words the refusal, and a refused move changes nothing. The move is run in a child process on a scratch store
// (`support/moveIntoOwnSubtreeChild.ts`), which this test kills after a few seconds, so that a loop (the failure on the reference engine, which accepted the move and looped on
// the parent chain) ends the test instead of the run. The test expects a refusal that names the cause, and a child that ends by itself.
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
    const result = JSON.parse(outline.slice('RESULT '.length)) as { outcome: string; message?: string; unchanged?: boolean };
    assert.equal(result.outcome, 'refused', `the move was carried out: ${outline}`);
    assert.ok(/own subtree|its own descendant|inside itself|cannot be moved (in)?to itself/i.test(result.message ?? ''), `the message does not name the cause: ${result.message}`);
    assert.equal(steps.length, 0, 'a refused move goes on to nothing');
    assert.equal(result.unchanged, true, 'and it changes nothing: the rendered tree and the parents of the two headings are as they were');
  });
});
