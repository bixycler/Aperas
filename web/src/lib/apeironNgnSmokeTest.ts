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

  console.log('2. Picking a real artifact with an ingested tree...');
  const artifact = [...artifacts.values()].find((a) => a.root && blocks.has(a.root));
  if (!artifact) throw new Error('No ArtifactNode with an ingested root found in the mirror.');
  console.log(`   ${artifact.path} (root: ${artifact.root})\n`);

  console.log('3. Scalar field access (a.b.c) vs ground truth...');
  const artifactNode = wrap(store, artifact['@id']);
  check('artifact.title matches ground truth', artifactNode.title === artifact.title);
  check('artifact.path matches ground truth', artifactNode.path === artifact.path);
  const rootNode = artifactNode.root as any;
  check('artifact.root.id resolves to the right BlockNode', rootNode?.id === artifact.root);
  check('artifact.root.title matches ground truth', rootNode?.title === blocks.get(artifact.root)?.title);
  console.log();

  console.log('4. Reified containment (.children) vs ground truth, several levels...');
  const rootTruth = blocks.get(artifact.root);
  const firstChildTruthId = rootTruth.children?.[0];
  check('root.children has the same length as ground truth', rootNode.children.length === (rootTruth.children?.length ?? 0));
  check(
    'root.children is in the same order as ground truth',
    rootNode.children.every((c: any, i: number) => c.id === rootTruth.children[i])
  );
  if (firstChildTruthId) {
    const firstChild = rootNode.children[0];
    check('root.children[0].title matches ground truth (a.b.c[0].d)', firstChild.title === blocks.get(firstChildTruthId)?.title);
    const grandchildrenTruth = blocks.get(firstChildTruthId)?.children ?? [];
    check('root.children[0].children length matches ground truth', firstChild.children.length === grandchildrenTruth.length);
  }
  console.log();

  console.log('5. General backlink pattern vs the specialized .children index...');
  // backlinks(id, field) finds subjects with `field` pointing *at* id — for '__parent' that's
  // "id's own children," the same set childrenOf/.children computes, just unsorted. Exercises the
  // general pattern (Aperas-kg-foundational-design.md §3.2) against the one concrete field that
  // already has a specialized accessor, as a cross-check that both paths agree.
  const genericChildren = backlinks(store, artifact.root, '__parent').map((n) => n.id).sort();
  const specializedChildren = rootNode.children.map((n: any) => n.id).sort();
  check(
    'backlinks(root, "__parent") finds the same set as root.children',
    genericChildren.length === specializedChildren.length && genericChildren.every((id, i) => id === specializedChildren[i])
  );
  console.log();

  console.log('6. Full-subtree materialization (every node, one field each) vs ground truth count...');
  const expectedCount = countGroundTruth(blocks, artifact.root);
  const t1 = performance.now();
  let visited = 0;
  const walk = (n: any) => {
    visited++;
    void n.title; // touch one scalar field per node, same as a real read would
    for (const child of n.children) walk(child);
  };
  walk(rootNode);
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
