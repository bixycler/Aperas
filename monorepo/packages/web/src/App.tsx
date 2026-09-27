import { createSignal, createResource, createEffect, onCleanup, For, Show, createMemo } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import FolderDiv from './FolderDiv';
import type { GraphInfo, TreeResponse, ViewInfo } from './render';
import { apiFetch } from './apiFetch';
import './App.css';

async function fetchViews(): Promise<ViewInfo[]> {
  const res = await apiFetch('/api/views');
  if (!res.ok) throw new Error(`/api/views: ${res.status}`);
  return res.json();
}

async function fetchGraphInfo(): Promise<GraphInfo> {
  const res = await apiFetch('/api/graph');
  if (!res.ok) throw new Error(`/api/graph: ${res.status}`);
  return res.json();
}

let lastTreeKey = '';
let lastTreeJson = '';
let cachedTreeResponse: TreeResponse | null = null;

async function fetchTree(params: { apex?: string; view: string }): Promise<TreeResponse> {
  // `apex` omitted (not defaulted to `.`) means "let the server decide" — it falls back to the
  // view's own recorded `root` (design/treeview.md), which is what makes a bare `?view=<name>` deep
  // link land somewhere other than the corpus root when a prior zoom set one.
  const path = params.apex !== undefined ? `path=${encodeURIComponent(params.apex)}&` : '';
  const url = `/api/tree?${path}view=${encodeURIComponent(params.view)}`;
  const key = `${params.apex ?? ''}::${params.view}`;
  const res = await apiFetch(url);
  const text = await res.text();
  if (!res.ok) {
    let msg = `/api/tree: ${res.status}`;
    try { msg = JSON.parse(text).error ?? msg; } catch {}
    throw new Error(msg);
  }
  if (key === lastTreeKey && text === lastTreeJson && cachedTreeResponse !== null) {
    return cachedTreeResponse;
  }
  lastTreeKey = key;
  lastTreeJson = text;
  const parsed = JSON.parse(text) as TreeResponse;
  cachedTreeResponse = parsed;
  return parsed;
}

async function postFold(ref: string, view: string, action: 'unfold' | 'fold'): Promise<void> {
  const url = `/api/fold?ref=${encodeURIComponent(ref)}&view=${encodeURIComponent(view)}&action=${action}`;
  const res = await apiFetch(url, { method: 'POST' });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `/api/fold: ${res.status}`);
}

/** Persists a webapp zoom as the view's `root` (design/treeview.md's "root records the current
 *  zoom") — the other zoom source alongside `aperas zoom`. Fired alongside `setApex`, not instead
 *  of it: the local signal is what makes the click feel instant, this is what makes it survive past
 *  this tab. */
async function postZoom(ref: string, view: string): Promise<void> {
  const url = `/api/zoom?ref=${encodeURIComponent(ref)}&view=${encodeURIComponent(view)}`;
  const res = await apiFetch(url, { method: 'POST' });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `/api/zoom: ${res.status}`);
}

/** Slice 8's shallow write — the one edit Phase 1 supports: a node's own text, nothing else. */
async function postUpdate(id: string, text: string): Promise<void> {
  const res = await apiFetch(`/api/update?id=${encodeURIComponent(id)}`, { method: 'POST', body: text });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `/api/update: ${res.status}`);
}

// `?view=<name>&path=<ref>` is a real two-way deep link: read once here to seed the initial
// signals, and kept in sync on every navigation below (`history.replaceState`, not `pushState` —
// each zoom/breadcrumb/view-change replaces the current entry rather than growing browser history
// one step per click; only a real page load creates a history entry). Bookmarking, sharing a link,
// or using back/forward across a reload all land on the same apex.
const initialParams = new URLSearchParams(window.location.search);

