/**
 * Test-only checks for the link refusals, the stored bad-target report of `check-links` and the
 * single-anchor preview rendering (issues/linking.md, issues/treeview.md). Written as functions of a
 * `Store` so `tests/links/refusals.test.ts` runs them on a tiny fixture store, and also runnable on
 * their own on a tiny scratch store (an empty Apeiron directory and a scratch artifacts root, never
 * the real mirror):
 *
 *   tsx packages/cli/src/verifyLinkRefusals.ts
 */

import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from 'oxigraph';
import { collectLinkCodesFromText } from '@aperas/core/astParser';
import { getArtifactsDir } from '@aperas/core/artifacts';
import { rehydrateStore } from '@aperas/core/shell/store';
import { dehydrateToJsonLd, dehydrateStateToJsonLd } from '@aperas/core/shell/dehydrate';
import { trackArtifact, ingestArtifact, resolveBlockLinks, findRefusedLinks } from '@aperas/core/shell/artifacts';
import { checkArtifactLinkIntegrity } from '@aperas/core/shell/linkIntegrity';
import { ingestFolderTree } from '@aperas/core/shell/folders';
import { findByExactPath } from '@aperas/core/shell/tree';
import { wrap, ensureDefaultView, collectOldWikilinksByBlock, type BlockNode, type ApeironNode } from '@aperas/core/shell/node';
import { runInsert } from './kgInsert';
import { runUpdate } from './kgUpdate';

/** Step 5g: refusals on write, set-aside on ingest, `check-links` bad targets. Returns the id of the
 *  cited heading in `link_target.md`, which `checkSingleAnchorRendering` reuses. */
