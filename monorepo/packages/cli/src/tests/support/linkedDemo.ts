// A demo artifact with links, for the tests that need a live block carrying wikilinks
// (view state, garbage collection). Each test file builds its own copy in its own fixture store.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getArtifactsDir } from '@aperas/core/artifacts';
import { trackArtifact, ingestArtifact } from '@aperas/core/shell/artifacts';
import { ingestFolderTree } from '@aperas/core/shell/folders';
import { findByExactPath } from '@aperas/core/shell/tree';
import { wrap, type ArtifactNode } from '@aperas/core/shell/node';
import type { FixtureStore } from './fixture.ts';
import { sampleMarkdown } from './sampleMarkdown.ts';
import { findByText } from './tree.ts';

export interface LinkedDemo {
  demoId: string;
  /** The artifact's own id, the target of the self-link. */
  rootId: string;
  title: string;
  /** The paragraph holding the self-link, the forward reference and the dangling link. */
  linkBlockId: string;
  /** The paragraph that mentions the same target twice. */
  dedupBlockId: string;
}

/**
 * Ingests `sampleMarkdown`, then the same file with two more sections (a self-link, a forward reference, a
 * dangling link, and a paragraph that mentions one target twice), the way a document is edited and
 * re-ingested.
 */
export function ingestLinkedDemo(fx: FixtureStore): LinkedDemo {
  const path = `${fx.demoDir}/demo.md`;
  const file = join(getArtifactsDir(), path);
  const ingest = (markdown: string) => {
    writeFileSync(file, markdown, 'utf-8');
    trackArtifact(fx.store, path);
    ingestFolderTree(fx.store);
    ingestArtifact(fx.store, path);
  };
  ingest(sampleMarkdown);
  const demoId = findByExactPath(fx.store, path);
  if (!demoId) throw new Error('No ArtifactNode found for the demo artifact after ingestion.');
  const artifact = wrap(fx.store, demoId) as unknown as ArtifactNode;
  const rootId = artifact.id;
  const rootBareCode = rootId.split(':')[1];
  ingest(sampleMarkdown + `\n\n## A New Section\n\nA freshly added paragraph.\n\nA [self link]([[${rootBareCode}]]) back to the root, a [forward reference]([[NotYetWritten]]) that should become a holder, and a [truly dangling one]([[../../../../../../nowhere]]) that still can't resolve.\n\n## A Dedup Section\n\nMentioned twice: a [first mention]([[${rootBareCode}]]) and again a [second mention]([[${rootBareCode}]]).`);
  const reingested = wrap(fx.store, demoId) as unknown as ArtifactNode;
  const linkBlock = findByText(reingested, 'self link');
  if (!linkBlock) throw new Error('Expected to find the paragraph containing the self-link.');
  const dedupBlock = findByText(reingested, 'Mentioned twice');
  if (!dedupBlock) throw new Error('Expected to find the paragraph mentioning the same target twice.');
  return { demoId, rootId, title: artifact.title as unknown as string, linkBlockId: linkBlock.id, dedupBlockId: dedupBlock.id };
}
