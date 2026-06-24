import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

/**
 * Rendered Markdown preview. Plain text remains the source of truth; this is a
 * read-only view. Output is sanitized so a pasted note can't run scripts or
 * reach the Tauri IPC bridge.
 */
export function MarkdownView({
  content,
  fontSize,
}: {
  content: string;
  fontSize: number;
}) {
  const html = useMemo(() => {
    try {
      const raw = marked.parse(content, { async: false, gfm: true }) as string;
      return DOMPurify.sanitize(raw);
    } catch {
      // Fall back to escaped plain text if Markdown parsing ever throws.
      return DOMPurify.sanitize(content);
    }
  }, [content]);

  return (
    <div
      className="markdown"
      style={{ fontSize }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
