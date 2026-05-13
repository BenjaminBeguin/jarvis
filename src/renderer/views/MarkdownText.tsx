import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Render assistant/user text as markdown — GFM enabled so tables,
 * strikethrough, task lists, and autolinks all work. Links open in the
 * default browser (via openExternal IPC, which only allows http/https
 * for safety).
 */
export function MarkdownText({ children }: { children: string }) {
  // Memoize so React doesn't re-run the parser on every parent render.
  const text = useMemo(() => children, [children]);
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children: kids }) => (
          <a
            href={href ?? '#'}
            onClick={(e) => {
              e.preventDefault();
              if (href) void window.jarvis.openExternal(href);
            }}
          >
            {kids}
          </a>
        ),
        // react-markdown v9+ doesn't accept `inline` on the `code` prop
        // anymore — distinguish via parent (pre = block, otherwise inline).
        code: ({ children: kids, className, ...rest }) => (
          <code className={className} {...rest}>
            {kids}
          </code>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
