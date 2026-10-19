// The Aperas schema (design/core.md, "The Aperas schema"): the kinds, fields and roles that the shell hands to the
// engine when it constructs it. It is written in the engine's meta-model and is the only place that names a kind or
// a field of Aperas; the engine's directory names none. The old `shape.ts` stays until Batch 12 step 4.
//
// Field order is the order a document lists its fields in (design/core.md, "Format"): the inherited fields first,
// then the kind's own, and `parent` at its place as the derived entry that reads the reverse side of `children`.
// `BlockNode` and `FolderNode` declare their order, because the Format puts `type` and `path` before `children`. The three kinds under `TreeNode`
// are siblings. The stored `path` of an artifact and of a folder stays until the user decides on it.
import type { SchemaSpec } from '@aperas/core/apeironNgn/schema';

export const APERAS_SCHEMA: SchemaSpec = {
  kinds: [
    {
      name: 'BaseNode',
      fields: [
        { name: 'links', storage: 'embed', cardinality: 'set', embeds: 'Link' },
        { name: 'props', storage: 'embed', cardinality: 'set', embeds: 'StringProp' },
        { name: 'tombstonedAt', storage: 'literal', cardinality: 'optional' },
        { name: 'holder', storage: 'literal', cardinality: 'optional' },
      ],
    },
    {
      // The tree: what a block, an artifact and a folder have in common. `children` is ordered and partitioning, and
      // `parent` is the derived entry that reads its reverse side.
      name: 'TreeNode',
      extends: 'BaseNode',
      fields: [
        { name: 'title', storage: 'literal', cardinality: 'one' },
        { name: 'text', storage: 'literal', cardinality: 'optional' },
        { name: 'parent', storage: 'derived' },
        { name: 'children', storage: 'reference', cardinality: 'ordered', partitioning: true, reverse: 'parent' },
      ],
    },
    {
      // The Format lists `type` between `parent` and `children`, which inheritance does not give.
      name: 'BlockNode',
      extends: 'TreeNode',
      fields: [{ name: 'type', storage: 'literal', cardinality: 'one' }],
      order: ['links', 'props', 'tombstonedAt', 'holder', 'title', 'text', 'parent', 'type', 'children'],
    },
    {
      // An artifact is a sibling of `BlockNode` and has no `type`. `path` stays for now.
      name: 'ArtifactNode',
      extends: 'TreeNode',
      fields: [
        { name: 'path', storage: 'literal', cardinality: 'one' },
        { name: 'fileHash', storage: 'literal', cardinality: 'optional' },
        { name: 'lastTrackedAt', storage: 'literal', cardinality: 'optional' },
        { name: 'ingestedHash', storage: 'literal', cardinality: 'optional' },
        { name: 'lastIngestedAt', storage: 'literal', cardinality: 'optional' },
        { name: 'projectedHash', storage: 'literal', cardinality: 'optional' },
      ],
    },
    {
      // The real mirror lists `path` before `children` in a folder (`parent`, `path`, `children`, `projectedHash`).
      name: 'FolderNode',
      extends: 'TreeNode',
      fields: [
        { name: 'path', storage: 'literal', cardinality: 'one' },
        { name: 'projectedHash', storage: 'literal', cardinality: 'optional' },
      ],
      order: ['links', 'props', 'tombstonedAt', 'holder', 'title', 'text', 'parent', 'path', 'children', 'projectedHash'],
    },
    {
      name: 'Link',
      fields: [
        { name: 'target', storage: 'reference', cardinality: 'one' },
        { name: 'props', storage: 'embed', cardinality: 'set', embeds: 'StringProp' },
      ],
    },
    {
      name: 'StringProp',
      fields: [
        { name: 'key', storage: 'literal', cardinality: 'one' },
        { name: 'value', storage: 'literal', cardinality: 'one' },
      ],
    },
    {
      name: 'Profile',
      fields: [
        { name: 'handle', storage: 'literal', cardinality: 'one' },
        { name: 'name', storage: 'literal', cardinality: 'optional' },
        { name: 'kind', storage: 'literal', cardinality: 'optional' },
        { name: 'preferences', storage: 'embed', cardinality: 'set', embeds: 'StringProp' },
      ],
    },
    {
      name: 'TreeView',
      fields: [
        { name: 'profile', storage: 'reference', cardinality: 'one' },
        { name: 'name', storage: 'literal', cardinality: 'one' },
        { name: 'unfolds', storage: 'reference', cardinality: 'set' },
        { name: 'root', storage: 'reference', cardinality: 'optional' },
      ],
    },
  ],
  roles: {
    containment: 'children',
    tombstone: 'tombstonedAt',
    dropWithTarget: ['unfolds'],
    sweep: { roots: ['ArtifactNode', 'FolderNode'], follow: ['children', 'links', 'target'] },
  },
};
