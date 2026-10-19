// The tombstone (planning/core.md, Batch 7 steps 1 and 2; design/core.md, "Tombstones", "A removed node leaves its container"):
// `tombstone` keeps the literal fields of a node and the references that name it, and takes out everything else: its place in
// every list that holds it, the pairs it holds as subject and the embedded nodes it owns; `tombstoneSubtree` does it for a node
// and the nodes its containment lists hold. Hand-written cases, each given to the engine and the oracle, then the two
// reproductions of the issue of the tombstone that the old engine fails (written first, shown failing there), then the
// embedded nodes. The random sequences are in `tombstone.model.test.ts`.
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, inspectEngine, Refused, Undecided } from '@aperas/core/apeironNgn/engine';
import type { Engine } from '@aperas/core/apeironNgn/interface';
import type { SchemaSpec } from '@aperas/core/apeironNgn/schema';
import { APERAS_SCHEMA } from '@aperas/core/shell/aperasSchema';
import { Oracle, Refused as OracleRefused, Undecided as OracleUndecided } from '../support/oracle.ts';
import { TEST_SCHEMA } from '../support/engineSchema.ts';
import { checkTree } from '../support/engineTree.ts';

const G = 'default';
const AT = '2026-10-16T00:00:00Z';
let n = 0;
const mint = (kind: string): string => `${kind}:${(++n).toString().padStart(13, '0')}`;
const embedded = (owner: string, field: string, kind: string): string => `${owner}:${field}:${mint(kind)}`;

let e: Engine;
let o: Oracle;
const mk = (kind: string): string => { const id = mint(kind); e.createNode(G, id, kind); o.createNode(G, id, kind); return id; };
/** An embedded node made and held by its owner. */
const own = (owner: string, field: string, kind: string): string => { const id = embedded(owner, field, kind); e.createNode(G, id, kind); o.createNode(G, id, kind); e.addPair(G, owner, field, id); o.addPair(G, owner, field, id); return id; };
const both = (run: (x: Engine) => void): void => { run(e); run(o); };
const sorted = (xs: readonly string[]): string[] => [...xs].sort();
const same = <T>(read: (x: Engine) => T, expected: T, why: string): void => {
  assert.deepEqual(read(e), expected, `engine: ${why}`);
  assert.deepEqual(read(o), expected, `oracle: ${why}`);
};
const sameSet = (read: (x: Engine) => readonly (string | number | boolean)[], expected: string[], why: string): void => same((x) => sorted(read(x) as string[]), sorted(expected), why);
const refused = (err: unknown): boolean => err instanceof Refused || err instanceof OracleRefused;
const undecided = (point: string) => (err: unknown): boolean => (err instanceof Undecided && err.point === point) || (err instanceof OracleUndecided && err.point === point);
const bothThrow = (run: (x: Engine) => void, check: (err: unknown) => boolean, why: string): void => {
  assert.throws(() => run(e), check, `engine: ${why}`);
  assert.throws(() => run(o), check, `oracle: ${why}`);
};
/** What a reader can see of an engine: the record of each id, and the ids of each kind. */
const snapshot = (x: Engine, ids: readonly string[]) => ({ records: ids.map((id) => x.record(G, id)), kinds: x.schema.kinds.map((k) => sorted(x.idsOfKind(G, k.name))) });
const fields = (x: Engine, id: string): [string, unknown[]][] => x.record(G, id)!.fields.map((f) => [f.name, [...f.values]]);

beforeEach(() => { e = createEngine(TEST_SCHEMA); o = new Oracle(e.schema); });

