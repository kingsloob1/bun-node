/**
 * Per-channel rate limits and digests (README §9.3), so an attack cannot
 * flood a channel: at most one message a minute per alert kind; past it,
 * the alert waits for the channel's digest, sent every 15 minutes; and at
 * most 60 messages an hour per channel, past which only `critical` goes
 * through and the rest wait for the digest too. A digest is itself a
 * message, counted against the hour.
 *
 * The two limits are counted in the store (`claimKey` for the minute per
 * kind, `incrementCounter` for the hour), so they hold across every
 * control-plane instance on it (the user's decision, 2026-11-17); what is
 * held for a digest stays with the instance that held it.
 */
import type { SecurityStoreDriver } from "../../store/types";
import type { AlertMessage, AlertRecord, AlertSeverity } from "./types";
import { ALERT_SEVERITIES } from "./types";

/** A short, stable digest of `text`, for a store key (a kind or key may be long). */
export function storeKeyPart(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 32);
}

/** The limits (README §9.3). */
export const ALERT_RATE_LIMITS = Object.freeze({
  /** The least time between two messages of one kind on one channel, ms. */
  perKindMs: 60_000,
  /** How often a channel's held-back alerts are sent as a digest, ms. */
  digestMs: 15 * 60_000,
  /** Messages a channel is sent an hour, past which only `critical` goes through. */
  perHour: 60,
  /** Distinct kinds a digest counts; past it, the rest are counted under `(other)`. */
  digestKinds: 100,
});

/** What became of an alert offered to a channel. */
export type Admission = "send" | "digest";

/** One channel's state on this instance. */
interface ChannelState {
  /** Held back, by kind. */
  readonly held: Map<string, { count: number; severity: AlertSeverity }>;
  /** When the last digest went (or the channel was first seen). */
  lastDigest: number;
}

/** The limits of every channel; see the module's description. */
export class AlertLimiter {
  readonly #channels = new Map<string, ChannelState>();
  readonly #now: () => number;
  readonly #store: Pick<
    SecurityStoreDriver,
    "claimKey" | "incrementCounter" | "getCounter"
  >;

  constructor(
    /** The clock, epoch ms. */
    now: () => number,
    /** Where the limits are counted, shared by every instance. */
    store: Pick<
      SecurityStoreDriver,
      "claimKey" | "incrementCounter" | "getCounter"
    >,
  ) {
    this.#now = now;
    this.#store = store;
  }

  /** The store key of a channel's messages in the current hour. */
  #hourKey(channelId: string, now: number): string {
    return `alert:hour:${storeKeyPart(channelId)}:${Math.floor(now / 3_600_000)}`;
  }

  /** Counts a message against its channel's hour. */
  async #countHour(channelId: string, now: number): Promise<void> {
    await this.#store.incrementCounter(
      this.#hourKey(channelId, now),
      3_660_000,
    );
  }

  /** A channel's state, made on first use. */
  #of(channelId: string): ChannelState {
    let state = this.#channels.get(channelId);
    if (state === undefined) {
      state = {
        held: new Map(),
        lastDigest: this.#now(),
      };
      this.#channels.set(channelId, state);
    }
    return state;
  }

  /** Whether `alert` is sent to `channelId` now, or held for the digest (counted). */
  async admit(channelId: string, alert: AlertRecord): Promise<Admission> {
    const now = this.#now();
    const state = this.#of(channelId);
    if (alert.severity === "critical") {
      await this.#countHour(channelId, now);
      return "send";
    }
    const hour = await this.#store.getCounter(this.#hourKey(channelId, now));
    const overHour = (hour?.count ?? 0) >= ALERT_RATE_LIMITS.perHour;
    if (
      !overHour &&
      (await this.#store.claimKey(
        `alert:kind:${storeKeyPart(channelId)}:${storeKeyPart(alert.kind)}`,
        ALERT_RATE_LIMITS.perKindMs,
      ))
    ) {
      await this.#countHour(channelId, now);
      return "send";
    }
    let kind = alert.kind;
    if (
      !state.held.has(kind) &&
      state.held.size >= ALERT_RATE_LIMITS.digestKinds
    )
      kind = "(other)";
    const held = state.held.get(kind);
    state.held.set(kind, {
      count: (held?.count ?? 0) + 1,
      severity:
        held === undefined ||
        ALERT_SEVERITIES.indexOf(alert.severity) >
          ALERT_SEVERITIES.indexOf(held.severity)
          ? alert.severity
          : held.severity,
    });
    return "digest";
  }

  /** The digests due now, one per channel holding alerts; each counted as a message. */
  async due(): Promise<{ channelId: string; message: AlertMessage }[]> {
    const now = this.#now();
    const out: { channelId: string; message: AlertMessage }[] = [];
    for (const [channelId, state] of this.#channels) {
      if (
        state.held.size === 0 ||
        now - state.lastDigest < ALERT_RATE_LIMITS.digestMs
      )
        continue;
      out.push({
        channelId,
        message: {
          type: "digest",
          at: now,
          held: [...state.held].map(([kind, { count, severity }]) => ({
            kind,
            count,
            severity,
          })),
        },
      });
      state.held.clear();
      state.lastDigest = now;
      await this.#countHour(channelId, now);
    }
    return out;
  }

  /** How many alerts a channel holds for its digest. */
  held(channelId: string): number {
    let count = 0;
    for (const { count: n } of this.#of(channelId).held.values()) count += n;
    return count;
  }
}
