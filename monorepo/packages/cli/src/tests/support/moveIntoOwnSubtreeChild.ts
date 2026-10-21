// Child process of `commands/moveIntoOwnSubtree.test.ts`: on a scratch store it moves a heading after an anchor that lies inside the heading's own
// subtree (`runInsert` with no markdown, the heading as the target and its child as the anchor), and prints one `RESULT <json>` line when the call
// returns or throws. The engine refuses that move; on the reference engine the call returned and the first walk of the moved heading's parent chain (`runPath`, after
// `runShow` and `runTree`, which return) looped. The parent kills this process after a few seconds when it does not end by itself; an `AFTER <step>` line says each step that returned.
// The scratch roots are made in the directory `TMPDIR` names, which the parent gives it inside the parent's own scratch directory.
import { runIngest } from '../../kgIngest';
import { runInsert } from '../../kgInsert';
import { runPath } from '../../kgPath';
import { runResolve } from '../../kgResolve';
import { runShow } from '../../kgShow';
import { runTree } from '../../kgTree';
import { makeFixtureStore } from './fixture.ts';
import { writeArtifact } from './commandsCorpus.ts';

const fx = makeFixtureStore('mv_demo');
writeArtifact(fx, 'mv_demo/doc.md', '# Doc\n\n## Outer\n\nOuter text.\n\n### Inner\n\nInner text.\n');
runIngest(fx.store, ['mv_demo/doc.md'], true, false);
const idOf = (path: string): string => runResolve(fx.store, { paths: [path], createHolder: false }).lines[0].split('  ')[0].replace('aperas://id/', '');
const outer = idOf('mv_demo/doc.md/Doc/Outer');
const inner = idOf('mv_demo/doc.md/Doc/Outer/Inner');
console.log(`READY ${outer} ${inner}`);
const shape = (): string => JSON.stringify([runTree(fx.store, { pathArg: 'mv_demo/doc.md', noHolders: false, showTombstoned: false }), runShow(fx.store, outer).parent, runShow(fx.store, inner).parent]);
const shapeBefore = shape();
try {
  const r = runInsert(fx.store, { path: outer, after: inner });
  console.log(`RESULT ${JSON.stringify({ outcome: 'moved', lines: r.lines })}`);
  // what the service goes on to do with the store: each step prints a line when it returns
  const step = (name: string, fn: () => unknown): void => { fn(); console.log(`AFTER ${name}`); };
  step('show', () => runShow(fx.store, outer));
  step('tree', () => runTree(fx.store, { pathArg: 'mv_demo/doc.md', noHolders: false, showTombstoned: false }));
  step('path', () => runPath(fx.store, outer)); // walks the parent chain of the moved heading, which the move has made a cycle
} catch (e) {
  console.log(`RESULT ${JSON.stringify({ outcome: 'refused', message: e instanceof Error ? e.message : String(e), unchanged: shape() === shapeBefore })}`);
}
fx.cleanup();
