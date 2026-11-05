import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Codex messages are untrusted Markdown, not HTML. Preserve the source string and
 * render safe React nodes; never use dangerouslySetInnerHTML or execute raw HTML.
 */
export function MarkdownContent({ content }: { content: string }) {
  return <div className="markdown-content">
    <Markdown remarkPlugins={[remarkGfm]} components={{
      a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer"/>,
      // Avoid automatically fetching URLs embedded by agents; retain useful alt text.
      img: ({ alt }) => <span className="markdown-image-alt">[Hình ảnh: {alt || "không có mô tả"}]</span>
    }}>
      {content}
    </Markdown>
  </div>;
}
