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

function Arrow(props: { open: boolean; onClick: () => void }) {
  return (
    <span
      class="fd-arrow"
      classList={{ 'fd-arrow-open': props.open }}
      onClick={(e) => { e.stopPropagation(); props.onClick(); }}
      title={props.open ? 'Fold' : 'Unfold'}
    >
      ▶
    </span>
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
          return (
            <div class="fd-node" style={{ '--depth': n.depth }}>
              <div
                class="fd-line"
                classList={{ 'fd-title-only': n.tier === 'title-only' }}
                onClick={(e) => { if (e.ctrlKey || e.metaKey) props.onZoom(n.id); }}
                title="Ctrl-click to zoom in"
              >
                <Show when={canToggle} fallback={<span class="fd-arrow-spacer" />}>
                  <Arrow open={isOpen} onClick={() => props.onFold(n.id, isOpen ? 'fold' : 'unfold')} />
                </Show>
                <span class="fd-kind">[{n.displayLabel}]</span>
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
              <Show when={!n.truncated && n.children.length > 0}>
                <div class="fd-children">
                  <For each={n.children}>{(child) => <FolderDiv {...props} item={child} />}</For>
                </div>
              </Show>
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

function LinkPreview(props: { title?: string; abstract?: string; onNavigate: (id: string) => void }) {
  return (
    <>
      <Inline text={props.title} onNavigate={props.onNavigate} />
      <Show when={props.abstract !== undefined}>
        {'  —  '}<Inline text={props.abstract} onNavigate={props.onNavigate} />
      </Show>
    </>
  );
}

function LinkRow(props: FolderDivProps & { item: Extract<RenderItem, { kind: 'link' }> }) {
  const l = () => props.item;

  return (
    <div class="fd-node fd-link" style={{ '--depth': l().depth }}>
      <Show when={l().mode === 'no-target'}>
        <div class="fd-line fd-dangling">
          <span class="fd-arrow-spacer" />
          <span class="fd-kind">[Link]</span>
          <span class="fd-title">{l().predicate} — no target</span>
        </div>
      </Show>

      <Show when={l().mode === 'preview'}>
        <div class="fd-line fd-preview" onClick={() => props.onFold(l().linkId, 'unfold')} title="Click to unfold">
          <Arrow open={false} onClick={() => props.onFold(l().linkId, 'unfold')} />
          <span class="fd-kind">[Link]</span>
          <span class="fd-title fd-link-text"><LinkPreview title={l().targetTitle} abstract={l().abstract} onNavigate={props.onZoom} /></span>
          <Tags tombstonedAt={l().tombstonedAt} hiddenCount={l().hiddenCount} />
        </div>
      </Show>

      <Show when={l().mode === 'expanded'}>
        <div class="fd-line">
          <Arrow open={true} onClick={() => props.onFold(l().linkId, 'fold')} />
          <span class="fd-kind">[Link]</span>
          <span
            class="fd-title fd-link-text"
            onClick={(e) => { if ((e.ctrlKey || e.metaKey) && l().targetId) props.onZoom(l().targetId!); }}
            title="Ctrl-click to zoom to this link's target"
          >
            <LinkPreview title={l().targetTitle} abstract={l().abstract} onNavigate={props.onZoom} />
          </span>
          <Tags starred={l().starred} tombstonedAt={l().tombstonedAt} />
        </div>
        <Show when={l().zoomPath !== undefined}>
          <div class="fd-breadcrumb">aperas://tree/{l().zoomPath}</div>
        </Show>
        <Show when={l().children.length > 0}>
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
          <span class="fd-arrow-spacer" />
          <span class="fd-kind">[Link]</span>
          <span class="fd-title fd-link-text"><Inline text={l().targetTitle} onNavigate={props.onZoom} /></span>
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
          <span class="fd-arrow-spacer" />
          <span class="fd-kind">[Link]</span>
          <span class="fd-title fd-link-text"><LinkPreview title={l().targetTitle} abstract={l().abstract} onNavigate={props.onZoom} /></span>
          <Tags tombstonedAt={l().tombstonedAt} hiddenCount={l().hiddenCount} />
          <span class="fd-tag">outside view</span>
        </div>
      </Show>
    </div>
  );
}
