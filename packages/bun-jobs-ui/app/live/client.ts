import type {
  EventName,
  EventWire,
  JobsApiAckMessage,
  JobsApiAckRejection,
  JobsApiClientMessage,
  JobsApiErrorMessage,
  JobsApiEventMessage,
  JobsApiGapMessage,
  JobsApiHelloMessage,
  JobsApiServerMessage,
} from "../api/types";
import {
  JOBS_API_WS_CLOSE,
  JOBS_API_WS_MAX_CHANNELS_PER_FRAME,
  JOBS_API_WS_SUBPROTOCOL,
} from "@kingsleyweb/bun-jobs/api/contract";

/**
 * The live-events socket client: one connection, shared by every screen
 * through refcounted holds. Framework-free; the React side (`LiveProvider`,
 * the hooks in `live.ts`) only holds and releases.
 *
 * Wire rules it keeps (design §8, §8.1):
 * - offers only the `bun-jobs.v1` subprotocol;
 * - refcounts channels and merges holders' event filters, because the server
 *   does neither (a re-subscribe replaces a channel's filter, one unsubscribe
 *   drops it); frames are chunked at 256 channels;
 * - de-duplicates by a bounded set of seen `seq`s, never a maximum, because a
 *   replay may deliver out of order; loss is learned from `gap` frames only;
 * - resumes with `{ epoch, afterSeq }` on reconnect, and turns
 *   `resumed: false` or a new epoch into a gap for the holders;
 * - waits on acks without a timeout: broad channels may ack late.
 */

/** Where the connection stands (see `LiveState` in `live.ts`). */
export type LiveClientState =
  | "off"
  | "connecting"
  | "live"
  | "reconnecting"
  | "refused";

/** What {@link LiveClient.getSnapshot} returns; a new object only when something changed. */
export interface LiveClientSnapshot {
  /** Where the connection stands. */
  state: LiveClientState;
  /** Why, in words, when not simply live; `null` otherwise. */
  detail: string | null;
  /** When the last event frame arrived, epoch ms; `null` before any. */
  lastEventAt: number | null;
}

/** The part of a browser `WebSocket` the client uses. */
export interface LiveSocket {
  /** `0` connecting, `1` open, `2` closing, `3` closed. */
  readonly readyState: number;
  /** Sends a text frame. */
  send: (data: string) => void;
  /** Closes the connection. */
  close: (code?: number, reason?: string) => void;
  /** Called once open. */
  onopen: ((event: unknown) => void) | null;
  /** Called per frame; `data` is the text. */
  onmessage: ((event: { data: unknown }) => void) | null;
  /** Called once closed, with the code (`1006` when no close frame arrived). */
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  /** Called on an error; a close follows. */
  onerror: ((event: unknown) => void) | null;
}

/** Builds a socket, as `new WebSocket(url, protocols)` does. */
export type LiveSocketConstructor = new (
  url: string,
  protocols: string[],
) => LiveSocket;

/** Timers and clock, injectable for tests. */
export interface LiveTimers {
  /** Schedules a callback. */
  setTimeout: (callback: () => void, ms: number) => unknown;
  /** Cancels one. */
  clearTimeout: (handle: unknown) => void;
  /** Epoch ms. */
  now: () => number;
}

/** One holder's interest: what a screen passes to {@link LiveClient.hold}. */
export interface LiveHolderSpec {
  /** Channel names exactly as sent (see `liveChannels`). */
  channels: readonly string[];
  /** Only these event types. Omitted: every type. */
  events?: readonly EventName[];
  /** Called for each event on these channels, once per event. */
  onEvent?: (event: EventWire) => void;
  /** Called when events on these channels may have been missed: refetch. */
  onGap?: (gap: JobsApiGapMessage) => void;
  /** Called with this holder's current rejections whenever they change. */
  onRejected?: (rejected: readonly JobsApiAckRejection[]) => void;
}

/** A hold on some channels, until released. */
export interface LiveHold {
  /** Replaces the holder's channels, filter and callbacks. */
  update: (spec: LiveHolderSpec) => void;
  /** Releases the hold; the last holder of a channel unsubscribes it. */
  release: () => void;
  /** The holder's current rejections. */
  rejected: () => readonly JobsApiAckRejection[];
}