describe('tombstone', () => {
  test('keeps the literal fields with their types, loses what it held, and carries the stamp at its place in the schema\'s order', () => {
    const x = mk('Leaf'); const y = mk('Leaf'); const z = mk('Leaf'); const box = mk('Box');
    both((s) => {
      s.insertItem(G, box, 'items', x);
      s.addPair(G, x, 'label', 'x'); s.addPair(G, x, 'note', 'n'); s.addPair(G, x, 'rank', 3); s.addPair(G, x, 'flag', true);
      s.addPair(G, x, 'likes', y); s.addPair(G, x, 'mate', z);
    });
    const r1 = own(x, 'refs', 'Ref'); const a1 = own(r1, 'attrs', 'Attr');
    both((s) => { s.addPair(G, r1, 'to', y); s.addPair(G, a1, 'k', 'position'); });
    both((s) => s.tombstone(G, x, AT));
    same((s) => fields(s, x), [['label', ['x']], ['retiredAt', [AT]], ['note', ['n']], ['rank', [3]], ['flag', [true]]], 'literals with their types, the marker at its place, nothing else');
    same((s) => [r1, a1].map((id) => s.record(G, id)), [undefined, undefined], 'the embedded nodes and the ones they embed are gone');
    same((s) => s.first(G, x, 'retiredAt'), AT, 'the marker is the stamp');
    sameSet((s) => s.idsOfKind(G, 'Ref'), [], 'no Ref is left in its collection');
    sameSet((s) => s.idsOfKind(G, 'Attr'), [], 'nor an Attr');
    sameSet((s) => s.subjectsOf(G, 'likes', y), [], 'the reverse of likes lost x');
    sameSet((s) => s.subjectsOf(G, 'mate', z), [], 'and of mate');
    sameSet((s) => s.subjectsOf(G, 'to', y), [], 'and of to, the field of the embedded node');
    sameSet((s) => s.subjectsOf(G, 'refs', r1), [], 'and of refs');
    checkTree(e, [x, y, z, box, r1, a1], 'after the tombstone');
  });

  test('leaves the list of its container: the other items keep their order and move up', () => {
    const box = mk('Box'); const [a, b, c, d] = [mk('Leaf'), mk('Stub'), mk('Leaf'), mk('Leaf')];
    both((s) => { for (const i of [a, b, c, d]) s.insertItem(G, box, 'items', i); });
    both((s) => s.tombstone(G, b, AT));
    same((s) => s.items(G, box, 'items'), [a, c, d], 'the list');
    same((s) => [a, b, c, d].map((i) => s.placeOf(G, box, 'items', i)), [0, undefined, 1, 2], 'the places');
    same((s) => [a, b, c, d].map((i) => s.values(G, i, 'up')), [[box], [], [box], [box]], 'up');
    sameSet((s) => s.subjectsOf(G, 'items', b), [], 'no list holds it');
    assert.equal(inspectEngine(e).treeParentOf(b), undefined, 'a root of the graph');
    checkTree(e, [box, a, b, c, d], 'after the tombstone');
    both((s) => s.tombstone(G, a, AT));
    same((s) => s.items(G, box, 'items'), [c, d], 'the first item');
  });

  test('a container takes its own list: the former children stay live, detached, and are roots', () => {
    const outer = mk('Box'); const inner = mk('Box'); const [a, b] = [mk('Leaf'), mk('Leaf')];
    both((s) => { s.insertItem(G, outer, 'items', inner); s.insertItem(G, inner, 'items', a); s.insertItem(G, inner, 'items', b); });
    both((s) => s.tombstone(G, inner, AT));
    same((s) => s.items(G, outer, 'items'), [], 'out of its container');
    same((s) => s.items(G, inner, 'items'), [], 'and empty');
    same((s) => [a, b].map((i) => s.values(G, i, 'up')), [[], []], 'the children have no container');
    same((s) => [a, b].map((i) => s.first(G, i, 'retiredAt')), [undefined, undefined], 'and are not tombstoned');
    assert.deepEqual(sorted(inspectEngine(e).rootIds(G)), sorted([outer, inner, a, b]), 'they are roots with the tombstone');
    checkTree(e, [outer, inner, a, b], 'after');
  });

  test('a node with likes, mate, embedded nodes that embed, and a built reverse read before or after the tombstone', () => {
    for (const askedBefore of [true, false]) {
      e = createEngine(TEST_SCHEMA); o = new Oracle(e.schema);
      const x = mk('Leaf'); const y = mk('Leaf'); const w = mk('Leaf'); const box = mk('Box');
      const r1 = own(x, 'refs', 'Ref'); const r2 = own(w, 'refs', 'Ref'); const a1 = own(r1, 'attrs', 'Attr');
      both((s) => { s.addPair(G, x, 'likes', y); s.addPair(G, x, 'mate', y); s.addPair(G, w, 'likes', y); s.addPair(G, r1, 'to', y); s.addPair(G, r2, 'to', y); s.insertItem(G, box, 'items', x); s.addPair(G, a1, 'v', '1'); });
      const reads = (): void => {
        for (const [field, object] of [['likes', y], ['mate', y], ['items', x], ['refs', r1], ['to', y], ['attrs', a1]] as const) {
          const scan = [x, y, w, box, r1, r2, a1].filter((id) => e.record(G, id) !== undefined && e.values(G, id, field).includes(object));
          sameSet((s) => s.subjectsOf(G, field, object), scan, `${field} of ${object} (asked ${askedBefore ? 'before' : 'after'})`);
        }
      };
      if (askedBefore) reads();
      both((s) => s.tombstone(G, x, AT));
      reads();
      sameSet((s) => s.subjectsOf(G, 'likes', y), [w], 'only the other subject is left');
      sameSet((s) => s.subjectsOf(G, 'to', y), [r2], 'the embedded node of another owner stays');
      same((s) => s.values(G, box, 'items'), [], 'the list lost it');
      checkTree(e, [x, y, w, box, r1, r2, a1], 'after');
    }
  });

  test('the incoming references of the tombstone stay, and so does it in idsOfKind', () => {
    const x = mk('Leaf'); const watcher = mk('Leaf'); const w2 = mk('Leaf'); const holder = mk('Leaf');
    const rh = own(holder, 'refs', 'Ref');
    both((s) => { s.addPair(G, watcher, 'likes', x); s.addPair(G, w2, 'mate', x); s.addPair(G, rh, 'to', x); });
    sameSet((s) => s.subjectsOf(G, 'likes', x), [watcher], 'built');
    both((s) => s.tombstone(G, x, AT));
    sameSet((s) => s.values(G, watcher, 'likes'), [x], 'a likes');
    sameSet((s) => s.values(G, w2, 'mate'), [x], 'a mate');
    sameSet((s) => s.values(G, rh, 'to'), [x], 'the to of an embedded Ref of another node');
    sameSet((s) => s.subjectsOf(G, 'likes', x), [watcher], 'with its bucket');
    sameSet((s) => s.subjectsOf(G, 'mate', x), [w2], 'and the other');
    sameSet((s) => s.subjectsOf(G, 'to', x), [rh], 'and the last');
    sameSet((s) => s.idsOfKind(G, 'Leaf'), [x, watcher, w2, holder], 'in the collection of its kind');
    assert.deepEqual(inspectEngine(e).waitingIds(), [], 'no bucket waits: the record is there');
  });

  test('the entries of the node in a field dropped with its target stay: that is the removal\'s', () => {
    const box = mk('Box'); const x = mk('Leaf');
    both((s) => s.addPair(G, box, 'pinned', x));
    both((s) => s.tombstone(G, x, AT));
    sameSet((s) => s.values(G, box, 'pinned'), [x], 'still pinned');
  });

  test('the tombstone of a tombstone changes nothing, and the first stamp stays', () => {
    const box = mk('Box'); const x = mk('Leaf'); const y = mk('Leaf');
    both((s) => { s.insertItem(G, box, 'items', x); s.addPair(G, y, 'likes', x); });
    both((s) => s.tombstone(G, x, AT));
    const before = [e, o].map((s) => snapshot(s, [box, x, y]));
    both((s) => s.tombstone(G, x, 'later'));
    assert.deepEqual([e, o].map((s) => snapshot(s, [box, x, y])), before, 'a snapshot equal');
    same((s) => s.first(G, x, 'retiredAt'), AT, 'the first stamp');
    assert.deepEqual(before[0], before[1], 'and the oracle agrees');
  });

  test('a node written after the tombstone holds references again, and a second tombstone does not take them (it is a tombstone already)', () => {
    const x = mk('Leaf'); const y = mk('Leaf');
    both((s) => s.tombstone(G, x, AT));
    both((s) => s.addPair(G, x, 'likes', y));
    both((s) => s.tombstone(G, x, 'later'));
    sameSet((s) => s.values(G, x, 'likes'), [y], 'kept');
    sameSet((s) => s.subjectsOf(G, 'likes', y), [x], 'and in the reverse');
  });

  test('a kind with no marker (Loose) and an embedded node (Ref) are Refused and unchanged', () => {
    const loose = mk('Loose'); const x = mk('Leaf'); const r1 = own(x, 'refs', 'Ref'); const t = mk('Leaf');
    both((s) => { s.addPair(G, loose, 'name', 'l'); s.addPair(G, r1, 'to', t); });
    const ids = [loose, x, r1, t];
    const before = [e, o].map((s) => snapshot(s, ids));
    bothThrow((s) => s.tombstone(G, loose, AT), refused, 'a Loose');
    bothThrow((s) => s.tombstone(G, r1, AT), refused, 'an embedded Ref');
    assert.deepEqual([e, o].map((s) => snapshot(s, ids)), before, 'nothing changed');
  });

  test('a node with no record is Undecided of Existence, even with incoming pairs, and no bucket moves; exists and size stay Undecided', () => {
    const watcher = mk('Leaf'); const ghost = mint('Leaf');
    bothThrow((s) => s.tombstone(G, ghost, AT), undecided('Existence'), 'an id nobody created');
    both((s) => s.addPair(G, watcher, 'likes', ghost));
    sameSet((s) => s.subjectsOf(G, 'likes', ghost), [watcher], 'built: the bucket waits');
    bothThrow((s) => s.tombstone(G, ghost, AT), undecided('Existence'), 'a node that incoming pairs name');
    assert.deepEqual(inspectEngine(e).waitingIds(), [ghost], 'no bucket moved');
    bothThrow((s) => s.tombstone(G, mint('Loose'), AT), undecided('Existence'), 'a kind with no marker but no record: the record is checked first');
    bothThrow((s) => s.exists(G, watcher), undecided('Existence'), 'exists');
    bothThrow((s) => s.size(G), undecided('Existence'), 'size');
  });

  test('the checks come in the order: the role, the record, the marker of the kind', () => {
    const noRole: SchemaSpec = { kinds: TEST_SCHEMA.kinds, roles: { containment: 'items' } };
    const x = createEngine(noRole); const y = new Oracle(x.schema);
    const leaf = mint('Leaf');
    for (const s of [x, y]) {
      assert.throws(() => s.tombstone(G, leaf, AT), refused, 'no role and no record: the role first');
      s.createNode(G, leaf, 'Leaf');
      assert.throws(() => s.tombstone(G, leaf, AT), refused, 'no role');
      assert.throws(() => s.tombstoneSubtree(G, leaf, AT), refused, 'no role, a subtree');
      assert.throws(() => s.tombstoneSubtree(G, mint('Leaf'), AT), refused, 'no role and no record: the role first, a subtree');
    }
    bothThrow((s) => s.tombstone(G, mint('Loose'), AT), undecided('Existence'), 'the record before the kind');
  });

  test('a schema with no containment role: the tombstone works and leaves no container, because there is none', () => {
    const spec: SchemaSpec = {
      kinds: [{ name: 'Thing', fields: [{ name: 'name', storage: 'literal', cardinality: 'optional' }, { name: 'gone', storage: 'literal', cardinality: 'optional' }, { name: 'friends', storage: 'reference', cardinality: 'set' }] }],
      roles: { tombstone: 'gone' },
    };
    const x = createEngine(spec); const y = new Oracle(x.schema);
    const [a, b] = [mint('Thing'), mint('Thing')];
    for (const s of [x, y]) {
      s.createNode(G, a, 'Thing'); s.createNode(G, b, 'Thing');
      s.addPair(G, a, 'name', 'a'); s.addPair(G, a, 'friends', b); s.addPair(G, b, 'friends', a);
      s.tombstone(G, a, AT);
      assert.deepEqual(s.record(G, a)!.fields, [{ name: 'name', values: ['a'] }, { name: 'gone', values: [AT] }]);
      assert.deepEqual(s.values(G, b, 'friends'), [a], 'the incoming reference stays');
      s.tombstoneSubtree(G, b, AT);
      assert.deepEqual(s.record(G, b)!.fields, [{ name: 'gone', values: [AT] }], 'a subtree is the node alone');
    }
  });

  test('with the Aperas schema: a block under an artifact loses parent, children, links and the Link nodes; title, text and type stay', () => {
    const a = createEngine(APERAS_SCHEMA); const b = new Oracle(a.schema);
    const art = mint('ArtifactNode'); const blk = mint('BlockNode'); const other = mint('BlockNode'); const kid = mint('BlockNode');
    const link = embedded(blk, 'links', 'Link'); const prop = embedded(blk, 'props', 'StringProp'); const lprop = embedded(link, 'props', 'StringProp');
    for (const s of [a, b]) {
      for (const [id, kind] of [[art, 'ArtifactNode'], [blk, 'BlockNode'], [other, 'BlockNode'], [kid, 'BlockNode'], [link, 'Link'], [prop, 'StringProp'], [lprop, 'StringProp']] as const) s.createNode(G, id, kind);
      s.addPair(G, art, 'children', blk); s.addPair(G, art, 'children', other); s.addPair(G, blk, 'children', kid);
      s.addPair(G, blk, 'title', 't'); s.addPair(G, blk, 'text', 'body'); s.addPair(G, blk, 'type', 'paragraph');
      s.addPair(G, blk, 'links', link); s.addPair(G, link, 'target', other); s.addPair(G, link, 'props', lprop); s.addPair(G, lprop, 'key', 'position');
      s.addPair(G, blk, 'props', prop); s.addPair(G, prop, 'key', 'k'); s.addPair(G, prop, 'value', 'v');
      s.tombstone(G, blk, AT);
      assert.deepEqual(s.record(G, blk)!.fields.map((f) => [f.name, f.values]), [['tombstonedAt', [AT]], ['title', ['t']], ['text', ['body']], ['type', ['paragraph']]]);
      assert.deepEqual(s.values(G, blk, 'parent'), []);
      assert.deepEqual(s.items(G, art, 'children'), [other], 'the sibling stays');
      assert.deepEqual(s.values(G, kid, 'parent'), [], 'the child is detached');
      assert.equal(s.first(G, kid, 'tombstonedAt'), undefined, 'and live');
      assert.deepEqual([link, prop, lprop].map((id) => s.record(G, id)), [undefined, undefined, undefined], 'the Link and the props are gone');
      assert.deepEqual(s.subjectsOf(G, 'target', other), [], 'the Link no longer targets the sibling');
    }
    for (const s of [a, b]) {
      const link2 = embedded(other, 'links', 'Link');
      s.createNode(G, link2, 'Link'); s.addPair(G, other, 'links', link2);
      assert.throws(() => s.tombstone(G, link2, AT), refused, 'the Link itself');
    }
  });
});

