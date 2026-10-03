import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './ai-markdown.css';

/** Model output is text, not trusted HTML or a source of remote image requests. */
export function AiMarkdown({ text }: { text: string }) {
  return <div className="ai-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ href, children }) => href && /^(https?:|mailto:)/i.test(href)
      ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
    img: ({ alt }) => <span>{alt}</span>,
    table: ({ children }) => <div className="ai-table-scroll" tabIndex={0}><table>{children}</table></div>,
  }}>{text}</Markdown></div>;
}
