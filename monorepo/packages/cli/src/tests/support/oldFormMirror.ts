// The fixture mirror in the form the reference engine left, for the six rules of `scripts/migrate-mirror.py` to act on (used by the tests of the cutover rehearsal and of the migration scripts).
import { A_DESIGN, B_ONE, B_TOMB, V_MAIN, fixtureDocs, idOf, testMapping, textsOf } from './mirrorFixture.ts';

export type Doc = Record<string, any>;
const flake = (n: number): string => `00T5MX${String(n).padStart(7, '0')}`;

/** The fixture mirror in the form the reference engine left, for the six rules to act on; `change` edits the documents of each file first. `projectDocs: false` leaves out what only this project's graph holds: the profile `dinhlx` (rule 4) and the twelve README documents (rule 3). */
export function oldFormTexts(change: (docs: Record<string, Doc[]>) => void = () => {}, options: { projectDocs?: boolean } = {}): Record<string, string> {
  const projectDocs = options.projectDocs ?? true;
  const mapping = testMapping();
  const docs = structuredClone(fixtureDocs()) as Record<string, Doc[]>;
  const all = (): Doc[] => Object.values(docs).flat();
  const find = (id: string): Doc => all().find((d) => d['@id'] === id)!;
  // Rule 1: every embedded Link holds a `predicate`.
  for (const d of all()) for (const l of d.links ?? []) l.predicate = '[[wikilink]]';
  // Rule 2: a tombstone that keeps its parent, a link and a prop, and is still listed by its container.
  const tomb = find(B_TOMB);
  tomb.parent = A_DESIGN;
  tomb.links = [{ '@id': `${B_TOMB}:links:Link:${flake(100)}`, '@type': 'Link', target: B_ONE, predicate: '[[wikilink]]' }];
  tomb.props = [{ '@id': `${B_TOMB}:props:StringProp:${flake(101)}`, '@type': 'StringProp', key: 'k', value: 'v' }];
  find(A_DESIGN).children.push(B_TOMB);
  // Rule 4: the profile that gets a `kind` (and the default profile, which the verifier prints).
  if (projectDocs) docs['Apeiron/Profile.jsonld']!.push({ '@id': 'Profile:00CA03JXD8000', '@type': 'Profile', handle: 'default' }, { '@id': 'Profile:00CJC4S69R000', '@type': 'Profile', handle: 'dinhlx', name: 'dinhlx' });
  // Rule 5: an `unfolds` entry that names nothing.
  find(V_MAIN).unfolds.push(idOf('BlockNode', 9999));
  // Rule 6: an artifact with a `type`.
  find(A_DESIGN).type = 'document';
  // Rule 3: the twelve README documents, parentless, each artifact with its paragraph.
  const readmes = [['00CN1QE950000', '00CN1QEAGG001'], ['00CN4ZQ8Y0000', '00CN4ZQAPG001'], ['00CN4ZSF58000', '00CN4ZSHMG001'], ['00CN4ZTZRR000', '00CN4ZV1G8001'], ['00CN4ZWHCG000', '00CN4ZWJMG001'], ['00CN4ZXWJ8000', '00CN4ZXXRR001']];
  for (const [a, p] of projectDocs ? readmes : []) {
    docs['Apeiron/ArtifactNode.jsonld']!.push({ '@id': `ArtifactNode:${a}`, '@type': 'ArtifactNode', title: 'README', children: [`BlockNode:${p}`], path: 'README.md' });
    docs['Apeiron/BlockNode.jsonld']!.push({ '@id': `BlockNode:${p}`, '@type': 'BlockNode', title: 'readme text', parent: `ArtifactNode:${a}`, type: 'paragraph', children: [] });
  }
  change(docs);
  for (const list of Object.values(docs)) list.sort((x, y) => (x['@id'] < y['@id'] ? -1 : 1));
  return textsOf(mapping, docs);
}

