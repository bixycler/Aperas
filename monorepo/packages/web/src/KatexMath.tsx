/**
 * Loaded only through `lazy(() => import('./KatexMath'))` in `Inline.tsx`, so KaTeX and its CSS/fonts
 * stay out of the entry chunk — same pattern as `MermaidDiagram.tsx`. `innerHTML` is safe here:
 * KaTeX's default `trust: false` escapes the TeX source and refuses `\href`/`\url`/raw-HTML commands.
 */
import katex from 'katex';
import 'katex/dist/katex.min.css';

export default function KatexMath(props: { tex: string; display?: boolean }) {
  const html = () => katex.renderToString(props.tex, { displayMode: !!props.display, throwOnError: false });
  return props.display
    ? <div class="fd-math-display" innerHTML={html()} />
    : <span class="fd-math" innerHTML={html()} />;
}
