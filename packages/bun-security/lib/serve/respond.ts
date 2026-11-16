/**
 * The answers a refusal gets (layers.md §0.1): problem+json for an API
 * request, a minimal HTML page for a browser's, and for `drop` no answer at
 * all. The body never names the rule that hit, only the decision's `code`.
 */
import type { Decision } from "../engine/decision";

/** The reason phrase of each status a refusal can carry. */
const TITLES: Readonly<Record<number, string>> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  413: "Content Too Large",
  414: "URI Too Long",
  415: "Unsupported Media Type",
  429: "Too Many Requests",
  431: "Request Header Fields Too Large",
  503: "Service Unavailable",
};

/** Whether the client asked for HTML ahead of JSON (a browser navigating). */
function wantsHtml(accept: string | null): boolean {
  if (!accept) return false;
  const html = accept.indexOf("text/html");
  if (html === -1) return false;
  const json = accept.search(/application\/(?:[\w.+-]+\+)?json/);
  return json === -1 || html < json;
}

/** The headers every refusal carries. */
function refusalHeaders(decision: Decision, type: string): Headers {
  const headers = new Headers({
    "content-type": type,
    "cache-control": "no-store",
  });
  if (decision.retryAfter !== undefined) {
    headers.set(
      "retry-after",
      String(Math.max(0, Math.ceil(decision.retryAfter))),
    );
  }
  return headers;
}

/**
 * The default refusal for a decision that answers (`challenge` without a
 * provider, `block`, `ban`, an L6 shape refusal, a honeypot's `404`): its
 * status, problem+json
 * (`{ type: "about:blank", title, status, code }`) or, when the client asks
 * for HTML first, a minimal page.
 */
export function refusalResponse(
  decision: Decision,
  request: Request,
): Response {
  const status = decision.status ?? 403;
  const title = TITLES[status] ?? "Refused";
  const code = decision.code ?? "blocked";
  if (wantsHtml(request.headers.get("accept"))) {
    return new Response(
      `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${status} ${title}</title></head><body><h1>${title}</h1><p>The request was refused.</p></body></html>\n`,
      { status, headers: refusalHeaders(decision, "text/html; charset=utf-8") },
    );
  }
  return new Response(
    JSON.stringify({ type: "about:blank", title, status, code }),
    { status, headers: refusalHeaders(decision, "application/problem+json") },
  );
}

/**
 * A response whose body fails before its first byte: Bun closes the
 * connection without writing a status line, so the client gets no answer
 * (`drop`). Measured on Bun 1.4.5-canary.1: a stream erroring with no
 * reason closes the socket silently; one erroring with a reason does the
 * same but prints the reason to stderr on every drop.
 */
export function dropResponse(): Response {
  return new Response(
    new ReadableStream({
      pull(controller) {
        controller.error();
      },
    }),
  );
}