/** Options of {@link LiveClient}. */
export interface LiveClientOptions {
  /** The socket URL, or a function giving it at each connection attempt. */
  url: string | (() => string);
  /** The socket constructor. Defaults to `globalThis.WebSocket`. */
  WebSocket?: LiveSocketConstructor;
  /** Timers and clock. Defaults to the global ones and `Date.now`. */
  timers?: LiveTimers;
  /** A number in `[0, 1)`, for backoff jitter. Defaults to `Math.random`. */
  random?: () => number;
  /** The heartbeat interval before `hello` says (`meta.websocket.heartbeatMs`). Defaults to 25 000 ms. */
  heartbeatMs?: number;
  /** Extra wait on top of two heartbeats before the connection counts as lost. Defaults to 5 000 ms. */
  heartbeatSlackMs?: number;
  /** When heartbeats are off (`0`), how long idle before a `ping`. Defaults to 25 000 ms. */
  pingIntervalMs?: number;
  /** First reconnect delay, before jitter. Defaults to 500 ms. */
  backoffInitialMs?: number;
  /** Longest reconnect delay. Defaults to 30 000 ms. */
  backoffMaxMs?: number;
  /** Reconnects after a protocol, size or rate-limit close (1003/1009/1008) before giving up. Defaults to 3. */
  maxPolicyRetries?: number;
  /** Retries of a connection that never opened, before the first ever open, before giving up (a refused upgrade). Defaults to 2. */
  maxRefusedRetries?: number;
  /** How long a connection must stay up for the policy-close count to reset. Defaults to 60 000 ms. */
  stableAfterMs?: number;
  /** Client-side send budget per second, under the server's 20. Defaults to 10. */
  messagesPerSecond?: number;
  /** How long to hold frames back after a `RATE_LIMITED` error. Defaults to 2 000 ms. */
  rateLimitPauseMs?: number;
  /** Most seen `seq`s remembered for de-duplication. Defaults to 2 048. */
  seenLimit?: number;
  /** Largest subscribe frame, in characters, below the server's 16 KiB default. Defaults to 12 000. */
  maxFrameChars?: number;
}

/** A registered holder. */
interface Holder {
  /** Its current spec. */
  spec: LiveHolderSpec;
  /** Its event filter as a set, or `undefined` for every type. */
  filter: ReadonlySet<string> | undefined;
  /** The rejections last reported to it, by channel. */
  rejected: JobsApiAckRejection[];
}

/** What this connection has asked the server for, per channel as sent. */
interface SentChannel {
  /** The filter key it was subscribed with (`*` = every type). */
  filter: string;
  /** Whether the server refused it (it holds nothing). */
  rejected: boolean;
}

/** A frame awaiting its ack or error. */
interface Pending {
  /** Its operation. */
  op: "subscribe" | "unsubscribe";
  /** The channels it named, as sent. */
  channels: string[];
  /** The filter key of a subscribe. */
  filter: string;
  /**
   * A resuming subscribe that was not the resume's first frame: the server
   * skips, in its replay, events it already replayed for an earlier frame,
   * so an event matching channels of both reaches only the first frame's
   * channels, and the ack still says `resumed: true`. Its holders are told
   * of a gap instead of trusting it.
   */
  splitResume?: true;
}

/** Filter key meaning "every type". */
const ALL = "*";

/** `WebSocket.OPEN`. */
const OPEN = 1;

/** The client's own close code for a lost heartbeat (3000–4999 are free for applications). */
const HEARTBEAT_LOST = 4000;

/** The status detail while the server's event source is down. */
const EVENTS_UNAVAILABLE = "The server's event source is unavailable; retrying";

/** Default timers. */
const DEFAULT_TIMERS: LiveTimers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/**
 * The socket URL for the API's `meta.websocket`: `ws(s)://` on the page's
 * origin, or the API's when `apiBase` is an absolute URL on another origin;
 * with a dedicated `port`, that origin's hostname on the port.
 */