export function checkLinkRefusals(store: Store, DEMO_DIR: string): string {
  const walkBlocks = (n: any, out: any[] = []): any[] => { for (const c of n.treeChildren ?? []) { out.push(c); walkBlocks(c, out); } return out; };
  // Demo files, written under the demo folder so the run's `finally` removes them with the others:
  // a target, a file the refusals are tried against, and a file ingested from disk with a bad link.
  const linkTargetPath = `${DEMO_DIR}/link_target.md`;
  const linkRefsPath = `${DEMO_DIR}/link_refs.md`;
  const linkSkipPath = `${DEMO_DIR}/link_skip.md`;
  writeFileSync(join(getArtifactsDir(), linkTargetPath), "# Link Target\n\nCited paragraph.\n\n## Section A <a name='link-target/section-a' class='aperas-anchor aperas-tree'></a>\n\nSection text.\n", 'utf-8');
  writeFileSync(join(getArtifactsDir(), linkRefsPath), '# Link Refs\n\n- A citing item.\n  - A child that a refused update must not tombstone.\n', 'utf-8');
  for (const path of [linkTargetPath, linkRefsPath]) trackArtifact(store, path);
  ingestFolderTree(store);
  for (const path of [linkTargetPath, linkRefsPath]) ingestArtifact(store, path);
  const linkTargetCitedId: string = walkBlocks(wrap(store, findByExactPath(store, linkTargetPath)!)).find((b) => b.id.startsWith('BlockNode:')).id;
  const citingItem = walkBlocks(wrap(store, findByExactPath(store, linkRefsPath)!)).find((b) => typeof b.text === 'string' && b.text.includes('A citing item'));
  if (!citingItem) throw new Error('Expected to find the list item the refusals are tried against.');
  const ghostId = 'BlockNode:ZZZZZZZZZZZZZ'; // a valid-looking id that no node has
  const goodHref = `./link_target.md#id/${linkTargetCitedId}`;

  // Each of these goes through `runInsert` (the same `resolveBlockLinks` every write path ends in) and
  // must be refused with a message naming the link text and the repeated fragment or the id.
  const refusedCases: Array<{ label: string; href: string; mustMention: string[] }> = [
    { label: 'repeated #id/ (2 ids)', href: `${goodHref}#id/${linkTargetCitedId}`, mustMention: ['repeats the anchor', `#id/${linkTargetCitedId} (2 times)`, '"bad"'] },
    { label: 'repeated #id/ (3 ids, formerly a URIError)', href: `${goodHref}#id/${linkTargetCitedId}#id/${linkTargetCitedId}`, mustMention: ['repeats the anchor', '(3 times)', '"bad"'] },
    { label: 'aperas://id/ spelling, repeated', href: `aperas://id/${linkTargetCitedId}#id/${linkTargetCitedId}`, mustMention: ['repeats the anchor', '"bad"'] },
    { label: 'path#id/ spelling, id names no node', href: `./link_target.md#id/${ghostId}`, mustMention: ['names no node', ghostId, '"bad"'] },
    { label: '[[id]] spelling, id names no node', href: `[[${ghostId}]]`, mustMention: ['names no node', ghostId, '"bad"'] },
    { label: 'aperas://id/ spelling, id names no node', href: `aperas://id/${ghostId}`, mustMention: ['names no node', ghostId, '"bad"'] },
  ];
  // A refused write changes nothing: the block count, the citing item's text and the quad count of the
  // store are the same after as before, for `insert` and for `update` in both modes (the default one
  // would tombstone the child and rewrite the text, --text-only would hydrate the pushed children).
  const subjectCount = (): number => new Set([...store.match(null, null, null, null)].map((q) => q.subject.value).filter((v) => v.includes('BlockNode:'))).size;
  const snapshot = () => ({ quads: store.size, blocks: subjectCount(), text: (wrap(store, citingItem.id) as unknown as BlockNode).text });
  const writes: Array<{ label: string; run: (markdown: string) => unknown }> = [
    { label: 'insert', run: (markdown) => runInsert(store, { path: `aperas://id/${citingItem.id}`, markdown }) },
    { label: 'update', run: (markdown) => runUpdate(store, { path: `aperas://id/${citingItem.id}`, markdown, textOnly: false }) },
    { label: 'update --text-only', run: (markdown) => runUpdate(store, { path: `aperas://id/${citingItem.id}`, markdown, textOnly: true }) },
  ];
  for (const c of refusedCases) {
    for (const write of writes) {
      const before = snapshot();
      let thrown: unknown = null;
      try {
        write.run(`- A [bad](${c.href}) link.\n  - An overflow child.\n`);
      } catch (err) {
        thrown = err;
      }
      if (thrown === null) throw new Error(`Expected ${write.label} to refuse the link (${c.label}), but it stored it.`);
      const message = (thrown as Error).message;
      if (thrown instanceof URIError) throw new Error(`Expected a clear refusal for ${c.label} (${write.label}), got a URIError: ${message}`);
      for (const needle of c.mustMention) {
        if (!message.includes(needle)) throw new Error(`Expected the ${write.label} refusal for ${c.label} to mention ${JSON.stringify(needle)}, got: ${message}`);
      }
      const after = snapshot();
      if (after.quads !== before.quads || after.blocks !== before.blocks || after.text !== before.text) {
        throw new Error(`Expected the refused ${write.label} (${c.label}) to change nothing, got ${JSON.stringify(before)} -> ${JSON.stringify(after)}.`);
      }
    }
  }
  console.log(`   - Writer: ${refusedCases.length} refused spellings x ${writes.length} writes (insert, update, update --text-only), each naming the link text and the repeated fragment or the id (no URIError), each leaving the block count, the item text and the quad count as they were.`);

  // A link to a not-yet-existing deep path still places a holder, and a single good anchor is stored.
  const okInsert = runInsert(store, { path: `aperas://id/${citingItem.id}`, markdown: `- A [deep]([[/${DEMO_DIR}/not_yet_written.md/Nowhere]]) and a [good](${goodHref}).\n` });
  const okId = okInsert.lines[0].split(/\s+/)[0].replace('aperas://id/', '');
  const okTargets = (((wrap(store, okId) as unknown as BlockNode).links as unknown as Array<{ target: { id: string; holder?: boolean } }>) ?? []).map((l) => l.target);
  if (!okTargets.some((t) => t.id === linkTargetCitedId)) throw new Error(`Expected the single-anchor link to be stored on ${linkTargetCitedId}, got ${JSON.stringify(okTargets.map((t) => t.id))}.`);
  if (!okTargets.some((t) => t.holder === true)) throw new Error(`Expected the deep-path link to a non-existing target to place a holder, got ${JSON.stringify(okTargets)}.`);
  console.log(`   - A deep path to a non-existing target still places a holder; a single anchor still links (${okTargets.length} Link(s) stored).`);

  // Ingest from disk never throws on such a link: it sets it aside (no Link, a warning) and finishes.
  writeFileSync(join(getArtifactsDir(), linkSkipPath), `# Link Skip\n\n- Cites [one](${goodHref}) and a [bad](${goodHref}#id/${linkTargetCitedId}) one.\n`, 'utf-8');
  trackArtifact(store, linkSkipPath);
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => { warnings.push(a.join(' ')); };
  let skipIngest;
  try { skipIngest = ingestArtifact(store, linkSkipPath); } finally { console.warn = realWarn; }
  if (!skipIngest || skipIngest.linkResolution.resolved !== 1) throw new Error(`Expected the ingest to store the one good link and set the bad one aside, got ${JSON.stringify(skipIngest?.linkResolution)}.`);
  if (!warnings.some((w) => w.includes('repeats the anchor') && w.includes('"bad"'))) throw new Error(`Expected a warning naming the set-aside link, got ${JSON.stringify(warnings)}.`);
  console.log('   - Ingest from disk: 1 link stored, the repeated-anchor one set aside with a warning.');

  // A bad link in a folder README's description is set aside the same way: a warning, and
  // `ingestFolderTree` completes (it would otherwise throw out of the whole folder ingest).
  const folderDir = join(getArtifactsDir(), DEMO_DIR, 'folder_bad');
  mkdirSync(folderDir, { recursive: true });
  writeFileSync(join(folderDir, 'README.md'), `---\ndescription: See [bad](${goodHref}#id/${linkTargetCitedId}) here.\n---\n\n# Folder Bad\n`, 'utf-8');
  const folderWarnings: string[] = [];
  console.warn = (...a: unknown[]) => { folderWarnings.push(a.join(' ')); };
  let folderResult;
  try { folderResult = ingestFolderTree(store); } finally { console.warn = realWarn; }
  if (!folderResult || folderResult.folderCount < 1) throw new Error(`Expected ingestFolderTree to complete, got ${JSON.stringify(folderResult)}.`);
  if (!folderWarnings.some((w) => w.includes('repeats the anchor') && w.includes('"bad"'))) throw new Error(`Expected a warning naming the set-aside folder description link, got ${JSON.stringify(folderWarnings)}.`);
  console.log('   - Folder description: the repeated-anchor link set aside with a warning and ingestFolderTree completed.');

  // Stored bad targets are reported with block, kind, link text and target. A stored Link is not refused
  // again for a block that already has it, and re-resolving that block (what --repair does) leaves it as is.
  const skipArtifactId = findByExactPath(store, linkSkipPath)!;
  const badBlock = wrap(store, walkBlocks(wrap(store, skipArtifactId)).find((b) => typeof b.text === 'string' && b.text.includes('[bad]')).id) as unknown as BlockNode;
  const badText = badBlock.text as string;
  const doubledTarget = `${linkTargetCitedId}#id/${linkTargetCitedId}`;
  const keptLinkIds = ((badBlock.links as unknown as Array<{ id: string }>) ?? []).map((l) => l.id);
  const badLinkId = badBlock.mintWikilink(doubledTarget, [badText.indexOf('[bad]')]);
  const ghostLinkId = badBlock.mintWikilink(ghostId, []);
  badBlock.links = [...keptLinkIds, badLinkId, ghostLinkId] as unknown as ApeironNode[];
  const found = checkArtifactLinkIntegrity(store, skipArtifactId).unresolvedTargets;
  const repeatedFound = found.find((u) => u.linkId === badLinkId);
  const unknownFound = found.find((u) => u.linkId === ghostLinkId);
  if (found.length !== 2 || !repeatedFound || !unknownFound) throw new Error(`Expected exactly the two planted bad targets to be reported, got ${JSON.stringify(found)}.`);
  if (repeatedFound.kind !== 'repeated-anchor' || repeatedFound.targetId !== doubledTarget || repeatedFound.linkText !== 'bad' || repeatedFound.blockId !== badBlock.id) {
    throw new Error(`Expected the doubled target to be reported as a repeated anchor on ${badBlock.id} with text "bad", got ${JSON.stringify(repeatedFound)}.`);
  }
  if (unknownFound.kind !== 'id-names-no-node' || unknownFound.targetId !== ghostId) throw new Error(`Expected the ghost target to be reported as an id naming no node, got ${JSON.stringify(unknownFound)}.`);
  const pendingForBlock = [{ blockId: badBlock.key, codes: collectLinkCodesFromText(badText) }];
  const oldWikilinks = new Map<string, Array<{ id: string; target: string; positions: number[] }>>();
  collectOldWikilinksByBlock(badBlock, oldWikilinks, false);
  if (findRefusedLinks(store, pendingForBlock).length !== 1) throw new Error('Expected the doubled code to be refused for a block that has no such Link yet.');
  if (findRefusedLinks(store, pendingForBlock, oldWikilinks).length !== 0) throw new Error('Expected the doubled code not to be refused again for a block that already stores that very Link.');
  resolveBlockLinks(store, pendingForBlock, undefined, oldWikilinks, skipArtifactId, 'skip');
  const afterLinkIds = (((wrap(store, badBlock.id) as unknown as BlockNode).links as unknown as Array<{ id: string }>) ?? []).map((l) => l.id);
  if (!afterLinkIds.includes(badLinkId)) throw new Error('Expected re-resolving the block to leave its stored bad Link in place.');
  // Remove what was planted, so the dehydrate round-trip below sees no dangling reference.
  (wrap(store, badBlock.id) as unknown as BlockNode).links = undefined;
  console.log('   - check-links: both planted targets reported (repeated-anchor and id-names-no-node, with block and link text); re-resolving the block left its stored Link in place.');

  return linkTargetCitedId;
}

