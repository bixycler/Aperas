// Child process of `corpus/roundtrip.test.ts`, started fresh once per phase so that the rehydrate it times is never
// the second rehydrate of a process that has just dehydrated a store of the same size.
//   write <Apeiron directory> <scratch directory>: rehydrates the copy, dehydrates content and `.state/` into
//     `<scratch>/mirror`, writes the store's sorted quad lines to `<scratch>/quads.txt`, prints one `RESULT <json>` line.
//   read <scratch directory>: a new process; rehydrates `<scratch>/mirror`, compares its quad set with
//     `<scratch>/quads.txt`, prints one `RESULT <json>` line: the quads each side lacks, with the missing ones that are not
//     the `predicate` quad of a `Link` (see the case in `corpus/roundtrip.test.ts`) and the extra ones listed apart.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from 'oxigraph';
import { rehydrateStore } from '@aperas/core/shell/store';
import { predIri } from '@aperas/core/shell/vocab';
import { dehydrateToJsonLd, dehydrateStateToJsonLd } from '@aperas/core/shell/dehydrate';

/** Every quad of the store as a sorted line (a JSON array of its terms, so a newline in a literal stays inside the line), so two stores compare as sets of quads. */
const quadLines = (store: Store): string[] =>
  [...store.match(null, null, null, null)].map((q) => JSON.stringify([q.subject.value, q.predicate.value, q.object.termType, q.object.value, q.graph.value])).sort();

/** True for the line of a `predicate` quad on a `Link` (the removed field of a manual link; a `Link`'s id has `:links:Link:` in it). */
const PREDICATE_PRED = predIri('predicate').value;
const isLinkPredicateLine = (line: string): boolean => {
  const [subject, predicate] = JSON.parse(line) as string[];
  return predicate === PREDICATE_PRED && subject.includes(':links:Link:');
};

const ms = (since: number): number => Date.now() - since;
const [mode, ...args] = process.argv.slice(2);

if (mode === 'write') {
  const [apeironRoot, scratchDir] = args;
  if (!apeironRoot || !scratchDir) throw new Error('usage: roundtripChild.ts write <Apeiron directory> <scratch directory>');
  const mirrorDir = join(scratchDir, 'mirror');
  mkdirSync(mirrorDir, { recursive: true });
  let t = Date.now();
  const first = rehydrateStore(apeironRoot);
  const rehydrate1 = ms(t);
  t = Date.now();
  const { counts } = dehydrateToJsonLd(first.store, mirrorDir);
  // The store holds the real `.state/` mirror too (TreeViews, Profiles), so the state mirror needs the same
  // dehydrate -> rehydrate pass into the same scratch directory for the quad counts to be comparable.
  const { counts: stateCounts } = dehydrateStateToJsonLd(first.store, join(mirrorDir, '.state'));
  const dehydrate = ms(t);
  const lines = quadLines(first.store);
  writeFileSync(join(scratchDir, 'quads.txt'), lines.join('\n'));
  console.log('RESULT ' + JSON.stringify({ counts, stateCounts, timings: { rehydrate1, dehydrate }, quadCount: first.quadCount, lines: lines.length }));
} else if (mode === 'read') {
  const [scratchDir] = args;
  if (!scratchDir) throw new Error('usage: roundtripChild.ts read <scratch directory>');
  const t = Date.now();
  const second = rehydrateStore(join(scratchDir, 'mirror'));
  const rehydrate2 = ms(t);
  const before = readFileSync(join(scratchDir, 'quads.txt'), 'utf8').split('\n');
  const after = quadLines(second.store);
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const missing = before.filter((l) => !afterSet.has(l));
  const extra = after.filter((l) => !beforeSet.has(l));
  const missingNotLinkPredicate = missing.filter((l) => !isLinkPredicateLine(l));
  console.log('RESULT ' + JSON.stringify({
    timings: { rehydrate2 }, quadCountAfter: second.quadCount,
    danglingRefs: second.danglingRefs.slice(0, 5), danglingCount: second.danglingRefs.length,
    linesBefore: before.length, linesAfter: after.length,
    missingCount: missing.length, missingLinkPredicateCount: missing.length - missingNotLinkPredicate.length,
    missingNotLinkPredicate: missingNotLinkPredicate.slice(0, 5), extraCount: extra.length, extra: extra.slice(0, 5),
  }));
} else {
  throw new Error('usage: roundtripChild.ts write|read ...');
}