describe('tombstoneSubtree', () => {
  const chain = (): { top: string; mid: string; low: string; leaf: string; other: string; sibling: string; outer: string } => {
    const outer = mk('Box'); const top = mk('Box'); const mid = mk('Box'); const low = mk('Box'); const leaf = mk('Leaf'); const other = mk('Leaf'); const sibling = mk('Leaf');
    both((s) => {
      s.insertItem(G, outer, 'items', sibling); s.insertItem(G, outer, 'items', top);
      s.insertItem(G, top, 'items', mid); s.insertItem(G, top, 'items', other);
      s.insertItem(G, mid, 'items', low); s.insertItem(G, low, 'items', leaf);
    });
    return { top, mid, low, leaf, other, sibling, outer };
  };

  test('a subtree three deep: every member stamped, the node out of its container, a root; the siblings and the ancestors untouched', () => {
    const { top, mid, low, leaf, other, sibling, outer } = chain();
    both((s) => s.addPair(G, sibling, 'label', 'kept'));
    both((s) => s.tombstoneSubtree(G, mid, AT));
    same((s) => [mid, low, leaf].map((id) => s.first(G, id, 'retiredAt')), [AT, AT, AT], 'every member stamped with the same at');
    same((s) => [top, other, sibling, outer].map((id) => s.first(G, id, 'retiredAt')), [undefined, undefined, undefined, undefined], 'the others are not');
    same((s) => s.items(G, top, 'items'), [other], 'the node is out of its container and the container\'s other item stays');
    same((s) => s.items(G, outer, 'items'), [sibling, top], 'the ancestor is untouched');
    same((s) => [mid, low, leaf].map((id) => s.values(G, id, 'up')), [[], [], []], 'no member has a container');
    same((s) => [mid, low].map((id) => s.items(G, id, 'items')), [[], []], 'and no member lists anything');
    same((s) => fields(s, sibling), [['label', ['kept']], ['up', [outer]]], 'the sibling\'s record is unchanged');
    assert.deepEqual(sorted(inspectEngine(e).rootIds(G).filter((id) => [mid, low, leaf].includes(id))), sorted([mid, low, leaf]), 'each member is a root of the tree');
    checkTree(e, [outer, top, mid, low, leaf, other, sibling], 'after');
  });

  test('a member that already is a tombstone keeps its stamp', () => {
    const { mid, low, leaf } = chain();
    both((s) => s.tombstone(G, low, 'early'));
    both((s) => s.tombstoneSubtree(G, mid, AT));
    same((s) => [mid, low, leaf].map((id) => s.first(G, id, 'retiredAt')), [AT, 'early', undefined], 'the middle one keeps its stamp, and the leaf, which low no longer lists, is not reached');
  });

  test('a member that is a tombstone holding a list written after it is walked through', () => {
    const top = mk('Box'); const dead = mk('Box'); const leaf = mk('Leaf');
    both((s) => { s.insertItem(G, top, 'items', dead); s.tombstone(G, dead, 'early'); s.insertItem(G, dead, 'items', leaf); s.insertItem(G, top, 'items', dead); });
    both((s) => s.tombstoneSubtree(G, top, AT));
    same((s) => [top, dead, leaf].map((id) => s.first(G, id, 'retiredAt')), [AT, 'early', AT], 'the list of the old tombstone is walked, the old stamp stays');
  });

  test('a list entry that names no record is skipped, not an error', () => {
    const top = mk('Box'); const kid = mk('Leaf'); const ghost = mint('Leaf');
    both((s) => { s.insertItem(G, top, 'items', ghost); s.insertItem(G, top, 'items', kid); });
    both((s) => s.tombstoneSubtree(G, top, AT));
    same((s) => [top, kid].map((id) => s.first(G, id, 'retiredAt')), [AT, AT], 'the real members');
    same((s) => s.record(G, ghost), undefined, 'no record made for the entry');
    assert.deepEqual(inspectEngine(e).waitingIds(), [], 'the list let go of the entry, so no bucket waits for it');
  });

  test('the embedded nodes of the members are gone', () => {
    const top = mk('Box'); const leaf = mk('Leaf'); const t = mk('Leaf');
    const r1 = own(top, 'refs', 'Ref'); const r2 = own(leaf, 'refs', 'Ref'); const a2 = own(r2, 'attrs', 'Attr');
    both((s) => { s.insertItem(G, top, 'items', leaf); s.addPair(G, r1, 'to', t); s.addPair(G, r2, 'to', t); });
    sameSet((s) => s.subjectsOf(G, 'to', t), [r1, r2], 'built');
    both((s) => s.tombstoneSubtree(G, top, AT));
    same((s) => [r1, r2, a2].map((id) => s.record(G, id)), [undefined, undefined, undefined], 'all gone');
    sameSet((s) => s.subjectsOf(G, 'to', t), [], 'and out of the reverse');
  });

  test('a member with no marker refuses the whole, and the engine and the oracle are unchanged', () => {
    const top = mk('Box'); const mid = mk('Box'); const early = mk('Leaf'); const loose = mk('Loose'); const late = mk('Leaf');
    both((s) => { s.insertItem(G, top, 'items', early); s.insertItem(G, top, 'items', mid); s.insertItem(G, mid, 'items', loose); s.insertItem(G, mid, 'items', late); });
    const ids = [top, mid, early, loose, late];
    const before = [e, o].map((s) => snapshot(s, ids));
    const rootsBefore = inspectEngine(e).rootIds(G);
    bothThrow((s) => s.tombstoneSubtree(G, top, AT), refused, 'a Loose in a Box');
    assert.deepEqual([e, o].map((s) => snapshot(s, ids)), before, 'nothing changed, the members before the Loose included');
    assert.deepEqual(before[0], before[1], 'and the two agree');
    assert.deepEqual(inspectEngine(e).rootIds(G), rootsBefore, 'and the tree is as it was');
  });

  test('a node with no record is Undecided of Existence', () => {
    bothThrow((s) => s.tombstoneSubtree(G, mint('Box'), AT), undecided('Existence'), 'an id nobody created');
    const ghost = mint('Box'); const watcher = mk('Leaf');
    both((s) => s.addPair(G, watcher, 'likes', ghost));
    bothThrow((s) => s.tombstoneSubtree(G, ghost, AT), undecided('Existence'), 'incoming pairs but no record');
  });

  test('a leaf is a subtree of one, and a Loose alone is Refused', () => {
    const box = mk('Box'); const leaf = mk('Leaf'); const loose = mk('Loose');
    both((s) => s.insertItem(G, box, 'items', leaf));
    both((s) => s.tombstoneSubtree(G, leaf, AT));
    same((s) => [s.items(G, box, 'items'), s.first(G, leaf, 'retiredAt')], [[], AT], 'the leaf');
    bothThrow((s) => s.tombstoneSubtree(G, loose, AT), refused, 'a Loose');
  });

  test('a chain of 5,000 nested boxes is tombstoned from the top with no stack overflow', () => {
    const x = createEngine(TEST_SCHEMA);
    const ids = Array.from({ length: 5000 }, () => mint('Box'));
    for (const id of ids) x.createNode(G, id, 'Box');
    for (let i = ids.length - 2; i >= 0; i--) x.insertItem(G, ids[i]!, 'items', ids[i + 1]!); // from the bottom: each host is a root when it takes its item
    x.tombstoneSubtree(G, ids[0]!, AT);
    assert.ok(ids.every((id) => x.first(G, id, 'retiredAt') === AT && x.items(G, id, 'items').length === 0 && x.first(G, id, 'up') === undefined), 'every box stamped, emptied and detached');
    assert.equal(inspectEngine(x).rootIds(G).length, 5000, 'each is a root');
  });
});