/** Step 13: a link that already carries `#id/<id>` renders with that one anchor, never two; a bare
 *  `./file.md` link still gets its target id baked in. Needs `checkLinkRefusals` to have run first. */
export function checkSingleAnchorRendering(store: Store, DEMO_DIR: string, linkTargetCitedId: string): void {
  const walkBlocks = (n: any, out: any[] = []): any[] => { for (const c of n.treeChildren ?? []) { out.push(c); walkBlocks(c, out); } return out; };
  // A link that already carries `#id/<id>` must render with that one anchor, never two; a bare `./file.md`
  // link still gets its target id baked in.
  const linkRenderPath = `${DEMO_DIR}/link_render.md`;
  // Three hrefs on one line: a bare path (baked), `path#id/X` (kept as written) and `path#slug` (baked, as
  // it was before the single-anchor change).
  writeFileSync(join(getArtifactsDir(), linkRenderPath), `# Link Render\n\n- Cites [one](./link_target.md#id/${linkTargetCitedId}) and [two](./link_target.md) and [three](./link_target.md#link-target/section-a) here.\n`, 'utf-8');
  trackArtifact(store, linkRenderPath);
  ingestArtifact(store, linkRenderPath);
  const renderedItem = walkBlocks(wrap(store, findByExactPath(store, linkRenderPath)!)).find((b) => typeof b.text === 'string' && b.text.includes('[one]'));
  if (!renderedItem) throw new Error('Expected to find the list item citing the target.');
  const renderingView = ensureDefaultView(store);
  renderingView.unfold(renderedItem.id);
  const renderedLine = (wrap(store, renderedItem.id) as unknown as BlockNode).renderTree({ view: renderingView, maxDepth: 0 })[0];
  const renderedAnchors = renderedLine.split('#id/').length - 1;
  const citedAnchors = renderedLine.split(`#id/${linkTargetCitedId}`).length - 1;
  if (!renderedLine.includes(`[one](./link_target.md#id/${linkTargetCitedId})`) || citedAnchors < 1) {
    throw new Error(`Expected [one], which carries #id/ already, to render as written, got: ${renderedLine}`);
  }
  if (!/\[two\]\(\.\/link_target\.md#id\/ArtifactNode:[^)#]+\)/.test(renderedLine)) throw new Error(`Expected the bare [two] to be baked with the target artifact's id, got: ${renderedLine}`);
  if (!/\[three\]\(\.\/link_target\.md#link-target\/section-a#id\/[^)#]+\)/.test(renderedLine)) throw new Error(`Expected [three] (path#slug) to be baked as before, got: ${renderedLine}`);
  if (renderedAnchors !== 3) throw new Error(`Expected 3 anchors in all (one kept, two baked), none doubled, got ${renderedAnchors}: ${renderedLine}`);
  console.log(`   - ${renderedAnchors} anchors on a line with a path#id/ link (kept), a bare path (baked) and a path#slug (baked); none doubled.`);
}

if (typeof process !== 'undefined' && process.argv[1]?.endsWith('verifyLinkRefusals.ts')) {
  const root = mkdtempSync(join(tmpdir(), 'link-refusals-'));
  process.env.APERAS_APEIRON_ROOT = join(root, 'Apeiron');
  process.env.APERAS_ARTIFACTS_ROOT = join(root, 'artifacts');
  mkdirSync(join(process.env.APERAS_APEIRON_ROOT, '.state'), { recursive: true });
  dehydrateToJsonLd(new Store(), process.env.APERAS_APEIRON_ROOT); // an empty but well-formed Apeiron directory
  dehydrateStateToJsonLd(new Store(), join(process.env.APERAS_APEIRON_ROOT, '.state'));
  const DEMO = 'link_demo';
  mkdirSync(join(getArtifactsDir(), DEMO), { recursive: true });
  const t0 = performance.now();
  try {
    const { store } = rehydrateStore();
    const cited = checkLinkRefusals(store, DEMO);
    checkSingleAnchorRendering(store, DEMO, cited);
    console.log(`[link-refusals] all checks passed, ${(performance.now() - t0).toFixed(0)} ms`);
  } catch (err) {
    console.error('[link-refusals] FAILED:', (err as Error).message);
    process.exitCode = 1;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
