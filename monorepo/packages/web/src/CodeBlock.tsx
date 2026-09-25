import { createSignal } from 'solid-js';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import rust from 'highlight.js/lib/languages/rust';
import python from 'highlight.js/lib/languages/python';
import yaml from 'highlight.js/lib/languages/yaml';
import css from 'highlight.js/lib/languages/css';
import scss from 'highlight.js/lib/languages/scss';
import xml from 'highlight.js/lib/languages/xml';
import sql from 'highlight.js/lib/languages/sql';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import ini from 'highlight.js/lib/languages/ini';
import diff from 'highlight.js/lib/languages/diff';
import graphql from 'highlight.js/lib/languages/graphql';
import plaintext from 'highlight.js/lib/languages/plaintext';
import { classifyBlock } from './markdown';

interface CodeBlockProps {
  source: string;
}

// Registered per-language (not the ~190-language `highlight.js` barrel — see `Inline.tsx`'s sibling
// reasoning for `mermaid`'s own diagram-type chunks). `bash`/`javascript`/`typescript`/`json`/
// `markdown`/`rust` are confirmed live in this corpus (`grep`'d: bash 36, markdown 12, json 12, ts 8,
// javascript 4, rust 2); the rest are a deliberately broader set of ~20 common languages, added
// ahead of need rather than one at a time as each first appears — small per-language cost (each is
// its own self-contained module, none import a sibling grammar as a base), worth it to avoid the
// "wrong grammar's coloring" failure mode `highlightToHtml`'s own fallback below exists for.
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('python', python);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('scss', scss);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('go', go);
hljs.registerLanguage('java', java);
hljs.registerLanguage('c', c);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('csharp', csharp);
hljs.registerLanguage('dockerfile', dockerfile);
hljs.registerLanguage('ini', ini);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('graphql', graphql);
hljs.registerLanguage('plaintext', plaintext);

const ALIASES: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  sh: 'bash', shell: 'bash', zsh: 'bash', md: 'markdown', text: 'plaintext', txt: 'plaintext',
  py: 'python', yml: 'yaml', html: 'xml', xhtml: 'xml', svg: 'xml',
  'c++': 'cpp', cc: 'cpp', cxx: 'cpp', cs: 'csharp', docker: 'dockerfile',
  toml: 'ini', patch: 'diff', gql: 'graphql',
};

/** Stored code nodes contain their original Markdown fence — `classifyBlock` (`./markdown`) already
 *  parses that fence via `remark-gfm`, the same parser that decided this was a code block in the
 *  first place, giving `{lang, value}` directly rather than hand-detecting the fence markers and
 *  re-deriving the dedented body from scratch. Falls back to the raw source, fenceless, for text
 *  that doesn't parse as a single code block (defensive only — every real call site already
 *  confirmed this via `classifyBlock` before rendering `CodeBlock` at all). */
export function parseCodeBlock(source: string): { code: string; language: string } {
  const c = classifyBlock(source);
  if (c.kind === 'code') return { code: c.node.value, language: (c.node.lang ?? '').toLowerCase() };
  if (c.kind === 'mermaid') return { code: c.code, language: 'mermaid' };
  return { code: source.trim(), language: '' };
}

/** `innerHTML` on the result — same trust boundary `MermaidDiagram.tsx` already accepts for its own
 *  SVG output: the source is this app's own registered `highlight.js` grammars running over this
 *  corpus's own stored text, not third-party/user-supplied markup. */
const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (c) => HTML_ESCAPES[c]);
}

/** A language this corpus's code fences don't currently use (not registered — see the list above)
 *  renders as plain, unhighlighted text. `hljs.highlightAuto` was tried first, but it only ever
 *  guesses *among the registered languages* — confirmed live, a Python snippet got confidently
 *  mislabeled "bash" and had `return` colored as a bash builtin, which is worse than no highlighting
 *  at all. Plain text degrades honestly; a wrong grammar's coloring doesn't. */
export function highlightToHtml(code: string, language: string): string {
  const lang = ALIASES[language] ?? language;
  if (hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
  return escapeHtml(code);
}

export default function CodeBlock(props: CodeBlockProps) {
  const parsed = () => parseCodeBlock(props.source);
  const [copied, setCopied] = createSignal(false);

  const copyCode = (e: MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(parsed().code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <div class="fd-code-wrapper" onClick={(e) => e.stopPropagation()}>
      <div class="fd-code-toolbar">
        <span class="fd-code-badge">💻 {parsed().language || 'Code'}</span>
        <div class="fd-code-actions">
          <button class="fd-btn-small" onClick={copyCode} title="Copy code">
            {copied() ? 'Copied ✓' : 'Copy'}
          </button>
        </div>
      </div>
      <pre class="fd-code-block"><code innerHTML={highlightToHtml(parsed().code, parsed().language)} /></pre>
    </div>
  );
}
