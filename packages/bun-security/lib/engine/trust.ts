/**
 * Layer L2.5: detecting a wrong trust configuration (layers.md L2.5).
 *
 * A wrong `trustProxy` fails silently in one of two ways, and each has a
 * per-minute gauge here:
 *
 * - **every client resolves into the internal list** (the proxy's private
 *   address, or a CGNAT edge such as Railway's `100.64.0.0/10`): nothing is
 *   ever counted or refused. Gauge: the share of requests whose client is in
 *   the `internal` list.
 * - **every client collapses to the proxy**: the requests carry forwarding
 *   headers, but the trust configuration never reads them, so the client is
 *   the socket peer and one key covers everyone. Gauge: the share of
 *   requests that carry `X-Forwarded-For`, `Forwarded` or `X-Real-IP` and
 *   resolved to the peer.
 *
 * Beside them, the distinct resolved clients and distinct peers of each
 * minute (bounded sets), which the status shows. On a service whose policy
 * says it is public, a share above the threshold for the window's minutes
 * in a row, each with at least `minRequests` requests, raises a warning:
 * once, until a quiet minute clears it. Verified service calls are not
 * counted: their client comes from a credential, not from trust.
 */
import type { CompiledTrustCheck } from "../policy/compile";

/** The most distinct clients and peers counted per minute. */
const MAX_DISTINCT = 10_000;

/** Closed minutes kept for the status. */
const HISTORY = 60;

/** One minute's gauges. */
export interface TrustMinute {
  /** The minute's start, epoch milliseconds. */
  readonly minute: number;
  /** Requests counted. */
  readonly requests: number;
  /** Requests whose client is in the `internal` list. */
  readonly internal: number;
  /** Requests carrying forwarding headers that resolved to the socket peer. */
  readonly unreadForwarding: number;
  /** Distinct resolved clients (at most 10,000 counted). */
  readonly distinctClients: number;
  /** Distinct socket peers (at most 10,000 counted). */
  readonly distinctPeers: number;
}

/** The two ways a trust configuration goes wrong. */
export type TrustWarningKind = "trust.internal" | "trust.unread-forwarding";

/**
 * Every warning the engine raises: the trust check's two (layers.md L2.5);
 * `state.evictions`, local state full and evicting keys (layers.md L9.6);
 * `bans.aggregated`, the ban table full and widening new address bans
 * (layers.md L4); `canary.used`, a canary credential used (layers.md L8);
 * `store.unavailable`, the shared store failing for 30 s (topologies.md
 * §6.2).
 */
export type SecurityWarningKind =
  | TrustWarningKind
  | "state.evictions"
  | "bans.aggregated"
  | "canary.used"
  | "store.unavailable";

/**
 * A warning (layers.md L2.5, L9.6): the trust configuration looks wrong, or
 * local state is evicting keys.
 */
export interface SecurityWarning {
  /**
   * Which: clients resolve into the internal list, forwarding headers are
   * never read, or local state is evicting keys.
   */
  readonly kind: SecurityWarningKind;
  /** What it means and what to check. */
  readonly message: string;
  /** The service's id, if the policy names one. */
  readonly service: string | undefined;
  /** The suspicious minutes in a row so far. */
  readonly minutes: number;
  /**
   * The last minute's share, 0 to 1: of requests (the trust check), or of
   * new keys that evicted another (`state.evictions`).
   */
  readonly share: number;
  /** The first suspicious minute's start, epoch milliseconds. */
  readonly since: number;
}

/** The trust check's state, for `status()`. */
export interface TrustStatus {
  /** Whether the check runs (the policy's `trustCheck` is not `false`). */
  readonly enabled: boolean;
  /** Whether warnings are raised (the policy says the service is public). */
  readonly public: boolean;
  /** The minute being counted, if any request arrived in it. */
  readonly current: TrustMinute | undefined;
  /** The last closed minutes, oldest first (at most 60). */
  readonly recent: readonly TrustMinute[];
  /** The warnings in force. */
  readonly warnings: readonly SecurityWarning[];
}

/** The minute being counted. */
interface Bucket {
  /** Its start. */
  minute: number;
  /** Requests counted. */
  requests: number;
  /** Internal-client requests. */
  internal: number;
  /** Requests with unread forwarding headers. */
  unreadForwarding: number;
  /** Distinct clients. */
  clients: Set<string>;
  /** Distinct peers. */
  peers: Set<string>;
}

/** One kind's run of suspicious minutes. */
interface Streak {
  /** Minutes in a row. */
  minutes: number;
  /** The first one's start. */
  since: number;
  /** The last one's start. */
  last: number;
  /** The warning raised for it, if any. */
  warning: SecurityWarning | undefined;
}

/** What one request contributes. */
export interface TrustSample {
  /** The resolved client, normalised; "" when none. */
  readonly client: string;
  /** The socket peer. */
  readonly peer: string;
  /** Whether the client is in the internal list. */
  readonly internal: boolean;
  /** Whether forwarding headers were sent but the client is the peer. */
  readonly unreadForwarding: boolean;
}

