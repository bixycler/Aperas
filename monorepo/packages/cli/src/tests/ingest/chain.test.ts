// The ingestion chain on one demo artifact (steps 3, 4, 5, 5b, 5c, 5d, 5e, 5f of the legacy suite): track
// and ingest, read the tree back, re-ingest an edited file and reconcile, then the wikilink checks that
// each later re-ingestion builds on (links extraction, regeneration without duplicates, deduplicated
// links with positions, identity kept across an unrelated edit, identity kept across position drift, and the ids of a
// link's position props kept across an unrelated edit).
// The cases share one store, one artifact file and the ids found along the way, and run in order, so the
// file is the unit: a single case cannot run alone.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from 'oxigraph';
import { getArtifactsDir } from '@aperas/core/artifacts';
import { getProps } from '@aperas/core/props';
import { trackArtifact, ingestArtifact } from '@aperas/core/shell/artifacts';
import { ingestFolderTree } from '@aperas/core/shell/folders';
import { findByExactPath } from '@aperas/core/shell/tree';
import { wrap, type ArtifactNode, type BlockNode } from '@aperas/core/shell/node';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';
import { sampleMarkdown } from '../support/sampleMarkdown.ts';
import { collectIds, findByText } from '../support/tree.ts';

type LinkView = { target: BlockNode; id: string };
const linksOf = (store: Store, blockId: string): LinkView[] => ((wrap(store, blockId) as unknown as BlockNode).links as unknown as LinkView[] | undefined) ?? [];
/** The ids of the `position` props of a `Link`, in the order the store gives them (a case compares them as a set). */
const positionPropIds = (link: LinkView): string[] => ((link as unknown as { props?: Array<{ key: string; id?: string }> }).props ?? []).filter((p) => p.key === 'position').map((p) => p.id as string);
const targetId = (l: LinkView): string => (l.target as unknown as { id: string }).id;

