/**
 * Layer L13.3, response leakage (layers.md L13.3): a `5xx` answer must not
 * carry a stack trace. bun-common's own error answer never does; an app's
 * error handler might (`res.status(500).json({ message, stack })`). Seen
 * before it is written, a `5xx` whose body has a `stack` field or a stack
 * frame (`at fn (/app/x.ts:12:5)`) is replaced with a bare problem+json of
 * the same status, and the replacement logged (the route and status, never
 * the body).
 */
import process from "node:process";
import type { BeforeWriteContext, Logger } from "@kingsleyweb/bun-common";

/** When stack traces are scrubbed. */
export type ScrubMode = "production" | "always";

/** A JSON `"stack"` member. */
const STACK_FIELD = /"stack"\s*:/;

/** A line's end that names a source position: `:12`, `:12:5`, either followed by `)`. */
const POSITION_END = /:\d+(?::\d+)?\)?$/;

/** The most of a body read for stack frames; a frame past it goes unseen. */
const MAX_SCAN = 65_536;

/** Whether `line` is a stack frame, V8's (`at fn (/x.ts:1:2)`) or JavaScriptCore's (`fn@/x.ts:1:2`). */
function isFrame(line: string): boolean {
  const trimmed = line.trim();
  if (!POSITION_END.test(trimmed)) return false;
  return (
    trimmed.startsWith("at ") ||
    (trimmed.includes("@") && !trimmed.includes(" "))
  );
}

/** Whether `text` carries a stack trace: a `"stack"` member or a stack frame line. */
export function carriesStack(text: string): boolean {
  const scanned = text.length > MAX_SCAN ? text.slice(0, MAX_SCAN) : text;
  if (STACK_FIELD.test(scanned)) return true;
  for (const line of scanned.split("\n")) {
    if (isFrame(line)) return true;
  }
  return false;
}

/** The body types worth reading: text, JSON, HTML, XML. */
const TEXTUAL =
  /^(?:text\/(?!event-stream)|application\/(?:[\w.+-]+\+)?(?:json|xml))/i;

/** The text a buffered body was sent as, when `res` holds it; `undefined` when it must be read. */
function sentText(context: BeforeWriteContext): string | undefined {
  const res = context.res;
  if (res === undefined || res.settledResponse !== context.response)
    return undefined;
  const sent: unknown = res.getBody();
  if (typeof sent === "string") return sent;
  if (
    typeof sent === "object" &&
    sent !== null &&
    !(sent instanceof Response)
  ) {
    try {
      return JSON.stringify(sent);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** The bare problem+json a scrubbed answer becomes. */
function scrubbed(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/problem+json");
  headers.set("cache-control", "no-store");
  const status = response.status;
  return new Response(
    JSON.stringify({
      type: "about:blank",
      title: status === 503 ? "Service Unavailable" : "Internal Server Error",
      status,
      code: "internal_error",
    }),
    { status, headers },
  );
}

/**
 * The scrubbing before-write hook: `mode` `"production"` scrubs while
 * `NODE_ENV` is `production` (read when the hook is made), `"always"`
 * scrubs everywhere. Streams are left alone: reading one would hold it.
 */
export function stackScrubber(
  mode: ScrubMode,
  logger: Logger,
):
  | ((
      context: BeforeWriteContext,
    ) => Response | undefined | Promise<Response | undefined>)
  | undefined {
  if (mode === "production" && process.env.NODE_ENV !== "production") {
    return undefined;
  }
  const replace = (context: BeforeWriteContext, text: string) => {
    if (!carriesStack(text)) return undefined;
    logger.warn("bun-security: a 5xx answer carried a stack trace; scrubbed", {
      status: context.response.status,
      method: context.request.method,
      path: context.req?.path,
    });
    discard(context.response);
    return scrubbed(context.response);
  };
  return (context) => {
    const response = context.response;
    if (response.status < 500) return undefined;
    if (context.res?.isStreamOpen === true) return undefined;
    const type = response.headers.get("content-type") ?? "";
    if (!TEXTUAL.test(type)) return undefined;
    const known = sentText(context);
    if (known !== undefined) return replace(context, known);
    return response
      .clone()
      .text()
      .then(
        (text) => replace(context, text),
        () => undefined,
      );
  };
}

/** Cancels a replaced response's body. */
function discard(response: Response): void {
  response.body?.cancel().catch(() => undefined);
}
