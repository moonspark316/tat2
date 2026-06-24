import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { invoke } from "@tauri-apps/api/core";

/**
 * Any navigation inside this frameless popover would replace the whole app UI
 * with no way back. Two layers of defense:
 *
 *  1. Sanitize away every element that can perform a top-level navigation other
 *     than a plain <a> — <form>/<input>/<button>, image-map <area>, <base>, and
 *     embedders. `marked` passes raw HTML through, and DOMPurify's defaults keep
 *     these, so a typed-out `<form action>` or <area> would otherwise click
 *     straight out of the app. Stripping them leaves <a> as the only link path.
 *  2. Intercept clicks on the surviving <a> (any mouse button) and hand external
 *     URLs to the OS browser instead of letting the webview follow them.
 */
const SANITIZE_OPTS = {
  // Drop everything that can navigate/submit on its own; keep formatting + <a>.
  FORBID_TAGS: [
    "form",
    "input",
    "button",
    "textarea",
    "select",
    "option",
    "area",
    "map",
    "base",
    "iframe",
    "object",
    "embed",
  ],
  FORBID_ATTR: ["usemap", "formaction", "action", "ping", "target"],
};

function handleLinkClick(e: React.MouseEvent<HTMLDivElement>) {
  const anchor = (e.target as HTMLElement).closest("a");
  if (!anchor) return;
  const href = anchor.getAttribute("href")?.trim();
  // In-page anchors (e.g. a table-of-contents "#heading") scroll within the
  // preview — that's same-document, harmless, so let it happen.
  if (!href || href.startsWith("#")) {
    if (!href) e.preventDefault();
    return;
  }
  // Everything else must NOT navigate the webview. Open known external schemes
  // in the OS default app; silently drop anything else (relative, javascript:…).
  e.preventDefault();
  if (/^(https?|mailto|tel):/i.test(href)) {
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
      return DOMPurify.sanitize(raw, SANITIZE_OPTS);
    } catch {
      // Fall back to escaped plain text if Markdown parsing ever throws.
      return DOMPurify.sanitize(content, SANITIZE_OPTS);
    }
  }, [content]);

  return (
    <div
      className="markdown"
      style={{ fontSize }}
      onClick={handleLinkClick}
      onAuxClick={handleLinkClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
