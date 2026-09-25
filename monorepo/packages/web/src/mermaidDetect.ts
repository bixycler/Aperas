/**
 * Split out of `MermaidDiagram.tsx` deliberately: this file imports nothing from `mermaid` itself,
 * so `MermaidDiagram.tsx`'s own lazy-loaded chunk (`FolderDiv.tsx`'s
 * `lazy(() => import('./MermaidDiagram'))`) can pull the fence text apart via `cleanMermaidCode`
 * without also pulling `mermaid`'s ~2MB dependency graph (elk, cytoscape, katex, one chunk per
 * diagram type) into whatever *else* imports this. Detecting "is this text a Mermaid block?" no
 * longer lives here at all — `./markdown`'s `classifyBlock` (mermaid-free itself) already answers
 * that as part of classifying a block's kind generally, so callers use that directly instead.
 */
import { classifyBlock } from './markdown';

export function cleanMermaidCode(text: string): string {
  const c = classifyBlock(text);
  return c.kind === 'mermaid' ? c.code : text.trim();
}
