/**
 * `@kingsleyweb/bun-cache/live`: a bun-cache bus as bun-common's live bus,
 * so an invalidation published in one process (`publishTags()`, a route's
 * `cache.invalidates`, bun-nest's `@Invalidates`) reaches the live
 * subscribers of every process on the bus.
 *
 * ```ts
 * import { liveInvalidation } from "@kingsleyweb/bun-common/live";
 * import { redisBus } from "@kingsleyweb/bun-cache";
 * import { cacheLiveBus } from "@kingsleyweb/bun-cache/live";
 *
 * const bus = redisBus({ url: process.env.REDIS_URL, channel: "app:live" });
 * app.use(liveInvalidation(app, { authorize, bus: cacheLiveBus(bus) }));
 * ```
 *
 * - **Any bus**: `redisBus()` (Redis pub/sub) or `pgBus()` (Postgres
 *   `LISTEN`/`NOTIFY`), or any `CacheBus`. The bus is the caller's: closing
 *   the live connection never closes it.
 * - **The wire**: each live message is a bus message of type
 *   `"invalidate-tags"` in its own namespace ({@link CacheLiveBusOptions.namespace},
 *   `"bun-common/live"` by default), its origin `<process>:<n>`. A channel
 *   may be shared with caches: a cache acts on a message of its own
 *   namespaces only, and this bus ignores every other namespace. A channel
 *   of its own (`channel: "app:live"`) keeps the two apart all the same.
 * - **Too large**: Postgres's `NOTIFY` carries under 8,000 bytes, and
 *   `pgBus` turns a larger message into a `clear` of its namespace, keeping
 *   its origin; that arrives as a `truncated` live message, which every
 *   receiver treats as a gap (its subscribers invalidate everything).
 */
import type { LiveBus, LiveBusMessage } from "@kingsleyweb/bun-common/live";
import type { BusMessage, CacheBus } from "../core/types";

/** The default {@link CacheLiveBusOptions.namespace}. */
export const DEFAULT_LIVE_NAMESPACE = "bun-common/live";

/** What {@link cacheLiveBus} takes. */
export interface CacheLiveBusOptions {
  /**
   * The bus-message namespace live messages are sent and read under; every
   * process on the bus must use the same one. Choose one no cache on the
   * same channel uses. Default `"bun-common/live"`.
   */
  readonly namespace?: string;
}

/** A live message's origin and number, as one bus `origin`. */
function encodeOrigin(message: LiveBusMessage): string {
  return `${message.origin}:${message.n}`;
}

/** A bus `origin` back as a live origin and number, if it is one. */
function decodeOrigin(
  origin: string | undefined,
): { origin: string; n: number } | undefined {
  if (origin === undefined) return undefined;
  const at = origin.lastIndexOf(":");
  if (at <= 0) return undefined;
  const n = Number(origin.slice(at + 1));
  if (!Number.isSafeInteger(n) || n <= 0) return undefined;
  return { origin: origin.slice(0, at), n };
}

/**
 * A bun-cache bus as bun-common's {@link LiveBus}, for `liveInvalidation()`'s
 * `bus` or `connectLiveBus()`. See the module header.
 *
 * @param bus A bun-cache bus: `redisBus(url)`, `pgBus(url)`, or any `CacheBus`.
 * @param options {@link CacheLiveBusOptions}.
 * @throws TypeError for a namespace that is not a non-empty string.
 */
export function cacheLiveBus(
  bus: CacheBus,
  options: CacheLiveBusOptions = {},
): LiveBus {
  const namespace = options.namespace ?? DEFAULT_LIVE_NAMESPACE;
  if (typeof namespace !== "string" || namespace === "") {
    throw new TypeError("cacheLiveBus: namespace must be a non-empty string");
  }
  return {
    name: bus.name,
    publish: async (message) => {
      await bus.publish({
        type: "invalidate-tags",
        namespace,
        tags: message.tags,
        at: Date.now(),
        origin: encodeOrigin(message),
      });
    },
    subscribe: async (onMessage, onGap) =>
      await bus.subscribe((message: BusMessage) => {
        if (message.namespace !== namespace) return;
        const from = decodeOrigin(message.origin);
        if (from === undefined) return;
        if (message.type === "invalidate-tags") {
          onMessage({ ...from, tags: message.tags ?? [] });
        } else if (message.type === "clear") {
          onMessage({ ...from, tags: [], truncated: true });
        }
      }, onGap),
  };
}