export function liveSocketUrl(
  websocket: {
    /** The full socket path. */
    path: string;
    /** A dedicated port, when the socket has one. */
    port?: number | null;
  },
  apiBase: string,
  pageUrl: string,
): string {
  const page = new URL(pageUrl);
  let origin = page;
  try {
    const api = new URL(apiBase);
    origin = api;
  } catch {
    // A same-origin path: the page's origin.
  }
  const url = new URL(origin.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (websocket.port != null) {
    url.port = String(websocket.port);
  }
  url.pathname = websocket.path;
  return url.toString();
}

/** The filter key of a holder filter. */
function filterKey(filter: ReadonlySet<string> | undefined): string {
  return filter === undefined ? ALL : [...filter].sort().join(",");
}

/** Close codes that mean "you sent something wrong": reconnect a few times only. */
const POLICY_CLOSES: ReadonlySet<number> = new Set([
  JOBS_API_WS_CLOSE.UNSUPPORTED_DATA,
  JOBS_API_WS_CLOSE.POLICY,
  JOBS_API_WS_CLOSE.TOO_BIG,
]);

/** Words for a policy close, as a refusal detail. */
function policyDetail(code: number): string {
  switch (code) {
    case JOBS_API_WS_CLOSE.POLICY:
      return "The server closed the live-events socket for exceeding its message rate";
    case JOBS_API_WS_CLOSE.TOO_BIG:
      return "The server closed the live-events socket: a message was too large";
    default:
      return "The server closed the live-events socket: it refused a message";
  }
}

/** The live-events client. See the module comment. */
export class LiveClient {
  /** Options, defaults applied. */
  readonly #options: Required<Omit<LiveClientOptions, "url" | "WebSocket">> & {
    url: LiveClientOptions["url"];
    WebSocket: LiveSocketConstructor | undefined;
  };

  /** Snapshot listeners. */
  readonly #listeners = new Set<() => void>();
  /** The current snapshot. */
  #snapshot: LiveClientSnapshot = {
    state: "off",
    detail: null,
    lastEventAt: null,
  };

  /** Registered holders. */
  readonly #holders = new Set<Holder>();
  /** The last rejection per channel as sent (this connection). */
  readonly #rejections = new Map<string, JobsApiAckRejection>();
  /** Canonical name → the names sent for it, learned from acks. */
  readonly #rawByKey = new Map<string, Set<string>>();

  /** Whether started (and not stopped). */
  #running = false;
  /** The socket, while one exists. */
  #socket: LiveSocket | undefined;
  /** Bumped per connection, so a stale socket's callbacks are ignored. */
  #generation = 0;
  /** Whether the current socket opened. */
  #opened = false;
  /** When the current socket received `hello`. */
  #liveSince: number | undefined;
  /** Whether any socket ever opened. */
  #everOpened = false;
  /** Consecutive reconnects since the last `hello`. */
  #attempt = 0;
  /** Connections that never opened, before the first ever open. */
  #refusedAttempts = 0;
  /** Policy closes (1003/1008/1009) since the last stable connection. */
  #policyCloses = 0;
  /** The reconnect timer. */
  #reconnectTimer: unknown;
  /** The heartbeat watchdog. */
  #watchdog: unknown;
  /** Whether the watchdog's last step sent a ping. */
  #pinged = false;
  /** Heartbeat interval in effect. */
  #heartbeatMs: number;

  /** The epoch last seen. */
  #epoch: string | undefined;
  /** The highest `seq` seen in the epoch (for `afterSeq` only, never for loss or dedupe). */
  #lastSeq = 0;
  /** Seen `seq`s → the holders each was delivered to. Bounded; insertion order is age. */
  readonly #seen = new Map<number, Set<Holder>>();
  /** Resume to send with the first subscribes after `hello`. */
  #resume: { epoch: string; afterSeq: number } | undefined;
  /** A gap to announce to every holder once live again (after a 4008 close). */
  #pendingGap: JobsApiGapMessage["reason"] | undefined;
  /** Set by `resumed: false`: the server's gap right after it was already announced. */
  #swallowGap = false;

  /** What this connection has asked for. */
  readonly #sent = new Map<string, SentChannel>();
  /** Frames awaiting an answer, by id. */
  readonly #pending = new Map<string, Pending>();
  /** Frames waiting for send budget. */
  #outbox: JobsApiClientMessage[] = [];
  /** Send tokens left. */
  #tokens: number;
  /** When tokens were last refilled. */
  #refilledAt: number;
  /** No frame is sent before this. */
  #pausedUntil = 0;
  /** The pump timer. */
  #pumpTimer: unknown;
  /** Whether a reconcile is scheduled. */
  #flushScheduled = false;
  /** Retry timer after an `EVENTS_UNAVAILABLE`. */
  #retryFlushTimer: unknown;
  /** Frame id counter. */
  #nextId = 0;

  constructor(
    /** See {@link LiveClientOptions}. */
    options: LiveClientOptions,
  ) {
    this.#options = {
      url: options.url,
      WebSocket: options.WebSocket,
      timers: options.timers ?? DEFAULT_TIMERS,
      random: options.random ?? Math.random,
      heartbeatMs: options.heartbeatMs ?? 25_000,
      heartbeatSlackMs: options.heartbeatSlackMs ?? 5_000,
      pingIntervalMs: options.pingIntervalMs ?? 25_000,
      backoffInitialMs: options.backoffInitialMs ?? 500,
      backoffMaxMs: options.backoffMaxMs ?? 30_000,
      maxPolicyRetries: options.maxPolicyRetries ?? 3,
      maxRefusedRetries: options.maxRefusedRetries ?? 2,
      stableAfterMs: options.stableAfterMs ?? 60_000,
      messagesPerSecond: options.messagesPerSecond ?? 10,
      rateLimitPauseMs: options.rateLimitPauseMs ?? 2_000,
      seenLimit: options.seenLimit ?? 2_048,
      maxFrameChars: options.maxFrameChars ?? 12_000,
    };
    this.#heartbeatMs = this.#options.heartbeatMs;
    this.#tokens = this.#options.messagesPerSecond * 2;
    this.#refilledAt = this.#options.timers.now();
  }

  /* ---------------------------------------------------------------- *
   * Status
   * ---------------------------------------------------------------- */

  /** Listens for snapshot changes (for `useSyncExternalStore`). */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** The current status; the same object until something changes. */
  getSnapshot = (): LiveClientSnapshot => this.#snapshot;

  /** The `hello`'s session id, while connected. */
  sessionId: string | undefined;

  /** Updates the snapshot and notifies, when anything changed. */
  #setSnapshot(patch: Partial<LiveClientSnapshot>): void {
    const next = { ...this.#snapshot, ...patch };
    if (
      next.state === this.#snapshot.state &&
      next.detail === this.#snapshot.detail &&
      next.lastEventAt === this.#snapshot.lastEventAt
    ) {
      return;
    }
    this.#snapshot = next;
    for (const listener of [...this.#listeners]) {
      listener();
    }
  }

  /* ---------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------- */

  /** Connects, and keeps reconnecting until {@link stop}. Idempotent; restartable. */
  start(): void {
    if (this.#running) {
      return;
    }
    this.#running = true;
    this.#attempt = 0;
    this.#refusedAttempts = 0;
    this.#policyCloses = 0;
    this.#setSnapshot({
      state: this.#everOpened ? "reconnecting" : "connecting",
      detail: null,
    });
    this.#connect();
  }

  /** Closes the socket and stops reconnecting. Holders stay registered. */
  stop(): void {
    if (!this.#running) {
      return;
    }
    this.#running = false;
    this.#timers.clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    this.#teardown(JOBS_API_WS_CLOSE.NORMAL, "client stopped");
    this.#setSnapshot({ state: "off", detail: null });
  }

  /** The timers. */
  get #timers(): LiveTimers {
    return this.#options.timers;
  }

  /** Opens a socket. */
  #connect(): void {
    this.#reconnectTimer = undefined;
    if (!this.#running) {
      return;
    }
    const Ctor =
      this.#options.WebSocket ??
      (globalThis as { WebSocket?: LiveSocketConstructor }).WebSocket;
    if (!Ctor) {
      this.#refuse("This browser has no WebSocket support");
      return;
    }
    const generation = ++this.#generation;
    this.#opened = false;
    let socket: LiveSocket;
    try {
      const url =
        typeof this.#options.url === "function"
          ? this.#options.url()
          : this.#options.url;
      socket = new Ctor(url, [JOBS_API_WS_SUBPROTOCOL]);
    } catch (error) {
      this.#refuse(
        `The live-events socket could not be created: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    this.#socket = socket;
    const current = () => generation === this.#generation;
    socket.onopen = () => {
      if (current()) {
        this.#onOpen();
      }
    };
    socket.onmessage = (event) => {
      if (current()) {
        this.#onMessage(event.data);
      }
    };
    socket.onclose = (event) => {
      if (current()) {
        this.#onClose(event.code);
      }
    };
    socket.onerror = () => {
      // A close follows; it decides what to do.
    };
  }

  /** Detaches and closes the socket, and forgets this connection's state. */
  #teardown(code: number, reason: string): void {
    this.#generation++;
    const socket = this.#socket;
    this.#socket = undefined;
    this.sessionId = undefined;
    this.#liveSince = undefined;
    this.#timers.clearTimeout(this.#watchdog);
    this.#watchdog = undefined;
    this.#timers.clearTimeout(this.#pumpTimer);
    this.#pumpTimer = undefined;
    this.#timers.clearTimeout(this.#retryFlushTimer);
    this.#retryFlushTimer = undefined;
    this.#sent.clear();
    this.#pending.clear();
    this.#outbox = [];
    this.#resume = undefined;
    this.#swallowGap = false;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close(code, reason);
      } catch {
        // Already closed.
      }
    }
  }

  /** Gives up: no more retries until restarted. */
  #refuse(detail: string): void {
    this.#running = false;
    this.#teardown(JOBS_API_WS_CLOSE.NORMAL, "refused");
    this.#setSnapshot({ state: "refused", detail });
  }

  /** The socket opened. */
  #onOpen(): void {
    this.#opened = true;
    this.#everOpened = true;
    this.#armWatchdog();
  }

  /** The socket closed (or was lost). */
  #onClose(code: number): void {
    const opened = this.#opened;
    const stable =
      this.#liveSince !== undefined &&
      this.#timers.now() - this.#liveSince >= this.#options.stableAfterMs;
    this.#teardown(code, "closed");
    if (!this.#running) {
      return;
    }
    if (stable) {
      this.#policyCloses = 0;
    }

    if (!opened && !this.#everOpened) {
      // Nothing ever opened: a browser sees a refused upgrade (401, 403,
      // 429, 404) only as this. Retry a little, then stop.
      this.#refusedAttempts++;
      if (this.#refusedAttempts > this.#options.maxRefusedRetries) {
        this.#refuse(
          "The server refused the live-events socket. Check that you are signed in and hold the events.connect permission",
        );
        return;
      }
      this.#scheduleReconnect(
        "The live-events socket could not connect; retrying",
      );
      return;
    }

    if (POLICY_CLOSES.has(code)) {
      this.#policyCloses++;
      if (this.#policyCloses > this.#options.maxPolicyRetries) {
        this.#refuse(policyDetail(code));
        return;
      }
      this.#scheduleReconnect(`${policyDetail(code)}; reconnecting`);
      return;
    }
    if (code === JOBS_API_WS_CLOSE.UNAUTHORIZED) {
      this.#refuse("The live-events session is no longer authorized");
      return;
    }
    if (code === JOBS_API_WS_CLOSE.SLOW_CONSUMER) {
      this.#pendingGap = "slow-consumer";
      this.#scheduleReconnect(
        "The connection fell behind the server's events; reconnecting",
      );
      return;
    }
    if (code === JOBS_API_WS_CLOSE.GOING_AWAY) {
      this.#scheduleReconnect("The server is restarting; reconnecting");
      return;
    }
    if (code === HEARTBEAT_LOST) {
      this.#scheduleReconnect("The connection went quiet; reconnecting");
      return;
    }
    this.#scheduleReconnect("The connection dropped; reconnecting");
  }

  /** The delay before reconnect attempt `attempt` (0-based): exponential, half-jittered. */
  backoffDelay(attempt: number): number {
    const { backoffInitialMs, backoffMaxMs, random } = this.#options;
    const ceiling = Math.min(backoffMaxMs, backoffInitialMs * 2 ** attempt);
    return Math.round(ceiling / 2 + (ceiling / 2) * random());
  }

  /** Schedules the next connection attempt. */
  #scheduleReconnect(detail: string): void {
    const delay = this.backoffDelay(this.#attempt);
    this.#attempt++;
    this.#setSnapshot({
      state: this.#everOpened ? "reconnecting" : "connecting",
      detail,
    });
    this.#timers.clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = this.#timers.setTimeout(
      () => this.#connect(),
      delay,
    );
  }

  /** (Re)arms the silence watchdog: any frame proves the connection. */
  #armWatchdog(): void {
    this.#timers.clearTimeout(this.#watchdog);
    this.#pinged = false;
    const { heartbeatSlackMs, pingIntervalMs } = this.#options;
    if (this.#heartbeatMs > 0) {
      this.#watchdog = this.#timers.setTimeout(
        () => this.#lost(),
        this.#heartbeatMs * 2 + heartbeatSlackMs,
      );
      return;
    }
    // No heartbeats: ping when idle, and give up if even that goes unanswered.
    this.#watchdog = this.#timers.setTimeout(() => {
      this.#pinged = true;
      this.#send({ op: "ping", id: this.#id() });
      this.#watchdog = this.#timers.setTimeout(
        () => this.#lost(),
        pingIntervalMs + heartbeatSlackMs,
      );
    }, pingIntervalMs);
  }

  /** Nothing arrived in time: drop the connection and reconnect. */
  #lost(): void {
    this.#onClose(HEARTBEAT_LOST);
  }

  /* ---------------------------------------------------------------- *
   * Holders
   * ---------------------------------------------------------------- */

  /** Holds channels until the returned hold is released. */
  hold(spec: LiveHolderSpec): LiveHold {
    const holder: Holder = {
      spec,
      filter: spec.events ? new Set(spec.events) : undefined,
      rejected: [],
    };
    this.#holders.add(holder);
    this.#refreshRejected(holder);
    this.#scheduleFlush();
    let released = false;
    return {
      update: (next) => {
        if (released) {
          return;
        }
        const before = holder.spec;
        holder.spec = next;
        holder.filter = next.events ? new Set(next.events) : undefined;
        if (
          before.channels.join("\n") !== next.channels.join("\n") ||
          filterKey(before.events ? new Set(before.events) : undefined) !==
            filterKey(holder.filter)
        ) {
          this.#refreshRejected(holder);
          this.#scheduleFlush();
        }
      },
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.#holders.delete(holder);
        for (const delivered of this.#seen.values()) {
          delivered.delete(holder);
        }
        this.#scheduleFlush();
      },
      rejected: () => holder.rejected,
    };
  }

  /** How many holders hold each channel (for tests and diagnostics). */
  holdCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const holder of this.#holders) {
      for (const channel of new Set(holder.spec.channels)) {
        counts.set(channel, (counts.get(channel) ?? 0) + 1);
      }
    }
    return counts;
  }

  /** The merged filter each held channel needs (`*` = every type). */
  #desired(): Map<string, string> {
    const merged = new Map<string, Set<string> | undefined>();
    for (const holder of this.#holders) {
      for (const channel of holder.spec.channels) {
        if (!merged.has(channel)) {
          merged.set(
            channel,
            holder.filter ? new Set(holder.filter) : undefined,
          );
          continue;
        }
        const current = merged.get(channel);
        if (current === undefined) {
          continue;
        }
        if (holder.filter === undefined) {
          merged.set(channel, undefined);
        } else {
          for (const type of holder.filter) {
            current.add(type);
          }
        }
      }
    }
    const desired = new Map<string, string>();
    for (const [channel, filter] of merged) {
      desired.set(channel, filterKey(filter));
    }
    return desired;
  }

  /** Reconciles on the next microtask, so one render's holds share frames. */
  #scheduleFlush(): void {
    if (this.#flushScheduled) {
      return;
    }
    this.#flushScheduled = true;
    queueMicrotask(() => {
      this.#flushScheduled = false;
      this.#flush();
    });
  }

  /** Sends what it takes for the server to hold exactly the desired channels and filters. */
  #flush(): void {
    if (!this.#socket || this.sessionId === undefined) {
      return;
    }
    const desired = this.#desired();
    const groups = new Map<string, string[]>();
    for (const [channel, filter] of desired) {
      if (this.#sent.get(channel)?.filter === filter) {
        continue;
      }
      let group = groups.get(filter);
      if (!group) {
        group = [];
        groups.set(filter, group);
      }
      group.push(channel);
    }
    const leaving: string[] = [];
    for (const [channel, sent] of this.#sent) {
      if (!desired.has(channel)) {
        this.#sent.delete(channel);
        this.#rejections.delete(channel);
        if (!sent.rejected) {
          leaving.push(channel);
        }
      }
    }

    const resume = this.#resume;
    this.#resume = undefined;
    let resumeFrames = 0;
    for (const [filter, channels] of groups) {
      for (const chunk of this.#chunks(channels)) {
        const id = this.#id();
        for (const channel of chunk) {
          this.#sent.set(channel, { filter, rejected: false });
        }
        this.#pending.set(id, {
          op: "subscribe",
          channels: chunk,
          filter,
          ...(resume && resumeFrames++ > 0 ? { splitResume: true } : {}),
        });
        this.#send({
          op: "subscribe",
          id,
          channels: chunk,
          ...(filter === ALL
            ? {}
            : { events: filter.split(",") as EventName[] }),
          ...(resume ? { resume } : {}),
        });
      }
    }
    for (const chunk of this.#chunks(leaving)) {
      const id = this.#id();
      this.#pending.set(id, { op: "unsubscribe", channels: chunk, filter: "" });
      this.#send({ op: "unsubscribe", id, channels: chunk });
    }
  }

  /** Splits channels into frames of at most 256 names and a bounded size. */
  *#chunks(channels: readonly string[]): Generator<string[]> {
    let chunk: string[] = [];
    let chars = 0;
    for (const channel of channels) {
      const size = channel.length * 3 + 4;
      if (
        chunk.length > 0 &&
        (chunk.length >= JOBS_API_WS_MAX_CHANNELS_PER_FRAME ||
          chars + size > this.#options.maxFrameChars)
      ) {
        yield chunk;
        chunk = [];
        chars = 0;
      }
      chunk.push(channel);
      chars += size;
    }
    if (chunk.length > 0) {
      yield chunk;
    }
  }

  /** A fresh frame id. */
  #id(): string {
    this.#nextId++;
    return `c${this.#nextId}`;
  }

  /** The holders holding any of these channels (canonical or as sent). */
  #holdersOf(channels: readonly string[]): Set<Holder> {
    const names = new Set<string>();
    for (const channel of channels) {
      names.add(channel);
      for (const raw of this.#rawByKey.get(channel) ?? []) {
        names.add(raw);
      }
    }
    const holders = new Set<Holder>();
    for (const holder of this.#holders) {
      if (holder.spec.channels.some((channel) => names.has(channel))) {
        holders.add(holder);
      }
    }
    return holders;
  }

  /** Recomputes a holder's rejections, notifying it when they changed. */
  #refreshRejected(holder: Holder): void {
    const next: JobsApiAckRejection[] = [];
    for (const channel of holder.spec.channels) {
      const rejection = this.#rejections.get(channel);
      if (rejection) {
        next.push(rejection);
      }
    }
    const same =
      next.length === holder.rejected.length &&
      next.every((rejection, index) => rejection === holder.rejected[index]);
    if (same) {
      return;
    }
    holder.rejected = next;
    this.#call(() => holder.spec.onRejected?.(next));
  }

  /** Runs a holder callback, so one failing screen cannot break the socket. */
  #call(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      queueMicrotask(() => {
        throw error;
      });
    }
  }

  /** Tells holders that events may have been missed. */
  #gap(holders: Iterable<Holder>, gap: JobsApiGapMessage): void {
    for (const holder of holders) {
      this.#call(() => holder.spec.onGap?.(gap));
    }
  }

  /* ---------------------------------------------------------------- *
   * Sending
   * ---------------------------------------------------------------- */

  /** Queues a frame and sends what the budget allows. */
  #send(frame: JobsApiClientMessage): void {
    this.#outbox.push(frame);
    this.#pump();
  }

  /** Sends queued frames within the budget, scheduling the rest. */
  #pump(): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== OPEN) {
      return;
    }
    const { messagesPerSecond } = this.#options;
    const now = this.#timers.now();
    this.#tokens = Math.min(
      messagesPerSecond * 2,
      this.#tokens + ((now - this.#refilledAt) * messagesPerSecond) / 1000,
    );
    this.#refilledAt = now;
    while (
      this.#outbox.length > 0 &&
      now >= this.#pausedUntil &&
      this.#tokens >= 1
    ) {
      const frame = this.#outbox.shift()!;
      this.#tokens -= 1;
      try {
        socket.send(JSON.stringify(frame));
      } catch {
        // The close that follows reconnects and resubscribes.
        return;
      }
    }
    if (this.#outbox.length > 0 && this.#pumpTimer === undefined) {
      const wait = Math.max(
        this.#pausedUntil - now,
        Math.ceil(((1 - this.#tokens) * 1000) / messagesPerSecond),
        1,
      );
      this.#pumpTimer = this.#timers.setTimeout(() => {
        this.#pumpTimer = undefined;
        this.#pump();
      }, wait);
    }
  }

  /* ---------------------------------------------------------------- *
   * Receiving
   * ---------------------------------------------------------------- */

  /** One frame from the server. */
  #onMessage(data: unknown): void {
    this.#armWatchdog();
    let frame: JobsApiServerMessage;
    try {
      frame = JSON.parse(String(data)) as JobsApiServerMessage;
    } catch {
      return;
    }
    const swallow = this.#swallowGap;
    this.#swallowGap = false;
    switch (frame.type) {
      case "hello":
        this.#onHello(frame);
        return;
      case "ack":
        this.#onAck(frame);
        return;
      case "event":
        this.#onEvent(frame);
        return;
      case "gap":
        if (swallow && frame.reason !== "slow-consumer") {
          return;
        }
        this.#gap(
          frame.channels ? this.#holdersOf(frame.channels) : this.#holders,
          frame,
        );
        return;
      case "error":
        this.#onError(frame);
        break;
      default:
        // heartbeat, pong: liveness only, which the watchdog already noted.
        break;
    }
  }

  /** The greeting: the connection is usable. */
  #onHello(hello: JobsApiHelloMessage): void {
    this.sessionId = hello.sessionId;
    this.#heartbeatMs = hello.heartbeatMs;
    this.#armWatchdog();
    this.#liveSince = this.#timers.now();
    this.#attempt = 0;
    this.#refusedAttempts = 0;

    if (this.#epoch === undefined) {
      this.#epoch = hello.epoch;
      this.#lastSeq = hello.seq;
    } else if (this.#epoch !== hello.epoch) {
      // A restart or another replica: every seq is meaningless now.
      this.#epoch = hello.epoch;
      this.#lastSeq = hello.seq;
      this.#seen.clear();
      this.#pendingGap = undefined;
      this.#gap(this.#holders, {
        type: "gap",
        epoch: hello.epoch,
        fromSeq: 0,
        toSeq: hello.seq,
        reason: "epoch-changed",
      });
    } else if (this.#holders.size > 0) {
      this.#resume = { epoch: this.#epoch, afterSeq: this.#lastSeq };
    }

    this.#setSnapshot({ state: "live", detail: null });
    if (this.#pendingGap) {
      const reason = this.#pendingGap;
      this.#pendingGap = undefined;
      this.#gap(this.#holders, {
        type: "gap",
        epoch: hello.epoch,
        fromSeq: 0,
        toSeq: hello.seq,
        reason,
      });
    }
    this.#timers.clearTimeout(this.#reconnectTimer);
    this.#flush();
  }

  /** An answer to a subscribe or unsubscribe. */
  #onAck(ack: JobsApiAckMessage): void {
    const pending = this.#pending.get(ack.id);
    this.#pending.delete(ack.id);
    if (!pending) {
      return;
    }
    const rejected = ack.rejected ?? [];
    if (pending.op === "unsubscribe") {
      for (const key of ack.channels) {
        const raws = this.#rawByKey.get(key);
        if (raws) {
          for (const raw of pending.channels) {
            raws.delete(raw);
          }
          if (raws.size === 0) {
            this.#rawByKey.delete(key);
          }
        }
      }
      return;
    }

    // Canonical names: the accepted names, in order, are the sent ones
    // less the rejected ones (the raw string is echoed, §8.1 f).
    const refused = new Set(rejected.map((rejection) => rejection.channel));
    const accepted = pending.channels.filter((raw) => !refused.has(raw));
    if (accepted.length === ack.channels.length) {
      accepted.forEach((raw, index) => {
        const key = ack.channels[index]!;
        if (key !== raw) {
          let raws = this.#rawByKey.get(key);
          if (!raws) {
            raws = new Set();
            this.#rawByKey.set(key, raws);
          }
          raws.add(raw);
        }
      });
    }
    if (accepted.length > 0 && this.#snapshot.detail === EVENTS_UNAVAILABLE) {
      this.#setSnapshot({ detail: null });
    }
    let changed = false;
    for (const raw of accepted) {
      if (this.#rejections.delete(raw)) {
        changed = true;
      }
    }
    for (const rejection of rejected) {
      const sent = this.#sent.get(rejection.channel);
      if (sent) {
        sent.rejected = true;
      }
      this.#rejections.set(rejection.channel, rejection);
      changed = true;
    }
    if (changed) {
      for (const holder of this.#holders) {
        this.#refreshRejected(holder);
      }
    }

    if (
      ack.channels.length > 0 &&
      (ack.resumed === false || (ack.resumed === true && pending.splitResume))
    ) {
      // After `resumed: false` the server's own gap follows: it is covered here.
      this.#swallowGap = ack.resumed === false;
      this.#gap(this.#holdersOf(ack.channels), {
        type: "gap",
        epoch: this.#epoch ?? "",
        fromSeq: 0,
        toSeq: ack.seq,
        reason: "resume-expired",
        channels: ack.channels,
      });
    }
  }

  /** An event: de-duplicated by `seq`, delivered once to each holder it concerns. */
  #onEvent(message: JobsApiEventMessage): void {
    if (this.#epoch !== undefined && message.epoch !== this.#epoch) {
      return;
    }
    if (message.seq > this.#lastSeq) {
      this.#lastSeq = message.seq;
    }
    this.#setSnapshot({ lastEventAt: this.#timers.now() });

    let delivered = this.#seen.get(message.seq);
    if (!delivered) {
      delivered = new Set();
      this.#seen.set(message.seq, delivered);
      if (this.#seen.size > this.#options.seenLimit) {
        const oldest = this.#seen.keys().next().value;
        if (oldest !== undefined) {
          this.#seen.delete(oldest);
        }
      }
    }
    const { event } = message;
    for (const holder of this.#holdersOf(message.subscriptions)) {
      if (delivered.has(holder)) {
        continue;
      }
      if (holder.filter && !holder.filter.has(event.type)) {
        continue;
      }
      delivered.add(holder);
      this.#call(() => holder.spec.onEvent?.(event));
    }
  }

  /** An `error` frame. */
  #onError(error: JobsApiErrorMessage): void {
    const pending =
      error.id === undefined ? undefined : this.#pending.get(error.id);
    if (error.id !== undefined) {
      this.#pending.delete(error.id);
    }
    if (error.code === "RATE_LIMITED") {
      this.#tokens = 0;
      this.#pausedUntil = this.#timers.now() + this.#options.rateLimitPauseMs;
    }
    if (pending) {
      // The frame had no effect: forget what it asked, so the next reconcile asks again.
      if (pending.op === "subscribe") {
        for (const channel of pending.channels) {
          if (this.#sent.get(channel)?.filter === pending.filter) {
            this.#sent.delete(channel);
          }
        }
      } else {
        for (const channel of pending.channels) {
          if (!this.#sent.has(channel)) {
            this.#sent.set(channel, { filter: "", rejected: false });
          }
        }
      }
      if (
        error.code === "RATE_LIMITED" ||
        error.code === "EVENTS_UNAVAILABLE" ||
        error.code === "INTERNAL"
      ) {
        const delay =
          error.code === "RATE_LIMITED"
            ? this.#options.rateLimitPauseMs
            : this.backoffDelay(Math.min(this.#attempt + 3, 10));
        this.#timers.clearTimeout(this.#retryFlushTimer);
        this.#retryFlushTimer = this.#timers.setTimeout(() => {
          this.#retryFlushTimer = undefined;
          this.#flush();
        }, delay);
      } else if (pending.op === "subscribe") {
        // A refusal that asking again will not change: report it, do not loop.
        for (const channel of pending.channels) {
          this.#sent.set(channel, { filter: pending.filter, rejected: true });
          this.#rejections.set(channel, {
            channel,
            code: error.code,
            status: error.status,
            detail: error.detail,
          });
        }
        for (const holder of this.#holders) {
          this.#refreshRejected(holder);
        }
      }
    }
    if (error.code === "EVENTS_UNAVAILABLE") {
      this.#setSnapshot({ detail: EVENTS_UNAVAILABLE });
    }
  }
}
