/**
 * Split out of `MermaidDiagram.tsx` deliberately: this file imports nothing from `mermaid` itself,
 * so a caller that only needs "is this text a Mermaid block?" (to decide whether to render one at
 * all) never pulls the ~2MB `mermaid` dependency graph (elk, cytoscape, katex, one chunk per
 * diagram type) into its own module's reachable set. `MermaidDiagram.tsx` — the actual renderer —
 * is loaded lazily (`FolderDiv.tsx`'s `lazy(() => import('./MermaidDiagram'))`) only once a real
 * Mermaid block is found, so a corpus with none never fetches any of it.
 */
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
