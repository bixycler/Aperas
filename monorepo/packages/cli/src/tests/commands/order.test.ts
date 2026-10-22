// The orders the shell promises (planning/core.md, Batch 11 step 3 and 6; design/core.md, "Where an order shows", "The order of links without a position", "The canonical place in the render"):
//   - the canonical place of a node reached through several unfolded links is the first in code-point order of the unfolded ids, whatever order the view
//     lists them in and whatever order the nodes were built in;
//   - the links of a block come by `position` (a number), then id, a link with no `position` after those with one, in `tree`, `unfold`, `render-tree`
//     and `check-links`;
//   - the five listings are sorted by id: `check-links`, `track --reverse`, the profiles, the views (and the unfolded ids of one), and `backlinks`.
// The nodes of the second and third part are made with chosen ids, in the opposite order of their ids, so that an order of insertion cannot pass for a sort.
// The store is the fixture's: scratch roots, nothing of the real mirror.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { compareIds } from '@aperas/core/apeironNgn/order';
import { checkLinkIntegrity } from '@aperas/core/shell/linkIntegrity';
import { createNode, linksInOrder, resolveTreeView, wrap, type ArtifactNode, type BlockNode, type Link, type Profile, type TreeNode, type TreeView, type ApeironNode } from '@aperas/core/shell/node';
import { runBacklinks } from '../../kgBacklinks';
import { runProfileCreate, runProfileCreateView, runProfileList, runProfileListView } from '../../kgProfile';
import { runIngest } from '../../kgIngest';
import { runTree, type TreeRenderResult } from '../../kgTree';
import { runReverseTrack } from '../../kgTrack';
import { runUnfold } from '../../kgUnfold';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';
import { idOf as chosenId } from '../support/mirrorFixture.ts';
import { idOf, linkIdsOf, linkTargetOf, parseTree, writeArtifact } from '../support/commandsCorpus.ts';

const plain = { noHolders: false, showTombstoned: false };
const bare = (id: string): string => id.split(':')[1];
const asNodes = (ids: readonly string[]): ApeironNode[] => ids as unknown as ApeironNode[];
const ascending = (xs: readonly string[]): string[] => [...xs].sort(compareIds);
const lines = (r: string[] | TreeRenderResult): string[] => {
  assert.ok(Array.isArray(r), 'the text format returns lines');
  return r;
};

