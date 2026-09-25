import { For, Show, createSignal, onCleanup, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { RenderNodeItem, TreeResponse } from './render';
import { apiFetch } from './apiFetch';
import { parseMarkdown } from './markdown';
import type { RootContent, PhrasingContent } from 'mdast';

/**
 * Renders a stored block's own prose (`title`/`text`) as inline markdown — bold, italics, code,
 * strikethrough, and links — instead of the raw literal syntax `aperas tree`'s plain-text output
 * leaves untouched (a CLI has no reason to parse it; a UI does). This is the "marker" half of
 * discussion/webapp.md's Settled "links render at two sites sharing one identity": the link's own
 * text, right here inline, is the click target — no separate superscript, matching the decision to
 * drop one.
 *
 * A link only becomes clickable when its `href` carries a same-corpus `id/<Kind>:<snowflake>`
 * anchor (design/linking.md's Anchors section — the form every internal reference in this corpus
 * has carried since the anchor-cleanup pass) — extracted and used directly as the new apex, the
 * same direct-id tier `resolveDeepPath`/`aperas tree <path>` already special-cases. A legacy
 * slug-path-only anchor (rare; the compatibility form design/linking.md's Anchors section describes
 * as pre-ingestion-only) has no id to extract and renders as plain, inert text — a real gap, not
 * silently faked as a working link.
 *
 * Parses via `./markdown`'s shared `remark-gfm` processor — the same one every other rendering site
 * in this package uses — rather than a bespoke tokenizer of its own; see that module's doc comment
 * for why. Whatever GFM/CommonMark recognizes as inline content (including constructs this
 * component never explicitly names, e.g. autolinks) renders correctly by construction; only a
 * handful of node types too exotic to be worth a real fallback (footnote references, inline math)
 * degrade to their own plain-text contents.
 */

const ID_FRAGMENT_RE = /#(?:.*\/)?id\/((?:BlockNode|ArtifactNode|FolderNode):[A-Za-z0-9]+)/;
const BR_RE = /^<br\s*\/?>$/i;

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
  onMouseEnter: () => void; onMouseLeave: () => void;
}) {
  const [preview, setPreview] = createSignal<RenderNodeItem | null>();
  const [error, setError] = createSignal<string>();

  apiFetch(`/api/tree?path=${encodeURIComponent(props.targetId)}&view=${encodeURIComponent(props.view)}&depth=0`)
    .then(async (r) => {
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? `/api/tree: ${r.status}`);
      return body as TreeResponse;
    })
    .then((body) => setPreview(body.tree))
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
      <div
        class="link-popover"
        style={{ top: `${props.top}px`, left: `${props.left}px` }}
        onClick={(e) => e.stopPropagation()}
        onMouseEnter={props.onMouseEnter}
        onMouseLeave={props.onMouseLeave}
      >
        <Show when={error()}><div class="status status-error">{error()}</div></Show>
        <Show when={preview() === undefined && !error()}><div class="status">Loading…</div></Show>
        <Show when={preview()}>
          {(p) => (
            <Show when={p().kind === 'node' && p().found ? p() : undefined} fallback={<div class="status">Not found.</div>}>
              {(n) => {
                const node = n() as Extract<RenderNodeItem, { kind: 'node'; found: true }>;
                return (
                  <>
                    <div class="link-popover-title"><Inline text={node.title} onNavigate={() => { }} /></div>
                    <Show when={node.abstract !== undefined}>
                      <div class="link-popover-abstract"><Inline text={node.abstract} onNavigate={() => { }} /></div>
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
  content: JSX.Element; targetId: string; href: string; onNavigate: (id: string) => void;
  popover?: { view: string; onFold: (ref: string, action: 'unfold' | 'fold') => void };
}) {
  const [rect, setRect] = createSignal<{ top: number; left: number }>();
  let anchorEl: HTMLAnchorElement | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let openTimer: ReturnType<typeof setTimeout> | undefined;

  // The popover renders through a `<Portal>` (see `LinkPopover` below), so it is never a DOM
  // descendant of this wrapper span — leaving the anchor's own bounding box to move toward the
  // popover below it already counts as leaving the wrapper, closing it before the pointer arrives.
  // A short grace period, cancelled by either element's own mouse-enter, bridges that gap and keeps
  // the popover open while hovering it directly (confirmed live: without this, its one button —
  // "Unfold in tree" — was never reachable).
  const cancelClose = () => {
    if (closeTimer === undefined) return;
    clearTimeout(closeTimer);
    closeTimer = undefined;
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer = setTimeout(() => setRect(undefined), 150);
  };
  const cancelOpen = () => {
    if (openTimer === undefined) return;
    clearTimeout(openTimer);
    openTimer = undefined;
  };
  onCleanup(() => { cancelClose(); cancelOpen(); });

  const onEnter = () => {
    if (!anchorEl) return;
    cancelClose();
    cancelOpen();
    // Opening is also delayed, not just closing — a pointer only passing through on its way
    // elsewhere (e.g. reading down the list) used to trigger the popover on every link it crossed.
    openTimer = setTimeout(() => {
      openTimer = undefined;
      if (!anchorEl) return;
      const r = anchorEl.getBoundingClientRect();
      // `.link-popover` is `position: fixed`, which is already viewport-relative — exactly what
      // `getBoundingClientRect()` returns. Adding `window.scrollY`/`scrollX` on top (as if this were
      // `position: absolute` in document-flow coordinates) double-counted the scroll offset, planting
      // the popover further below the link with every pixel the page had scrolled — confirmed live.
      setRect({ top: r.bottom + 2, left: r.left });
    }, 600);
  };
  const onLeave = () => {
    cancelOpen();
    scheduleClose();
  };
  return (
    <span class="inline-link-wrap" onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <a
        ref={anchorEl}
        class="inline-link"
        title={props.href}
        onClick={(e) => { e.preventDefault(); props.onNavigate(props.targetId); }}
      >
        {props.content}
      </a>
      <Show when={rect() && props.popover}>
        {(pop) => (
          <LinkPopover
            targetId={props.targetId} view={pop().view} onFold={pop().onFold}
            top={rect()!.top} left={rect()!.left}
            onMouseEnter={cancelClose} onMouseLeave={scheduleClose}
          />
        )}
      </Show>
    </span>
  );
}

/** Recursively extracts plain text from a node this renderer has no explicit case for (e.g. a
 *  footnote reference or inline math, from a GFM extension this app doesn't otherwise use) — so an
 *  unrecognized construct degrades to visible text instead of silently vanishing, the same
 *  "anything else passes through as literal text" contract the old regex tokenizer had. */
export function plainTextOf(node: RootContent | PhrasingContent): string {
  if ('value' in node && typeof node.value === 'string') return node.value;
  if ('children' in node && Array.isArray(node.children)) return node.children.map(plainTextOf).join('');
  return '';
}

/** Exported so a component that already holds a parsed AST fragment of its own (a table cell, a
 *  blockquote's content) can render it directly, rather than re-serializing back to a string and
 *  paying for a second parse of text this module's own caller already parsed once. */
export function renderInline(
  nodes: PhrasingContent[],
  onNavigate: (id: string) => void,
  popover: InlineProps['popover'],
): JSX.Element[] {
  return nodes.map((node): JSX.Element => {
    switch (node.type) {
      case 'text':
        return <>{node.value}</>;
      case 'strong':
        return <strong>{renderInline(node.children, onNavigate, popover)}</strong>;
      case 'emphasis':
        return <em>{renderInline(node.children, onNavigate, popover)}</em>;
      case 'delete':
        return <del>{renderInline(node.children, onNavigate, popover)}</del>;
      case 'inlineCode':
        return <code>{node.value}</code>;
      case 'break':
        return <br />;
      case 'html':
        return BR_RE.test(node.value.trim()) ? <br /> : <>{node.value}</>;
      case 'link': {
        const content = renderInline(node.children, onNavigate, popover);
        const idMatch = ID_FRAGMENT_RE.exec(node.url);
        return idMatch ? (
          <NavigableLink content={content} targetId={idMatch[1]} href={node.url} onNavigate={onNavigate} popover={popover} />
        ) : (
          <span class="inline-link inline-link-inert" title={`${node.url} (no resolvable id — can't navigate)`}>{content}</span>
        );
      }
      default:
        return <>{plainTextOf(node)}</>;
    }
  });
}

export default function Inline(props: InlineProps): JSX.Element {
  const parts = () => {
    const text = props.text ?? '';
    if (!text) return [] as JSX.Element[];
    const root = parseMarkdown(text);
    const out: JSX.Element[] = [];
    root.children.forEach((child, i) => {
      if (i > 0) out.push(<>{'\n\n'}</>);
      if (child.type === 'paragraph') out.push(...renderInline(child.children, props.onNavigate, props.popover));
      else out.push(<>{plainTextOf(child)}</>);
    });
    return out;
  };

  return <For each={parts()}>{(p) => p}</For>;
}
