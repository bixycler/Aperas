import { createSignal, For, Show, type JSX } from 'solid-js';
import Inline from './Inline';

export function splitTableRow(row: string): string[] {
  let line = row.trim();
  if (line.startsWith('|')) line = line.slice(1);
  if (line.endsWith('|') && !line.endsWith('\\|')) line = line.slice(0, -1);

  const cells: string[] = [];
  let current = '';
  let inCodeSpan = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const prev = i > 0 ? line[i - 1] : '';

    if (char === '`' && prev !== '\\') {
      inCodeSpan = !inCodeSpan;
      current += char;
    } else if (char === '|' && !inCodeSpan && prev !== '\\') {
      cells.push(current.trim());
      current = '';
    } else if (char === '|' && prev === '\\') {
      current = current.slice(0, -1) + '|';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

export function parseAlignment(cell: string): 'left' | 'center' | 'right' | undefined {
  const trimmed = cell.trim();
  const startsWithColon = trimmed.startsWith(':');
  const endsWithColon = trimmed.endsWith(':');
  if (startsWithColon && endsWithColon) return 'center';
  if (endsWithColon) return 'right';
  if (startsWithColon) return 'left';
  return undefined;
}

export function isDelimiterRow(line: string): boolean {
  const cells = splitTableRow(line);
  if (cells.length === 0) return false;
  return cells.every((c) => /^\s*:?-+:?\s*$/.test(c));
}

export function isMarkdownTable(raw: string): boolean {
  if (!raw) return false;
  const lines = raw.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return false;
  if (!lines[0].includes('|')) return false;
  return isDelimiterRow(lines[1]);
}

export interface ParsedTableData {
  headers: string[];
  alignments: ('left' | 'center' | 'right' | undefined)[];
  rows: string[][];
}

export function parseMarkdownTable(markdown: string): ParsedTableData | null {
  const lines = markdown.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  if (!isDelimiterRow(lines[1])) return null;

  const rawHeaders = splitTableRow(lines[0]);
  const alignments = splitTableRow(lines[1]).map(parseAlignment);
  const rawRows = lines.slice(2).map((l) => splitTableRow(l));

  const colCount = Math.max(rawHeaders.length, ...rawRows.map((r) => r.length));
  const headers = [...rawHeaders];
  while (headers.length < colCount) headers.push('');

  while (alignments.length < colCount) alignments.push(undefined);

  const rows = rawRows.map((row) => {
    const r = [...row];
    while (r.length < colCount) r.push('');
    return r;
  });

  return { headers, alignments, rows };
}

export interface MarkdownTableProps {
  markdown: string;
  id?: string;
  onNavigate?: (id: string) => void;
  popover?: { view: string; onFold: (ref: string, action: 'unfold' | 'fold') => void };
}

export default function MarkdownTable(props: MarkdownTableProps): JSX.Element {
  const tableData = () => parseMarkdownTable(props.markdown);
  const [showSource, setShowSource] = createSignal(false);
  const [copied, setCopied] = createSignal(false);

  const copyMarkdown = (e: MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(props.markdown.trim()).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <div class="fd-table-wrapper" onClick={(e) => e.stopPropagation()}>
      <div class="fd-table-toolbar">
        <div class="fd-table-header-info">
          <span class="fd-table-badge">📊 Table</span>
          <Show when={tableData()}>
            {(data) => (
              <span class="fd-table-stats">
                ({data().rows.length} {data().rows.length === 1 ? 'row' : 'rows'}, {data().headers.length} cols)
              </span>
            )}
          </Show>
        </div>
        <div class="fd-table-actions">
          <button
            class="fd-btn-small"
            classList={{ 'fd-btn-active': !showSource() }}
            onClick={() => setShowSource(false)}
          >
            Table
          </button>
          <button
            class="fd-btn-small"
            classList={{ 'fd-btn-active': showSource() }}
            onClick={() => setShowSource(true)}
          >
            Source
          </button>
          <button class="fd-btn-small" onClick={copyMarkdown} title="Copy Markdown table">
            {copied() ? 'Copied ✓' : 'Copy'}
          </button>
        </div>
      </div>

      <Show when={showSource()}>
        <pre class="fd-code-block fd-table-source">
          <code>{props.markdown.trim()}</code>
        </pre>
      </Show>

      <Show when={!showSource()}>
        <Show
          when={tableData()}
          fallback={
            <pre class="fd-code-block fd-table-source">
              <code>{props.markdown.trim()}</code>
            </pre>
          }
        >
          {(data) => (
            <div class="fd-table-container">
              <table class="fd-table">
                <thead>
                  <tr>
                    <For each={data().headers}>
                      {(header, idx) => (
                        <th
                          class="fd-table-th"
                          style={{ 'text-align': data().alignments[idx()] ?? 'left' }}
                        >
                          <Inline
                            text={header}
                            onNavigate={props.onNavigate ?? (() => {})}
                            popover={props.popover}
                          />
                        </th>
                      )}
                    </For>
                  </tr>
                </thead>
                <tbody>
                  <For each={data().rows}>
                    {(row) => (
                      <tr class="fd-table-tr">
                        <For each={row}>
                          {(cell, idx) => (
                            <td
                              class="fd-table-td"
                              style={{ 'text-align': data().alignments[idx()] ?? 'left' }}
                            >
                              <Inline
                                text={cell}
                                onNavigate={props.onNavigate ?? (() => {})}
                                popover={props.popover}
                              />
                            </td>
                          )}
                        </For>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          )}
        </Show>
      </Show>
    </div>
  );
}
