import { For, Show, createSignal } from 'solid-js';
import type { RenderItem } from './render';
import Inline from './Inline';

/**
 * `FolderDiv` — first Solid pass at the fold/unfold/zoom/edit mechanics discussion/webapp.md
 * settled on, driven directly by a `RenderItem` (the wire shape `/api/tree` returns). This is a v0,
 * not the full port the original vanilla `FolderDiv.js` sketch described — Wikipedia-style
 * `cite-ref`/`cite-note` numbered back-references between the two link sites aren't built (an
 * inline prose link and its structural endnote row, when both exist, aren't cross-highlighted or
 * scroll-linked to each other yet; each works correctly on its own). What *is* real: the arrow
 * handle folds/unfolds by writing to the actual `TreeView.unfolds` set (`/api/fold`, which shells to
 * the same `aperas unfold`/`fold` verbs a terminal caller uses) and refetching, not a client-side-
 * only simulation; ctrl-click zooms by making the clicked node the new apex; an inline prose link
 * (`Inline.tsx`) is a real navigable anchor with a hover popover that can promote it into `unfolds`;
 * the edit pencil is Slice 8's shallow write, piping straight to `aperas update --text-only`;
 * canonical-position pointers/outside-view markers render exactly as the server decided them, never
 * re-derived here (design/webapp.md's Topology: "both sites obey canonical position rather than
 * re-deriving it").
 */

export interface FolderDivProps {
  item: RenderItem;
  view: string;
  onZoom: (id: string) => void;
  onFold: (ref: string, action: 'unfold' | 'fold') => void;
  /** Slice 8's shallow write: replaces `id`'s own text (`/api/update`, `aperas update --text-only`)
   * and re-fetches. The one edit Phase 1 supports — the current node's own text, nothing else;
   * deep write (composing an intent for the Agent) is Phase 2+ (discussion/webapp.md's Settled). */
  onEdit: (id: string, text: string) => Promise<void>;
}

/** Compact glyphs for the node-kind tag, replacing the old `[FolderNode]`/`[heading]`/... bracket
 * label. Only the kinds design/webapp.md's UI review actually called out get one; anything else
 * (`listItem`, `code`, `table`, ...) gets no tag at all — `undefined` rather than the bare type name,
 * so the caller can skip rendering the tag's span entirely instead of leaving an empty one in the
 * flex row (which would still eat a `gap`). */
const KIND_GLYPH: Record<string, string> = {
  FolderNode: '📂',
  ArtifactNode: '📄',
  heading: '§',
  paragraph: '¶',
};
function kindGlyph(displayLabel: string | undefined): string | undefined {
  return displayLabel ? KIND_GLYPH[displayLabel] : undefined;
}

/** The target's own kind glyph, right after the link glyph — so a reader can tell what a link
 * resolves to (a folder, a heading, ...) without unfolding it. Nothing to show for `no-target`: with
 * no target there's no kind to name. */
function LinkKind(props: { targetDisplayLabel?: string }) {
  return (
    <>
      <span class="fd-kind">🔗</span>
      <Show when={kindGlyph(props.targetDisplayLabel)}>
        {(glyph) => <span class="fd-kind">{glyph()}</span>}
      </Show>
    </>
  );
}

/** Purely presentational — the click/hover behavior lives one level up, on the whole `.fd-gutter`
 * (arrow and stem together), matching the original vanilla `FolderDiv.js`'s single `<label>` wrapping
 * both: hovering or clicking either the arrow or the stem line below it is the same action. */
function Arrow(props: { open: boolean }) {
  return <span class="fd-arrow" classList={{ 'fd-arrow-open': props.open }}>▶</span>;
}

/** The gutter itself: arrow (or spacer) on top, a stem line filling the rest of this node's height
 * when it has visible children. `onToggle` undefined means nothing to do — no arrow, no stem, no
 * hover/pointer affordance (e.g. a link's `pointer`/`outside-view`/`no-target` rows). */
