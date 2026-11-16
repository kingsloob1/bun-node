/**
 * What the API key anomalies remember (layers.md L12), on S4's shared state
 * when the engine has a store, so a fleet watches each key once:
 *
 * - **a key's ASNs**: one counter per key (`ak:k:<key>`, its requests) and
 *   one per key and ASN (`ak:a:<key>:<asn>`), each created with the
 *   memory's lifetime by one atomic `increment`. A key's first ASN is
 *   learned; a later ASN whose counter is new is the anomaly;
 * - **a key's addresses**: S4's distinct counts (`DistinctCounts`, a
 *   HyperLogLog per key and window in the store);
 * - **once per window**: a marker (`ak:m:…`), so the event and the hook
 *   fire once per key and window, however many requests are over.
 *
 * Keys are the API key's HMAC, never its id. When the store fails, this
 * process's own memory answers (bounded by `maxKeys`), logged at most
 * every ten seconds.
 */
import type { Logger } from "@kingsleyweb/bun-common";
import type { DistinctCounts } from "../engine/distinct";
import { then } from "../engine/maybe";
import type { MaybePromise } from "../engine/maybe";
import type { SharedStateStore } from "../engine/shared";
import { BoundedTable } from "../engine/state";
import type { EvictionMonitor } from "../engine/state";

/** What a request's ASN is to its key. */
export type AsnVerdict = "learned" | "known" | "new";

/** A key's ASNs in this process. */
interface LocalAsns {
  /** The ASNs, each with when it is forgotten. */
  readonly asns: Map<number, number>;
  /** When the key itself is forgotten. */
  until: number;
}

/** The anomalies' memory. */
export class ApiKeyWatch {
  readonly #local: BoundedTable<LocalAsns>;
  /** Markers set in this process, with when they end. */
  readonly #markers: BoundedTable<number>;
  #lastWarn = Number.NEGATIVE_INFINITY;

  constructor(
    /** The shared store, if any. */
    private readonly store: Pick<SharedStateStore, "increment"> | undefined,
    /** The distinct counts (S4's). */
    readonly distinct: DistinctCounts,
    /** The bound on local keys. */
    maxKeys: number,
    /** Counts local evictions. */
    monitor: EvictionMonitor,
    /** Where store failures are logged. */
    private readonly logger: Logger,
  ) {
    this.#local = new BoundedTable("api key ASNs", maxKeys, monitor);
    this.#markers = new BoundedTable("api key markers", maxKeys, monitor);
  }

  /** Logs a store failure, at most every ten seconds. */
  #warn(now: number, error: unknown): void {
    if (now - this.#lastWarn < 10_000) return;
    this.#lastWarn = now;
    this.logger.warn(
      "bun-security: the shared store failed an API key check; this process's memory answers",
      { error },
    );
  }

  /**
   * What `asn` is to `key`: its first (`learned`), one it used before
   * (`known`), or a new one (`new`). With `writes` off, nothing is
   * remembered.
   */
  asn(
    key: string,
    asn: number,
    remember: number,
    now: number,
    writes: boolean,
  ): MaybePromise<AsnVerdict> {
    const local = (): AsnVerdict =>
      this.#asnLocal(key, asn, remember, now, writes);
    if (this.store === undefined) return local();
    const store = this.store;
    const by = writes ? 1 : 0;
    return Promise.all([
      store.increment(`ak:k:${key}`, by, remember),
      store.increment(`ak:a:${key}:${asn}`, by, remember),
    ]).then(
      ([requests, uses]): AsnVerdict => {
        // Keep this process's memory current too, for a store outage.
        this.#asnLocal(key, asn, remember, now, writes);
        const first = writes ? 1 : 0;
        if (uses > first) return "known";
        return requests <= first ? "learned" : "new";
      },
      (error: unknown) => {
        this.#warn(now, error);
        return local();
      },
    );
  }

  /** {@link asn} in this process. */
  #asnLocal(
    key: string,
    asn: number,
    remember: number,
    now: number,
    writes: boolean,
  ): AsnVerdict {
    let entry = this.#local.get(key);
    if (entry !== undefined && entry.until <= now) entry = undefined;
    if (entry === undefined) {
      if (writes)
        this.#local.set(
          key,
          { asns: new Map([[asn, now + remember]]), until: now + remember },
          now,
        );
      return "learned";
    }
    const until = entry.asns.get(asn);
    if (until !== undefined && until > now) return "known";
    if (writes) entry.asns.set(asn, now + remember);
    return "new";
  }

  /**
   * Whether this is the first time `marker` is set before it ends (`ttl`
   * ms): an anomaly's event and hook fire once per key and window.
   */
  once(marker: string, ttl: number, now: number): MaybePromise<boolean> {
    const local = (): boolean => {
      const until = this.#markers.get(marker);
      if (until !== undefined && until > now) return false;
      this.#markers.set(marker, now + ttl, now);
      return true;
    };
    if (this.store === undefined) return local();
    return then(
      this.store.increment(`ak:m:${marker}`, 1, ttl).then(
        (count) => {
          local();
          return count === 1;
        },
        (error: unknown) => {
          this.#warn(now, error);
          return local();
        },
      ),
      (first) => first,
    );
  }
}
