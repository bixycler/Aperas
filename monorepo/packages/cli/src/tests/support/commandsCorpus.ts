// A small corpus for the tests of the commands (`tree`, `show`, `unfold`, `path`, `resolve`, `fold`, `zoom`, `profile`, `remove`, `insert`, `track`, `project`):
// four artifacts under one folder, built through `runIngest` and read back through `runResolve` and `runShow`, so a file that uses
// it touches the store through `fx.store`, `wrap` and the `runX` functions only.
//
//   cmd_demo/beta.md   # Beta ( ## Beta Section, ## Other )
//   cmd_demo/alpha.md  # Alpha ( ## Alpha Sec ), whose paragraph links to beta.md and to Beta Section
//   cmd_demo/gamma.md  # Gamma, whose paragraph links to Beta Section too, and to a title that has no node yet (a holder)
//   cmd_demo/dup.md    # Dup ( ## Item One, ## Item Two ), two siblings that share a prefix
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runIngest } from '../../kgIngest';
import { runProject } from '../../kgProject';
import { runResolve } from '../../kgResolve';
import { runShow } from '../../kgShow';
import type { FixtureStore } from './fixture.ts';

/** Writes `text` to the artifact file `path` (relative to the artifacts root). */
export function writeArtifact(fx: FixtureStore, path: string, text: string): void {
  const file = join(fx.artifactsRoot, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf-8');
}

/** What `aperas project` does: `runProject` renders and marks the node, the client writes the file. Returns the result of `runProject`; a conflict writes nothing. */
export function projectToDisk(fx: FixtureStore, path: string, force = false): ReturnType<typeof runProject> {
  const result = runProject(fx.store, path, false, force);
  if (result.markdown !== undefined) {
    mkdirSync(dirname(result.targetFile), { recursive: true });
    writeFileSync(result.targetFile, result.markdown, 'utf-8');
  }
  return result;
}

/** The id `runResolve` gives a deep path. */
export function idOf(fx: FixtureStore, ref: string, base?: string): string {
  const line = runResolve(fx.store, { paths: [ref], base, createHolder: false }).lines[0];
  return line.split('  ')[0].replace('aperas://id/', '');
}

/** The ids of the `Link`s of a block, as `show` prints them. */
export function linkIdsOf(fx: FixtureStore, blockId: string): string[] {
  return ((runShow(fx.store, blockId).links as Array<{ '@id': string }> | undefined) ?? []).map((l) => l['@id']);
}

/** The target of a `Link`, as `show` prints it. */
export function linkTargetOf(fx: FixtureStore, blockId: string, linkId: string): string {
  const link = (runShow(fx.store, blockId).links as Array<{ '@id': string; target: string }>).find((l) => l['@id'] === linkId);
  if (!link) throw new Error(`${blockId} has no link ${linkId}`);
  return link.target;
}

export interface Corpus {
  folder: string;
  betaArt: string; beta: string; betaSec: string; betaOther: string;
  alphaArt: string; alpha: string; alphaSec: string;
  gammaArt: string; gamma: string;
  dupArt: string; dup: string; itemOne: string; itemTwo: string;
  /** The ids of the links of the Alpha heading: one to `beta.md`, one to Beta Section. */
  alphaLinkToBeta: string; alphaLinkToSec: string;
  /** The id of the link of the Gamma heading that reaches Beta Section. */
  gammaLinkToSec: string;
}

export function buildCorpus(fx: FixtureStore): Corpus {
  const ingest = (...paths: string[]) => runIngest(fx.store, paths, true, false);
  writeArtifact(fx, 'cmd_demo/beta.md', '# Beta\n\nBeta intro.\n\n## Beta Section\n\nBeta section text.\n\n## Other\n\nOther text.\n');
  writeArtifact(fx, 'cmd_demo/dup.md', '# Dup\n\nDup intro.\n\n## Item One\n\nOne.\n\n## Item Two\n\nTwo.\n');
  ingest('cmd_demo/beta.md', 'cmd_demo/dup.md');
  const betaArt = idOf(fx, 'cmd_demo/beta.md');
  const betaSec = idOf(fx, 'cmd_demo/beta.md/Beta/Beta Section');
  const bare = (id: string): string => id.split(':')[1];
  writeArtifact(fx, 'cmd_demo/alpha.md', `# Alpha\n\nTo [beta]([[${bare(betaArt)}]]) and [section]([[${bare(betaSec)}]]).\n\n## Alpha Sec\n\nAlpha text.\n`);
  writeArtifact(fx, 'cmd_demo/gamma.md', `# Gamma\n\nAlso [section]([[${bare(betaSec)}]]) and [later]([[NotYetWritten]]).\n`);
  ingest('cmd_demo/alpha.md', 'cmd_demo/gamma.md');
  const alpha = idOf(fx, 'cmd_demo/alpha.md/Alpha');
  const gamma = idOf(fx, 'cmd_demo/gamma.md/Gamma');
  const alphaLinks = linkIdsOf(fx, alpha);
  const alphaLinkToBeta = alphaLinks.find((l) => linkTargetOf(fx, alpha, l) === betaArt);
  const alphaLinkToSec = alphaLinks.find((l) => linkTargetOf(fx, alpha, l) === betaSec);
  const gammaLinkToSec = linkIdsOf(fx, gamma).find((l) => linkTargetOf(fx, gamma, l) === betaSec);
  if (!alphaLinkToBeta || !alphaLinkToSec || !gammaLinkToSec) throw new Error('The corpus did not resolve its links.');
  return {
    folder: idOf(fx, 'cmd_demo'),
    betaArt, beta: idOf(fx, 'cmd_demo/beta.md/Beta'), betaSec, betaOther: idOf(fx, 'cmd_demo/beta.md/Beta/Other'),
    alphaArt: idOf(fx, 'cmd_demo/alpha.md'), alpha, alphaSec: idOf(fx, 'cmd_demo/alpha.md/Alpha/Alpha Sec'),
    gammaArt: idOf(fx, 'cmd_demo/gamma.md'), gamma,
    dupArt: idOf(fx, 'cmd_demo/dup.md'), dup: idOf(fx, 'cmd_demo/dup.md/Dup'),
    itemOne: idOf(fx, 'cmd_demo/dup.md/Dup/Item-One'), itemTwo: idOf(fx, 'cmd_demo/dup.md/Dup/Item-Two'),
    alphaLinkToBeta, alphaLinkToSec, gammaLinkToSec,
  };
}

/** One line of a rendered tree: its depth (the `│ ` prefixes), id, bracketed label, and the rest of the line. */
export interface TreeLine { depth: number; id: string; label: string; rest: string; line: string }

/** Parses the lines of `runTree`, leaving out the `aperas://tree/…` breadcrumb. */
export function parseTree(lines: readonly string[]): TreeLine[] {
  const out: TreeLine[] = [];
  for (const line of lines) {
    if (line.startsWith('aperas://tree/')) continue;
    let depth = 0;
    let s = line;
    while (s.startsWith('│ ')) { depth++; s = s.slice(2); }
    const m = /^(\S+)  \[([^\]]+)\]  (.*)$/.exec(s);
    if (!m) { out.push({ depth, id: '', label: '', rest: s, line }); continue; }
    out.push({ depth, id: m[1], label: m[2], rest: m[3], line });
  }
  return out;
}

/** The (id → parent id) pairs of a parsed tree, for comparing a shape without its order. */
export function parentPairs(entries: readonly TreeLine[]): Array<[string, string | null]> {
  const stack: TreeLine[] = [];
  const pairs: Array<[string, string | null]> = [];
  for (const e of entries) {
    while (stack.length > 0 && stack[stack.length - 1].depth >= e.depth) stack.pop();
    pairs.push([e.id, stack.length > 0 ? stack[stack.length - 1].id : null]);
    stack.push(e);
  }
  return pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}
