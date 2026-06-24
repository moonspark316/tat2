import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { invoke } from "@tauri-apps/api/core";

/**
 * A link inside a frameless popover that navigates the webview would replace the
 * whole app UI with no way back. Intercept clicks and hand external URLs to the
 * OS default browser instead; ignore anything else.
 */
function handleLinkClick(e: React.MouseEvent<HTMLDivElement>) {
  const anchor = (e.target as HTMLElement).closest("a");
  if (!anchor) return;
  e.preventDefault();
  const href = anchor.getAttribute("href");
  if (href && /^(https?|mailto|tel):/i.test(href)) {
    void invoke("plugin:opener|open_url", { url: href }).catch(() => {});
  }
}

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
      onClick={handleLinkClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
