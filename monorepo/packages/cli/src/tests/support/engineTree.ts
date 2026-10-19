// A check of the tree the engine arranges its records in (design/core.md, "Records follow containment"), independent of the
// oracle and of the engine's own bookkeeping: it scans the lists of every host and the embed fields through the interface, and
// compares what it finds with what `inspectEngine` shows of the tree. Every record is exactly one of a root or beneath one
// record; its place is the node that embeds it, else the host that lists it, else none; the roots and the records beneath
// others together are every record there is.
import assert from 'node:assert/strict';
import { inspectEngine } from '@aperas/core/apeironNgn/engine';
import type { Engine } from '@aperas/core/apeironNgn/interface';
import { oracleFieldOfId, oracleOwnerOfId } from './oracle.ts';

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

/** Check the tree of one graph of an engine (the default graph when none is named) over the ids that may have a record. `at` names the step for the failure message. */
export function checkTree(x: Engine, universe: readonly string[], at: string, G = 'default'): void {
  const tree = inspectEngine(x);
  const present = universe.filter((id) => x.record(G, id) !== undefined);
  const containment = x.schema.roles.containment;
  const kindOf = (id: string): string => x.record(G, id)!.kind;
  const declares = (kind: string, field: string): boolean => x.schema.kinds.find((k) => k.name === kind)!.fields.some((f) => f.name === field && !f.derived);

  // The hosts whose list holds an id: a node is in at most one list.
  const listedBy = new Map<string, string>();
  if (containment !== undefined) {
    for (const host of present) {
      if (!declares(kindOf(host), containment)) continue;
      for (const item of x.items(G, host, containment)) {
        assert.ok(!listedBy.has(item), `${at}: ${item} is in the lists of two hosts, ${listedBy.get(item)} and ${host}`);
        listedBy.set(item, host);
      }
    }
  }

  const expected = new Map<string, string | undefined>();
  for (const id of present) {
    const owner = oracleOwnerOfId(id);
    const field = oracleFieldOfId(id);
    const embeddedBy = owner !== undefined && field !== undefined && x.record(G, owner) !== undefined && declares(kindOf(owner), field)
      && x.schema.kinds.find((k) => k.name === kindOf(owner))!.fields.find((f) => f.name === field)!.storage === 'embed'
      && x.values(G, owner, field).includes(id);
    const container = listedBy.get(id);
    expected.set(id, embeddedBy ? owner : container !== undefined && x.record(G, container) !== undefined ? container : undefined);
  }

  let counted = 0;
  for (const id of present) {
    assert.equal(tree.treeParentOf(id), expected.get(id), `${at}: the place of ${id} in the tree`);
    const want = present.filter((other) => expected.get(other) === id);
    assert.deepEqual(sorted(tree.nestedIds(id)), sorted(want), `${at}: the records beneath ${id}`);
    counted += want.length;
  }
  const roots = present.filter((id) => expected.get(id) === undefined);
  assert.deepEqual(sorted(tree.rootIds(G)), sorted(roots), `${at}: the roots of the graph`);
  assert.equal(counted + roots.length, present.length, `${at}: the roots and the records beneath others are the master map`);
}
