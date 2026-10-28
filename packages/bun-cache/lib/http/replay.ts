/**
 * The background revalidation of `cacheResponse()` (plan §9.4): a stale
 * entry served inside its stale-while-revalidate window is refreshed by
 * replaying its request through the router's socket-free `fetch()`.
 *
 * The replay carries `x-bun-cache-revalidate: <token>.<id>`: a random
 * per-process token, and the id of one replay a middleware started and is
 * waiting on. Only a request carrying both is treated as a replay, so a
 * client cannot forge one (the token never leaves the process: the replay
 * goes through `fetch()`, not a socket).
 */
import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import type { BunRequest } from "@kingsleyweb/bun-common";

/** The internal request header carrying the replay token (plan §21). */
export const REVALIDATE_HEADER = "x-bun-cache-revalidate";

/** This process's replay token: 32 random bytes, hex. */
const TOKEN = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
  "hex",
);
const TOKEN_BYTES = Buffer.from(TOKEN);

/** The header value of the replay `id`. */
export function replayHeaderValue(id: string): string {
  return `${TOKEN}.${id}`;
}

/**
 * The replay id a request's {@link REVALIDATE_HEADER} carries, when its
 * token is this process's (compared in constant time); `undefined` for no
 * header or a forged one.
 */
export function replayIdOf(req: BunRequest): string | undefined {
  const value = req.getHeader(REVALIDATE_HEADER);
  if (value === null) {
    return undefined;
  }
  const dot = value.indexOf(".");
  if (dot === -1) {
    return undefined;
  }
  const token = Buffer.from(value.slice(0, dot));
  if (
    token.byteLength !== TOKEN_BYTES.byteLength ||
    !timingSafeEqual(token, TOKEN_BYTES)
  ) {
    return undefined;
  }
  const id = value.slice(dot + 1);
  return id === "" ? undefined : id;
}

/**
 * The `GET` that replays `req` for revalidation: the same host and target,
 * and only the request headers the key reads (`names`: the `varyBy` ones
 * and the response's `Vary`), plus the replay header. Nothing else of the
 * client's request is carried: no cookie or credential the key does not
 * vary on, no conditional, no `Cache-Control`.
 */
export function replayRequest(
  req: BunRequest,
  names: readonly string[],
  id: string,
): Request {
  const headers = new Headers();
  for (const name of names) {
    const value = req.getHeader(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }
  headers.set("host", req.host);
  headers.set(REVALIDATE_HEADER, replayHeaderValue(id));
  const scheme = req.protocol === "https" ? "https" : "http";
  return new Request(`${scheme}://${req.host}${req.originalUrl}`, {
    method: "GET",
    headers,
  });
}

/**
 * Reads `response`'s body to its end (a buffered replay's capture is
 * already done; a streamed one under `streams: { buffer }` is copied only
 * as it is read), cancelling it when `signal` aborts first.
 */
export async function drain(
  response: Response,
  signal: AbortSignal,
): Promise<void> {
  const body = response.body;
  if (body === null) {
    return;
  }
  const reader = body.getReader();
  const onAbort = (): void => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  if (signal.aborted) {
    onAbort();
    return;
  }
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) {
        return;
      }
    }
  } catch {
    // Cancelled, or the stream failed: the capture reports which.
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
