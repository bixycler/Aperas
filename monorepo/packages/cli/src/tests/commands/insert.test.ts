// The write commands that place and change a block, before the writes move to the engine (planning/core.md, Batch 11, step 10): `runInsert` (create a
// block or several at an anchor or at the end, move one before or after an anchor in the same parent or in another, promote a placeholder in place),
// `runUpdate` (a text, a retitled heading, the overflow of a piped document in both modes, a checkbox, a placeholder made real, the frontmatter of a
// folder and of an artifact, the links of the text) and `runRetype` (the depth of a heading, the crossing from heading to paragraph and back, the props of
// the type left behind). The order of the children of a block is an ordered list, so a case compares the sequence of ids, not a set. A refused call leaves
// the rendered tree as it was. A move of a node after an anchor inside its own subtree is not here: it loops on the old code, and its reproduction is in
// `moveIntoOwnSubtree.repro.ts`. The cases share one store and run in order. The store is reached through `fx.store`, `wrap` and the `runX` functions only.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runInsert } from '../../kgInsert';
import { runUpdate } from '../../kgUpdate';
import { runRetype } from '../../kgRetype';
import { runResolve } from '../../kgResolve';
import { runIngest } from '../../kgIngest';
import { runRemove } from '../../kgRemove';
import { runShow } from '../../kgShow';
import { runTree } from '../../kgTree';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';
import { buildCorpus, idOf, linkIdsOf, linkTargetOf, parseTree, writeArtifact, type Corpus } from '../support/commandsCorpus.ts';

const sorted = (xs: readonly string[]): string[] => [...xs].sort();
const refuses = (fn: () => unknown, message: RegExp): void => assert.throws(fn, (e: unknown) => e instanceof Error && message.test(e.message), `expected a refusal matching ${message}`);
const NOT_TRACKED = /isn't a tracked artifact\/folder path, deep path, bare node code, or full node id/;
const bare = (id: string): string => id.split(':')[1];
/** The id a line of `runInsert` names, and the rest of the line after the label and the title. */
const createdIdOf = (line: string): string => line.split('  ')[0].replace('aperas://id/', '');

