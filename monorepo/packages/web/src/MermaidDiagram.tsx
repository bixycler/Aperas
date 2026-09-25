import { createSignal, createEffect, Show } from 'solid-js';
import mermaid from 'mermaid';

let mermaidInitialized = false;
function ensureMermaidInitialized() {
  if (mermaidInitialized) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: 'dark',
    themeVariables: {
      darkMode: true,
      background: '#26292b',
      mainBkg: '#313538',
      nodeBorder: '#5aa7ff',
      lineColor: '#5aa7ff',
      textColor: '#9ea4aa',
      clusterBkg: '#2b2e31',
      edgeLabelBackground: '#26292b',
    },
    securityLevel: 'loose',
  });
  mermaidInitialized = true;
}

export function cleanMermaidCode(raw: string): string {
  let text = raw.trim();
  if (text.startsWith('```mermaid')) {
    text = text.slice('```mermaid'.length);
  } else if (text.startsWith('```')) {
    text = text.slice(3);
  }
  if (text.endsWith('```')) {
    text = text.slice(0, -3);
  }
  return text.trim();
}

export function isMermaidCode(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.startsWith('```mermaid')) return true;
  const firstLine = cleanMermaidCode(trimmed).split('\n')[0]?.trim() ?? '';
  return /^(flowchart|sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|journey|gantt|pie|gitGraph|quadrantChart|xychart-beta|graph)\b/.test(firstLine);
}

export interface MermaidDiagramProps {
  code: string;
  id?: string;
}

const svgCache = new Map<string, string>();

export default function MermaidDiagram(props: MermaidDiagramProps) {
  const cleanCode = () => cleanMermaidCode(props.code);
  const cachedSvg = () => svgCache.get(cleanCode());

  const [svg, setSvg] = createSignal<string>(cachedSvg() ?? '');
  const [error, setError] = createSignal<string>();
  const [loading, setLoading] = createSignal(!cachedSvg());
  const [showSource, setShowSource] = createSignal(false);
  const [copied, setCopied] = createSignal(false);

  createEffect(() => {
    const code = cleanCode();
    if (!code) {
      setSvg('');
      setError(undefined);
      setLoading(false);
      return;
    }

    const cached = svgCache.get(code);
    if (cached) {
      setSvg(cached);
      setError(undefined);
      setLoading(false);
      return;
    }

    ensureMermaidInitialized();
    if (!svg()) setLoading(true);
    setError(undefined);

    const renderId = 'mermaid-' + (props.id ? props.id.replace(/[^a-zA-Z0-9_-]/g, '_') : Math.random().toString(36).substring(2, 9)) + '-' + Math.random().toString(36).substring(2, 7);

    mermaid
      .render(renderId, code)
      .then((res) => {
        svgCache.set(code, res.svg);
        setSvg(res.svg);
        setLoading(false);
      })
      .catch((err) => {
        console.error('[MermaidDiagram] render error:', err);
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  });

  const copyCode = (e: MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(cleanCode()).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <div class="fd-mermaid-container" onClick={(e) => e.stopPropagation()}>
      <div class="fd-mermaid-toolbar">
        <span class="fd-mermaid-badge">📊 Mermaid Diagram</span>
        <div class="fd-mermaid-actions">
          <button
            class="fd-btn-small"
            classList={{ 'fd-btn-active': !showSource() }}
            onClick={() => setShowSource(false)}
          >
            Diagram
          </button>
          <button
            class="fd-btn-small"
            classList={{ 'fd-btn-active': showSource() }}
            onClick={() => setShowSource(true)}
          >
            Source
          </button>
          <button class="fd-btn-small" onClick={copyCode} title="Copy Mermaid code">
            {copied() ? 'Copied ✓' : 'Copy'}
          </button>
        </div>
      </div>

      <Show when={showSource()}>
        <pre class="fd-code-block fd-mermaid-source">
          <code>{cleanCode()}</code>
        </pre>
      </Show>

      <Show when={!showSource()}>
        <Show when={loading() && !svg()}>
          <div class="status fd-mermaid-loading">Rendering diagram…</div>
        </Show>
        <Show when={error()}>
          <div class="fd-mermaid-error">
            <div class="status status-error">Mermaid syntax error: {error()}</div>
            <pre class="fd-code-block fd-mermaid-source">
              <code>{cleanCode()}</code>
            </pre>
          </div>
        </Show>
        <Show when={!error() && svg()}>
          <div class="fd-mermaid-svg" innerHTML={svg()} />
        </Show>
      </Show>
    </div>
  );
}
