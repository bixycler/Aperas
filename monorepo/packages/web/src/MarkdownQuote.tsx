import Inline from './Inline';

export function isMarkdownQuote(source: string): boolean {
  return /^[ \t]*>/m.test(source);
}

/** Keep the quote's inline Markdown while removing its source-level `>` markers. */
export function quoteContent(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();

  const quoteIndent = lines.reduce((minimum, line) => {
    const marker = /^([ \t]*)>[ \t]?/.exec(line);
    return marker ? Math.min(minimum, marker[1].length) : minimum;
  }, Infinity);

  return lines.map((line) => {
    const marker = /^[ \t]*>[ \t]?/.exec(line);
    if (marker) return line.slice(marker[0].length);
    // CommonMark also allows a paragraph's continuation line without another `>`.
    const indent = /^[ \t]*/.exec(line)![0].length;
    return line.slice(Math.min(indent, Number.isFinite(quoteIndent) ? quoteIndent : 0));
  }).join('\n');
}

export default function MarkdownQuote(props: {
  source: string;
  onNavigate: (id: string) => void;
  popover?: { view: string; onFold: (ref: string, action: 'unfold' | 'fold') => void };
}) {
  return (
    <blockquote class="fd-blockquote">
      <Inline text={quoteContent(props.source)} onNavigate={props.onNavigate} popover={props.popover} />
    </blockquote>
  );
}
