/**
 * The graceful stop both adapters' `close()` use (bun-common's
 * `BunHttpAdapter` and bun-nest's): drain in-flight requests for a bounded
 * time, then always force-close.
 */

/** `closeDrainTimeout`'s default: the longest drain, in milliseconds. */
const DEFAULT_CLOSE_DRAIN_TIMEOUT = 10_000;

/**
 * The part of a `Bun.serve` server {@link drainAndStop} uses, so any server
 * (or a test double) with these two members can be drained.
 */
export interface DrainableServer {
  /** In-flight HTTP requests, streamed responses included until they end. */
  readonly pendingRequests: number;
  /**
   * Stops the server; with `closeActiveConnections` true, every open
   * connection (WebSockets included) is closed at once.
   */
  stop: (closeActiveConnections?: boolean) => Promise<void>;
}

/**
 * The `closeDrainTimeout` option, checked: `undefined` gives the default
 * (`10_000`); a finite number of milliseconds `>= 0` is returned as it is.
 *
 * @param value The option as given.
 * @returns The drain cap, in milliseconds.
 * @throws {RangeError} for anything else (negative, `NaN`, `Infinity`, a
 *   non-number).
 */
export function validateCloseDrainTimeout(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_CLOSE_DRAIN_TIMEOUT;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    const shown =
      typeof value === "number" ? String(value) : Bun.inspect(value);
    throw new RangeError(
      `closeDrainTimeout must be a finite number of milliseconds >= 0, got ${shown}`,
    );
  }
  return value;
}

/**
 * Drains `server`, then force-closes it. With requests in flight and a cap
 * above `0`, `stop(false)` stops accepting (Bun closes the listener and every
 * idle keep-alive connection at once, and each busy one as its response
 * completes), then this waits until `pendingRequests` is `0` or `drainMs`
 * has passed. The wait is on `pendingRequests`, not on that call's promise,
 * which would also wait for every WebSocket. `stop(true)` then always runs:
 * a graceful stop alone leaves a long-lived response (an SSE stream) and
 * WebSockets served by the old server after it resolves, even once another
 * server is bound on the same port (measured: S3 of
 * `docs/plans/nestjs-12-parity/evidence/lifecycle-spike/`). So a stream that
 * never ends holds this for the whole cap.
 *
 * @param server The server to stop.
 * @param drainMs The longest wait for in-flight requests, in milliseconds;
 *   `0` force-closes at once. Check it first with
 *   {@link validateCloseDrainTimeout}.
 */
export async function drainAndStop(
  server: DrainableServer,
  drainMs: number,
): Promise<void> {
  if (drainMs > 0 && server.pendingRequests > 0) {
    server.stop(false).catch(() => undefined);
    const deadline = Date.now() + drainMs;
    while (server.pendingRequests > 0 && Date.now() < deadline) {
      await Bun.sleep(10);
    }
  }
  await server.stop(true);
}