describe('orders of the shell', () => {
  let fx: FixtureStore;
  before(() => { fx = makeFixtureStore('ord_demo'); });
  after(() => fx.cleanup());

  const ingest = (...paths: string[]): void => { runIngest(fx.store, paths, true, false); };
  const view = (name: string): TreeView => {
    if (name === 'default') return resolveTreeView(fx.store, 'default');
    runProfileCreateView(fx.store, name, 'ord');
    return resolveTreeView(fx.store, name);
  };
  /** A view named `name` with exactly `refs` unfolded, in that order, and the text its render from `apex` gives. */
  const render = (name: string, apex: string, refs: readonly string[]): string[] => {
    const v = view(name);
    for (const ref of refs) runUnfold(fx.store, ref, v);
    return lines(runTree(fx.store, { pathArg: apex, viewRef: name, ...plain }));
  };
  /** The `Link` lines of a render that reach `target`, with whether each is the canonical place (`[*]`) or the pointer (`[*see …]`). */
  const reaching = (out: readonly string[], target: string): Array<{ id: string; canonical: boolean; pointsTo?: string }> =>
    parseTree(out).filter((e) => e.label === 'Link' && e.rest.includes(`→ ${target}`)).map((e) => ({
      id: e.id,
      canonical: e.rest.endsWith('[*]'),
      pointsTo: /\[\*see (\S+) \(link\)\]/.exec(e.rest)?.[1],
    }));

  before(() => {
    runProfileCreate(fx.store, 'ord');
  });

  describe('the canonical place of a node reached through several unfolded links', () => {
    interface Doc { art: string; x: string; y: string; lxT: string; lxO: string; lyT: string; lyO: string }
    let tId: string;
    let oId: string;
    let older: Doc; // the block Y is built first and X is added before it: the tree lists X, then Y, and the id of Y is the lower
    let newer: Doc; // X is built first, then Y: the tree and the ids agree

    const para = (): string => `To [t]([[${bare(tId)}]]) and [o]([[${bare(oId)}]]).`;
    /** Builds `ord_demo/<file>` in two ingests: the blocks `first` (titled), then, in the tree before or after it, `added`. */
    function buildDoc(file: string, first: string, added: string, addedBefore: boolean): Doc {
      const section = (title: string): string => `## ${title}\n\n${para()}\n`;
      writeArtifact(fx, `ord_demo/${file}`, `# Doc\n\n${section(first)}`);
      ingest(`ord_demo/${file}`);
      writeArtifact(fx, `ord_demo/${file}`, `# Doc\n\n${addedBefore ? section(added) + '\n' + section(first) : section(first) + '\n' + section(added)}`);
      ingest(`ord_demo/${file}`);
      const x = idOf(fx, `ord_demo/${file}/Doc/X`);
      const y = idOf(fx, `ord_demo/${file}/Doc/Y`);
      const linkTo = (block: string, target: string): string => {
        const l = linkIdsOf(fx, block).find((id) => linkTargetOf(fx, block, id) === target);
        assert.ok(l, `${block} links to ${target}`);
        return l;
      };
      return { art: idOf(fx, `ord_demo/${file}`), x, y, lxT: linkTo(x, tId), lxO: linkTo(x, oId), lyT: linkTo(y, tId), lyO: linkTo(y, oId) };
    }

    before(() => {
      writeArtifact(fx, 'ord_demo/target.md', '# Target\n\n## Target Section\n\nTarget text.\n');
      writeArtifact(fx, 'ord_out/out.md', '# Out\n\n## Out Section\n\nOut text.\n');
      ingest('ord_demo/target.md', 'ord_out/out.md');
      tId = idOf(fx, 'ord_demo/target.md/Target/Target Section');
      oId = idOf(fx, 'ord_out/out.md/Out/Out Section');
      older = buildDoc('older.md', 'Y', 'X', true);
      newer = buildDoc('newer.md', 'X', 'Y', false);
    });

    test('the two documents are built so that the order of the tree and the order of the ids disagree in one and agree in the other', () => {
      assert.ok(older.y < older.x, 'older: the block Y has the lower id');
      const tree = parseTree(lines(runTree(fx.store, { pathArg: 'ord_demo/older.md', ...plain })));
      assert.deepEqual(tree.filter((e) => e.id === older.x || e.id === older.y).map((e) => e.id), [older.x, older.y], 'older: the tree lists X, then Y');
      assert.ok(newer.x < newer.y, 'newer: the block X has the lower id');
    });

    for (const [name, pick] of [['older', () => older], ['newer', () => newer]] as const) {
      test(`${name}: a target outside the cone is claimed by the first of the links in id order, under either order of the view's unfolds`, () => {
        const d = pick();
        const refs = [d.lxT, d.lxO, d.lyT, d.lyO, d.x, d.y];
        const forward = render(`esc-${name}-forward`, `ord_demo/${name}.md`, refs);
        const backward = render(`esc-${name}-backward`, `ord_demo/${name}.md`, [...refs].reverse());
        const raw = (n: string): string[] => ((resolveTreeView(fx.store, n).unfolds as unknown as ApeironNode[] | undefined) ?? []).map((u) => u.id);
        assert.notDeepEqual(raw(`esc-${name}-forward`), raw(`esc-${name}-backward`), 'the two views list the same ids in two orders');
        assert.deepEqual(ascending(raw(`esc-${name}-forward`)), ascending(raw(`esc-${name}-backward`)));
        assert.deepEqual(forward, backward, 'the render is the same');
        for (const [target, ids] of [[oId, [d.lxO, d.lyO]], [tId, [d.lxT, d.lyT]]] as const) {
          const found = reaching(forward, target);
          const first = ascending(ids)[0];
          assert.deepEqual(found.map((f) => f.id).sort(compareIds), ascending(ids), `both links to ${target} are rendered`);
          assert.deepEqual(found.filter((f) => f.canonical).map((f) => f.id), [first], `the canonical place of ${target} is the first in id order`);
          assert.deepEqual(found.filter((f) => !f.canonical).map((f) => f.pointsTo), [first], 'the other is a pointer to it');
        }
      });

      test(`${name}: a target inside the cone is claimed by the first of the links in id order, under either order of the view's unfolds`, () => {
        const d = pick();
        const refs = [d.lxT, d.lyT, d.x, d.y];
        const forward = render(`in-${name}-forward`, 'ord_demo', refs);
        const backward = render(`in-${name}-backward`, 'ord_demo', [...refs].reverse());
        assert.deepEqual(forward, backward, 'the render is the same');
        const found = reaching(forward, tId);
        const first = ascending([d.lxT, d.lyT])[0];
        assert.deepEqual(found.filter((f) => f.canonical).map((f) => f.id), [first]);
        assert.deepEqual(found.filter((f) => !f.canonical).map((f) => f.pointsTo), [first]);
      });
    }

    test('with the links of both documents unfolded, the render is the same under either order and the lowest id of the four claims', () => {
      const refs = [older.lxT, older.lyT, newer.lxT, newer.lyT, older.x, older.y, newer.x, newer.y];
      const forward = render('both-forward', 'ord_demo', refs);
      const backward = render('both-backward', 'ord_demo', [...refs].reverse());
      assert.deepEqual(forward, backward);
      const found = reaching(forward, tId);
      assert.equal(found.length, 4);
      assert.deepEqual(found.filter((f) => f.canonical).map((f) => f.id), [ascending([older.lxT, older.lyT, newer.lxT, newer.lyT])[0]]);
    });
  });

  describe('the links of a block', () => {
    let block: string;
    let expected: string[];
    let zId: string;

    before(() => {
      const tId = idOf(fx, 'ord_demo/target.md/Target/Target Section');
      const [a, b, c, d, e] = [idOf(fx, 'ord_demo/target.md'), idOf(fx, 'ord_out/out.md'), idOf(fx, 'ord_demo/older.md'), idOf(fx, 'ord_demo/newer.md'), idOf(fx, 'ord_out')];
      zId = idOf(fx, 'ord_demo/older.md/Doc/Y');
      block = tId;
      const b0 = wrap(fx.store, block) as unknown as BlockNode;
      // Minted one after the other, so their ids rise in this order; their places by position are another order, and the numbers 9, 10 and 100 tell a number from a string.
      const none = b0.mintWikilink(a, []);
      const at100 = b0.mintWikilink(b, [100]);
      const at10 = b0.mintWikilink(c, [10]);
      const multi = b0.mintWikilink(d, [40, 3]);
      const at9 = b0.mintWikilink(e, [9]);
      b0.links = asNodes([none, at100, at10, multi, at9]);
      b0.text = `Target text, and [z]([[${bare(zId)}]]) that no link of this block holds.`;
      expected = [multi, at9, at10, at100, none];
      assert.deepEqual([none, at100, at10, multi, at9], ascending([none, at100, at10, multi, at9]), 'the ids rise in the order of minting');
    });

    test('linksInOrder gives them by position as a number, a link of several positions at its first, a link with none last', () => {
      assert.deepEqual(linksInOrder(wrap(fx.store, block) as unknown as { links?: ApeironNode[] }).map((l: Link) => l.id), expected);
    });

    test('tree lists them in that order under the unfolded block', () => {
      const v = view('links-tree');
      runUnfold(fx.store, block, v);
      const out = parseTree(lines(runTree(fx.store, { pathArg: 'ord_demo/target.md', viewRef: 'links-tree', ...plain })));
      assert.deepEqual(out.filter((e) => e.label === 'Link').map((e) => e.id), expected);
    });

    test('render-tree, the structured form the web reads, lists them in that order', () => {
      const out = runTree(fx.store, { pathArg: 'ord_demo/target.md', viewRef: 'links-tree', format: 'render-tree', ...plain }) as TreeRenderResult;
      type RNode = { kind: string; id: string; children?: RNode[] };
      const found: string[] = [];
      const walk = (n: RNode): void => { if (n.kind === 'link') found.push(n.id); for (const k of n.children ?? []) walk(k); };
      walk(out.tree as unknown as RNode);
      assert.deepEqual(found, expected);
    });

    test('unfold lists them in that order, after the children', () => {
      const r = runUnfold(fx.store, block, null);
      assert.deepEqual((r.children as Array<{ id: string; label: string }>).filter((k) => k.label === 'Link').map((k) => k.id), expected);
    });

    test('check-links lists the links of a block it reports in that order', () => {
      const report = checkLinkIntegrity(fx.store);
      const found = report.discrepancies.find((d) => d.blockId === block);
      assert.ok(found, 'the block cites a target its links do not hold');
      assert.deepEqual(found.resolvedLinks.map((l) => l.id), expected);
    });

    test('the links of an expanded link are the links of its target, in that order', () => {
      const v = view('links-expanded');
      const via = idOf(fx, 'ord_demo/older.md/Doc/Y');
      const link = linkIdsOf(fx, via).find((l) => linkTargetOf(fx, via, l) === block);
      assert.ok(link, 'the block Y of the older document links to the block');
      runUnfold(fx.store, via, v); // the block shows its links
      runUnfold(fx.store, link, v);
      const out = parseTree(lines(runTree(fx.store, { pathArg: 'ord_demo', viewRef: 'links-expanded', ...plain })));
      const at = out.findIndex((e) => e.id === link);
      assert.ok(at >= 0, 'the link is rendered');
      const inside: string[] = [];
      for (const e of out.slice(at + 1)) {
        if (e.depth <= out[at].depth) break;
        if (e.label === 'Link' && e.depth === out[at].depth + 1) inside.push(e.id);
      }
      assert.deepEqual(inside, expected);
    });

    test('the dangling links of a block are reported in the order of their positions, not of their ids, each with the text at its first position', () => {
      const b = wrap(fx.store, zId) as unknown as BlockNode;
      b.text = '[a](u) and [b](v) and [c](w)';
      const first = b.mintWikilink(chosenId('BlockNode', 900), [22]);
      const second = b.mintWikilink(chosenId('BlockNode', 901), [11, 0]);
      assert.ok(first < second);
      b.links = asNodes([first, second]);
      const mine = checkLinkIntegrity(fx.store).unresolvedTargets.filter((u) => u.blockId === zId);
      assert.deepEqual(mine.map((u) => [u.linkId, u.linkText]), [[second, 'a'], [first, 'c']]);
    });
  });

  describe('the listings', () => {
    const created = (...ns: number[]): number[] => ns;

    test('profiles: listed by id, whatever order they were made in; the views of one by id; its preferences by id', () => {
      const made = created(7, 3, 5).map((n) => {
        const id = chosenId('Profile', n);
        (createNode(fx.store, id) as unknown as Profile).handle = `h${n}`;
        return id;
      });
      const all = runProfileList(fx.store);
      assert.ok('profiles' in all);
      const ids = all.profiles.map((p) => p.id);
      assert.deepEqual(ids, ascending(ids), 'the whole list is in id order');
      assert.deepEqual(ids.filter((id) => made.includes(id)), [chosenId('Profile', 3), chosenId('Profile', 5), chosenId('Profile', 7)]);

      const owner = chosenId('Profile', 3);
      const views = created(9, 2, 6).map((n) => {
        const id = chosenId('TreeView', n);
        const v = createNode(fx.store, id) as unknown as TreeView;
        v.name = `w${n}`;
        v.profile = owner as unknown as Profile;
        return id;
      });
      const detail = runProfileList(fx.store, 'h3');
      assert.ok(!('profiles' in detail));
      assert.deepEqual(detail.views.map((v) => v.id), [chosenId('TreeView', 2), chosenId('TreeView', 6), chosenId('TreeView', 9)]);
      assert.equal(views.length, 3);

      const prefs = created(8, 2, 5).map((n) => {
        const id = `${owner}:preferences:StringProp:${bare(chosenId('StringProp', n))}`;
        const p = createNode(fx.store, id, { under: owner }) as unknown as { key: string; value: string };
        p.key = `k${n}`;
        p.value = `v${n}`;
        return id;
      });
      (wrap(fx.store, owner) as unknown as Profile).preferences = asNodes(prefs);
      assert.deepEqual((runProfileList(fx.store, 'h3') as { preferences: Array<{ key: string }> }).preferences.map((p) => p.key), ['k2', 'k5', 'k8']);
    });

    test('views: listed by id; the unfolded ids of one by id', () => {
      const all = runProfileListView(fx.store);
      assert.ok('views' in all);
      const ids = all.views.map((v) => v.id);
      assert.ok(ids.length > 6);
      assert.deepEqual(ids, ascending(ids), 'the whole list is in id order');
      const unfolded = created(40, 10, 30).map((n) => chosenId('BlockNode', n));
      for (const id of unfolded) createNode(fx.store, id, { under: idOf(fx, 'ord_demo/target.md') });
      (resolveTreeView(fx.store, 'w9') as unknown as TreeView).unfolds = asNodes(unfolded);
      const detail = runProfileListView(fx.store, 'w9');
      assert.ok(!('views' in detail));
      assert.deepEqual(detail.unfolds, ascending(unfolded));
    });

    test('backlinks: by the id of the link, whatever order the links were made in', () => {
      const target = idOf(fx, 'ord_demo/target.md/Target/Target Section');
      const links = created(9, 1, 5).map((n) => {
        const owner = chosenId('BlockNode', n);
        createNode(fx.store, owner, { under: idOf(fx, 'ord_demo/target.md') });
        const link = `${owner}:links:Link:${bare(chosenId('Link', n))}`;
        (createNode(fx.store, link, { under: owner }) as unknown as Link).target = target as unknown as TreeNode;
        (wrap(fx.store, owner) as unknown as BlockNode).links = asNodes([link]);
        return link;
      });
      const found = runBacklinks(fx.store, target, false).map((b) => b.linkId);
      assert.deepEqual(found, ascending(found), 'the whole list is in id order');
      assert.deepEqual(found.filter((l) => links.includes(l)), ascending(links));
    });

    describe('with artifacts and blocks of chosen ids', () => {
      const artifacts = created(8, 3, 6);
      const artId = (n: number): string => chosenId('ArtifactNode', n);
      const blockId = (n: number): string => chosenId('BlockNode', 100 + n);
      const path = (n: number): string => `ord_demo/t${n}.md`;
      const code = (): string => `[z]([[${bare(idOf(fx, 'ord_demo/older.md/Doc/Y'))}]])`;

      before(() => {
        for (const n of artifacts) {
          const art = createNode(fx.store, artId(n), { path: path(n) }) as unknown as ArtifactNode;
          art.title = `t${n}.md`;
          art.path = path(n);
          const b = createNode(fx.store, blockId(n), { under: artId(n) }) as unknown as BlockNode;
          b.type = 'paragraph';
          b.title = `block ${n}`;
          b.text = `see ${code()}`;
          art.children = [blockId(n)] as unknown as TreeNode[];
          if (n !== 6) art.projectedHash = 'stale';
        }
      });

      test('track --reverse: never projected and changed, each by id', () => {
        const r = runReverseTrack(fx.store);
        const mine = (xs: Array<{ path: string; kind: string }>): string[] => xs.filter((e) => /^ord_demo\/t\d\.md$/.test(e.path)).map((e) => e.path);
        assert.deepEqual(mine(r.neverProjected), [path(6)]);
        assert.deepEqual(mine(r.changed), [path(3), path(8)]);
        const kinds = r.neverProjected.map((e) => e.kind);
        assert.deepEqual(kinds, [...kinds].sort(), 'the artifacts come before the folders, as their ids do');
      });

      test('check-links: the discrepancies by the id of the block, the dangling links by the id of the block', () => {
        for (const n of [8, 3]) {
          const b = wrap(fx.store, blockId(n)) as unknown as BlockNode;
          const dangling = b.mintWikilink(chosenId('BlockNode', 950 + n), [1]);
          b.links = asNodes([dangling]);
        }
        const report = checkLinkIntegrity(fx.store);
        const discrepant = report.discrepancies.map((d) => d.blockId);
        assert.deepEqual(discrepant, ascending(discrepant), 'the discrepancies are in id order');
        assert.deepEqual(discrepant.filter((id) => artifacts.some((n) => id === blockId(n))), [blockId(3), blockId(6), blockId(8)]);
        const dangling = report.unresolvedTargets.map((u) => u.blockId);
        assert.deepEqual(dangling, ascending(dangling), 'the dangling links are in id order of their blocks');
        assert.deepEqual(dangling.filter((id) => artifacts.some((n) => id === blockId(n))), [blockId(3), blockId(8)]);
      });
    });
  });
});