function Gutter(props: { arrow?: boolean; open?: boolean; hasStem: boolean; onToggle?: () => void }) {
  return (
    <div
      class="fd-gutter"
      classList={{ 'fd-gutter-active': !!props.onToggle }}
      onClick={props.onToggle ? (e) => { e.stopPropagation(); props.onToggle!(); } : undefined}
      title={props.onToggle ? (props.open ? 'Fold' : 'Unfold') : undefined}
    >
      <div class="fd-gutter-toggle">
        <Show when={props.arrow} fallback={<span class="fd-arrow-spacer" />}>
          <Arrow open={!!props.open} />
        </Show>
      </div>
      <Show when={props.hasStem}>
        <div class="fd-stem"><div class="fd-stem-line" /></div>
      </Show>
    </div>
  );
}

/** The shallow-write UI itself: opened on-demand (never pre-fetched for every visible node), always
 * reads `id`'s current *stored* `text` fresh via `/api/show` rather than reusing the row's own
 * (possibly truncated, and possibly stale by the time a slow edit finishes) `abstract` — the same
 * "never reconstruct from an already-projected/derived view" discipline the `aperas` skill applies
 * to CLI editing applies here too. */
function Editor(props: { id: string; onSave: (text: string) => Promise<void>; onCancel: () => void }) {
  const [text, setText] = createSignal('');
  const [loading, setLoading] = createSignal(true);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string>();

  fetch(`/api/show?id=${encodeURIComponent(props.id)}`)
    .then((r) => r.json())
    .then((doc) => { setText(doc.text ?? ''); setLoading(false); })
    .catch((err) => { setError(err instanceof Error ? err.message : String(err)); setLoading(false); });

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      await props.onSave(text());
      props.onCancel(); // closes the editor — the surrounding refetch already shows the new text
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <div class="fd-editor" onClick={(e) => e.stopPropagation()}>
      <Show when={!loading()} fallback={<div class="status">Loading current text…</div>}>
        <textarea value={text()} onInput={(e) => setText(e.currentTarget.value)} rows={4} />
        <div class="fd-editor-actions">
          <button onClick={save} disabled={saving()}>{saving() ? 'Saving…' : 'Save'}</button>
          <button onClick={props.onCancel} disabled={saving()}>Cancel</button>
        </div>
        <Show when={error()}><div class="status status-error">{error()}</div></Show>
      </Show>
    </div>
  );
}

function Tags(props: { holder?: boolean; starred?: boolean; tombstonedAt?: string; hiddenCount?: number }) {
  return (
    <>
      <Show when={props.holder}><span class="fd-tag fd-tag-holder">holder</span></Show>
      <Show when={props.starred}><span class="fd-tag fd-tag-star">*</span></Show>
      <Show when={props.tombstonedAt}><span class="fd-tag fd-tag-dead">tombstoned</span></Show>
      <Show when={(props.hiddenCount ?? 0) > 0}><span class="fd-tag fd-tag-fold">+{props.hiddenCount}</span></Show>
    </>
  );
}

export default function FolderDiv(props: FolderDivProps) {
  return (
    <Show when={props.item.kind === 'node' ? props.item : undefined} fallback={<LinkRow {...props} item={props.item as any} />}>
      {(node) => <NodeRow {...props} item={node()} />}
    </Show>
  );
}

