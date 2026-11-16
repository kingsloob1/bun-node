/**
 * Crawler verification (layers.md L3.2): a claimant's address checked
 * against its crawler's range file (`crawler:<id>`, a class of the
 * engine's `intel`), or by forward-confirmed reverse DNS — the address's
 * name must end in one of the crawler's domains, and that name must
 * resolve back to the address, or an attacker's own PTR record would pass.
 *
 * DNS stays off the hot path and cannot be used for a flood:
 *
 * - verdicts are cached per crawler and address, positive for 24 h and
 *   negative for 1 h, in an LRU (`cacheSize`, 50,000);
 * - at most `maxPendingVerifications` lookups run at once (64); a claimant
 *   arriving with every slot taken is **unknown** for this request;
 * - a lookup is awaited for at most `verifyTimeoutMs` (500 ms); a timeout or
 *   an error is **unknown**, never cached: a slow resolver costs a crawler
 *   its allowance for one request, but never grants one;
 * - the same address's lookup is shared by claimants arriving together;
 * - with a shared store, verdicts are kept there too, so a fleet resolves
 *   each address once.
 *
 * An unknown claimant is an ordinary client: no allowance, and not spoofed.
 */
import dns from "node:dns/promises";
import type { SharedStateStore } from "../engine/shared";
import type { IntelLookup } from "../intel/types";
import { parseAddress } from "../ip/address";
import type { ParsedAddress } from "../ip/address";
import type { CrawlerVerifyMethod } from "./policy";
import type { CrawlerDefinition } from "./registry";
import { underDomain } from "./registry";

/** Reverse and forward DNS, as the verifier asks them. */
export interface CrawlerResolver {
  /** The names an address's PTR records give. Rejects with `code: "ENOTFOUND"` (or `ENODATA`) when it has none. */
  readonly reverse: (address: string) => Promise<readonly string[]>;
  /** The addresses a name resolves to (both families). */
  readonly lookup: (name: string) => Promise<readonly string[]>;
}

/** The host's resolver (`node:dns`), Bun's, measured on 1.4.5 to answer IPv4 and IPv6 PTRs. */
export const systemResolver: CrawlerResolver = Object.freeze({
  reverse: (address: string) => dns.reverse(address),
  lookup: async (name: string) =>
    (await dns.lookup(name, { all: true })).map((entry) => entry.address),
});

/** A verdict. */
export interface CrawlerVerdict {
  /** `verified`, `spoofed` (verification failed), or `unknown` (it could not be told). */
  readonly status: "verified" | "spoofed" | "unknown";
  /** How it was told: `ranges`, `rdns` or `cache` (a cached verdict). */
  readonly by?: "ranges" | "rdns" | "cache";
  /** Why, for the reason of a hit. */
  readonly reason: string;
}

/** Options for {@link CrawlerVerifier}. */
export interface CrawlerVerifierOptions {
  /** DNS. Default {@link systemResolver}. */
  readonly resolver?: CrawlerResolver;
  /** The most lookups at once. Default `64`. */
  readonly maxPendingVerifications?: number;
  /** How long a lookup is awaited, in ms. Default `500`. */
  readonly verifyTimeoutMs?: number;
  /** The most verdicts cached. Default `50_000`. */
  readonly cacheSize?: number;
  /** A shared store for verdicts. */
  readonly store?: Pick<SharedStateStore, "get" | "set">;
  /** The clock. */
  readonly now: () => number;
}

/** How long a verdict is cached, by outcome. */
const POSITIVE_MS = 24 * 3_600_000;
const NEGATIVE_MS = 3_600_000;

/** A DNS error that means "no such record", a definite answer. */
function definite(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOTFOUND" || code === "ENODATA" || code === "NXDOMAIN";
}

/** Verifies claimants. */
export class CrawlerVerifier {
  readonly #resolver: CrawlerResolver;
  readonly #maxPending: number;
  readonly #timeoutMs: number;
  readonly #cacheSize: number;
  readonly #store: Pick<SharedStateStore, "get" | "set"> | undefined;
  readonly #now: () => number;
  /** Verdicts by `id|address`, oldest first, with their expiry. */
  readonly #cache = new Map<
    string,
    { verdict: CrawlerVerdict; until: number }
  >();
  /** Lookups in flight, shared by key. */
  readonly #pending = new Map<string, Promise<CrawlerVerdict>>();

  constructor(options: CrawlerVerifierOptions) {
    this.#resolver = options.resolver ?? systemResolver;
    this.#maxPending = options.maxPendingVerifications ?? 64;
    this.#timeoutMs = options.verifyTimeoutMs ?? 500;
    this.#cacheSize = options.cacheSize ?? 50_000;
    this.#store = options.store;
    this.#now = options.now;
  }

  /** Lookups in flight. */
  get pending(): number {
    return this.#pending.size;
  }

  /** Verdicts cached. */
  get cached(): number {
    return this.#cache.size;
  }

  /** Forgets every cached verdict (a policy or range change). */
  clear(): void {
    this.#cache.clear();
  }

