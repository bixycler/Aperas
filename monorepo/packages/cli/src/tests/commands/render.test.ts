// The render commands before the reads move to the engine (planning/core.md, Batch 11, step 10): `runTree`, `runShow` and `runUnfold` on a small corpus
// of four artifacts. Plain and with a view, `maxDepth`, `noHolders`, the structured `render-tree` format, the links of a block, a node reached through
// two unfolded links (one canonical place and a pointer elsewhere), and what a tombstoned node does to each command. The links of a block come by the order of
// their `position` and the canonical place of a node reached through two links is the first of them in id order (`order.test.ts` has the cases that tell these
// from the order the store lists them in); the cases here compare the order exactly. The cases share one corpus and run in order; the last block removes a
// node. The store is reached through `fx.store`, `wrap` and the `runX` functions only.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTreeView } from '@aperas/core/shell/node';
import { runTree, type TreeRenderResult } from '../../kgTree';
import { runShow } from '../../kgShow';
import { runUnfold } from '../../kgUnfold';
import { runRemove } from '../../kgRemove';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';
import { buildCorpus, idOf, linkIdsOf, parentPairs, parseTree, type Corpus } from '../support/commandsCorpus.ts';

const plain = { noHolders: false, showTombstoned: false };
const sorted = (xs: readonly string[]): string[] => [...xs].sort();
const lines = (r: string[] | TreeRenderResult): string[] => {
  assert.ok(Array.isArray(r), 'the text format returns lines');
  return r;
};
/** A refusal is an Error whose message matches; anything else (no throw, another message) fails. */
const refuses = (fn: () => unknown, message: RegExp): void => assert.throws(fn, (e: unknown) => e instanceof Error && message.test(e.message), `expected a refusal matching ${message}`);

