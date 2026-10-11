// Pure checks on the markdown AST transducer (steps 1, 1c, 1d, 1e, 1b of the legacy suite): no store,
// no files; the fixture is the `sampleMarkdown` string.
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdownTree } from '@aperas/core/astParser';
import { serializeBlock } from '@aperas/core/project';
import { reconcileTree } from '@aperas/core/reconcile';
import { getProp } from '@aperas/core/props';
import { sampleMarkdown } from '../support/sampleMarkdown.ts';
import { findByText, findHeadingByTitle as findHeading } from '../support/tree.ts';

describe('markdown AST transducer', () => {
  let rootBlock: any;
  let frontmatter: string | undefined;
  before(() => ({ root: rootBlock, frontmatter } = parseMarkdownTree(sampleMarkdown)));

  test('1: frontmatter is separate and task items carry checked', () => {
    assert.ok(frontmatter?.includes('title: Metaphysics of Aperas'), `frontmatter: ${JSON.stringify(frontmatter)}`);
    assert.equal(getProp(findByText(rootBlock, 'An open question') ?? {}, 'checked'), 'false');
    assert.equal(getProp(findByText(rootBlock, 'A settled one') ?? {}, 'checked'), 'true');
  });

  test('1c: a list nests into the real preceding paragraph (consumption)', () => {
    const heading = findHeading(rootBlock, 'A Consuming Example');
    assert.ok(heading, 'heading "A Consuming Example"');
    assert.equal(heading.text, 'An introductory sentence.');
    assert.deepEqual((heading.children ?? []).map((c: any) => c.type), ['paragraph']);
    const paragraph = heading.children[0];
    const items = paragraph.children ?? [];
    assert.ok(items.length === 2 && items.every((c: any) => c.type === 'listItem'), `nested: ${JSON.stringify(items.map((c: any) => c.type))}`);
    assert.equal(getProp(paragraph, 'orderedList'), undefined);
    assert.equal(getProp(paragraph, 'startIndex'), undefined);
    assert.equal(getProp(items[0], 'orderedList'), 'false');
    assert.equal(getProp(items[0], 'startIndex'), '1');
  });

  test('1d: two back-to-back list runs dissolve into flat items with their own leaders', () => {
    const heading = findHeading(rootBlock, 'Metaphysics of Aperas');
    assert.ok(heading, 'heading "Metaphysics of Aperas"');
    assert.ok(!(heading.children ?? []).some((c: any) => c.type === 'list'), 'no child of type list');
    const items = (heading.children ?? []).filter((c: any) => c.type === 'listItem');
    assert.equal(items.length, 7);
    const [bulletLeader, , , , bulletLast, ordinalLeader, ordinalLast] = items;
    assert.equal(getProp(bulletLeader, 'orderedList'), 'false');
    assert.equal(getProp(bulletLeader, 'startIndex'), '1');
    assert.equal(getProp(bulletLast, 'orderedList'), undefined);
    assert.equal(getProp(ordinalLeader, 'orderedList'), 'true');
    assert.equal(getProp(ordinalLeader, 'startIndex'), '1');
    assert.equal(getProp(ordinalLast, 'orderedList'), undefined);
    const projected = serializeBlock(heading);
    assert.ok(projected.includes('- Unbounded: Apeiron macrocosm') && projected.includes('1. First ordered step\n2. Second ordered step'), projected);
  });

  test('1e: two list runs split by an opaque leaf both dissolve', () => {
    const heading = findHeading(rootBlock, 'Two Runs Separated By An Opaque Leaf');
    assert.ok(heading, 'heading "Two Runs Separated By An Opaque Leaf"');
    const children = heading.children ?? [];
    assert.deepEqual(children.map((c: any) => c.type), ['listItem', 'listItem', 'code', 'listItem', 'listItem']);
    assert.equal(getProp(children[0], 'orderedList'), 'false');
    assert.equal(getProp(children[3], 'orderedList'), 'true');
  });

  test('1b: serialize, re-parse and reconcile gives zero drift', () => {
    const projected = serializeBlock(rootBlock);
    const { root: reparsed } = parseMarkdownTree(projected);
    const { stats } = reconcileTree(rootBlock, reparsed);
    assert.deepEqual({ added: stats.added, removed: stats.removed, changed: stats.changed }, { added: 0, removed: 0, changed: 0 }, projected);
  });
});
