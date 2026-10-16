/**
 * The removal confirmation shared by `aperas ingest` and `aperas track` (Aperas-crud-design.md §14): the
 * caller has already printed what would be removed; this asks `[yes/NO]` and answers whether the user said
 * yes. `noPrompt` (the `--no-prompt` flag) answers no at once, without opening a reader on stdin or writing
 * the question, for a caller that has no stdin to give (a harness, a hook) and must not block on one. A
 * closed or silent-then-closed stdin is also no. No `isTTY` check: piped answers (`echo yes | aperas ...`) are
 * a design goal of `lineReader.ts`.
 */

import { createInterface } from 'node:readline/promises';
import { createLineReader } from '@aperas/core/lineReader';

export interface ConfirmRemovalOptions {
  noPrompt?: boolean;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export async function confirmRemoval({ noPrompt = false, input = process.stdin, output = process.stdout }: ConfirmRemovalOptions = {}): Promise<boolean> {
  if (noPrompt) return false;
  const rl = createInterface({ input, output });
  const lines = createLineReader(rl);
  output.write('\nAre you sure you want to remove these? [yes/NO]: ');
  const raw = await lines.next();
  rl.close();
  const answer = (raw ?? '').trim().toLowerCase();
  return answer === 'yes' || answer === 'y';
}