describe('render commands', () => {
  let fx: FixtureStore;
  let c: Corpus;
  before(() => { fx = makeFixtureStore('cmd_demo'); c = buildCorpus(fx); });
  after(() => fx.cleanup());

  describe('tree', () => {
    test('from the root, the plain render is the whole structure, each node under its parent, with the breadcrumb first', () => {
      const out = lines(runTree(fx.store, { pathArg: '.', ...plain }));
      assert.equal(out[0], 'aperas://tree/.');
      const entries = parseTree(out);
      const pairs = new Map(parentPairs(entries));
      const root = entries[0];
      assert.equal(root.depth, 0);
      assert.equal(root.label, 'FolderNode');
      assert.equal(pairs.get(c.folder), root.id, 'the demo folder is under the root');
      for (const art of [c.alphaArt, c.betaArt, c.gammaArt, c.dupArt]) assert.equal(pairs.get(art), c.folder, `${art} is under the demo folder`);
      assert.equal(pairs.get(c.alpha), c.alphaArt);
      assert.equal(pairs.get(c.alphaSec), c.alpha, 'a second-level heading is under the first');
      assert.equal(pairs.get(c.beta), c.betaArt);
      assert.equal(pairs.get(c.betaSec), c.beta);
      assert.equal(pairs.get(c.betaOther), c.beta);
      assert.equal(pairs.get(c.itemOne), c.dup);
      assert.equal(pairs.get(c.itemTwo), c.dup);
      assert.ok(entries.every((e) => e.id !== ''), 'every line carries an id and a label');
      assert.ok(entries.every((e) => !e.line.includes('║')), 'a plain render shows titles only, no abstract');
    });

    test('the same node is reached by a deep path, a bare code, a full id and the aperas:// forms, and the breadcrumb is its path', () => {
      const byPath = lines(runTree(fx.store, { pathArg: 'cmd_demo/beta.md', ...plain }));
      assert.equal(byPath[0], 'aperas://tree/cmd_demo/beta.md');
      const shape = parentPairs(parseTree(byPath));
      assert.deepEqual(shape.map(([id]) => id), sorted([c.betaArt, c.beta, c.betaSec, c.betaOther]));
      for (const ref of [c.betaArt, c.betaArt.split(':')[1], `aperas://id/${c.betaArt}`, 'aperas://tree/cmd_demo/beta.md']) {
        const out = lines(runTree(fx.store, { pathArg: ref, ...plain }));
        assert.deepEqual(parentPairs(parseTree(out)), shape, `'${ref}' renders the same subtree`);
      }
    });

    test('maxDepth cuts the render at that depth, and a depth past the tree changes nothing', () => {
      const cut = parseTree(lines(runTree(fx.store, { pathArg: 'cmd_demo', maxDepth: 1, ...plain })));
      assert.equal(cut.filter((e) => e.label === 'ArtifactNode').length, 4, 'the four artifacts are at depth 1');
      assert.equal(cut.filter((e) => e.label === 'heading').length, 0, 'no heading is shown below the cut');
      assert.ok(cut.some((e) => e.line.includes('…')), 'a cut is marked');
      const deep = lines(runTree(fx.store, { pathArg: 'cmd_demo', maxDepth: 9, ...plain }));
      assert.deepEqual(deep, lines(runTree(fx.store, { pathArg: 'cmd_demo', ...plain })), 'a depth past the deepest node is the full render');
    });

    test('noHolders hides a placeholder node that a forward reference made, and the default shows it tagged', () => {
      const withHolders = parseTree(lines(runTree(fx.store, { pathArg: 'cmd_demo/gamma.md', ...plain })));
      const holders = withHolders.filter((e) => e.rest.includes('(holder)'));
      assert.equal(holders.length, 1, 'one holder, for NotYetWritten');
      assert.ok(holders[0].rest.startsWith('NotYetWritten'), holders[0].rest);
      const without = parseTree(lines(runTree(fx.store, { pathArg: 'cmd_demo/gamma.md', noHolders: true, showTombstoned: false })));
      assert.equal(without.some((e) => e.id === holders[0].id), false, 'the holder is gone');
      assert.equal(without.length, withHolders.length - 1, 'and nothing else is');
    });

    test('with a view, an unfolded node shows its abstract and a node that is not unfolded does not; the view is created on first use', () => {
      const view = resolveTreeView(fx.store, 'default');
      runUnfold(fx.store, c.alpha, view);
      const out = parseTree(lines(runTree(fx.store, { pathArg: 'cmd_demo/alpha.md', viewRef: 'default', ...plain })));
      const alphaLine = out.find((e) => e.id === c.alpha)!;
      assert.ok(alphaLine.rest.includes('║  To [beta]'), `the unfolded heading shows its text: ${alphaLine.line}`);
      const secLine = out.find((e) => e.id === c.alphaSec)!;
      assert.equal(secLine.rest.includes('║'), true, 'a child of an unfolded node is listed with its abstract');
      const betaOut = parseTree(lines(runTree(fx.store, { pathArg: 'cmd_demo/beta.md', viewRef: 'default', ...plain })));
      assert.ok(betaOut.every((e) => !e.rest.includes('║  Beta section text')), 'a node nobody unfolded keeps to its title');
    });

    test('the links of an unfolded block are lines under it, one for each link, each naming its target', () => {
      const view = resolveTreeView(fx.store, 'default');
      runUnfold(fx.store, c.alphaLinkToBeta, view);
      runUnfold(fx.store, c.alphaLinkToSec, view);
      const out = parseTree(lines(runTree(fx.store, { pathArg: 'cmd_demo/alpha.md', viewRef: 'default', ...plain })));
      const links = out.filter((e) => e.label === 'Link');
      assert.deepEqual(links.map((e) => e.id), [c.alphaLinkToBeta, c.alphaLinkToSec], 'two links, one for each wikilink of the paragraph, in the order of the text');
      const target = (id: string): string => /→ (\S+)/.exec(links.find((e) => e.id === id)!.rest)![1];
      assert.equal(target(c.alphaLinkToBeta), c.betaArt);
      assert.equal(target(c.alphaLinkToSec), c.betaSec);
      const parents = new Map(parentPairs(out));
      assert.equal(parents.get(c.alphaLinkToBeta), c.alpha, 'a link is under the block that holds it');
    });

    test('a node reached through two unfolded links has one canonical place and a pointer at the other', () => {
      const view = resolveTreeView(fx.store, 'default');
      runUnfold(fx.store, c.gamma, view);
      runUnfold(fx.store, c.gammaLinkToSec, view); // alphaLinkToSec is unfolded by the case above: two links reach Beta Section
      const out = parseTree(lines(runTree(fx.store, { pathArg: 'cmd_demo', viewRef: 'default', ...plain })));
      const reaching = out.filter((e) => e.label === 'Link' && e.rest.includes(`→ ${c.betaSec}`));
      assert.deepEqual(reaching.map((e) => e.id), [c.alphaLinkToSec, c.gammaLinkToSec], 'both links are rendered, in the order of the tree');
      const canonical = reaching.filter((e) => e.rest.endsWith('[*]'));
      const pointers = reaching.filter((e) => e.rest.includes('[*see '));
      assert.equal(canonical.length, 1, `exactly one canonical place: ${reaching.map((e) => e.line).join(' / ')}`);
      assert.equal(canonical[0].id, [c.alphaLinkToSec, c.gammaLinkToSec].sort()[0], 'it is the first of the two links in id order');
      assert.equal(pointers.length, 1, 'and one pointer');
      assert.ok(pointers[0].rest.includes(`[*see ${canonical[0].id} (link)]`), `the pointer names the canonical link: ${pointers[0].line}`);
      assert.ok(canonical[0].rest.includes('║  Beta section text.'), 'the canonical place shows the target\'s text');
      assert.ok(!pointers[0].rest.includes('║'), 'the pointer does not repeat it');
    });

    test('render-tree returns the structure as data: the path, the node, its children, and a link with its target', () => {
      const out = runTree(fx.store, { pathArg: 'cmd_demo', viewRef: 'default', format: 'render-tree', ...plain }) as TreeRenderResult;
      assert.equal(out.path, 'cmd_demo');
      assert.ok(out.tree);
      type RNode = { kind: string; id: string; children?: RNode[]; targetId?: string; depth: number };
      const all: RNode[] = [];
      const walk = (n: RNode): void => { all.push(n); for (const k of n.children ?? []) walk(k); };
      walk(out.tree as unknown as RNode);
      assert.equal(all[0].id, c.folder);
      assert.equal(all[0].depth, 0);
      const byId = new Map(all.filter((n) => n.kind === 'node').map((n) => [n.id, n]));
      assert.ok(byId.has(c.alpha) && byId.has(c.alphaSec) && byId.has(c.gamma), 'the unfolded headings are in the structure');
      const linkNodes = all.filter((n) => n.kind === 'link');
      assert.deepEqual(linkNodes.map((n) => n.id), [c.alphaLinkToBeta, c.alphaLinkToSec, c.gammaLinkToSec, linkIdsOf(fx, c.gamma).find((l) => l !== c.gammaLinkToSec)], 'every link of an unfolded block is in the structure, in the order of the text, the one to the holder too');
      assert.equal(linkNodes.find((n) => n.id === c.alphaLinkToBeta)!.targetId, c.betaArt);
    });

    test('refused: a path that resolves to nothing, a view that does not exist, and render-tree without a view', () => {
      refuses(() => runTree(fx.store, { pathArg: 'cmd_demo/nothing-here', ...plain }), /isn't a tracked artifact\/folder path/);
      refuses(() => runTree(fx.store, { pathArg: '.', viewRef: 'no-such-view', ...plain }), /TreeView 'no-such-view' not found/);
      refuses(() => runTree(fx.store, { pathArg: '.', format: 'render-tree', ...plain }), /requires '--view/);
    });
  });

  describe('show', () => {
    test('prints the stored record of a block: its kind, title, text, parent, children and links', () => {
      const rec = runShow(fx.store, c.alpha);
      assert.equal(rec['@id'], c.alpha);
      assert.equal(rec['@type'], 'BlockNode');
      assert.equal(rec.title, '# Alpha');
      assert.equal(rec.text, `To [beta]([[${c.betaArt.split(':')[1]}]]) and [section]([[${c.betaSec.split(':')[1]}]]).`);
      assert.equal(rec.type, 'heading');
      assert.equal(rec.parent, c.alphaArt);
      assert.deepEqual(rec.children, [c.alphaSec]);
      const links = rec.links as Array<{ '@id': string; '@type': string; target: string }>;
      assert.deepEqual(links.map((l) => l.target), [c.betaArt, c.betaSec], 'the links of a record come by id');
      assert.deepEqual(links.map((l) => l['@id']), [c.alphaLinkToBeta, c.alphaLinkToSec].sort());
      assert.ok(links.every((l) => l['@type'] === 'Link'));
    });

    test('prints an artifact with its path and its hashes, and a folder with its path', () => {
      const art = runShow(fx.store, 'cmd_demo/beta.md');
      assert.equal(art['@id'], c.betaArt);
      assert.equal(art['@type'], 'ArtifactNode');
      assert.equal(art.path, 'cmd_demo/beta.md');
      assert.equal(typeof art.fileHash, 'string');
      assert.equal(art.ingestedHash, art.fileHash, 'ingested, so the two hashes agree');
      const folder = runShow(fx.store, 'cmd_demo');
      assert.equal(folder['@id'], c.folder);
      assert.equal(folder.path, 'cmd_demo');
    });

    test('every form of a reference prints the same record', () => {
      const expected = runShow(fx.store, c.betaSec);
      for (const ref of ['cmd_demo/beta.md/Beta/Beta Section', c.betaSec.split(':')[1], `aperas://id/${c.betaSec}`, 'aperas://tree/cmd_demo/beta.md/Beta/Beta-Section']) {
        assert.deepEqual(runShow(fx.store, ref), expected, `'${ref}'`);
      }
    });

    test('refused: a path that resolves to nothing, and an id that no node has', () => {
      refuses(() => runShow(fx.store, 'cmd_demo/nothing-here'), /isn't a tracked artifact\/folder path/);
      refuses(() => runShow(fx.store, 'BlockNode:0000000000000'), /Node 'BlockNode:0000000000000' not found/);
    });
  });

  describe('unfold, read-only (no view)', () => {
    test('peeks a block: its path, its title with the abstract, and its children and links as one-line previews', () => {
      const r = runUnfold(fx.store, c.alpha, null);
      assert.equal(r.id, c.alpha);
      assert.equal(r.label, 'heading');
      assert.equal(r.path, 'cmd_demo/alpha.md/--alpha');
      assert.ok(r.title.startsWith('# Alpha  ║  To [beta]'), r.title);
      const kids = r.children as Array<{ id: string; label: string; text: string }>;
      assert.deepEqual(kids.map((k) => k.id), [c.alphaSec, c.alphaLinkToBeta, c.alphaLinkToSec], 'the child, then the two links in the order of the text');
      assert.equal(kids.find((k) => k.id === c.alphaSec)!.label, 'heading');
      assert.equal(kids.find((k) => k.id === c.alphaLinkToBeta)!.label, 'Link');
      assert.ok(kids.find((k) => k.id === c.alphaLinkToBeta)!.text.startsWith(`→ ${c.betaArt}`));
    });

    test('peeks a link: the target is its one child, with the target\'s own children under it', () => {
      const r = runUnfold(fx.store, c.alphaLinkToBeta, null);
      assert.equal(r.label, 'Link');
      assert.equal(r.title, `→ ${c.betaArt}`);
      assert.equal(r.path, 'cmd_demo/beta.md', 'the breadcrumb is the target\'s path');
      assert.equal(r.children.length, 1);
      const target = r.children[0] as { id: string; children?: Array<{ id: string }> };
      assert.equal(target.id, c.betaArt);
      assert.deepEqual((target.children ?? []).map((k) => k.id), [c.beta]);
    });

    test('a bare peek unfolds nothing', () => {
      const view = resolveTreeView(fx.store, 'default');
      const before = [...((view.unfolds as unknown as Array<{ id: string }> | undefined) ?? [])].map((n) => n.id);
      runUnfold(fx.store, c.betaArt, null);
      runUnfold(fx.store, c.itemOne, null);
      const after = ((resolveTreeView(fx.store, 'default').unfolds as unknown as Array<{ id: string }> | undefined) ?? []).map((n) => n.id);
      assert.deepEqual(after, before);
    });

    test('refused: a path that resolves to nothing, and an id that no node has', () => {
      refuses(() => runUnfold(fx.store, 'cmd_demo/nothing-here', null), /isn't a tracked artifact\/folder path/);
      refuses(() => runUnfold(fx.store, 'BlockNode:0000000000000', null), /Node 'BlockNode:0000000000000' not found/);
    });
  });

  describe('after a removal', () => {
    let removed = '';
    before(() => { removed = runRemove(fx.store, { path: 'cmd_demo/beta.md/Beta/Other' }).id; });

    test('tree hides the tombstoned node by default and shows it tagged with showTombstoned', () => {
      assert.equal(removed, c.betaOther);
      const hidden = parseTree(lines(runTree(fx.store, { pathArg: 'cmd_demo/beta.md', ...plain })));
      assert.equal(hidden.some((e) => e.id === c.betaOther), false);
      assert.ok(hidden.some((e) => e.id === c.betaSec), 'its sibling is still there');
      // A tombstone leaves the list of its container (design/core.md, "Tombstones"): in place there is nothing to show, with or without the flag.
      const shown = parseTree(lines(runTree(fx.store, { pathArg: 'cmd_demo/beta.md', noHolders: false, showTombstoned: true })));
      assert.equal(shown.some((e) => e.id === c.betaOther), false, 'a removed child is not in its container');
      assert.equal(shown.length, hidden.length);
      // A tombstone is shown by its id, tagged.
      const byId = parseTree(lines(runTree(fx.store, { pathArg: c.betaOther, noHolders: false, showTombstoned: true })));
      assert.equal(byId.length, 1);
      assert.ok(byId[0].rest.endsWith('(tombstoned)'), byId[0].line);
    });

    test('show prints a tombstoned node with its tombstonedAt, and a live node without one', () => {
      assert.equal(typeof runShow(fx.store, c.betaOther).tombstonedAt, 'string');
      assert.equal(runShow(fx.store, c.betaSec).tombstonedAt, undefined);
    });

    test('unfold refuses a tombstoned node unless showTombstoned, and does not preview a removed child, which has left its container', () => {
      refuses(() => runUnfold(fx.store, c.betaOther, null), /is tombstoned — pass --tombstoned/);
      const direct = runUnfold(fx.store, c.betaOther, null, true);
      assert.ok(direct.title.endsWith('(tombstoned)'), direct.title);
      const live = runUnfold(fx.store, c.beta, null);
      assert.deepEqual((live.children as Array<{ id: string }>).map((k) => k.id), [c.betaSec], 'the removed child is not previewed');
      const all = runUnfold(fx.store, c.beta, null, true);
      assert.deepEqual((all.children as Array<{ id: string }>).map((k) => k.id), [c.betaSec], 'with the flag too: the removed child is in no list');
    });

    test('a link to a removed node is hidden from the preview of its block unless showTombstoned', () => {
      runRemove(fx.store, { path: 'cmd_demo/beta.md/Beta/Beta Section' });
      const live = runUnfold(fx.store, c.alpha, null).children as Array<{ id: string }>;
      assert.equal(live.some((k) => k.id === c.alphaLinkToSec), false, 'the link to the removed section is not previewed');
      assert.ok(live.some((k) => k.id === c.alphaLinkToBeta), 'the other link is');
      const all = runUnfold(fx.store, c.alpha, null, true).children as Array<{ id: string; text: string }>;
      assert.ok(all.find((k) => k.id === c.alphaLinkToSec)!.text.endsWith('(tombstoned)'));
      assert.deepEqual(idOf(fx, 'cmd_demo/alpha.md/Alpha'), c.alpha, 'resolution of a live node is unaffected');
    });
  });
});
