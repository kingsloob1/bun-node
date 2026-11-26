/**
 * What every mount does around better-auth's handler: the client address
 * set on the request it hands over (plan §4.2), and an internal error that
 * better-auth answered as a bare `500` reported to the host's logger (§4.3).
 * Shared by `mountAuth`/`authHandler` and `./serve`'s `withAuth`.
 */
import type { Logger } from "@kingsleyweb/bun-common";

/**
 * `request` with `header` set to `address`, after removing any copy the
 * client sent; with `address` empty (nothing resolved), only removed. The
 * body is carried over unread, and the method, URL and signal kept.
 */
export function withClientAddress(
  request: Request,
  header: string,
  address: string,
): Request {
  const headers = new Headers(request.headers);
  headers.delete(header);
  if (address !== "") headers.set(header, address);
  if (headers.keys().next().done === true) {
    // Bun keeps the input's headers when `init.headers` is empty
    // (oven-sh/bun#49395), which would hand the client's forged copy on:
    // build the request from its parts instead. Remove once a stable Bun
    // has the fix.
    return new Request(request.url, {
      method: request.method,
      headers,
      body: request.body,
      signal: request.signal,
    });
  }
  return new Request(request, { headers });
}

/**
 * Logs a `5xx` better-auth answered without throwing: by default an internal
 * error becomes an empty `500` whose cause better-auth prints to the console
 * only (evidence E4). The answer itself is sent unchanged.
 */
export function reportServerError(
  logger: Logger,
  request: Request,
  response: Response,
  throws: boolean,
): void {
  if (response.status < 500) return;
  const path = new URL(request.url).pathname;
  const hint = throws
    ? ""
    : "; its error went to the console and onAPIError.onError, not here " +
      "(set onAPIError: { throw: true } to hand it to this app)";
  logger.error(
    `bun-auth: better-auth answered ${response.status} to ${request.method} ${path}${hint}`,
    { status: response.status, method: request.method, path },
  );
}