/** The trust check's gauges and its warnings. */
export class TrustMonitor {
  /** The minute being counted. */
  #bucket: Bucket | undefined;
  /** Closed minutes, oldest first. */
  readonly #history: TrustMinute[] = [];
  /** Each kind's run. */
  readonly #streaks: Record<TrustWarningKind, Streak> = {
    "trust.internal": { minutes: 0, since: 0, last: -1, warning: undefined },
    "trust.unread-forwarding": {
      minutes: 0,
      since: 0,
      last: -1,
      warning: undefined,
    },
  };

  constructor(
    /** Called with each warning as it is raised. */
    private readonly warn: (warning: SecurityWarning) => void,
  ) {}

  /** Counts one request at `now`, closing the previous minute first when it ended. */
  record(
    sample: TrustSample,
    now: number,
    check: CompiledTrustCheck,
    isPublic: boolean,
    service: string | undefined,
  ): void {
    const minute = now - (now % 60_000);
    let bucket = this.#bucket;
    if (bucket === undefined || bucket.minute !== minute) {
      if (bucket !== undefined) this.#close(bucket, check, isPublic, service);
      bucket = {
        minute,
        requests: 0,
        internal: 0,
        unreadForwarding: 0,
        clients: new Set(),
        peers: new Set(),
      };
      this.#bucket = bucket;
    }
    bucket.requests++;
    if (sample.internal) bucket.internal++;
    if (sample.unreadForwarding) bucket.unreadForwarding++;
    if (sample.client && bucket.clients.size < MAX_DISTINCT)
      bucket.clients.add(sample.client);
    if (sample.peer && bucket.peers.size < MAX_DISTINCT)
      bucket.peers.add(sample.peer);
  }

  /** A minute's gauges. */
  static #summary(bucket: Bucket): TrustMinute {
    return Object.freeze({
      minute: bucket.minute,
      requests: bucket.requests,
      internal: bucket.internal,
      unreadForwarding: bucket.unreadForwarding,
      distinctClients: bucket.clients.size,
      distinctPeers: bucket.peers.size,
    });
  }

  /** Closes a minute: keeps its gauges and updates each kind's run. */
  #close(
    bucket: Bucket,
    check: CompiledTrustCheck,
    isPublic: boolean,
    service: string | undefined,
  ): void {
    const summary = TrustMonitor.#summary(bucket);
    this.#history.push(summary);
    if (this.#history.length > HISTORY) this.#history.shift();
    const enough = summary.requests >= check.minRequests;
    this.#advance(
      "trust.internal",
      summary,
      enough ? summary.internal / summary.requests : 0,
      check,
      isPublic,
      service,
    );
    this.#advance(
      "trust.unread-forwarding",
      summary,
      enough ? summary.unreadForwarding / summary.requests : 0,
      check,
      isPublic,
      service,
    );
  }

  /** Moves one kind's run on by a closed minute with this share. */
  #advance(
    kind: TrustWarningKind,
    summary: TrustMinute,
    share: number,
    check: CompiledTrustCheck,
    isPublic: boolean,
    service: string | undefined,
  ): void {
    const streak = this.#streaks[kind];
    if (share <= check.threshold) {
      streak.minutes = 0;
      streak.warning = undefined;
      return;
    }
    if (streak.minutes > 0 && streak.last === summary.minute - 60_000) {
      streak.minutes++;
    } else {
      streak.minutes = 1;
      streak.since = summary.minute;
    }
    streak.last = summary.minute;
    if (
      isPublic &&
      streak.minutes >= check.minutes &&
      streak.warning === undefined
    ) {
      streak.warning = Object.freeze({
        kind,
        message:
          kind === "trust.internal"
            ? `${Math.round(share * 100)}% of requests resolve to an internal address for ${streak.minutes} minutes on a public service: the trust configuration (trustProxy) probably stops at your proxy, so no client is ever counted. Check that the proxies in front of the service are trusted.`
            : `${Math.round(share * 100)}% of requests carry forwarding headers that are never read, for ${streak.minutes} minutes on a public service: every client resolves to the proxy, so one key covers everyone. Check that trustProxy trusts the proxies in front of the service.`,
        service,
        minutes: streak.minutes,
        share,
        since: streak.since,
      });
      this.warn(streak.warning);
    }
  }

  /** The gauges and the warnings in force at `now`. */
  status(
    now: number,
    check: CompiledTrustCheck | undefined,
    isPublic: boolean,
    service: string | undefined,
  ): TrustStatus {
    const bucket = this.#bucket;
    if (check && bucket && bucket.minute !== now - (now % 60_000)) {
      this.#close(bucket, check, isPublic, service);
      this.#bucket = undefined;
    }
    const warnings = Object.values(this.#streaks)
      .map((streak) => streak.warning)
      .filter((warning): warning is SecurityWarning => warning !== undefined);
    return Object.freeze({
      enabled: check !== undefined,
      public: isPublic,
      current: this.#bucket ? TrustMonitor.#summary(this.#bucket) : undefined,
      recent: Object.freeze([...this.#history]),
      warnings: Object.freeze(warnings),
    });
  }
}
