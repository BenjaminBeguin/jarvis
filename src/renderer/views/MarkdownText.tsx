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

/**
 * Split a markdown document with optional YAML frontmatter into the raw
 * frontmatter chunk (without delimiters) and the body. Used to render
 * docs that carry config metadata (SKILL.md, skill suggestions) — the
 * front strip can be shown in a metadata block while the body renders
 * as proper prose.
 */
export function splitFrontmatter(raw: string): {
  frontmatter: string | null;
  body: string;
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: null, body: raw };
  return { frontmatter: match[1]!.trim(), body: match[2]!.trimStart() };
}

/**
 * Renders a markdown document with optional YAML frontmatter. When a
 * frontmatter block is present and `showFrontmatter` is true, it is
 * shown as a small read-only metadata strip above the rendered body.
 * Otherwise just the body is rendered. The wrapper class keeps spacing
 * consistent across the app's "view mode" markdown surfaces.
 */
export function MarkdownDoc({
  children,
  showFrontmatter = false,
}: {
  children: string;
  showFrontmatter?: boolean;
}) {
  const { frontmatter, body } = useMemo(
    () => splitFrontmatter(children),
    [children],
  );
  return (
    <div className="md-doc">
      {showFrontmatter && frontmatter && (
        <details className="md-doc__frontmatter">
          <summary>frontmatter</summary>
          <pre>{frontmatter}</pre>
        </details>
      )}
      <div className="md-doc__body">
        <MarkdownText>{body || '_(empty)_'}</MarkdownText>
      </div>
    </div>
  );
}