describe('the reproductions of the issue of the tombstone, which the old engine fails', () => {
  const aperas = (): { a: Engine; b: Oracle } => { const a = createEngine(APERAS_SCHEMA); return { a, b: new Oracle(a.schema) }; };

  test('a tombstoned subtree leaves its container, and nothing but the stamp stays on its nodes (tombstoneLiveSubtree)', () => {
    const { a, b } = aperas();
    const p = mint('BlockNode'); const b1 = mint('BlockNode'); const b2 = mint('BlockNode');
    for (const s of [a, b]) {
      for (const id of [p, b1, b2]) s.createNode(G, id, 'BlockNode');
      s.addPair(G, p, 'children', b1); s.addPair(G, b1, 'children', b2);
      s.tombstoneSubtree(G, b1, AT);
      assert.deepEqual(s.items(G, p, 'children'), [], 'P\'s list is without B1: a tombstone is in no container\'s list');
      assert.deepEqual([b1, b2].map((id) => s.values(G, id, 'parent')), [[], []], 'B1 and B2 have no reference and no parent');
      assert.deepEqual([b1, b2].map((id) => s.items(G, id, 'children')), [[], []]);
      assert.deepEqual([b1, b2].map((id) => s.first(G, id, 'tombstonedAt')), [AT, AT], 'both stamped');
      assert.deepEqual([b1, b2].map((id) => s.subjectsOf(G, 'children', id)), [[], []], 'in no list');
    }
  });

  test('a childless list block with a prop is emptied by its tombstone, so none of the 40 list nodes keeps props (tombstoneVacuousContainers)', () => {
    const { a, b } = aperas();
    const list = mint('BlockNode'); const prop = embedded(list, 'props', 'StringProp');
    for (const s of [a, b]) {
      s.createNode(G, list, 'BlockNode'); s.createNode(G, prop, 'StringProp');
      s.addPair(G, list, 'type', 'list'); s.addPair(G, list, 'props', prop); s.addPair(G, prop, 'key', 'k'); s.addPair(G, prop, 'value', 'v');
      s.tombstone(G, list, AT);
      assert.deepEqual(s.record(G, list)!.fields.map((f) => [f.name, f.values]), [['tombstonedAt', [AT]], ['type', ['list']]], 'the stamp and the literals only');
      assert.equal(s.record(G, prop), undefined, 'the prop is gone');
    }
  });
});