function NodeRow(props: FolderDivProps & { item: Extract<RenderItem, { kind: 'node' }> }) {
  const item = () => props.item;

  return (
    <Show when={item().found} fallback={<div class="fd-row fd-not-found">{(item() as any).id} — not found</div>}>
      <Show when={!(item() as any).hidden} fallback={<PassthroughChildren {...props} />}>
        {(() => {
          const n = item() as Extract<RenderItem, { kind: 'node'; found: true }>;
          const canToggle = n.hiddenCount > 0 || n.tier === 'unfolded';
          const isOpen = n.tier === 'unfolded';
          const [editing, setEditing] = createSignal(false);
          const hasChildren = () => !n.truncated && n.children.length > 0;
          return (
            <div class="fd-node">
              {/* Arrow and stem are one unit (`Gutter`) sharing this fixed-width column, so the stem
                  is mechanically centered under the arrow rather than lined up by a separately-guessed
                  margin (the old `.fd-children` border-left, which had no actual relationship to the
                  arrow's own position). `.fd-gutter` stretches to the full height of `.fd-content`
                  (default flex `align-items: stretch`), so the stem's `flex: 1` fills exactly from
                  under the arrow down to the last child. */}
              <Gutter
                arrow={canToggle}
                open={isOpen}
                hasStem={hasChildren()}
                onToggle={canToggle ? () => props.onFold(n.id, isOpen ? 'fold' : 'unfold') : undefined}
              />
              <div class="fd-content">
                <div
                  class="fd-line"
                  classList={{ 'fd-title-only': n.tier === 'title-only' }}
                  onClick={(e) => { if (e.ctrlKey || e.metaKey) props.onZoom(n.id); }}
                  title="Ctrl-click to zoom in"
                >
                  <Show when={kindGlyph(n.displayLabel)}>
                    {(glyph) => <span class="fd-kind">{glyph()}</span>}
                  </Show>
                  <span class="fd-title"><Inline text={n.title} onNavigate={props.onZoom} popover={{ view: props.view, onFold: props.onFold }} /></span>
                  <Tags holder={n.holder} starred={n.starred} tombstonedAt={n.tombstonedAt} hiddenCount={n.hiddenCount} />
                  <Show when={!editing()}>
                    <span class="fd-edit-btn" onClick={(e) => { e.stopPropagation(); setEditing(true); }} title="Edit this node's own text">✎</span>
                  </Show>
                </div>
                <Show when={editing()}>
                  <Editor id={n.id} onSave={(text) => props.onEdit(n.id, text)} onCancel={() => setEditing(false)} />
                </Show>
                <Show when={!editing() && n.tier !== 'title-only' && n.abstract !== undefined}>
                  <div class="fd-abstract"><Inline text={n.abstract} onNavigate={props.onZoom} popover={{ view: props.view, onFold: props.onFold }} /></div>
                </Show>
                <Show when={n.isTextlessList}>
                  <div class="fd-abstract fd-muted">(no text of its own)</div>
                </Show>
                <Show when={n.truncated}>
                  <div class="fd-ellipsis">…</div>
                </Show>
                <Show when={hasChildren()}>
                  <div class="fd-children">
                    <For each={n.children}>{(child) => <FolderDiv {...props} item={child} />}</For>
                  </div>
                </Show>
              </div>
            </div>
          );
        })()}
      </Show>
    </Show>
  );
}

/** A holder-hidden node renders no line of its own — same depth passed straight to its children,
 * exactly like the server's own `hidden` semantics (core's `buildNodeItem` doc comment). */
function PassthroughChildren(props: FolderDivProps & { item: Extract<RenderItem, { kind: 'node' }> }) {
  const n = props.item as Extract<RenderItem, { kind: 'node'; found: true }>;
  return (
    <For each={n.children ?? []}>{(child) => <FolderDiv {...props} item={child} />}</For>
  );
}

/** The target's abstract, broken out of the title line into its own row — same `.fd-abstract` a
 * normal node's own text renders in, not the link-highlighted title color, so a link preview reads
 * as "a title, then its actual body text" rather than one long highlighted run. */
function LinkAbstract(props: { text?: string; onNavigate: (id: string) => void }) {
  return (
    <Show when={props.text !== undefined}>
      <div class="fd-abstract"><Inline text={props.text} onNavigate={props.onNavigate} /></div>
    </Show>
  );
}