describe('insert, update and retype', () => {
  let fx: FixtureStore;
  let c: Corpus;
  before(() => {
    fx = makeFixtureStore('cmd_demo');
    c = buildCorpus(fx);
    writeArtifact(fx, 'cmd_demo/mv.md', '# Mv\n\n## A\n\nA text.\n\n## B\n\nB text.\n\n## C\n\nC text.\n\n## D\n\nD text.\n');
    writeArtifact(fx, 'cmd_demo/other.md', '# Other\n\n## X\n\nX text.\n');
    writeArtifact(fx, 'cmd_demo/lists.md', '# Lists\n\n## Bullets\n\n- one\n- two\n\n## Numbered\n\n1. first\n2. second\n');
    writeArtifact(fx, 'cmd_demo/upd.md', '# Upd\n\nUpd intro.\n\n## One\n\nOne text.\n\n## Two\n\nTwo text.\n\n### Two A\n\nTwo A text.\n\n## Three\n\nThree text.\n');
    writeArtifact(fx, 'cmd_demo/fm.md', '# Fm\n\nFm intro.\n');
    runIngest(fx.store, ['cmd_demo/mv.md', 'cmd_demo/other.md', 'cmd_demo/lists.md', 'cmd_demo/upd.md', 'cmd_demo/fm.md'], true, false);
  });
  after(() => fx.cleanup());

  /** The ids of the children of a node in the rendered tree, in order. */
  const kids = (ref: string): string[] => parseTree(runTree(fx.store, { pathArg: ref, noHolders: false, showTombstoned: false }) as string[]).filter((e) => e.depth === 1).map((e) => e.id);
  /** The whole rendered tree, to see that a refused call changed nothing. */
  const snapshot = (): string[] => runTree(fx.store, { pathArg: '.', noHolders: false, showTombstoned: false }) as string[];
  const entry = (ref: string, id: string) => parseTree(runTree(fx.store, { pathArg: ref, noHolders: false, showTombstoned: false }) as string[]).find((e) => e.id === id);
  const stored = (id: string) => runShow(fx.store, id) as { title?: string; text?: string; type?: string; parent?: string; children?: string[]; props?: Array<{ key: string; value: string }>; tombstonedAt?: string };
  const propOf = (id: string, key: string): string | undefined => stored(id).props?.find((p) => p.key === key)?.value;
  const refusedLeavesTree = (fn: () => unknown, message: RegExp): void => {
    const before = snapshot();
    refuses(fn, message);
    assert.deepEqual(snapshot(), before, 'the rendered tree is as it was');
  };

  describe('insert: create', () => {
    let three = '';
    let zero = '';
    let half = '';

    test('a piped block is appended as the last child of the parent', () => {
      const r = runInsert(fx.store, { path: 'cmd_demo/dup.md/Dup', markdown: '## Item Three\n\nThree.\n' });
      assert.equal(r.lines.length, 1);
      three = createdIdOf(r.lines[0]);
      assert.ok(three.startsWith('BlockNode:'), three);
      assert.ok(r.lines[0].endsWith('  [heading]  ## Item Three  (created)'), r.lines[0]);
      assert.deepEqual(kids('cmd_demo/dup.md/Dup'), [c.itemOne, c.itemTwo, three]);
      assert.equal(stored(three).text, 'Three.');
      assert.equal(stored(three).parent, c.dup);
      assert.deepEqual(r.linkResolution, { resolved: 0, dangling: 0, changed: 0 });
    });

    test('--before and --after an anchor place the block next to it', () => {
      zero = createdIdOf(runInsert(fx.store, { path: 'cmd_demo/dup.md/Dup', markdown: '## Item Zero\n\nZero.\n', before: c.itemOne }).lines[0]);
      half = createdIdOf(runInsert(fx.store, { path: 'cmd_demo/dup.md/Dup', markdown: '## Item Half\n\nHalf.\n', after: c.itemOne }).lines[0]);
      assert.deepEqual(kids('cmd_demo/dup.md/Dup'), [zero, c.itemOne, half, c.itemTwo, three]);
    });

    test('a path, a bare code or a full id names the parent and the anchor alike', () => {
      const viaCode = createdIdOf(runInsert(fx.store, { path: bare(c.dup), markdown: '## Via Code\n', after: bare(c.itemTwo) }).lines[0]);
      const viaPath = createdIdOf(runInsert(fx.store, { path: `aperas://id/${c.dup}`, markdown: '## Via Path\n', after: 'cmd_demo/dup.md/Dup/Via-Code' }).lines[0]);
      assert.deepEqual(kids('cmd_demo/dup.md/Dup'), [zero, c.itemOne, half, c.itemTwo, viaCode, viaPath, three]);
    });

    test('several blocks in one piped document are all created, in order, after or before the anchor', () => {
      const after = runInsert(fx.store, { path: 'cmd_demo/mv.md/Mv', markdown: '## M1\n\n## M2\n', after: idOf(fx, 'cmd_demo/mv.md/Mv/A') }).lines.map(createdIdOf);
      assert.equal(after.length, 2);
      const before = runInsert(fx.store, { path: 'cmd_demo/mv.md/Mv', markdown: '## N1\n\n## N2\n', before: idOf(fx, 'cmd_demo/mv.md/Mv/B') }).lines.map(createdIdOf);
      const a = idOf(fx, 'cmd_demo/mv.md/Mv/A');
      const b = idOf(fx, 'cmd_demo/mv.md/Mv/B');
      const cc = idOf(fx, 'cmd_demo/mv.md/Mv/C');
      const d = idOf(fx, 'cmd_demo/mv.md/Mv/D');
      assert.deepEqual(kids('cmd_demo/mv.md/Mv'), [a, ...after, ...before, b, cc, d]);
      // the blocks are removed again so that the order of the move cases below is the one they say
      for (const id of [...after, ...before]) runRemove(fx.store, { path: id });
      assert.deepEqual(kids('cmd_demo/mv.md/Mv'), [a, b, cc, d]);
    });

    test('a block can be created under an artifact, as its last child', () => {
      const id = createdIdOf(runInsert(fx.store, { path: 'cmd_demo/fm.md', markdown: '# Second Top\n\nBody.\n' }).lines[0]);
      const k = kids('cmd_demo/fm.md');
      assert.equal(k[k.length - 1], id);
      assert.equal(k.length, 2);
    });

    test('a nested piped document brings its children with it', () => {
      const id = createdIdOf(runInsert(fx.store, { path: 'cmd_demo/fm.md/Fm', markdown: '## Parent\n\n### Child\n\nChild text.\n' }).lines[0]);
      assert.equal(kids(id).length, 1);
      assert.equal(stored(kids(id)[0]).text, 'Child text.');
    });

    test('links in the piped text are resolved, and a link to a title with no node makes a placeholder', () => {
      const r = runInsert(fx.store, { path: 'cmd_demo/fm.md/Fm', markdown: `## Linked\n\nSee [section]([[${bare(c.betaSec)}]]) and [later]([[NotYetThere]]).\n` });
      const id = createdIdOf(r.lines[0]);
      assert.equal(r.linkResolution!.resolved, 2);
      assert.equal(r.linkResolution!.dangling, 0);
      const links = linkIdsOf(fx, id);
      assert.equal(links.length, 2, 'both resolve: the title with no node gets a placeholder, as it does in `ingest` and `update`');
      const targets = links.map((l) => linkTargetOf(fx, id, l));
      assert.ok(targets.includes(c.betaSec));
      const placeholder = targets.find((t) => t !== c.betaSec)!;
      assert.equal(stored(placeholder).title, 'NotYetThere');
      assert.equal((stored(placeholder) as { holder?: boolean }).holder, true);
    });

    test('a lone list item landing after a run continues it; a wrong number in an ordered run is refused', () => {
      const bullets = idOf(fx, 'cmd_demo/lists.md/Lists/Bullets');
      const three = createdIdOf(runInsert(fx.store, { path: bullets, markdown: '- three\n' }).lines[0]);
      assert.equal(propOf(three, 'orderedList'), undefined, 'a continuation carries no run props of its own');
      assert.equal(propOf(kids(bullets)[0], 'orderedList'), 'false', 'the leader of the run has them');
      assert.equal(kids(bullets).length, 3);

      const numbered = idOf(fx, 'cmd_demo/lists.md/Lists/Numbered');
      refusedLeavesTree(() => runInsert(fx.store, { path: numbered, markdown: '5. five\n' }), /expected item number 3 \(continuing the existing run\) — got 5/);
      const third = createdIdOf(runInsert(fx.store, { path: numbered, markdown: '3. third\n' }).lines[0]);
      assert.equal(propOf(third, 'orderedList'), undefined);
      assert.equal(stored(third).text, 'third');
      assert.equal(kids(numbered).length, 3);
    });

    test('refused: a second anchor flag, an anchor that is not a child of the parent, an anchor that resolves to nothing, nothing piped, a parent that is not a block', () => {
      refusedLeavesTree(() => runInsert(fx.store, { path: 'cmd_demo/dup.md/Dup', markdown: '## X\n', after: c.itemOne, before: c.itemTwo }), /--after and --before are mutually exclusive/);
      refusedLeavesTree(() => runInsert(fx.store, { path: 'cmd_demo/dup.md/Dup', markdown: '## X\n', after: 'cmd_demo/nothing' }), /Anchor 'cmd_demo\/nothing' isn't a tracked/);
      refusedLeavesTree(() => runInsert(fx.store, { path: 'cmd_demo/dup.md/Dup', markdown: '## X\n', after: c.alphaSec }), /is not a child of/);
      refusedLeavesTree(() => runInsert(fx.store, { path: 'cmd_demo/dup.md/Dup', markdown: '\n' }), /Piped markdown produced no content to insert/);
      refusedLeavesTree(() => runInsert(fx.store, { path: 'cmd_demo/nothing', markdown: '## X\n' }), NOT_TRACKED);
      refusedLeavesTree(() => runInsert(fx.store, { path: c.alphaLinkToBeta, markdown: '## X\n' }), /isn't a valid parent to create under/);
    });

    test('refused: a title that another live block already has under the same path, and a link to an id that names no node', () => {
      refusedLeavesTree(() => runInsert(fx.store, { path: 'cmd_demo/dup.md/Dup', markdown: '## Item One\n\nAgain.\n' }), /Full-slug-path collision/);
      refusedLeavesTree(() => runInsert(fx.store, { path: 'cmd_demo/dup.md/Dup', markdown: '## Bad\n\nSee [x]([[BlockNode:0000000000000]]).\n' }), /Refusing to store 1 link\(s\) that cannot point anywhere/);
    });
  });

  describe('insert: move and promote', () => {
    let a = ''; let b = ''; let cc = ''; let d = ''; let x = '';
    before(() => {
      [a, b, cc, d] = ['A', 'B', 'C', 'D'].map((t) => idOf(fx, `cmd_demo/mv.md/Mv/${t}`));
      x = idOf(fx, 'cmd_demo/other.md/Other/X');
    });

    test('a node moves before an anchor in its own parent, keeping its id', () => {
      const r = runInsert(fx.store, { path: d, before: b });
      assert.deepEqual(r.lines, [`aperas://id/${d}  [heading]  ## D  (moved before ${b})`]);
      assert.deepEqual(kids('cmd_demo/mv.md/Mv'), [a, d, b, cc]);
      assert.equal(stored(d).text, 'D text.');
    });

    test('a node moves after an anchor in its own parent', () => {
      const r = runInsert(fx.store, { path: a, after: cc });
      assert.deepEqual(r.lines, [`aperas://id/${a}  [heading]  ## A  (moved after ${cc})`]);
      assert.deepEqual(kids('cmd_demo/mv.md/Mv'), [d, b, cc, a]);
    });

    test('a node moves into another parent, the anchor\'s: it leaves the old one, and a path names it by its new place', () => {
      runInsert(fx.store, { path: 'cmd_demo/mv.md/Mv/C', markdown: '### C1\n\nC1 text.\n' });
      const c1 = idOf(fx, 'cmd_demo/mv.md/Mv/C/C1');
      runInsert(fx.store, { path: b, after: x });
      assert.deepEqual(kids('cmd_demo/mv.md/Mv'), [d, cc, a]);
      assert.deepEqual(kids('cmd_demo/other.md/Other'), [x, b]);
      assert.equal(stored(b).parent, idOf(fx, 'cmd_demo/other.md/Other'));
      assert.equal(idOf(fx, 'cmd_demo/other.md/Other/B'), b);
      // a node with a subtree takes it along
      runInsert(fx.store, { path: cc, before: x });
      assert.deepEqual(kids('cmd_demo/other.md/Other'), [cc, x, b]);
      assert.deepEqual(kids(cc), [c1]);
      assert.equal(idOf(fx, 'cmd_demo/other.md/Other/C/C1'), c1);
    });

    test('an anchor that is a top-level heading makes the node a child of the artifact', () => {
      runInsert(fx.store, { path: d, after: idOf(fx, 'cmd_demo/other.md/Other') });
      assert.equal(stored(d).parent, idOf(fx, 'cmd_demo/other.md'));
    });

    test('a placeholder is promoted in place by an insert with no anchor, and a real node answers the same', () => {
      runResolve(fx.store, { paths: ['cmd_demo/mv.md/Mv/Ghost'], createHolder: true, titles: ['Ghost'] });
      const ghost = idOf(fx, 'cmd_demo/mv.md/Mv/Ghost');
      assert.ok(entry('cmd_demo/mv.md', ghost)!.rest.endsWith('(holder)'));
      const r = runInsert(fx.store, { path: ghost });
      assert.deepEqual(r.lines, [`aperas://id/${ghost}  [heading]  Ghost  (promoted in place)`]);
      assert.equal(entry('cmd_demo/mv.md', ghost)!.rest.endsWith('(holder)'), false);
      assert.ok(runInsert(fx.store, { path: ghost }).lines[0].endsWith('(promoted in place)'));
    });

    test('a placeholder folder is promoted in place, and a folder with an anchor is refused', () => {
      runResolve(fx.store, { paths: ['cmd_demo/sub/x.md/X'], createHolder: true, titles: ['sub', 'x.md', 'X'] });
      assert.ok(parseTree(runTree(fx.store, { pathArg: 'cmd_demo/sub', noHolders: false, showTombstoned: false }) as string[])[0].rest.endsWith('(holder)'));
      refusedLeavesTree(() => runInsert(fx.store, { path: 'cmd_demo/sub', after: c.itemOne }), /can only bare-promote a folder holder/);
      const r = runInsert(fx.store, { path: 'cmd_demo/sub' });
      assert.ok(r.lines[0].endsWith('  [FolderNode]  sub  (promoted in place)'), r.lines[0]);
      assert.equal(parseTree(runTree(fx.store, { pathArg: 'cmd_demo/sub', noHolders: false, showTombstoned: false }) as string[])[0].rest.endsWith('(holder)'), false);
    });

    test('refused: the node as its own anchor, an anchor that has no parent, a target that is not a block, an anchor or a target that does not exist', () => {
      refusedLeavesTree(() => runInsert(fx.store, { path: cc, after: cc }), /The anchor cannot be the same node as the target/);
      refusedLeavesTree(() => runInsert(fx.store, { path: cc, after: '.' }), /has no parent to insert relative to/);
      refusedLeavesTree(() => runInsert(fx.store, { path: c.dupArt, after: x }), /resolves to a ArtifactNode — kg:insert only positions Block-level nodes/);
      refusedLeavesTree(() => runInsert(fx.store, { path: c.alphaLinkToBeta, after: x }), /resolves to a Link — kg:insert only positions Block-level nodes/);
      refusedLeavesTree(() => runInsert(fx.store, { path: cc, after: 'cmd_demo/nothing' }), /Anchor 'cmd_demo\/nothing' isn't a tracked/);
      refusedLeavesTree(() => runInsert(fx.store, { path: 'cmd_demo/nothing', after: x }), /Target 'cmd_demo\/nothing' isn't a tracked/);
    });
  });

  describe('update', () => {
    let one = ''; let two = ''; let twoA = '';
    before(() => { [one, two, twoA] = ['One', 'Two', 'Two/Two-A'].map((t) => idOf(fx, `cmd_demo/upd.md/Upd/${t}`)); });

    test('--text-only puts the piped document\'s blocks ahead of the children the node has, and keeps those with their ids', () => {
      const r = runUpdate(fx.store, { path: two, markdown: 'Para text.\n\n### Fresh\n\nFresh text.\n', textOnly: true });
      assert.equal(r.reconciled, false);
      const k = kids(two);
      assert.equal(k.length, 3);
      assert.equal(k[2], twoA, 'the old child is last, as it was');
      assert.equal(stored(twoA).text, 'Two A text.');
      assert.equal(stored(k[0]).text, 'Para text.');
      assert.equal(stored(k[1]).title, '### Fresh');
    });

    test('the default mode reconciles the piped document against the children: a match keeps its id and takes the new text, the rest is removed or added', () => {
      const [para] = kids(two);
      const r = runUpdate(fx.store, { path: two, markdown: 'Para text.\n\n### Two A\n\nTwo A edited.\n\n### Added\n\nAdded text.\n', textOnly: false });
      assert.equal(r.reconciled, true);
      const k = kids(two);
      assert.equal(k.length, 3);
      assert.deepEqual(k.slice(0, 2), [para, twoA], 'the paragraph and Two A keep their ids and their places');
      assert.equal(stored(twoA).text, 'Two A edited.');
      assert.equal(stored(k[2]).title, '### Added', 'the block that is not in the piped document is gone, and the new one stands in its place');
      assert.equal(stored(k[2]).text, 'Added text.');
      assert.equal(k.some((id) => stored(id).title === '### Fresh'), false);
    });

    test('one piped paragraph becomes the text of a heading, whose title and id stay', () => {
      const r = runUpdate(fx.store, { path: one, markdown: 'One edited.\n', textOnly: false });
      assert.equal(r.reconciled, true);
      assert.equal(stored(one).text, 'One edited.');
      assert.equal(stored(one).title, '## One');
    });

    test('a piped heading of the same depth retitles it in place, and the path follows the title', () => {
      runUpdate(fx.store, { path: one, markdown: '## One Renamed\n\nOne renamed text.\n', textOnly: false });
      assert.equal(stored(one).title, '## One Renamed');
      assert.equal(stored(one).text, 'One renamed text.');
      assert.equal(idOf(fx, 'cmd_demo/upd.md/Upd/One-Renamed'), one);
    });

    test('a checkbox is set by a bullet with a marker, kept by plain text, and cleared by a bullet without one', () => {
      const bullets = kids(idOf(fx, 'cmd_demo/lists.md/Lists/Bullets'));
      runUpdate(fx.store, { path: bullets[1], markdown: '- [x] two\n', textOnly: false });
      assert.equal(propOf(bullets[1], 'checked'), 'true');
      runUpdate(fx.store, { path: bullets[1], markdown: 'two edited\n', textOnly: false });
      assert.equal(propOf(bullets[1], 'checked'), 'true');
      assert.equal(stored(bullets[1]).text, 'two edited');
      runUpdate(fx.store, { path: bullets[1], markdown: '- plain\n', textOnly: false });
      assert.equal(propOf(bullets[1], 'checked'), undefined);
      assert.equal(stored(bullets[1]).text, 'plain');
      assert.equal(propOf(bullets[0], 'orderedList'), 'false', 'the run props of the leader are untouched');
    });

    test('piping content onto a placeholder makes it real', () => {
      runResolve(fx.store, { paths: ['cmd_demo/upd.md/Upd/Later'], createHolder: true, titles: ['Later'] });
      const later = idOf(fx, 'cmd_demo/upd.md/Upd/Later');
      assert.ok(entry('cmd_demo/upd.md', later)!.rest.endsWith('(holder)'));
      runUpdate(fx.store, { path: later, markdown: 'Now real.\n', textOnly: false });
      assert.equal(entry('cmd_demo/upd.md', later)!.rest.endsWith('(holder)'), false);
      assert.equal(stored(later).text, 'Now real.');
    });

    test('piping content onto a placeholder with --text-only makes it real as well', () => {
      runResolve(fx.store, { paths: ['cmd_demo/upd.md/Upd/Sooner'], createHolder: true, titles: ['Sooner'] });
      const sooner = idOf(fx, 'cmd_demo/upd.md/Upd/Sooner');
      assert.ok(entry('cmd_demo/upd.md', sooner)!.rest.endsWith('(holder)'));
      runUpdate(fx.store, { path: sooner, markdown: 'Sooner text.\n', textOnly: true });
      assert.equal(entry('cmd_demo/upd.md', sooner)!.rest.endsWith('(holder)'), false);
    });

    test('the frontmatter of an artifact becomes its props, and the piped paragraph its text', () => {
      const art = idOf(fx, 'cmd_demo/fm.md');
      runUpdate(fx.store, { path: art, markdown: '---\ndescription: About fm\n---\n\nFm summary.\n', textOnly: false });
      assert.equal(propOf(art, 'description'), 'About fm');
      assert.equal(stored(art).text, 'Fm summary.');
    });

    test('a folder takes frontmatter only: its props change, a body or no frontmatter is refused', () => {
      const r = runUpdate(fx.store, { path: 'cmd_demo', markdown: '---\ndescription: Demo folder\n---\n', textOnly: false });
      assert.equal(r.reconciled, false);
      assert.equal(propOf(c.folder, 'description'), 'Demo folder');
      refuses(() => runUpdate(fx.store, { path: 'cmd_demo', markdown: '---\ndescription: X\n---\n\nA body.\n', textOnly: false }), /only edits its frontmatter/);
      refuses(() => runUpdate(fx.store, { path: 'cmd_demo', markdown: '\n', textOnly: false }), /No frontmatter found in the piped input/);
      assert.equal(propOf(c.folder, 'description'), 'Demo folder');
    });

    test('links in the text: one is resolved and made a link, and the same text again keeps the link\'s id', () => {
      const text = `Links to [alpha]([[${bare(c.alphaArt)}]]).\n`;
      const r1 = runUpdate(fx.store, { path: three(), markdown: text, textOnly: false });
      assert.deepEqual(r1.linkResolution, { resolved: 1, dangling: 0, changed: 1 });
      const ids = linkIdsOf(fx, three());
      assert.equal(ids.length, 1);
      assert.equal(linkTargetOf(fx, three(), ids[0]), c.alphaArt);
      const r2 = runUpdate(fx.store, { path: three(), markdown: text, textOnly: false });
      assert.deepEqual(r2.linkResolution, { resolved: 1, dangling: 0, changed: 0 });
      assert.deepEqual(linkIdsOf(fx, three()), ids);
    });

    test('refused: a path that resolves to nothing, a link, a heading of another depth, a link to an id that names no node', () => {
      refuses(() => runUpdate(fx.store, { path: 'cmd_demo/nothing', markdown: 'x\n', textOnly: false }), /Target 'cmd_demo\/nothing' isn't a tracked/);
      refuses(() => runUpdate(fx.store, { path: c.alphaLinkToBeta, markdown: 'x\n', textOnly: false }), /resolves to a Link — kg:update only targets Block\/Artifact\/Folder nodes/);
      refuses(() => runUpdate(fx.store, { path: two, markdown: '# Wrong\n\nx\n', textOnly: false }), /is a depth-2 heading — the piped input's own heading is depth-1/);
      const before = stored(three()).text;
      refuses(() => runUpdate(fx.store, { path: three(), markdown: 'See [x]([[BlockNode:0000000000000]]).\n', textOnly: false }), /Refusing to store 1 link\(s\) that cannot point anywhere/);
      assert.equal(stored(three()).text, before, 'a refused link changes nothing');
    });

    const three = (): string => idOf(fx, 'cmd_demo/upd.md/Upd/Three');
  });

  describe('retype', () => {
    let two = ''; let twoA = '';
    before(() => { [two, twoA] = ['Two', 'Two/Two-A'].map((t) => idOf(fx, `cmd_demo/upd.md/Upd/${t}`)); });

    test('a heading changes depth in place: the words, the text, the id and the children stay', () => {
      const r = runRetype(fx.store, { path: twoA, to: 'h4' });
      assert.deepEqual(r, { id: twoA, fromType: 'heading', toType: 'heading', fromTitle: '### Two A', toTitle: '#### Two A', toText: undefined, untitled: false, droppedProps: [] });
      assert.equal(stored(twoA).title, '#### Two A');
      assert.equal(stored(twoA).text, 'Two A edited.');
      assert.equal(stored(twoA).parent, two);
      runRetype(fx.store, { path: twoA, to: 'h3' });
    });

    test('a heading becomes a paragraph with its title as a lead-in, and the paragraph becomes the same heading again', () => {
      const r = runRetype(fx.store, { path: twoA, to: 'paragraph' });
      assert.equal(r.toType, 'paragraph');
      assert.equal(r.toText, '**Two A**: Two A edited.');
      assert.equal(r.toTitle, '**Two A**');
      assert.equal(stored(twoA).type, 'paragraph');
      assert.equal(stored(twoA).text, '**Two A**: Two A edited.');
      const back = runRetype(fx.store, { path: twoA, to: 'h3' });
      assert.equal(back.toTitle, '### Two A');
      assert.equal(back.toText, 'Two A edited.');
      assert.equal(stored(twoA).type, 'heading');
      assert.equal(stored(twoA).title, '### Two A');
      assert.equal(stored(twoA).text, 'Two A edited.');
    });

    test('a list item becomes a paragraph and drops the props of a list item, and keeps its id and text', () => {
      const bullet = kids(idOf(fx, 'cmd_demo/lists.md/Lists/Bullets'))[0];
      assert.equal(propOf(bullet, 'orderedList'), 'false');
      const r = runRetype(fx.store, { path: bullet, to: 'paragraph' });
      assert.deepEqual(sorted(r.droppedProps), ['orderedList', 'startIndex']);
      assert.equal(stored(bullet).type, 'paragraph');
      assert.equal(stored(bullet).props, undefined);
      assert.equal(stored(bullet).text, 'one');
    });

    test('a paragraph with no lead-in becomes a heading titled by its id, and the text is left alone', () => {
      const para = kids(idOf(fx, 'cmd_demo/lists.md/Lists/Bullets'))[0];
      const r = runRetype(fx.store, { path: para, to: 'h4' });
      assert.equal(r.untitled, true);
      assert.equal(stored(para).title, `#### ${bare(para)}`);
      assert.equal(stored(para).text, 'one');
    });

    test('refused: a type it already has, a heading with no depth, a type that does not exist, an artifact, a link, a removed node, a path that resolves to nothing', () => {
      refuses(() => runRetype(fx.store, { path: twoA, to: 'h3' }), /is already h3 — nothing to convert/);
      refuses(() => runRetype(fx.store, { path: twoA, to: 'heading' }), /needs its depth/);
      refuses(() => runRetype(fx.store, { path: twoA, to: 'bogus' }), /Unknown target type 'bogus'/);
      refuses(() => runRetype(fx.store, { path: c.dupArt, to: 'h3' }), /retype only converts BlockNodes/);
      refuses(() => runRetype(fx.store, { path: c.alphaLinkToBeta, to: 'h3' }), /retype only converts BlockNodes/);
      refuses(() => runRetype(fx.store, { path: 'cmd_demo/nothing', to: 'h3' }), /Target 'cmd_demo\/nothing' isn't a tracked/);
      const gone = idOf(fx, 'cmd_demo/upd.md/Upd/Three');
      runRemove(fx.store, { path: gone });
      refuses(() => runRetype(fx.store, { path: gone, to: 'paragraph' }), /is tombstoned — retype only converts live nodes/);
      assert.equal(stored(twoA).type, 'heading', 'a refused call changed nothing');
    });
  });
});
