import { For, Show, createSignal, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { RenderNodeItem, TreeResponse } from './render';

/**
 * Renders a stored block's own prose (`title`/`text`) as inline markdown — bold, code, italics, and
 * links — instead of the raw literal syntax `aperas tree`'s plain-text output leaves untouched (a
 * CLI has no reason to parse it; a UI does). This is the "marker" half of discussion/webapp.md's
 * Settled "links render at two sites sharing one identity": the link's own text, right here inline,
 * is the click target — no separate superscript, matching the decision to drop one.
 *
 * A link only becomes clickable when its `href` carries a same-corpus `id/<Kind>:<snowflake>`
 * anchor (design/linking.md's Anchors section — the form every internal reference in this corpus
 * has carried since the anchor-cleanup pass) — extracted and used directly as the new apex, the
 * same direct-id tier `resolveDeepPath`/`aperas tree <path>` already special-cases, so no new
 * resolution logic exists here, just a regex pulling the id back out of an href this corpus already
 * writes. A legacy slug-path-only anchor (rare; the compatibility form design/linking.md's Anchors
 * section describes as pre-ingestion-only) has no id to extract and renders as plain, inert text —
 * a real gap, not silently faked as a working link.
 *
 * Deliberately not a general markdown renderer: only the constructs actually seen in this corpus's
 * prose (`**bold**`, `` `code` ``, single `*italic*`, `[text](href)`) are recognized; anything else
 * passes through as literal text, same as today.
 */

const ID_FRAGMENT_RE = /#(?:.*\/)?id\/((?:BlockNode|ArtifactNode|FolderNode):[A-Za-z0-9]+)/;

const TOKEN_RE = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)|\*([^*]+?)\*/g;

export interface InlineProps {
  text: string | undefined;
  onNavigate: (id: string) => void;
  /** Present only where a hover popover makes sense (the corpus-prose rendering sites) — omit to
   * render links as plain click-to-navigate with no popover (used for a link's own targetTitle in
   * an endnote row, which is already the preview a popover would otherwise show). */
  popover?: { view: string; onFold: (ref: string, action: 'unfold' | 'fold') => void };
}

/** discussion/webapp.md's Settled "Hovering a link previews, and can promote": fetched lazily, on
 * first hover, via the same `/api/tree` endpoint every other read in this app uses (`depth: 0` —
 * rule a's flat, non-recursing preview, §5) rather than a second preview-shaped endpoint. The
 * unfold control adds the *target* to `unfolds` directly (there is no `Link` id available to hover
 * over here — the marker is inline prose text, not a structural link row — so this promotes by
 * target rather than by link identity; the structural endnote row for the same relationship, when
 * one exists, still unfolds via its own `Link` id exactly as today). */
function LinkPopover(props: {
  targetId: string; view: string; onFold: (ref: string, action: 'unfold' | 'fold') => void;
  top: number; left: number;
}) {
  const [preview, setPreview] = createSignal<RenderNodeItem | null>();
  const [error, setError] = createSignal<string>();

  fetch(`/api/tree?path=${encodeURIComponent(props.targetId)}&view=${encodeURIComponent(props.view)}&depth=0`)
    .then((r) => r.json())
    .then((body: TreeResponse) => setPreview(body.tree))
    .catch((err) => setError(err instanceof Error ? err.message : String(err)));

  // Portaled to `document.body` (below) rather than positioned relative to the hovered link's own
  // wrapper span — a CSS `opacity` on any ancestor (here, `.fd-abstract`'s deliberate 0.75 dimming
  // of prose text) applies to that whole subtree's compositing, including any descendant's own
  // fully-opaque background; the only way to actually escape it is to not be a descendant at all
  // (confirmed live: the popover's own computed `background-color` was already the intended solid
  // color, and it *still* washed out, because the ancestor's 0.75 opacity was compositing the
  // entire box against the page behind it regardless). `top`/`left` are the trigger's own
  // `getBoundingClientRect()`, taken fresh on each hover in `NavigableLink` below.
  return (
    <Portal>
      <div class="link-popover" style={{ top: `${props.top}px`, left: `${props.left}px` }} onClick={(e) => e.stopPropagation()}>
        <Show when={error()}><div class="status status-error">{error()}</div></Show>
        <Show when={preview() === undefined && !error()}><div class="status">Loading…</div></Show>
        <Show when={preview()}>
          {(p) => (
            <Show when={p().kind === 'node' && p().found ? p() : undefined} fallback={<div class="status">Not found.</div>}>
              {(n) => {
                const node = n() as Extract<RenderNodeItem, { kind: 'node'; found: true }>;
                return (
                  <>
                    <div class="link-popover-title"><Inline text={node.title} onNavigate={() => {}} /></div>
                    <Show when={node.abstract !== undefined}>
                      <div class="link-popover-abstract"><Inline text={node.abstract} onNavigate={() => {}} /></div>
                    </Show>
                    <Show when={node.hiddenCount > 0}>
                      <button
                        class="link-popover-unfold"
                        onClick={() => props.onFold(props.targetId, 'unfold')}
                      >
                        Unfold in tree ↴
                      </button>
                    </Show>
                  </>
                );
              }}
            </Show>
          )}
        </Show>
      </div>
    </Portal>
  );
}

