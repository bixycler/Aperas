import { For } from 'solid-js';

interface CodeBlockProps {
  source: string;
}

interface CodeToken {
  text: string;
  kind?: 'comment' | 'string' | 'number' | 'keyword' | 'type' | 'function' | 'constant';
}

const KEYWORDS: Record<string, Set<string>> = {
  java: new Set('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while var record sealed permits yield'.split(' ')),
  javascript: new Set('async await break case catch class const continue debugger default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while yield'.split(' ')),
  python: new Set('and as assert async await break class continue def del elif else except False finally for from global if import in is lambda nonlocal not or pass raise return True try while with yield None self'.split(' ')),
  bash: new Set('case do done elif else esac fi for function if in select then until while'.split(' ')),
  sql: new Set('all alter and as asc between by case create cross database delete desc distinct drop else end exists false from full group having in inner insert into is join left like limit not null offset on or order outer primary references right select set table then true union unique update values when where with'.split(' ')),
};

const ALIASES: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', ts: 'javascript', tsx: 'javascript',
  py: 'python', sh: 'bash', shell: 'bash', zsh: 'bash',
  mysql: 'sql', postgres: 'sql', postgresql: 'sql',
  kotlin: 'java', c: 'java', cpp: 'java', 'c++': 'java', cs: 'java', csharp: 'java',
};

/** Stored code nodes contain their original Markdown fence and list indentation. */
export function parseCodeBlock(source: string): { code: string; language: string } {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const first = lines.findIndex((line) => line.trim() !== '');
  let language = '';
  let body = lines;

  if (first >= 0) {
    const opening = /^[ \t]*(`{3,}|~{3,})([^\n]*)$/.exec(lines[first]);
    if (opening) {
      const marker = opening[1][0];
      const minimumLength = opening[1].length;
      const last = lines.findLastIndex((line) => line.trim() !== '');
      const closing = lines[last]?.trim() ?? '';
      if (last > first && closing.length >= minimumLength && [...closing].every((char) => char === marker)) {
        language = opening[2].trim().split(/\s+/)[0]?.replace(/^\{\.?|\}$/g, '').toLowerCase() ?? '';
        body = lines.slice(first + 1, last);
      }
    }
  }

  while (body.length && body[0].trim() === '') body.shift();
  while (body.length && body[body.length - 1].trim() === '') body.pop();
  const indent = body.reduce((minimum, line) => line.trim() === ''
    ? minimum
    : Math.min(minimum, /^[ \t]*/.exec(line)![0].length), Infinity);
  const code = body.map((line) => line.slice(Number.isFinite(indent) ? indent : 0)).join('\n');
  return { code, language };
}

export function highlight(code: string, language: string): CodeToken[] {
  const lang = ALIASES[language] ?? language;
  const comment = lang === 'python' || lang === 'bash'
    ? '#[^\\n]*'
    : lang === 'sql'
      ? '--[^\\n]*|\\/\\*[\\s\\S]*?(?:\\*\\/|$)'
      : '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?(?:\\*\\/|$)';
  const pattern = new RegExp(`${comment}|"(?:\\\\.|[^"\\\\])*"?|'(?:\\\\.|[^'\\\\])*'?|\x60(?:\\\\.|[^\x60\\\\])*\x60?|\\b(?:0x[\\da-fA-F]+|\\d+(?:\\.\\d+)?)\\b|\\b[A-Za-z_$][\\w$]*\\b`, 'g');
  const tokens: CodeToken[] = [];
  let cursor = 0;
  for (const match of code.matchAll(pattern)) {
    const index = match.index!;
    if (index > cursor) tokens.push({ text: code.slice(cursor, index) });
    const value = match[0];
    let kind: CodeToken['kind'];
    if (value.startsWith('//') || value.startsWith('/*') || value.startsWith('#') || (lang === 'sql' && value.startsWith('--'))) kind = 'comment';
    else if (/^["'`]/.test(value)) kind = 'string';
    else if (/^(?:0x|\d)/.test(value)) kind = 'number';
    else if (['true', 'false', 'null', 'undefined', 'True', 'False', 'None'].includes(value)) kind = 'constant';
    else if (KEYWORDS[lang]?.has(lang === 'sql' ? value.toLowerCase() : value)) kind = 'keyword';
    else if (/^[A-Z]/.test(value)) kind = 'type';
    else if (/^\s*\(/.test(code.slice(index + value.length))) kind = 'function';
    tokens.push({ text: value, kind });
    cursor = index + value.length;
  }
  if (cursor < code.length) tokens.push({ text: code.slice(cursor) });
  return tokens;
}

export default function CodeBlock(props: CodeBlockProps) {
  const parsed = () => parseCodeBlock(props.source);
  return (
    <pre class="fd-code-block"><code><For each={highlight(parsed().code, parsed().language)}>
      {(token) => token.kind ? <span class={`fd-syntax-${token.kind}`}>{token.text}</span> : token.text}
    </For></code></pre>
  );
}
