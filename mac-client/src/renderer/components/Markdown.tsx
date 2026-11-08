import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Devin reply markdown — sanitized by construction: react-markdown emits
 * elements only (no `rehype-raw`, so raw HTML in agent output can never
 * reach the DOM). URL schemes are restricted to http(s)/mailto; other
 * schemes (javascript:, file:) are stripped of href and rendered as text.
 * Navigation is inert anyway (main denies will-navigate), but clicks are
 * still prevented so the shell never attempts a page transition.
 */
function safeUrl(url: string): string | undefined {
  const transformed = defaultUrlTransform(url);
  return transformed === '' ? undefined : transformed;
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="otterin-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            const safe = href ? safeUrl(href) : undefined;
            return (
              <a
                href={safe}
                title={href}
                onClick={(event) => event.preventDefault()}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
