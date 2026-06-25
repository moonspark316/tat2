# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately via GitHub's **[Security Advisories](https://github.com/moonspark316/tat2/security/advisories/new)**
("Report a vulnerability"). We aim to acknowledge within a few days and will
keep you updated on a fix.

If you can, include:

- what the issue is and where (file / command / flow),
- a minimal way to reproduce it,
- the impact you think it has.

## Scope

Tat2 is a **local-first** desktop app — there's no server and no account.
The areas most relevant to security:

- **Storage** — atomic, local writes under the OS app-data dir. We care about
  data-loss and path-handling bugs.
- **Markdown preview** — user content is rendered through a sanitizer
  (DOMPurify) that strips scripts and self-navigating elements, and links open
  in the OS browser rather than navigating the app's webview.
- **Tauri IPC / capabilities** — the frontend can only call the commands and
  window operations allowed in `src-tauri/capabilities/`.

Reports about realistic local-attacker or content-injection scenarios are very
welcome. Thanks for helping keep Tat2 safe.
