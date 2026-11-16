/**
 * The challenge page (layers.md L10.2): a tiny HTML page under a strict
 * Content Security Policy of its own — nothing by default, scripts only by
 * nonce and from the provider's origins, frames and connections only to
 * the provider, forms only to this origin — the policy shape bun-ui's pages
 * use. It holds the provider's widget in a form that posts the answer to the
 * challenge endpoint, then returns to the page that was asked for.
 */
import { randomBytes } from "node:crypto";
import type { ChallengeDescriptor } from "./types";

/** `text` escaped for HTML text and attributes. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** The origin of a URL, or `undefined` for one that is not absolute http(s). */
function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.origin
      : undefined;
  } catch {
    return undefined;
  }
}

/** The page's Content-Security-Policy for a descriptor and a nonce. */
export function challengeCsp(
  descriptor: ChallengeDescriptor,
  nonce: string,
): string {
  const scripts = (descriptor.scripts ?? [])
    .map(originOf)
    .filter((o): o is string => o !== undefined);
  const join = (values: readonly string[] | undefined) =>
    (values ?? []).join(" ");
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' ${scripts.join(" ")}`.trim(),
    `style-src 'nonce-${nonce}' ${join(descriptor.origins?.style)}`.trim(),
    descriptor.origins?.frame?.length
      ? `frame-src ${join(descriptor.origins.frame)}`
      : "frame-src 'none'",
    `connect-src 'self' ${join(descriptor.origins?.connect)}`.trim(),
    "img-src 'self' data:",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** What {@link challengePage} renders. */
export interface ChallengePageOptions {
  /** Where the form posts the answer. */
  readonly action: string;
  /** Where to go once the challenge is passed: a path on this origin. */
  readonly returnTo: string;
  /** The page's title. */
  readonly title: string;
  /** A line under the title (a failed attempt's notice). */
  readonly notice?: string;
  /** The status to answer with. */
  readonly status: number;
}

/**
 * The challenge page for `descriptor`, under its CSP, `no-store`. The
 * widget's own scripts load from the provider; the page's inline script
 * (the proof of work's solver, or the CAPTCHA's callback) runs by nonce.
 */
export function challengePage(
  descriptor: ChallengeDescriptor,
  options: ChallengePageOptions,
): Response {
  const nonce = randomBytes(16).toString("base64");
  const scripts = (descriptor.scripts ?? [])
    .map(
      (src) =>
        `<script src="${escapeHtml(src)}" nonce="${nonce}" async defer></script>`,
    )
    .join("\n");
  const inline =
    descriptor.script ??
    `window.bunSecuritySolved = () => document.getElementById("bun-security-challenge").submit();`;
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(options.title)}</title>
<style nonce="${nonce}">
body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f6f7f9;color:#1d2433}
main{max-width:28rem;padding:2rem;text-align:center}
@media (prefers-color-scheme:dark){body{background:#14161a;color:#e6e8eb}}
</style>
</head>
<body>
<main>
<h1>${escapeHtml(options.title)}</h1>
${options.notice ? `<p role="alert">${escapeHtml(options.notice)}</p>` : ""}
<form id="bun-security-challenge" method="post" action="${escapeHtml(options.action)}">
<input type="hidden" name="return" value="${escapeHtml(options.returnTo)}">
${descriptor.html}
<noscript><p>This check needs JavaScript.</p></noscript>
</form>
</main>
${scripts}
<script nonce="${nonce}">${inline}</script>
</body>
</html>
`;
  return new Response(body, {
    status: options.status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": challengeCsp(descriptor, nonce),
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}
