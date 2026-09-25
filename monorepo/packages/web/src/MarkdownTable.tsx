import { createSignal, For, Show, type JSX } from 'solid-js';
import { renderInline, plainTextOf } from './Inline';
import { classifyBlock } from './markdown';
import type { Table } from 'mdast';

/** Tab/newline inside a cell's own text would otherwise corrupt the TSV's row/column structure —
 *  collapsed to a single space, same as a spreadsheet's own paste-as-TSV would do. */
function tableToTsv(table: Table): string {
  const cellText = (cell: Table['children'][number]['children'][number]) =>
    cell.children.map(plainTextOf).join('').replace(/[\t\n]+/g, ' ').trim();
  return table.children.map((row) => row.children.map(cellText).join('\t')).join('\n');
}

/** `true` only when the *entire* text is one GFM table — see `./markdown`'s doc comment for why a
 *  stored block's own text is never really "some prose, then a table" at this layer. */
export function isMarkdownTable(text: string): boolean {
  return classifyBlock(text).kind === 'table';
}

export interface MarkdownTableProps {
  markdown: string;
  id?: string;
  onNavigate?: (id: string) => void;
  popover?: { view: string; onFold: (ref: string, action: 'unfold' | 'fold') => void };
}

export default function MarkdownTable(props: MarkdownTableProps): JSX.Element {
  const tableNode = () => {
    const c = classifyBlock(props.markdown);
    return c.kind === 'table' ? c.node : null;
  };
  const [showSource, setShowSource] = createSignal(false);
  const [copied, setCopied] = createSignal(false);

  // View-based: the rendered "Table" view copies as TSV (pastes straight into a spreadsheet), the
  // "Source" view copies the original Markdown (pastes into another Markdown document) — copying
  // the format of whichever view is actually on screen, not always the same one regardless.
  const copyTable = (e: MouseEvent) => {
    e.stopPropagation();
    const table = tableNode();
    const text = showSource() || !table ? props.markdown.trim() : tableToTsv(table);
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  const onNavigate = props.onNavigate ?? (() => {});
  const headerRow = (table: Table) => table.children[0];
  const dataRows = (table: Table) => table.children.slice(1);
  const align = (table: Table, idx: number) => table.align?.[idx] ?? 'left';

  return (
    <div class="fd-table-wrapper" onClick={(e) => e.stopPropagation()}>
      <div class="fd-table-toolbar">
        <div class="fd-table-header-info">
          <span class="fd-table-badge">📊 Table</span>
          <Show when={tableNode()}>
            {(table) => (
              <span class="fd-table-stats">
                ({dataRows(table()).length} {dataRows(table()).length === 1 ? 'row' : 'rows'}, {headerRow(table()).children.length} cols)
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
          <button class="fd-btn-small" onClick={copyTable} title={showSource() ? 'Copy as Markdown' : 'Copy as TSV (paste into a spreadsheet)'}>
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
          when={tableNode()}
          fallback={
            <pre class="fd-code-block fd-table-source">
              <code>{props.markdown.trim()}</code>
            </pre>
          }
        >
          {(table) => (
            <div class="fd-table-container">
              <table class="fd-table">
                <thead>
                  <tr>
                    <For each={headerRow(table()).children}>
                      {(cell, idx) => (
                        <th class="fd-table-th" style={{ 'text-align': align(table(), idx()) }}>
                          {renderInline(cell.children, onNavigate, props.popover)}
                        </th>
                      )}
                    </For>
                  </tr>
                </thead>
                <tbody>
                  <For each={dataRows(table())}>
                    {(row) => (
                      <tr class="fd-table-tr">
                        <For each={row.children}>
                          {(cell, idx) => (
                            <td class="fd-table-td" style={{ 'text-align': align(table(), idx()) }}>
                              {renderInline(cell.children, onNavigate, props.popover)}
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
