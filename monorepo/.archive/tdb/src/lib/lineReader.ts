/**
 * Line-by-line stdin reader for interactive CLI prompts (`kg:title`/`kg:link`, TDB-backed and
 * ApeironNgn alike). Deliberately not `rl.question()`: that API races against readline's
 * auto-close-on-stream-'end' whenever real async work happens between calls — confirmed live,
 * two different failure modes depending on timing (an immediate throw, or a silently-abandoned
 * pending call that lets the process exit with no output at all). A live interactive TTY never
 * sends 'end' mid-session, so neither failure mode is reachable there; both are real for a coding
 * agent piping pre-computed answers non-interactively, which these tools are explicitly meant to
 * support. Consuming the interface's own async iterator instead reports end-of-input as an
 * ordinary `{done: true}`, not a race-prone exception, regardless of what else is `await`ed in
 * between reads.
 */
export function createLineReader(rl: any): { next: () => Promise<string | null> } {
  const iter = rl[Symbol.asyncIterator]();
  return {
    async next(): Promise<string | null> {
      const { value, done } = await iter.next();
      return done ? null : value;
    },
  };
}