describe('ingestion chain', () => {
  let fx: FixtureStore;
  let artifactPath = '';
  let artifactFile = '';
  // State carried from case to case.
  let demoId = '';
  let rootId = '';
  let rootBareCode = '';
  let firstChildId: string | undefined;
  let editedMarkdown = '';
  let thirdMarkdown = '';
  let dedupMarkdown = '';
  let latestMarkdown = '';
  let linkBlockId = '';
  let dedupBlockId = '';
  let wikilinkIdsByTarget = new Map<string, string>();
  let positionPropIdsByTarget = new Map<string, string[]>();
  let dedupLinkId = '';
  let positions: number[] = [];

  /** Writes the artifact file, then tracks, rebuilds the folder tree and ingests, in the order `runIngest` uses. */
  const ingest = (markdown: string) => {
    writeFileSync(artifactFile, markdown, 'utf-8');
    trackArtifact(fx.store, artifactPath);
    ingestFolderTree(fx.store);
    return ingestArtifact(fx.store, artifactPath);
  };

  before(() => {
    fx = makeFixtureStore('ingest_demo');
    artifactPath = `${fx.demoDir}/demo.md`;
    artifactFile = join(getArtifactsDir(), artifactPath);
  });
  after(() => fx.cleanup());

  test('3: tracking and ingesting a demo artifact builds a block tree', () => {
    const result = ingest(sampleMarkdown);
    assert.ok(result, 'ingestArtifact returned a result');
    // The old step printed the count of blocks ingested; the next case reads the tree back.
    assert.ok((result.blockCount ?? 0) > 1, `blocks ingested: ${result.blockCount}`); // new: the count was only printed
  });

  test('4: the ingested tree reads back through wrap()', () => {
    demoId = findByExactPath(fx.store, artifactPath) ?? '';
    assert.ok(demoId, 'an ArtifactNode exists for the demo artifact after ingestion');
    const artifactNode = wrap(fx.store, demoId) as unknown as ArtifactNode;
    assert.notEqual(artifactNode.ingestedHash, undefined, 'the ArtifactNode has ingested content');
    rootId = artifactNode.id;
    rootBareCode = rootId.split(':')[1];
    firstChildId = ((artifactNode.children as unknown as BlockNode[] | undefined)?.[0])?.id;
    // new: the old step printed the count of blocks resolved (and step 1 printed "Ids unique", which was
    // false because a parsed block has no id until ingestion); here the ingested ids are checked.
    const ids = collectIds(artifactNode);
    assert.ok(ids.length > 1, `blocks resolved via wrap(): ${ids.length}`);
    assert.equal(new Set(ids).size, ids.length, 'every ingested block has its own id');
  });

  test('5: re-ingesting an edited file reconciles and keeps identity', () => {
    // The dangling link's `..` count must overshoot past the artifacts root to stay unresolvable: an
    // artifact and its document content are the same node, so a shorter path would land inside it.
    editedMarkdown = sampleMarkdown + `\n\n## A New Section\n\nA freshly added paragraph.\n\nA [self link]([[${rootBareCode}]]) back to the root, a [forward reference]([[NotYetWritten]]) that should become a holder, and a [truly dangling one]([[../../../../../../nowhere]]) that still can't resolve.`;
    const result = ingest(editedMarkdown);
    assert.ok(result?.reconciliation, 'a reconciliation report on re-ingestion of an already-ingested artifact');
    const { matched, added } = result.reconciliation;
    assert.notEqual(matched, 0, 'matched blocks');
    assert.notEqual(added, 0, 'added blocks');
    const ids = new Set(collectIds(wrap(fx.store, demoId)));
    assert.ok(ids.has(rootId), 'the artifact keeps its id');
    if (firstChildId) assert.ok(ids.has(firstChildId), 'the first child keeps its id');
  });

  test('5b: BlockNode.links extraction: self-link, forward reference to a holder, dangling skipped', () => {
    const summary = findByText(wrap(fx.store, demoId), 'self link');
    assert.ok(summary, 'the paragraph containing the self-link');
    linkBlockId = summary.id;
    const links = linksOf(fx.store, linkBlockId);
    assert.equal(links.length, 2, 'two resolved links (self-link and the forward reference); the dangling one is skipped');
    const selfLink = links.find((l) => targetId(l) === rootId);
    assert.ok(selfLink, `a resolved Link targeting ${rootId}`);
    const holderLink = links.find((l) => targetId(l) !== rootId);
    assert.ok(holderLink, 'a second resolved Link targeting a newly created holder');
    const holder = holderLink.target as unknown as { holder?: boolean; title?: string };
    assert.equal(holder.holder, true);
    assert.equal(holder.title, 'NotYetWritten');
  });

  test('5c: wikilink Links are regenerated, not duplicated', () => {
    // The paragraph's own text is unchanged, a heading added elsewhere forces a real file-hash change.
    thirdMarkdown = editedMarkdown + `\n\n## Yet Another Section\n\nUnrelated content, just to force a real file-hash change elsewhere.`;
    const result = ingest(thirdMarkdown);
    assert.ok(result?.reconciliation, 'a reconciliation report on the third ingestion');
    const links = linksOf(fx.store, linkBlockId);
    assert.equal(links.length, 2, 'wikilink Links regenerated, not duplicated');
    // Captured here, checked again in 5e.
    wikilinkIdsByTarget = new Map(links.map((l) => [targetId(l), l.id]));
    positionPropIdsByTarget = new Map(links.map((l) => [targetId(l), positionPropIds(l)]));
  });

  test('5d: the same target twice in one paragraph is one Link carrying two positions', () => {
    dedupMarkdown = thirdMarkdown + `\n\n## A Dedup Section\n\nMentioned twice: a [first mention]([[${rootBareCode}]]) and again a [second mention]([[${rootBareCode}]]).`;
    const result = ingest(dedupMarkdown);
    assert.ok(result?.reconciliation, 'a reconciliation report on the fourth ingestion');
    const summary = findByText(wrap(fx.store, demoId), 'Mentioned twice');
    assert.ok(summary, 'the paragraph mentioning the same target twice');
    dedupBlockId = summary.id;
    const dedupWikilinks = linksOf(fx.store, dedupBlockId);
    assert.equal(dedupWikilinks.length, 1, 'two mentions of one target collapse into one Link');
    positions = getProps(dedupWikilinks[0] as any, 'position').map(Number).sort((a, b) => a - b);
    assert.equal(positions.length, 2, `one 'position' prop per occurrence: ${JSON.stringify(positions)}`);
    const blockText = (wrap(fx.store, dedupBlockId) as unknown as BlockNode).text as unknown as string;
    for (const position of positions) {
      assert.equal(blockText[position], '[', `position ${position} lands on the opening '[' of a link (text: ${JSON.stringify(blockText)})`);
    }
    dedupLinkId = dedupWikilinks[0].id;
  });

  test('5e: a wikilink Link keeps its id across a later, unrelated re-ingestion', () => {
    // 5d added a section elsewhere without touching the self-link paragraph. (The forward reference to
    // "NotYetWritten" is not checked: each ingestion mints a new holder for it, so its target changes.)
    const selfLink = linksOf(fx.store, linkBlockId).find((l) => targetId(l) === rootId);
    assert.ok(selfLink, 'the self-link wikilink Link');
    assert.equal(selfLink.id, wikilinkIdsByTarget.get(rootId));
  });

  test('5f: position drift alone does not change a wikilink Link id', () => {
    // An inserted clause shifts both occurrences without changing the target; `target` is the identity key.
    const driftedMarkdown = dedupMarkdown.replace('Mentioned twice: a [first mention]', 'Mentioned twice: with an inserted clause first, a [first mention]');
    assert.notEqual(driftedMarkdown, dedupMarkdown, 'the dedup paragraph text actually changed');
    latestMarkdown = driftedMarkdown;
    const result = ingest(driftedMarkdown);
    assert.ok(result?.reconciliation, 'a reconciliation report on the fifth ingestion');
    const dedupWikilinks = linksOf(fx.store, dedupBlockId);
    assert.equal(dedupWikilinks.length, 1);
    assert.equal(dedupWikilinks[0].id, dedupLinkId);
    const text = (wrap(fx.store, dedupBlockId) as unknown as BlockNode).text as unknown as string;
    const drifted = getProps(dedupWikilinks[0] as any, 'position').map(Number).sort((a, b) => a - b);
    for (const position of drifted) assert.equal(text[position], '[', `drifted position ${position} still lands on '['`);
    assert.notDeepEqual(drifted, positions, 'the positions actually shifted');
  });

  test('5g: the position props of a wikilink Link keep their ids across a later ingestion of the same paragraph text', () => {
    // The paragraph of 5b has not changed since 5c captured the ids; a heading added elsewhere forces a real file-hash change.
    const before = positionPropIdsByTarget.get(rootId) ?? [];
    assert.ok(before.length > 0 && before.every((id) => typeof id === 'string' && id.length > 0), `the self-link has position props with ids: ${JSON.stringify(before)}`);
    const text = (wrap(fx.store, linkBlockId) as unknown as BlockNode).text as unknown as string;
    const result = ingest(latestMarkdown + `\n\n## One More Section\n\nUnrelated content again, so that the file hash moves and the paragraph is not.\n`);
    assert.ok(result?.reconciliation, 'a reconciliation report on the sixth ingestion');
    assert.equal((wrap(fx.store, linkBlockId) as unknown as BlockNode).text as unknown as string, text, 'the paragraph text is unchanged');
    const selfLink = linksOf(fx.store, linkBlockId).find((l) => targetId(l) === rootId);
    assert.ok(selfLink, 'the self-link wikilink Link');
    assert.equal(selfLink.id, wikilinkIdsByTarget.get(rootId), 'the Link id is the same');
    assert.deepEqual([...positionPropIds(selfLink)].sort(), [...before].sort(), 'its position props are the same nodes, not rewritten ones');
  });
});
