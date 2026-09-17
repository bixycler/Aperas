import { createSignal, createResource, createEffect, For, Show, createMemo } from 'solid-js';
import FolderDiv from './FolderDiv';
import type { TreeResponse, ViewInfo } from './render';
import './App.css';

async function fetchViews(): Promise<ViewInfo[]> {
  const res = await fetch('/api/views');
  if (!res.ok) throw new Error(`/api/views: ${res.status}`);
  return res.json();
}

async function fetchTree(params: { apex: string; view: string }): Promise<TreeResponse> {
  const url = `/api/tree?path=${encodeURIComponent(params.apex)}&view=${encodeURIComponent(params.view)}`;
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `/api/tree: ${res.status}`);
  return body;
}

async function postFold(ref: string, view: string, action: 'unfold' | 'fold'): Promise<void> {
  const url = `/api/fold?ref=${encodeURIComponent(ref)}&view=${encodeURIComponent(view)}&action=${action}`;
  const res = await fetch(url, { method: 'POST' });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `/api/fold: ${res.status}`);
}

/** Slice 8's shallow write — the one edit Phase 1 supports: a node's own text, nothing else. */
async function postUpdate(id: string, text: string): Promise<void> {
  const res = await fetch(`/api/update?id=${encodeURIComponent(id)}`, { method: 'POST', body: text });
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
  const [apex, setApex] = createSignal(initialParams.get('path') ?? '.');
  const [refreshTick, setRefreshTick] = createSignal(0);

  const [views] = createResource(fetchViews);
  const [tree, { refetch }] = createResource(
    () => ({ apex: apex(), view: view(), tick: refreshTick() }),
    (params) => fetchTree(params),
  );

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
    params.set('path', apex());
    history.replaceState(null, '', `${location.pathname}?${params}`);
  });

  const breadcrumbs = createMemo(() => {
    const path = tree()?.path;
    if (!path || path === '.') return [] as Array<{ label: string; full: string }>;
    const segments = path.split('/').filter((s) => s.length > 0);
    return segments.map((_, i) => ({ label: segments[i], full: segments.slice(0, i + 1).join('/') }));
  });

  const onZoom = (id: string) => setApex(id);
  const onFold = async (ref: string, action: 'unfold' | 'fold') => {
    await postFold(ref, view(), action);
    refetch();
    setRefreshTick((t) => t + 1);
  };
  const onEdit = async (id: string, text: string) => {
    await postUpdate(id, text);
    refetch();
    setRefreshTick((t) => t + 1);
  };

  return (
    <div class="app">
      <header class="app-header">
        <h1>Aperas</h1>
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
        <button onClick={() => setApex('.')} title="Zoom out to the artifacts root">⌂ root</button>
      </header>

      <nav class="breadcrumbs">
        <span class="crumb" onClick={() => setApex('.')}>.</span>
        <For each={breadcrumbs()}>
          {(c) => (
            <>
              <span class="crumb-sep">/</span>
              <span class="crumb" onClick={() => setApex(c.full)}>{c.label}</span>
            </>
          )}
        </For>
      </nav>

      <main class="tree">
        <Show when={tree.loading}><p class="status">Loading…</p></Show>
        <Show when={tree.error}><p class="status status-error">{String((tree.error as Error).message)}</p></Show>
        <Show when={tree()?.tree} fallback={!tree.loading && !tree.error && <p class="status">Nothing here — the apex itself may be hidden.</p>}>
          {(root) => <FolderDiv item={root()} view={view()} onZoom={onZoom} onFold={onFold} onEdit={onEdit} />}
        </Show>
      </main>
    </div>
  );
}
