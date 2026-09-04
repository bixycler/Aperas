/**
 * ApeironNgn Engine Smoke Test (Aperas-apeironngn-design.md §4 step 1: "ApeironNgn development").
 *
 * Verifies the rehydration + `a.b.c` prop-access layer against the real
 * AperasKG/Apeiron/ JSON-LD mirror — deliberately with no TerminusDB dependency at all, since the
 * whole point is that this engine doesn't need one. Ground truth is the raw JSON-LD read directly
 * (readFileSync + JSON.parse), not a re-derivation through the code under test.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rehydrateStore, getApeironExportDir } from './apeironNgn/store';
import { wrap, backlinks } from './apeironNgn/node';

let failures = 0;
function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`   [✓] ${label}`);
  } else {
    console.error(`   [✗] ${label}`);
    failures++;
  }
}

function loadGroundTruth(file: string): Map<string, any> {
  const dir = getApeironExportDir();
  const docs: any[] = JSON.parse(readFileSync(join(dir, `${file}.jsonld`), 'utf-8'));
  const byId = new Map<string, any>();
  for (const doc of docs) {
    if (doc['@type'] === '@context') continue;
    byId.set(doc['@id'], doc);
  }
  return byId;
}

/** Recursively counts a ground-truth BlockNode subtree via its raw `children` arrays. */
function countGroundTruth(blocks: Map<string, any>, id: string): number {
  const doc = blocks.get(id);
  if (!doc) return 0;
  let n = 1;
  for (const childId of doc.children ?? []) n += countGroundTruth(blocks, childId);
  return n;
}

async function main() {
  console.log('=== ApeironNgn Engine Smoke Test ===\n');

  console.log('1. Rehydrating Store from AperasKG/Apeiron/...');
  const t0 = performance.now();
  const { store, quadCount, nodeCount, danglingRefs } = rehydrateStore();
  const rehydrateMs = performance.now() - t0;
  console.log(`   ${quadCount} quads, ${nodeCount} documents, ${rehydrateMs.toFixed(1)}ms`);
  if (danglingRefs.length > 0) {
    console.log(
      `   [!] ${danglingRefs.length} dangling reference(s) (e.g. ${danglingRefs[0]}) — expected: ` +
      `\`Link\` isn't among export.ts's INSTANCE_CLASSES, so \`links\` values pointing at one can't ` +
      `be resolved to a document from this mirror. Pre-existing export-pipeline gap, not introduced here.`
    );
  }
  console.log();

  const blocks = loadGroundTruth('BlockNode');
  const artifacts = loadGroundTruth('ArtifactNode');

  console.log('2. Picking a real artifact with ingested content...');
  // ArtifactNode is merged with its document content (Aperas-apeironngn-design.md) — no separate
  // root BlockNode to find; the artifact's own ground-truth doc carries `type`/`children` directly
  // once something's been ingested (both fields are omitted from the JSON-LD entirely beforehand,
  // `dehydrate.ts`'s `serializeDoc` — `type` because it's an unset optional literal, `children`
  // because `orderedContainment` writes `[]`, so an *empty* array here still means "never ingested"
  // is impossible to tell apart from "ingested with zero top-level blocks" by `children` alone).
  const artifact = [...artifacts.values()].find((a) => a.type !== undefined && (a.children ?? []).length > 0);
  if (!artifact) throw new Error('No ArtifactNode with ingested content found in the mirror.');
  console.log(`   ${artifact.path} (${artifact.children.length} top-level blocks)\n`);

  console.log('3. Scalar field access (a.b.c) vs ground truth...');
  const artifactNode = wrap(store, artifact['@id']) as any;
  check('artifact.title matches ground truth', artifactNode.title === artifact.title);
  check('artifact.path matches ground truth', artifactNode.path === artifact.path);
  check('artifact.type matches ground truth', artifactNode.type === artifact.type);
  console.log();

  console.log('4. Reified containment (.children) vs ground truth, several levels...');
  const firstChildTruthId = artifact.children?.[0];
  check('artifact.children has the same length as ground truth', artifactNode.children.length === (artifact.children?.length ?? 0));
  check(
    'artifact.children is in the same order as ground truth',
    artifactNode.children.every((c: any, i: number) => c.id === artifact.children[i])
  );
  if (firstChildTruthId) {
    const firstChild = artifactNode.children[0];
    check('artifact.children[0].title matches ground truth (a.b.c[0].d)', firstChild.title === blocks.get(firstChildTruthId)?.title);
    const grandchildrenTruth = blocks.get(firstChildTruthId)?.children ?? [];
    check('artifact.children[0].children length matches ground truth', firstChild.children.length === grandchildrenTruth.length);
  }
  console.log();

  console.log('5. General backlink pattern vs the specialized .children index...');
  // backlinks(id, field) finds subjects with `field` pointing *at* id — for '__parent' that's
  // "id's own children," the same set childrenOf/.children computes, just unsorted. Exercises the
  // general pattern (Aperas-kg-foundational-design.md §3.2) against the one concrete field that
  // already has a specialized accessor, as a cross-check that both paths agree.
  const genericChildren = backlinks(store, artifact['@id'], '__parent').map((n) => n.id).sort();
  const specializedChildren = artifactNode.children.map((n: any) => n.id).sort();
  check(
    'backlinks(artifact, "__parent") finds the same set as artifact.children',
    genericChildren.length === specializedChildren.length && genericChildren.every((id, i) => id === specializedChildren[i])
  );
  console.log();

  console.log('6. Full-subtree materialization (every node, one field each) vs ground truth count...');
  // +1 for the artifact itself (it's the merged root now, not itself one of `blocks`'s entries) —
  // every top-level child's own subtree is still ordinary ground-truth BlockNode counting.
  const expectedCount = 1 + (artifact.children as string[]).reduce((sum, id) => sum + countGroundTruth(blocks, id), 0);
  const t1 = performance.now();
  let visited = 0;
  const walk = (n: any) => {
    visited++;
    void n.title; // touch one scalar field per node, same as a real read would
    for (const child of n.children) walk(child);
  };
  walk(artifactNode);
  const walkMs = performance.now() - t1;
  check(`visited count (${visited}) matches ground truth (${expectedCount})`, visited === expectedCount);
  console.log(`   ${walkMs.toFixed(1)}ms for ${visited} nodes, in-process (no I/O) — not comparable to the TerminusDB bench's network-bound numbers, only to itself over time.\n`);

  console.log('=== Summary ===');
  if (failures === 0) {
    console.log('All checks passed.');
  } else {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
