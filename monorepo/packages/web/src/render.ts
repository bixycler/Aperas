/**
 * Client-side mirror of `@aperas/core/apeironNgn/node`'s `RenderItem` shape (design/webapp.md's
 * render contract, planning/webapp.md's Slice 1). Kept as a plain local type rather than importing
 * the core package's own export: importing it as a *value* would pull `node:fs`/`oxigraph`-touching
 * code into the browser bundle (`discussion/webapp.md`'s "Code inventory" freeflow entry names this
 * exact hazard), and `import type` — while runtime-safe on its own — still couples this bundle's
 * build to core's internal module graph for no benefit, since the wire shape is already just JSON
 * over `/api/tree`. Field-for-field identical to core's own `RenderNodeItem`/`RenderLinkItem`.
 */
export interface RenderNodeItemFound {
  kind: 'node';
  id: string;
  depth: number;
  found: true;
  hidden: boolean;
  displayLabel: string;
  title: string;
  abstract?: string;
  isTextlessList: boolean;
  tier: 'unfolded' | 'listed' | 'title-only';
  holder: boolean;
  starred: boolean;
  tombstonedAt?: string;
  hiddenCount: number;
  truncated: boolean;
  backlinkCount: number;
  children: RenderItem[];
}
export interface RenderNodeItemNotFound {
  kind: 'node';
  id: string;
  depth: number;
  found: false;
}
export type RenderNodeItem = RenderNodeItemFound | RenderNodeItemNotFound;

export interface RenderLinkItem {
  kind: 'link';
  linkId: string;
  depth: number;
  predicate: string;
  targetId?: string;
  targetTitle?: string;
  targetDisplayLabel?: string;
  abstract?: string;
  mode: 'no-target' | 'preview' | 'expanded' | 'pointer' | 'outside-view';
  hiddenCount?: number;
  starred?: boolean;
  zoomPath?: string;
  pointerTarget?: string;
  tombstonedAt?: string;
  children: RenderItem[];
}

export type RenderItem = RenderNodeItem | RenderLinkItem;

export interface TreeResponse {
  path: string | null;
  tree: RenderNodeItem | null;
}

export interface ViewInfo {
  name: string;
  profile: string;
}

/** Mirror of `@aperas/cli/kgBacklinks`'s own `BacklinkEntry` — same duplication rationale as this
 * file's header comment, one level removed: `cli` isn't `core`, but it still isn't browser-safe. */
export interface BacklinkEntry {
  linkId: string;
  ownerId: string;
  label: string;
  title: string;
  text?: string;
}