function NavigableLink(props: {
  content: string; targetId: string; href: string; onNavigate: (id: string) => void;
  popover?: { view: string; onFold: (ref: string, action: 'unfold' | 'fold') => void };
}) {
  const [rect, setRect] = createSignal<{ top: number; left: number }>();
  let anchorEl: HTMLAnchorElement | undefined;
  const onEnter = () => {
    if (!anchorEl) return;
    const r = anchorEl.getBoundingClientRect();
    // `.link-popover` is `position: fixed`, which is already viewport-relative — exactly what
    // `getBoundingClientRect()` returns. Adding `window.scrollY`/`scrollX` on top (as if this were
    // `position: absolute` in document-flow coordinates) double-counted the scroll offset, planting
    // the popover further below the link with every pixel the page had scrolled — confirmed live.
    setRect({ top: r.bottom + 2, left: r.left });
  };
  return (
    <span class="inline-link-wrap" onMouseEnter={onEnter} onMouseLeave={() => setRect(undefined)}>
      <a
        ref={anchorEl}
        class="inline-link"
        title={props.href}
        onClick={(e) => { e.preventDefault(); props.onNavigate(props.targetId); }}
      >
        {props.content}
      </a>
      <Show when={rect() && props.popover}>
        {(pop) => <LinkPopover targetId={props.targetId} view={pop().view} onFold={pop().onFold} top={rect()!.top} left={rect()!.left} />}
      </Show>
    </span>
  );
}

export default function Inline(props: InlineProps): JSX.Element {
  const parts = () => {
    const text = props.text ?? '';
    const out: Array<{ kind: 'text' | 'bold' | 'code' | 'italic' | 'link'; content: string; href?: string; targetId?: string }> = [];
    let cursor = 0;
    TOKEN_RE.lastIndex = 0;
    for (const m of text.matchAll(TOKEN_RE)) {
      if (m.index! > cursor) out.push({ kind: 'text', content: text.slice(cursor, m.index) });
      if (m[1] !== undefined) out.push({ kind: 'bold', content: m[1] });
      else if (m[2] !== undefined) out.push({ kind: 'code', content: m[2] });
      else if (m[3] !== undefined) {
        const href = m[4];
        const idMatch = ID_FRAGMENT_RE.exec(href);
        out.push({ kind: 'link', content: m[3], href, targetId: idMatch?.[1] });
      } else if (m[5] !== undefined) out.push({ kind: 'italic', content: m[5] });
      cursor = m.index! + m[0].length;
    }
    if (cursor < text.length) out.push({ kind: 'text', content: text.slice(cursor) });
    return out;
  };

  return (
    <For each={parts()}>
      {(p) => {
        switch (p.kind) {
          case 'bold': return <strong>{p.content}</strong>;
          case 'code': return <code>{p.content}</code>;
          case 'italic': return <em>{p.content}</em>;
          case 'link':
            return p.targetId ? <NavigableLink content={p.content} targetId={p.targetId} href={p.href!} onNavigate={props.onNavigate} popover={props.popover} /> : (
              <span class="inline-link inline-link-inert" title={`${p.href} (no resolvable id — can't navigate)`}>{p.content}</span>
            );
          default: return <>{p.content}</>;
        }
      }}
    </For>
  );
}
