import { For } from 'solid-js';
import { renderInline } from './Inline';
import { classifyBlock } from './markdown';
import type { PhrasingContent } from 'mdast';

/** `true` only when the *entire* text is one GFM blockquote — see `./markdown`'s doc comment. */
export function isMarkdownQuote(text: string): boolean {
  return classifyBlock(text).kind === 'quote';
}

export default function MarkdownQuote(props: {
  source: string;
  onNavigate: (id: string) => void;
  popover?: { view: string; onFold: (ref: string, action: 'unfold' | 'fold') => void };
}) {
  const paragraphs = () => {
    const c = classifyBlock(props.source);
    if (c.kind !== 'quote') return [];
    return c.node.children
      .filter((child): child is Extract<typeof child, { type: 'paragraph' }> => child.type === 'paragraph')
      .map((p) => p.children as PhrasingContent[]);
  };

  return (
    <blockquote class="fd-blockquote">
      <For each={paragraphs()}>
        {(children, i) => (
          <>
            {i() > 0 && <br />}
            {renderInline(children, props.onNavigate, props.popover)}
          </>
        )}
      </For>
    </blockquote>
  );
}