  /** Remembers a definite verdict. */
  #remember(key: string, verdict: CrawlerVerdict): void {
    if (verdict.status === "unknown") return;
    const ttl = verdict.status === "verified" ? POSITIVE_MS : NEGATIVE_MS;
    this.#cache.delete(key);
    this.#cache.set(key, { verdict, until: this.#now() + ttl });
    if (this.#cache.size > this.#cacheSize) {
      const oldest = this.#cache.keys().next().value;
      if (oldest !== undefined) this.#cache.delete(oldest);
    }
    if (this.#store !== undefined) {
      this.#store
        .set(
          `crawler:verdict:${key}`,
          { status: verdict.status, reason: verdict.reason },
          ttl,
        )
        .catch(() => {});
    }
  }

  /**
   * Verifies `address` as `crawler`: synchronously when the ranges or the
   * cache answer, else a promise of the DNS verdict (never rejecting).
   */
  verify(
    crawler: CrawlerDefinition,
    address: ParsedAddress,
    method: CrawlerVerifyMethod,
    intel: IntelLookup | undefined,
  ): CrawlerVerdict | Promise<CrawlerVerdict> {
    const className = `crawler:${crawler.id}`;
    const ranges =
      intel !== undefined && intel.provides().classes.has(className);
    if (method !== "rdns" && ranges) {
      if (intel.lookup(address).classes.includes(className)) {
        return {
          status: "verified",
          by: "ranges",
          reason: `in ${crawler.id}'s published ranges`,
        };
      }
      if (method === "ranges") {
        return {
          status: "spoofed",
          by: "ranges",
          reason: `not in ${crawler.id}'s published ranges`,
        };
      }
    }
    if (crawler.rdns.length === 0 || method === "ranges") {
      // No DNS for it (or none asked for): the ranges decided, or nothing can.
      if (method !== "rdns" && ranges) {
        return {
          status: "spoofed",
          by: "ranges",
          reason: `not in ${crawler.id}'s published ranges`,
        };
      }
      return {
        status: "unknown",
        reason:
          method === "ranges" || crawler.rdns.length > 0
            ? `${crawler.id}'s ranges are not loaded`
            : `${crawler.id} has no reverse DNS domains to verify by`,
      };
    }
    const key = `${crawler.id}|${address.text}`;
    const hit = this.#cache.get(key);
    if (hit !== undefined) {
      if (hit.until > this.#now()) {
        this.#cache.delete(key);
        this.#cache.set(key, hit);
        return { ...hit.verdict, by: "cache" };
      }
      this.#cache.delete(key);
    }
    const shared = this.#pending.get(key);
    if (shared !== undefined) return shared;
    if (this.#pending.size >= this.#maxPending) {
      return { status: "unknown", reason: "too many verifications in flight" };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<CrawlerVerdict>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            status: "unknown",
            reason: `verification took over ${this.#timeoutMs} ms`,
          }),
        this.#timeoutMs,
      );
    });
    const lookup = this.#fromStore(key)
      .then((stored) => stored ?? this.#rdns(crawler, address))
      .then(
        (verdict) => {
          this.#remember(key, verdict);
          return verdict;
        },
        (error: unknown): CrawlerVerdict => ({
          status: "unknown",
          reason: `verification failed: ${error instanceof Error ? error.message : String(error)}`,
        }),
      );
    const raced = Promise.race([lookup, timeout]).finally(() => {
      clearTimeout(timer);
      this.#pending.delete(key);
    });
    this.#pending.set(key, raced);
    return raced;
  }

  /** A verdict another process stored, if any. */
  async #fromStore(key: string): Promise<CrawlerVerdict | undefined> {
    if (this.#store === undefined) return undefined;
    try {
      const value = (await this.#store.get(`crawler:verdict:${key}`)) as
        { status?: unknown; reason?: unknown } | undefined;
      if (value?.status === "verified" || value?.status === "spoofed") {
        return {
          status: value.status,
          by: "cache",
          reason: String(value.reason ?? ""),
        };
      }
    } catch {
      // The store is optional here: DNS answers instead.
    }
    return undefined;
  }

  /** Forward-confirmed reverse DNS. */
  async #rdns(
    crawler: CrawlerDefinition,
    address: ParsedAddress,
  ): Promise<CrawlerVerdict> {
    let names: readonly string[];
    try {
      names = await this.#resolver.reverse(address.text);
    } catch (error) {
      if (definite(error)) {
        return {
          status: "spoofed",
          by: "rdns",
          reason: "the address has no reverse DNS name",
        };
      }
      throw error;
    }
    const candidates = names.filter((name) =>
      crawler.rdns.some((domain) => underDomain(name, domain)),
    );
    if (candidates.length === 0) {
      return {
        status: "spoofed",
        by: "rdns",
        reason: `its reverse DNS name (${names.slice(0, 3).join(", ") || "none"}) is not under ${crawler.rdns.join(", ")}`,
      };
    }
    for (const name of candidates) {
      let forward: readonly string[];
      try {
        forward = await this.#resolver.lookup(name.replace(/\.$/, ""));
      } catch (error) {
        if (definite(error)) continue;
        throw error;
      }
      if (forward.some((text) => parseAddress(text)?.text === address.text)) {
        return {
          status: "verified",
          by: "rdns",
          reason: `${name} resolves back to it`,
        };
      }
    }
    return {
      status: "spoofed",
      by: "rdns",
      reason: `${candidates[0] ?? ""} does not resolve back to the address`,
    };
  }
}
