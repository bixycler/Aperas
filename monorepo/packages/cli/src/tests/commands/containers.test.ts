// The rule at the time of a removal (design/core.md, "Tombstones"; planning/core.md, Batch 11): a tombstone leaves the list of its container, so a `list`, or a `listItem` with no
// text of its own, that a removal leaves with nothing live is tombstoned in the same write, and so on upward; a container with something live, or an item with text of its own, stays.
// The boot rule (`tombstoneVacuousContainers`) keeps the same definition for what an edit from outside left behind. Built directly on the handle, under one artifact.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateNodeId } from '@aperas/core/snowflake';
import { createNode, tombstoneVacuousContainers, wrap, type BlockNode } from '@aperas/core/shell/node';
import { runRemove } from '../../kgRemove';
import { runShow } from '../../kgShow';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';

describe('containers a removal empties', () => {
  let fx: FixtureStore;
  let host = '';
  before(() => {
    fx = makeFixtureStore('ct_demo');
    host = `ArtifactNode:${generateNodeId()}`;
    createNode(fx.store, host, { path: 'ct_demo/host.md' });
  });
  after(() => fx.cleanup());

  const block = (type: string, text: string | undefined, under: string): BlockNode => {
    const node = createNode(fx.store, `BlockNode:${generateNodeId()}`, { under }) as unknown as BlockNode;
    node.type = type;
    node.title = type;
    if (text !== undefined) node.text = text;
    return node;
  };
  const attach = (parent: BlockNode | string, ...kids: BlockNode[]): void => {
    const p = typeof parent === 'string' ? (wrap(fx.store, parent) as unknown as BlockNode) : parent;
    p.children = [...((p.children as unknown as BlockNode[] | undefined) ?? []), ...kids] as unknown as typeof p.children;
  };
  const dead = (id: string): boolean => typeof runShow(fx.store, id).tombstonedAt === 'string';
  const kids = (id: string): string[] => ((wrap(fx.store, id) as unknown as BlockNode).children as unknown as Array<{ id: string }>).map((k) => k.id);

  test('the last live item of a list tombstones the list, and a list with another item stays', () => {
    const list = block('list', undefined, host);
    const a = block('listItem', 'a', list.id);
    const b = block('listItem', 'b', list.id);
    attach(list, a, b);
    attach(host, list);
    runRemove(fx.store, { path: a.id });
    assert.deepEqual([dead(a.id), dead(list.id)], [true, false], 'one item left: the list stays');
    assert.deepEqual(kids(list.id), [b.id], 'the removed item left the list');
    runRemove(fx.store, { path: b.id });
    assert.deepEqual([dead(b.id), dead(list.id)], [true, true], 'the last item went: the list goes in the same write');
    assert.deepEqual(kids(host), [], 'and it left its container too');
  });

  test('a listItem with no text of its own goes when its children do, and the list above it goes only if that was its last; an item with text stays', () => {
    const list = block('list', undefined, host);
    const wrapper = block('listItem', undefined, list.id);
    const inner = block('listItem', 'inner', wrapper.id);
    const textful = block('listItem', 'has text', list.id);
    attach(wrapper, inner);
    attach(list, wrapper, textful);
    attach(host, list);
    runRemove(fx.store, { path: inner.id });
    assert.deepEqual([dead(inner.id), dead(wrapper.id), dead(list.id), dead(textful.id)], [true, true, false, false], 'the wrapper has nothing live and goes; the list still holds the other item');
    assert.deepEqual(kids(list.id), [textful.id]);

    const item = block('listItem', 'has text', list.id);
    const child = block('listItem', 'child', item.id);
    attach(item, child);
    attach(list, item);
    runRemove(fx.store, { path: child.id });
    assert.deepEqual([dead(child.id), dead(item.id), dead(list.id)], [true, false, false], 'an item with text of its own stays when its children go');

    const solo = block('list', undefined, host);
    const soloWrapper = block('listItem', undefined, solo.id);
    const soloChild = block('listItem', 'c', soloWrapper.id);
    attach(soloWrapper, soloChild);
    attach(solo, soloWrapper);
    attach(host, solo);
    runRemove(fx.store, { path: soloChild.id });
    assert.deepEqual([dead(soloChild.id), dead(soloWrapper.id), dead(solo.id)], [true, true, true], 'the rule goes up while the container above is vacuous');
  });

  test('the boot rule finds what is left vacuous from outside: a list with no child, and a wrapper with none', () => {
    const list = block('list', undefined, host);
    const wrapper = block('listItem', undefined, list.id);
    attach(list, wrapper);
    attach(host, list);
    assert.deepEqual([dead(list.id), dead(wrapper.id)], [false, false]);
    // an emptied wrapper: the item inside is tombstoned directly, as a hand-edited mirror would have it
    const inner = block('listItem', 'x', wrapper.id);
    attach(wrapper, inner);
    fx.store.write.tombstone(fx.store.engine.graphOf(inner.id)!, inner.id, new Date().toISOString());
    const { tombstoned } = tombstoneVacuousContainers(fx.store);
    assert.equal(tombstoned, 2, 'the wrapper, and then the list it emptied');
    assert.deepEqual([dead(wrapper.id), dead(list.id)], [true, true]);
  });
});
