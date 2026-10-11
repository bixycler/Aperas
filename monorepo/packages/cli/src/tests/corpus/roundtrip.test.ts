// Corpus check: the dehydrate -> rehydrate round trip of the whole mirror (step 7 of the legacy suite at the
// real mirror's size, with the rehydration of step 2 as its set-up). It needs the real mirror's size and shape
// for its meaning: the tiny-store version is `store/roundtrip.test.ts`.
// It runs on a COPY of `AperasKG/Apeiron/` (`makeCorpusCopy()`), the mirror as it is on disk, which lags the
// service's memory by up to its flush interval. The real mirror is only read.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCorpusCopy, type CorpusCopy } from '../support/corpus.ts';

const CHILD = join(import.meta.dirname, '..', 'support', 'roundtripChild.ts');

/** What the `write` phase of `support/roundtripChild.ts` prints on its `RESULT` line. */
interface WriteResult {
  counts: Record<string, number>;
  stateCounts: Record<string, number>;
  timings: { rehydrate1: number; dehydrate: number };
  quadCount: number;
  lines: number;
}

/** What the `read` phase prints on its `RESULT` line. */
interface ReadResult {
  timings: { rehydrate2: number };
  quadCountAfter: number;
  danglingRefs: string[];
  danglingCount: number;
  linesBefore: number;
  linesAfter: number;
  firstDifference?: string;
}

/** Runs one phase of the child in a new process and returns its `RESULT` line. */
function runChild<T>(...args: string[]): T {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), CHILD, ...args], { encoding: 'utf8', env, timeout: 140000, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, `the round-trip child (${args[0]}) exited ${r.status ?? r.signal}: ${r.error?.message ?? ''}\n${r.stderr}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, `the round-trip child (${args[0]}) printed no RESULT line:\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(line.slice('RESULT '.length)) as T;
}

describe('corpus: round trip of the whole mirror', () => {
  let copy: CorpusCopy;
  let scratchDir: string | undefined;
  before(() => { copy = makeCorpusCopy(); });
  after(() => {
    if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
    copy?.cleanup();
  });

  test('2: the mirror rehydrates', () => {
    assert.ok(copy.quadCount > 0 && copy.nodeCount > 0, `${copy.quadCount} quads, ${copy.nodeCount} documents rehydrated`); // new: the old step printed the counts
    assert.equal(copy.store.size, copy.quadCount);
  });

  // Two children, each started fresh: the first rehydrates the copy and dehydrates it into a scratch directory, the second
  // rehydrates that directory and compares its quads with the first's. So the second rehydrate does not run in a process that has
  // just dehydrated a store of the same size; this file tests the round trip's fidelity, not that cost.
  test('7: a round trip through a scratch directory keeps every quad', () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'apeironngn-verify-'));
    const w = runChild<WriteResult>('write', copy.apeironRoot, scratchDir);
    console.log(`round trip, child 1: rehydrate ${w.timings.rehydrate1} ms, dehydrate ${w.timings.dehydrate} ms`);
    const r = runChild<ReadResult>('read', scratchDir);
    console.log(`round trip, child 2 (a new process): second rehydrate ${r.timings.rehydrate2} ms`);
    assert.equal(w.quadCount, copy.store.size, 'the child rehydrated the same quads as this process did');
    assert.ok(Object.values(w.counts).some((n) => Number(n) > 0) && Object.values(w.stateCounts).some((n) => Number(n) > 0), `both mirrors were dehydrated: ${JSON.stringify(w.counts)}, state ${JSON.stringify(w.stateCounts)}`); // new
    assert.deepEqual(r.danglingRefs, [], `zero dangling references after a round trip (${r.danglingCount})`);
    assert.equal(r.quadCountAfter, w.quadCount, 'the round-tripped store has the same quad count as the original');
    // new: the same quads, not only the same number of them
    assert.equal(r.linesAfter, r.linesBefore);
    assert.equal(r.firstDifference, undefined, `the round-tripped store holds the same quads; first difference: ${r.firstDifference}`);
  });
});