describe('embedded nodes (planning/core.md, Batch 7 step 2)', () => {
  test('are never tombstoned: no kind of an embedded node holds the marker, in either schema', () => {
    for (const spec of [TEST_SCHEMA, APERAS_SCHEMA]) {
      const embeddedKinds = new Set(spec.kinds.flatMap((k) => k.fields.filter((f) => f.storage === 'embed' && 'embeds' in f).map((f) => (f as { embeds: string }).embeds)));
      const x = createEngine(spec);
      const marker = x.schema.roles.tombstone!;
      for (const kind of x.schema.kinds.filter((k) => [...embeddedKinds].some((em) => em === k.name))) {
        assert.equal(kind.fields.some((f) => f.name === marker), false, `${kind.name} holds no marker`);
      }
    }
  });

  test('the tombstone of the owner drops them, the ones they embed in turn, and their entries in the reverse', () => {
    const x = mk('Leaf'); const t = mk('Leaf');
    const r1 = own(x, 'refs', 'Ref'); const r2 = own(x, 'refs', 'Ref'); const a1 = own(r1, 'attrs', 'Attr');
    both((s) => { s.addPair(G, r1, 'to', t); s.addPair(G, r2, 'to', t); s.addPair(G, a1, 'k', 'p'); });
    sameSet((s) => s.subjectsOf(G, 'to', t), [r1, r2], 'built');
    both((s) => s.tombstone(G, x, AT));
    same((s) => [r1, r2, a1].map((id) => s.record(G, id)), [undefined, undefined, undefined], 'all gone');
    sameSet((s) => s.subjectsOf(G, 'to', t), [], 'out of the reverse');
    sameSet((s) => s.values(G, x, 'refs'), [], 'the field is empty');
  });

  test('a tombstone made when the reverse of the dropped fields was not built builds it, as a removal does', () => {
    const x = mk('Leaf'); const box = mk('Box');
    own(x, 'refs', 'Ref');
    both((s) => s.addPair(G, box, 'pinned', x));
    assert.deepEqual(inspectEngine(e).reversesBuilt(), [], 'nothing built by the writes');
    both((s) => s.tombstone(G, x, AT));
    assert.deepEqual(inspectEngine(e).reversesBuilt(), ['pinned'], 'the tombstone of a node that embeds asked for the field dropped with its target');
  });
});