export default function App() {
  const [view, setView] = createSignal(initialParams.get('view') ?? 'default');
  // `undefined` (no `path` in the URL at all) means "not yet known — let the view's own `root`
  // decide"; it's resolved to a concrete value from the first response's own `path` field below,
  // same as `aperas tree --view <name>` with no explicit path falls back to `root` server-side.
  // Distinct from an explicit `'.'`, which is a real, deliberate corpus-root apex.
  const [apex, setApex] = createSignal<string | undefined>(initialParams.get('path') ?? undefined);
  const [refreshTick, setRefreshTick] = createSignal(0);

  const [views] = createResource(fetchViews);
  const [graphInfo] = createResource(fetchGraphInfo);
  createEffect(() => {
    const name = graphInfo()?.name;
    document.title = name ? `${name} | Aperas` : 'Aperas';
  });
  const [tree, { refetch }] = createResource(
    () => ({ apex: apex(), view: view(), tick: refreshTick() }),
    (params) => fetchTree(params),
  );

  // `<For>` (in `FolderDiv`) reconciles by object reference, and a plain `createResource` hands back
  // a brand-new object graph on every poll — new references top to bottom, even when nothing
  // changed. Without this store, `<For>` can't tell an unchanged node from a new one and tears down
  // and remounts the entire tree every `POLL_INTERVAL_MS`, dropping any open inline editor mid-edit
  // (discussion/webapp.md's Freeflow entry on this dates the finding). `reconcile` merges each poll's
  // response into `treeStore` by `id`, preserving reference identity for anything unchanged so `<For>`
  // only remounts what actually differs.
  const [treeStore, setTreeStore] = createStore<TreeResponse>({ path: null, tree: null });
  createEffect(() => {
    if (tree.error) return;
    const data = tree.latest;
    if (data) setTreeStore(reconcile(data, { key: 'id' }));
    // First response after an apex-less request: seed the concrete apex from what the server
    // actually resolved (the view's `root`, or the corpus root if it has none) — every later read
    // and every URL update from here on uses this real value, same as if it had been typed in.
    // Falls back to '.' on the rare `path: null` case (whatever `toPath()` can't walk) rather than
    // leaving `apex` unresolved forever.
    if (data && apex() === undefined) setApex(data.path ?? '.');
  });

  // Cheap stopgap for the missing tick channel (Slice 4, planning/webapp.md): no push exists yet
  // to tell this tab an external `aperas fold`/`unfold`/CLI write changed the store, so poll for it
  // instead of requiring a manual reload. User-toggleable (`pollingEnabled`) since a 1s poll against
  // a store someone is deliberately mid-edit on via the CLI can be more noise than help.
  const POLL_INTERVAL_MS = 1000;
  const [pollingEnabled, setPollingEnabled] = createSignal(true);
  createEffect(() => {
    if (!pollingEnabled()) return;
    const id = setInterval(() => setRefreshTick((t) => t + 1), POLL_INTERVAL_MS);
    onCleanup(() => clearInterval(id));
  });

  // Native `<select>` only honors a `value` prop reliably once its `<option>` children already
  // exist in the DOM — `views()` resolves asynchronously, after the element's first paint, so the
  // browser is left to pick its own default (the first option) unless `.value` is re-applied once
  // the list actually arrives. Re-running this whenever `views()` changes is what fixes that,
  // rather than depending on `view()` alone (which never changes on its own after mount).
  let selectEl: HTMLSelectElement | undefined;
  createEffect(() => {
    if (views() && selectEl) selectEl.value = view();
  });

  createEffect(() => {
    const params = new URLSearchParams();
    params.set('view', view());
    // Omitted while still unresolved (see `apex`'s own doc comment) — writing a placeholder here
    // would turn a genuine "let the view decide" reload into a hardcoded one the moment the tab is
    // bookmarked or refreshed.
    const a = apex();
    if (a !== undefined) params.set('path', a);
    history.replaceState(null, '', `${location.pathname}?${params}`);
  });

  // Both `tree()` and `tree.latest` rethrow the resource's stored error once it's set and no newer
  // fetch is in flight (Solid's ErrorBoundary integration; see `createResource`'s own source) — this
  // app has no boundary anywhere above it, so a single transient poll failure would otherwise crash
  // this memo (and the `<Show>` below that reads the tree the same way) permanently: the throw
  // happens synchronously inside the resource's own error-handling promise chain, which nothing
  // else awaits, so it surfaces as an uncaught rejection and this computation never runs again. The
  // fix is to never call either accessor while `tree.error` is set — checking it first short-circuits
  // before the throwing read happens, and self-heals as soon as the next poll succeeds and clears it.
  const breadcrumbs = createMemo(() => {
    const path = tree.error ? undefined : tree.latest?.path;
    if (!path || path === '.') return [] as Array<{ label: string; full: string }>;
    const segments = path.split('/').filter((s) => s.length > 0);
    return segments.map((_, i) => ({ label: segments[i], full: segments.slice(0, i + 1).join('/') }));
  });

  // Every user-initiated zoom — tree click, backlink zoom, breadcrumb, "zoom out to root" — goes
  // through here: `setApex` for the instant local UI update, `postZoom` fire-and-forget alongside it
  // so the new apex is recorded as the view's `root` and survives past this tab (design/treeview.md).
  // Not awaited: a zoom that failed to persist still zoomed, and awaiting would make every click wait
  // on a round trip for a UI update that's already local.
  const zoomTo = (id: string) => {
    setApex(id);
    void postZoom(id, view());
  };
  const onZoom = (id: string) => zoomTo(id);
  // Awaited all the way through the refetch, not fire-and-forget — every existing caller already
  // ignored the returned promise, so this is a strict tightening, and it's what lets
  // `onRevealBacklink` below know the new content has actually landed before it tries to scroll to it.
  const onFold = async (ref: string, action: 'unfold' | 'fold') => {
    await postFold(ref, view(), action);
    await refetch();
    setRefreshTick((t) => t + 1);
  };
  // A backlinks-popover entry names both the citing `Link` and the node it lives in. Both unfolds are
  // needed, not just the link's own: `buildNodeItem` only shows a node's own links at all
  // (`linksToShow`) once that node itself is in the view's `unfolds` set — being the apex alone
  // doesn't put it there, confirmed live (the owner rendered as a title+abstract preview with the
  // link nowhere to be found until its own id was unfolded too).
  //
  // Two distinct actions, not one: plain click stays at the current apex — unfolds both in place and
  // scrolls to the owner once it renders (which only happens if the owner is actually reachable from
  // here — a sibling top-level document generally isn't, and this silently does nothing then, same as
  // any anchor-scroll to an id that isn't on the page). Ctrl-click is the "go there for real" action,
  // matching ctrl-click's meaning everywhere else in this app (zoom).
  const onRevealBacklink = async (linkId: string, ownerId: string) => {
    await onFold(ownerId, 'unfold');
    await onFold(linkId, 'unfold');
    requestAnimationFrame(() => {
      document.querySelector(`[data-node-id="${CSS.escape(ownerId)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  };
  const onZoomToBacklink = (linkId: string, ownerId: string) => {
    zoomTo(ownerId);
    void onFold(ownerId, 'unfold');
    void onFold(linkId, 'unfold');
  };
  const onEdit = async (id: string, text: string) => {
    await postUpdate(id, text);
    refetch();
    setRefreshTick((t) => t + 1);
  };

  return (
    <div class="app">
      <header class="app-header">
        <h1>{graphInfo()?.name ?? 'Aperas'}</h1>
        <select
          ref={selectEl}
          id="view-picker"
          name="view"
          value={view()}
          onChange={(e) => setView(e.currentTarget.value)}
          disabled={views.loading}
        >
          <For each={views()}>{(v) => <option value={v.name}>{v.name} ({v.profile})</option>}</For>
        </select>
        <button onClick={() => zoomTo('.')} title="Zoom out to the artifacts root">⌂ root</button>

        <label class="poll-toggle" title="Poll every 1s for changes made outside this tab (e.g. via the CLI)">
          <input
            type="checkbox"
            checked={pollingEnabled()}
            onChange={(e) => setPollingEnabled(e.currentTarget.checked)}
          />
          sync
        </label>

        {/* Fixed-size, floated to the header's far right via `margin-left: auto` — always present so
            a poll flipping loading/error on and off every second never reflows anything around it,
            in either the header or the tree below (see this file's own note on the background poll). */}
        <div class="status-bar">
          <Show when={tree.loading}><span class="status">Loading…</span></Show>
          <Show when={tree.error}><span class="status status-error">{String((tree.error as Error).message)}</span></Show>
        </div>
      </header>

      <nav class="breadcrumbs">
        <span class="crumb" onClick={() => zoomTo('.')}>.</span>
        <For each={breadcrumbs()}>
          {(c) => (
            <>
              <span class="crumb-sep">/</span>
              <span class="crumb" onClick={() => zoomTo(c.full)}>{c.label}</span>
            </>
          )}
        </For>
      </nav>

      <main class="tree">
        <Show when={!tree.error && treeStore.tree} fallback={!tree.loading && !tree.error && <p class="status">Nothing here — the apex itself may be hidden.</p>}>
          {(root) => (
            <FolderDiv
              item={root()} view={view()} onZoom={onZoom} onFold={onFold} onEdit={onEdit}
              onRevealBacklink={onRevealBacklink} onZoomToBacklink={onZoomToBacklink}
            />
          )}
        </Show>
      </main>
    </div>
  );
}