function LinkRow(props: FolderDivProps & { item: Extract<RenderItem, { kind: 'link' }> }) {
  const l = () => props.item;
  const hasChildren = () => l().mode === 'expanded' && l().children.length > 0;

  return (
    <div class="fd-node fd-link">
      {/* Same `Gutter` unit as `NodeRow`. Only 'preview' (unfold) and 'expanded' (fold) have anything
          to toggle; the other three render a plain spacer with no hover/click affordance at all,
          same as before. */}
      <Gutter
        arrow={l().mode === 'preview' || l().mode === 'expanded'}
        open={l().mode === 'expanded'}
        hasStem={hasChildren()}
        onToggle={
          l().mode === 'preview' ? () => props.onFold(l().linkId, 'unfold')
          : l().mode === 'expanded' ? () => props.onFold(l().linkId, 'fold')
          : undefined
        }
      />
      <div class="fd-content">
        <Show when={l().mode === 'no-target'}>
          <div class="fd-line fd-dangling">
            <span class="fd-kind">🔗</span>
            <span class="fd-title">{l().predicate} — no target</span>
          </div>
        </Show>

        <Show when={l().mode === 'preview'}>
          <div class="fd-line fd-preview" onClick={() => props.onFold(l().linkId, 'unfold')} title="Click to unfold">
            <LinkKind targetDisplayLabel={l().targetDisplayLabel} />
            <span class="fd-title fd-link-text fd-link-title"><Inline text={l().targetTitle} onNavigate={props.onZoom} /></span>
            <Tags tombstonedAt={l().tombstonedAt} hiddenCount={l().hiddenCount} />
          </div>
          <LinkAbstract text={l().abstract} onNavigate={props.onZoom} />
        </Show>

        <Show when={l().mode === 'expanded'}>
          <div class="fd-line">
            <LinkKind targetDisplayLabel={l().targetDisplayLabel} />
            <span
              class="fd-title fd-link-text fd-link-title"
              onClick={(e) => { if ((e.ctrlKey || e.metaKey) && l().targetId) props.onZoom(l().targetId!); }}
              title="Ctrl-click to zoom to this link's target"
            >
              <Inline text={l().targetTitle} onNavigate={props.onZoom} />
            </span>
            <Tags starred={l().starred} tombstonedAt={l().tombstonedAt} />
          </div>
          <LinkAbstract text={l().abstract} onNavigate={props.onZoom} />
          <Show when={l().zoomPath !== undefined}>
            <div class="fd-breadcrumb">aperas://tree/{l().zoomPath}</div>
          </Show>
          <Show when={hasChildren()}>
            <div class="fd-children">
              <For each={l().children}>{(child) => <FolderDiv {...props} item={child} />}</For>
            </div>
          </Show>
        </Show>

        <Show when={l().mode === 'pointer'}>
          <div
            class="fd-line fd-pointer"
            onClick={() => { if (l().targetId) props.onZoom(l().targetId!); }}
            title="Jump to this link's canonical position"
          >
            <LinkKind targetDisplayLabel={l().targetDisplayLabel} />
            <span class="fd-title fd-link-text fd-link-title"><Inline text={l().targetTitle} onNavigate={props.onZoom} /></span>
            <Tags tombstonedAt={l().tombstonedAt} />
            <span class="fd-tag">see {l().pointerTarget}</span>
          </div>
        </Show>

        <Show when={l().mode === 'outside-view'}>
          <div
            class="fd-line fd-outside"
            onClick={() => { if (l().targetId) props.onZoom(l().targetId!); }}
            title="Click to zoom out to this ancestor"
          >
            <LinkKind targetDisplayLabel={l().targetDisplayLabel} />
            <span class="fd-title fd-link-text fd-link-title"><Inline text={l().targetTitle} onNavigate={props.onZoom} /></span>
            <Tags tombstonedAt={l().tombstonedAt} hiddenCount={l().hiddenCount} />
            <span class="fd-tag">outside view</span>
          </div>
          <LinkAbstract text={l().abstract} onNavigate={props.onZoom} />
        </Show>
      </div>
    </div>
  );
}
